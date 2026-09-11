import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";

import { loadCognitoConfig } from "../cognitoConfig.js";
import {
  ExpiredTokenError,
  InvalidSignatureError,
  MalformedTokenError,
  WrongAudienceError,
  WrongIssuerError,
  WrongTokenUseError,
} from "../errors.js";
import type { IdentityProvider, VerifiedTokenClaims } from "../identityProvider.js";

export interface CognitoIdentityProviderOptions {
  issuer: string;
  audience: string;
  clockToleranceSeconds: number;
  /** JWKS key resolver — a remote set in production, a local set in tests. */
  getKey: JWTVerifyGetKey;
}

// The only module in this backend that knows Cognito exists. It verifies
// signature/issuer/audience/expiry only — it deliberately returns nothing
// about roles, scopes or operator status, because Cognito is an
// *authentication* source of truth for "is this a real, MFA'd operator
// subject", not an *authorization* source of truth. Privilege is resolved
// afterward, from the governance-owned OperatorDirectory (see
// middleware/requireManagementApiAuth.ts) — never from token claims.
export class CognitoIdentityProvider implements IdentityProvider {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clockToleranceSeconds: number;
  private readonly getKey: JWTVerifyGetKey;

  constructor(options: CognitoIdentityProviderOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.clockToleranceSeconds = options.clockToleranceSeconds;
    this.getKey = options.getKey;
  }

  /** Production factory — resolves keys from the real Cognito JWKS endpoint. */
  static fromEnv(): CognitoIdentityProvider {
    const config = loadCognitoConfig();
    return new CognitoIdentityProvider({
      issuer: config.issuer,
      audience: config.appClientId,
      clockToleranceSeconds: config.clockToleranceSeconds,
      getKey: createRemoteJWKSet(new URL(config.jwksUri)),
    });
  }

  async verifyToken(rawToken: string): Promise<VerifiedTokenClaims> {
    if (!rawToken || rawToken.trim() === "") {
      throw new MalformedTokenError("token is empty");
    }
    // jose parses compact-JWS structure itself; a non-JWT string (e.g. a
    // random opaque string, or a JWT missing a segment) surfaces as
    // JWSInvalid/JWTInvalid below, not as a thrown TypeError, but we guard
    // the obvious shape first for a clearer rejection reason.
    if (rawToken.split(".").length !== 3) {
      throw new MalformedTokenError("token is not a three-part compact JWS");
    }

    try {
      const { payload } = await jwtVerify(rawToken, this.getKey, {
        algorithms: ["RS256"],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockToleranceSeconds,
      });

      const subject = payload.sub;
      const tokenId = typeof payload.jti === "string" ? payload.jti : undefined;
      const issuedAt = payload.iat;
      const expiresAt = payload.exp;

      // Management auth accepts Cognito ID tokens only. Access tokens are
      // signed by the same pool but use `client_id` rather than `aud` and
      // must never be accepted by this operator boundary accidentally.
      if (payload.token_use !== "id") {
        throw new WrongTokenUseError(payload.token_use);
      }

      if (typeof subject !== "string" || subject.trim() === "") {
        throw new MalformedTokenError("token is missing a 'sub' claim");
      }
      if (!tokenId) {
        throw new MalformedTokenError("token is missing a 'jti' claim");
      }
      if (typeof issuedAt !== "number" || typeof expiresAt !== "number") {
        throw new MalformedTokenError("token is missing 'iat'/'exp' claims");
      }

      return {
        subject,
        tokenId,
        issuedAt: new Date(issuedAt * 1000),
        expiresAt: new Date(expiresAt * 1000),
        rawClaims: payload as Record<string, unknown>,
      };
    } catch (err) {
      throw this.mapVerificationError(err);
    }
  }

  private mapVerificationError(err: unknown): Error {
    if (err instanceof WrongTokenUseError) return err;
    if (err instanceof joseErrors.JWTExpired) {
      return new ExpiredTokenError();
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      if (err.claim === "iss") return new WrongIssuerError();
      if (err.claim === "aud") return new WrongAudienceError();
      return new MalformedTokenError(`claim validation failed for '${err.claim}'`);
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return new InvalidSignatureError();
    }
    if (
      err instanceof joseErrors.JWTInvalid ||
      err instanceof joseErrors.JWSInvalid ||
      err instanceof joseErrors.JWKSNoMatchingKey ||
      err instanceof joseErrors.JWKSMultipleMatchingKeys
    ) {
      return new MalformedTokenError(err.message);
    }
    if (err instanceof Error) {
      return new MalformedTokenError(err.message);
    }
    return new MalformedTokenError("unknown token verification failure");
  }
}
