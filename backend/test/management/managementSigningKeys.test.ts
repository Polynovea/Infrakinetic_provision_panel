import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadManagementSigningKeys } from "../../src/management/managementSigningKeys.js";
import { DatabaseUnavailableError } from "../../src/db/errors.js";

const ENV_VARS = [
  "GOVERNANCE_MANAGEMENT_SIGNING_KID",
  "GOVERNANCE_MANAGEMENT_SIGNING_PRIVATE_KEY_PEM",
  "GOVERNANCE_MANAGEMENT_SIGNING_ADDITIONAL_PUBLIC_JWKS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function toPem(privateKey: KeyObject): string {
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("management/managementSigningKeys", () => {
  beforeEach(() => {
    for (const key of ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("throws DatabaseUnavailableError naming the missing variable when unset", async () => {
    await expect(loadManagementSigningKeys()).rejects.toThrow(DatabaseUnavailableError);
    await expect(loadManagementSigningKeys()).rejects.toThrow(/GOVERNANCE_MANAGEMENT_SIGNING_KID/);
  });

  it("loads a valid key and derives its own public JWK from the private key", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_KID = "kid-1";
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_PRIVATE_KEY_PEM = toPem(privateKey);

    const keys = await loadManagementSigningKeys();

    expect(keys.activeKid).toBe("kid-1");
    expect(keys.publicJwks).toHaveLength(1);
    expect(keys.publicJwks[0].kid).toBe("kid-1");
    expect(keys.publicJwks[0]).not.toHaveProperty("d"); // never the private exponent
  });

  it("rejects a malformed private key PEM", async () => {
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_KID = "kid-1";
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_PRIVATE_KEY_PEM = "not a real pem";
    await expect(loadManagementSigningKeys()).rejects.toThrow(DatabaseUnavailableError);
  });

  it("includes additional public JWKs (rotation grace window) when configured", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { publicKey: otherPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { exportJWK } = await import("jose");
    const otherJwk = await exportJWK(otherPublicKey);
    otherJwk.kid = "previous-kid";

    process.env.GOVERNANCE_MANAGEMENT_SIGNING_KID = "kid-1";
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_PRIVATE_KEY_PEM = toPem(privateKey);
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_ADDITIONAL_PUBLIC_JWKS = JSON.stringify([otherJwk]);

    const keys = await loadManagementSigningKeys();
    expect(keys.publicJwks.map((k) => k.kid)).toEqual(["kid-1", "previous-kid"]);
  });

  it("fails closed on an additional JWK missing a kid", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_KID = "kid-1";
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_PRIVATE_KEY_PEM = toPem(privateKey);
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_ADDITIONAL_PUBLIC_JWKS = JSON.stringify([{ kty: "RSA" }]);

    await expect(loadManagementSigningKeys()).rejects.toThrow(DatabaseUnavailableError);
  });

  it("fails closed on invalid JSON in the additional JWKS variable", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_KID = "kid-1";
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_PRIVATE_KEY_PEM = toPem(privateKey);
    process.env.GOVERNANCE_MANAGEMENT_SIGNING_ADDITIONAL_PUBLIC_JWKS = "{not json";

    await expect(loadManagementSigningKeys()).rejects.toThrow(DatabaseUnavailableError);
  });
});
