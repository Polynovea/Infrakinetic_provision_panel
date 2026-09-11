import type { JWK } from "jose";

import type { ManagementSigningKeySet } from "./managementSigningKeys.js";

// 1A.4 — public verification material only. This is the one piece of
// management-signing state Infrakinetic (or anything else) is meant to
// fetch; it is safe to expose unauthenticated, same as any standard JWKS
// endpoint (Cognito's own included).
export function buildManagementJwks(keys: ManagementSigningKeySet): { keys: JWK[] } {
  return { keys: keys.publicJwks };
}
