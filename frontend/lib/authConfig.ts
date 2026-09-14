// Real Cognito Hosted UI configuration for the browser side of the
// operator-auth boundary. The backend (backend/src/identity/cognitoConfig.ts)
// only ever verifies a token that's handed to it — it has no concept of a
// login domain. The Hosted UI domain/client id/redirect URI below are the
// additional public (non-secret) values a browser-based Authorization
// Code + PKCE flow needs to actually get that token in the first place.
//
// These are NEXT_PUBLIC_* values, which Next.js inlines into the bundle at
// build time. That is what makes "fail closed in production" a build-time
// guarantee rather than a runtime toggle someone could flip: a production
// build (`next build`, which Next.js always runs with NODE_ENV=production)
// performed without these variables set produces a bundle that can never
// show a real sign-in option and can never compile in the dev-only bypass
// below — there is no code path that reads them differently at runtime.
export interface CognitoAuthConfig {
  domain: string;
  clientId: string;
  redirectUri: string;
}

export function getCognitoAuthConfig(): CognitoAuthConfig | null {
  const domain = process.env.NEXT_PUBLIC_GOVERNANCE_COGNITO_DOMAIN;
  const clientId = process.env.NEXT_PUBLIC_GOVERNANCE_COGNITO_CLIENT_ID;
  const redirectUri = process.env.NEXT_PUBLIC_GOVERNANCE_COGNITO_REDIRECT_URI;
  if (!domain || !clientId || !redirectUri) return null;
  return { domain, clientId, redirectUri };
}

// Gated by TWO independent conditions, not one: Next.js's own build-time
// NODE_ENV (never true for `next build`/`next start`, so this branch is
// dead-code-eliminated from any production bundle regardless of what else
// is set) AND an explicit opt-in flag a developer must set themselves. A
// production deployment that forgets to configure Cognito gets the
// fail-closed screen, never a silent fallback to a token field.
export function isDevAuthBypassEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_GOVERNANCE_DEV_AUTH === "1";
}
