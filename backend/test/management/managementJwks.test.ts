import { describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify } from "jose";

import { buildManagementJwks } from "../../src/management/managementJwks.js";
import { mintManagementAssertion } from "../../src/management/managementAssertionIssuer.js";
import { generateTestKeyPair } from "./testKeys.js";

const CONFIG = { issuer: "https://governance.test.invalid", audience: "infrakinetic-management-api-test" };
const BASE_PARAMS = {
  operatorId: "operator-1",
  operatorSessionId: "session-1",
  operatorRoles: ["platform_operator"],
  operatorGrantedScopes: ["engines.read"],
  requestedScopes: ["engines.read"],
  targetEngine: "module_billing",
  requestedAction: "engines.catalog.read",
};

describe("management/managementJwks", () => {
  it("shape: a JWK Set object with a keys array", async () => {
    const { privateKey, publicJwk } = await generateTestKeyPair("k1");
    const jwks = buildManagementJwks({ activeKid: "k1", activePrivateKey: privateKey, publicJwks: [publicJwk] });
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys[0].kid).toBe("k1");
  });

  it("key rotation compatibility: a token signed by an older key still verifies via a JWKS that carries both", async () => {
    const oldKey = await generateTestKeyPair("old-key");
    const newKey = await generateTestKeyPair("new-key");

    // Old assertion, signed while "old-key" was still active.
    const oldToken = await mintManagementAssertion(
      { activeKid: "old-key", activePrivateKey: oldKey.privateKey, publicJwks: [oldKey.publicJwk] },
      CONFIG,
      { ...BASE_PARAMS },
    );

    // Rotation happened: JWKS now advertises the new key as active but
    // still carries the old one for the grace window.
    const rotatedKeySet = {
      activeKid: "new-key",
      activePrivateKey: newKey.privateKey,
      publicJwks: [newKey.publicJwk, oldKey.publicJwk],
    };
    const jwks = buildManagementJwks(rotatedKeySet);
    const remoteLikeKeySet = createLocalJWKSet(jwks);

    const { protectedHeader } = await jwtVerify(oldToken, remoteLikeKeySet, {
      algorithms: ["RS256"],
      issuer: CONFIG.issuer,
      audience: CONFIG.audience,
    });
    expect(protectedHeader.kid).toBe("old-key");

    // A freshly minted assertion under the new active key verifies too.
    const newToken = await mintManagementAssertion(rotatedKeySet, CONFIG, { ...BASE_PARAMS });
    const { protectedHeader: newHeader } = await jwtVerify(newToken, remoteLikeKeySet, {
      algorithms: ["RS256"],
      issuer: CONFIG.issuer,
      audience: CONFIG.audience,
    });
    expect(newHeader.kid).toBe("new-key");
  });

  it("a token signed by a key fully retired out of the JWKS no longer verifies", async () => {
    const retiredKey = await generateTestKeyPair("retired-key");
    const currentKey = await generateTestKeyPair("current-key");

    const retiredToken = await mintManagementAssertion(
      { activeKid: "retired-key", activePrivateKey: retiredKey.privateKey, publicJwks: [retiredKey.publicJwk] },
      CONFIG,
      { ...BASE_PARAMS },
    );

    const jwks = buildManagementJwks({
      activeKid: "current-key",
      activePrivateKey: currentKey.privateKey,
      publicJwks: [currentKey.publicJwk],
    });
    const keySet = createLocalJWKSet(jwks);

    await expect(
      jwtVerify(retiredToken, keySet, { algorithms: ["RS256"], issuer: CONFIG.issuer, audience: CONFIG.audience }),
    ).rejects.toThrow();
  });
});
