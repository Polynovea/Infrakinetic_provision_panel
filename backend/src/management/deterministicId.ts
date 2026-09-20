import { createHash } from "node:crypto";

// Phase 1A.11 — deterministic, name-based UUID derivation (UUIDv5-shaped:
// sha-based digest, version/variant bits set per RFC 4122 §4.3, sha256
// instead of sha1 since this only needs a stable, collision-resistant,
// UUID-FORMATTED string — not literal RFC 4122 interop with another UUIDv5
// implementation). Used exactly once today: routes/publicOnboarding/
// index.ts derives commissionRequestId from the caller's idempotencyKey,
// never from crypto.randomUUID(), so that the SAME idempotencyKey (itself
// derived by Infrakinetic's signup.js from the full normalized signup
// intent) always maps to the SAME commissionRequestId. Without this, a
// public-signup retry with a matching idempotencyKey would still mint a
// fresh random commissionRequestId each time, and since Governance's
// ledger request-hash includes target_resource_id (=commissionRequestId),
// that mismatch — not a real change in intent — was what actually produced
// the idempotency conflict this fix closes.
export function deterministicUuidFrom(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const bytes = hex.split("");
  // Version nibble (position 12, 0-indexed within the 32 hex chars) -> '5'
  // (name-based, sha-derived), matching UUIDv5's own version marker.
  bytes[12] = "5";
  // Variant bits (position 16) -> RFC 4122 variant (10xx), same technique
  // every real UUIDv3/v5 implementation uses: force the top two bits of
  // that nibble to 10, expressed here as one of 8/9/a/b.
  const variantNibble = parseInt(bytes[16], 16);
  bytes[16] = ((variantNibble & 0x3) | 0x8).toString(16);
  const h = bytes.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
