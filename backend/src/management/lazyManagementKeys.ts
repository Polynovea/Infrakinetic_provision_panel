import { loadManagementSigningKeys, type ManagementSigningKeySet } from "./managementSigningKeys.js";

// Same "required env var, thrown lazily, never at import time" invariant as
// db/lazyDbClient.ts and identity/providers/lazyIdentityProvider.ts — server
// boot and /healthz never require GOVERNANCE_MANAGEMENT_SIGNING_* to be
// set; only the JWKS endpoint or an actual assertion-minting call does, and
// both fail closed with a named missing variable if it isn't.
let cached: Promise<ManagementSigningKeySet> | undefined;

export function getManagementSigningKeysLazy(): Promise<ManagementSigningKeySet> {
  if (!cached) cached = loadManagementSigningKeys();
  return cached;
}

/** Test-only: clears the cache so a test can reload keys after changing env. */
export function resetManagementSigningKeysCacheForTests(): void {
  cached = undefined;
}
