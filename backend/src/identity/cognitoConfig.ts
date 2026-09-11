import { ConfigurationError } from "./errors.js";

// 1A.2 — Cognito boundary configuration. Every value here comes from the
// environment; nothing is a hardcoded AWS account id, pool id, region,
// domain or ARN (master plan §15/§69.2). This module is only ever called
// lazily, at first use of the real CognitoIdentityProvider — never at
// import time — so `npm run build`/`typecheck` and the /healthz path never
// require these variables to be set, matching the 1A.1 zero-dependency
// health check invariant.

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  appClientId: string;
  /** Derived from region+pool unless explicitly overridden. */
  issuer: string;
  /** Derived from issuer unless explicitly overridden (tests only). */
  jwksUri: string;
  clockToleranceSeconds: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new ConfigurationError(
      `Missing required environment variable ${name}. Phase 1A.2 Cognito ` +
        `verification cannot start until the dedicated ` +
        `polynovea-platform-operators pool exists and its region/pool ` +
        `id/app client id are provided via environment configuration — see ` +
        `docs/1A.2_status.md "AWS resources required to finish live 1A.2".`,
    );
  }
  return value;
}

export function loadCognitoConfig(): CognitoConfig {
  const region = required("GOVERNANCE_COGNITO_REGION");
  const userPoolId = required("GOVERNANCE_COGNITO_USER_POOL_ID");
  const appClientId = required("GOVERNANCE_COGNITO_APP_CLIENT_ID");

  const issuer =
    process.env.GOVERNANCE_COGNITO_ISSUER?.trim() ||
    `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

  const jwksUri = process.env.GOVERNANCE_COGNITO_JWKS_URI?.trim() || `${issuer}/.well-known/jwks.json`;

  const clockToleranceSeconds = Number(process.env.GOVERNANCE_MANAGEMENT_TOKEN_CLOCK_TOLERANCE_SEC ?? "5");
  if (!Number.isFinite(clockToleranceSeconds) || clockToleranceSeconds < 0) {
    throw new ConfigurationError(
      "GOVERNANCE_MANAGEMENT_TOKEN_CLOCK_TOLERANCE_SEC must be a non-negative number.",
    );
  }

  return { region, userPoolId, appClientId, issuer, jwksUri, clockToleranceSeconds };
}
