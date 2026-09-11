import { generateKeyPairSync } from "node:crypto";
import { exportJWK, type JWK } from "jose";

import type { ManagementSigningKeySet } from "../../src/management/managementSigningKeys.js";

// Shared test helper — generates a real RSA keypair per call (no fixture
// files, no shared state between tests) so signing/verification tests
// exercise the real `jose` code paths, not a mock.
export async function generateTestKeyPair(kid: string): Promise<{
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  publicJwk: JWK;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { privateKey, publicJwk };
}

export async function buildTestKeySet(kid = "test-key-1"): Promise<ManagementSigningKeySet> {
  const { privateKey, publicJwk } = await generateTestKeyPair(kid);
  return { activeKid: kid, activePrivateKey: privateKey, publicJwks: [publicJwk] };
}
