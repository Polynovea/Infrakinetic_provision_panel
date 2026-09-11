import { describe, expect, it } from "vitest";

import {
  ExpiredTokenError,
  InvalidSignatureError,
  MalformedTokenError,
  WrongAudienceError,
  WrongIssuerError,
} from "../../src/identity/errors.js";
import { buildTestIdentityProvider } from "../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken, TEST_AUDIENCE, TEST_ISSUER } from "../helpers/testToken.js";

describe("CognitoIdentityProvider — the Cognito JWT verification boundary", () => {
  it("accepts a well-formed token signed by the configured pool", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const token = await signTestToken(keyPair, { subject: "fixture-sub-admin" });

    const claims = await provider.verifyToken(token);

    expect(claims.subject).toBe("fixture-sub-admin");
    expect(claims.tokenId).toBeTruthy();
    expect(claims.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a malformed (non-JWT) token", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);

    await expect(provider.verifyToken("not-a-jwt")).rejects.toBeInstanceOf(MalformedTokenError);
  });

  it("rejects an empty token", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);

    await expect(provider.verifyToken("")).rejects.toBeInstanceOf(MalformedTokenError);
  });

  it("rejects a structurally JWT-shaped but garbage token", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);

    await expect(provider.verifyToken("aaaa.bbbb.cccc")).rejects.toBeInstanceOf(MalformedTokenError);
  });

  it("rejects an expired token", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const token = await signTestToken(keyPair, { expiresInSeconds: -3600, issuedAtSecondsAgo: 7200 });

    await expect(provider.verifyToken(token)).rejects.toBeInstanceOf(ExpiredTokenError);
  });

  it("rejects a token signed with a key that is not in the pool's JWKS (bad signature)", async () => {
    const legitimateKeyPair = await generateTestKeyPair();
    const attackerKeyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(legitimateKeyPair);
    // Signed by a different key but claims the legitimate key's kid so it
    // reaches signature verification rather than failing key lookup.
    const forgedToken = await signTestToken({ ...attackerKeyPair, kid: legitimateKeyPair.kid });

    await expect(provider.verifyToken(forgedToken)).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("rejects a token from the wrong issuer (e.g. a different Cognito pool)", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const token = await signTestToken(keyPair, { issuer: "https://cognito-idp.test-region-1.amazonaws.com/some-other-pool" });

    await expect(provider.verifyToken(token)).rejects.toBeInstanceOf(WrongIssuerError);
  });

  it("rejects a token for the wrong audience — e.g. a tenant-pool-issued token presented to the operator API", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const tenantShapedToken = await signTestToken(keyPair, { audience: "tenant-app-client-id" });

    await expect(provider.verifyToken(tenantShapedToken)).rejects.toBeInstanceOf(WrongAudienceError);
  });

  it("rejects a token missing the 'sub' claim", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const token = await signTestToken(keyPair, { omitSub: true });

    await expect(provider.verifyToken(token)).rejects.toBeInstanceOf(MalformedTokenError);
  });

  it("rejects a token missing the 'jti' claim", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const token = await signTestToken(keyPair, { omitJti: true });

    await expect(provider.verifyToken(token)).rejects.toBeInstanceOf(MalformedTokenError);
  });

  it("sanity: the shared test constants actually match issuer/audience used above", () => {
    expect(TEST_ISSUER).toContain("amazonaws.com");
    expect(TEST_AUDIENCE).toBeTruthy();
  });
});
