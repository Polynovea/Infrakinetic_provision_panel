import { randomUUID } from "node:crypto";

import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from "jose";

export const TEST_ISSUER = "https://cognito-idp.test-region-1.amazonaws.com/test-pool";
export const TEST_AUDIENCE = "test-app-client-id";

export interface TestKeyPair {
  publicJwk: JWK;
  privateKey: KeyLike;
  kid: string;
}

export async function generateTestKeyPair(): Promise<TestKeyPair> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = randomUUID();
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { publicJwk, privateKey, kid };
}

export function jwksFor(keyPair: TestKeyPair): { keys: JWK[] } {
  return { keys: [keyPair.publicJwk] };
}

export interface SignOptions {
  issuer?: string;
  audience?: string;
  subject?: string;
  jti?: string;
  expiresInSeconds?: number;
  issuedAtSecondsAgo?: number;
  omitSub?: boolean;
  omitJti?: boolean;
}

export async function signTestToken(keyPair: TestKeyPair, options: SignOptions = {}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const iat = nowSeconds - (options.issuedAtSecondsAgo ?? 0);
  const exp = iat + (options.expiresInSeconds ?? 3600);

  let builder = new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: keyPair.kid })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? TEST_AUDIENCE);

  if (!options.omitSub) {
    builder = builder.setSubject(options.subject ?? "fixture-sub-admin");
  }
  if (!options.omitJti) {
    builder = builder.setJti(options.jti ?? randomUUID());
  }

  return builder.sign(keyPair.privateKey);
}
