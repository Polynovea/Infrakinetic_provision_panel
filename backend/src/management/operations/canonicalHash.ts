import { createHash } from "node:crypto";

// 1A.5 — deterministic, key-order-independent hashing for idempotency
// conflict detection. JSON.stringify's key order follows insertion order,
// which is NOT a stable representation of "the same payload" — two callers
// who mean the same request but built their objects in a different order
// would otherwise hash differently. canonicalize() recursively sorts every
// object's keys (arrays keep their own order — order is significant there)
// before stringifying, so the hash is a true function of the value, not of
// how it happened to be constructed.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalize(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const result: { [key: string]: JsonValue } = {};
    for (const [key, v] of entries) result[key] = canonicalize(v);
    return result;
  }
  // Functions, symbols, bigints: not valid request-payload shapes. Coerce to
  // a stable string rather than throwing, so hashing never crashes the
  // request path — the odd input still produces a deterministic hash, it is
  // just not a meaningful one for that field.
  return String(value);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// The full identity a management operation's idempotency guard binds to:
// action + tenant + engine + payload. Hashing all four together (not just
// the payload) is what makes "same key, materially different request"
// detectable — two requests that reuse an idempotency key but disagree on
// any of these fields produce different hashes and are therefore rejected
// as a conflict, never silently aliased to one operation.
export interface IdempotencyScope {
  requestedAction: string;
  targetTenantId?: string | null;
  targetEngine: string;
  payload: unknown;
}

export function computeSafePayloadHash(scope: IdempotencyScope): string {
  const canonical = canonicalStringify({
    requestedAction: scope.requestedAction,
    targetTenantId: scope.targetTenantId ?? null,
    targetEngine: scope.targetEngine,
    payload: scope.payload,
  });
  return sha256Hex(canonical);
}
