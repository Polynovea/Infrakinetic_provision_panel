// Clean identity-provider boundary: everything above this interface (the
// middleware, the operator directory, the routes) is AWS-agnostic. Only
// identity/providers/cognitoIdentityProvider.ts knows Cognito exists, so a
// future non-Cognito IdP — or a break-glass local IdP — is a new class that
// implements this interface, not a rewrite of the auth boundary.

export interface VerifiedTokenClaims {
  /** Stable subject identifier from the IdP (Cognito "sub"). */
  subject: string;
  /** IdP-side unique token identifier, used as the operator session id. */
  tokenId: string;
  issuedAt: Date;
  expiresAt: Date;
  /** Raw claim bag, for audit evidence only — never used for authorization. */
  rawClaims: Record<string, unknown>;
}

export interface IdentityProvider {
  /**
   * Verify a raw bearer token's signature, issuer, audience and expiry.
   * Must reject (throw a ManagementAuthError subclass) on any malformed,
   * expired, badly-signed, wrong-issuer or wrong-audience token. Must never
   * fall back to accepting an unverifiable token.
   */
  verifyToken(rawToken: string): Promise<VerifiedTokenClaims>;
}
