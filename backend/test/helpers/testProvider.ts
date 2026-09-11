import { createLocalJWKSet } from "jose";

import { CognitoIdentityProvider } from "../../src/identity/providers/cognitoIdentityProvider.js";
import { jwksFor, TEST_AUDIENCE, TEST_ISSUER, type TestKeyPair } from "./testToken.js";

/**
 * Builds a CognitoIdentityProvider wired to a local (in-memory) JWKS instead
 * of a network endpoint, per "use fixtures/mocks/local JWKS only where
 * needed" — this exercises the exact same signature/issuer/audience/expiry
 * verification path as production, just with keys that never leave the
 * test process.
 */
export function buildTestIdentityProvider(keyPair: TestKeyPair): CognitoIdentityProvider {
  return new CognitoIdentityProvider({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    clockToleranceSeconds: 5,
    getKey: createLocalJWKSet(jwksFor(keyPair)),
  });
}
