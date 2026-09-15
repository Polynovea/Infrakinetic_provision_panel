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
  return String(value);
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// 1A.8.1 adds generic management-resource addressing while preserving the
// exact canonical object used by already-persisted 1A.6 engine operations.
// Optional generic fields are intentionally not derived from targetEngine in
// this function: canonicalize() drops undefined object keys, so an old engine
// call shape hashes byte-for-byte exactly as it did before 1A.8.1.
export interface IdempotencyScope {
  requestedAction: string;
  targetTenantId?: string | null;
  targetEngine?: string;
  targetResourceType?: string;
  targetResourceId?: string;
  payload: unknown;
}

export function computeSafePayloadHash(scope: IdempotencyScope): string {
  const canonical = canonicalStringify({
    requestedAction: scope.requestedAction,
    targetTenantId: scope.targetTenantId ?? null,
    targetEngine: scope.targetEngine,
    targetResourceType: scope.targetResourceType,
    targetResourceId: scope.targetResourceId,
    payload: scope.payload,
  });
  return sha256Hex(canonical);
}
