import type { CognitoAuthConfig } from "./authConfig";
import { deriveCodeChallenge, generateCodeVerifier } from "./pkce";

// Standard Cognito Hosted UI OAuth2 Authorization Code + PKCE flow. This is
// unverified against a live pool — GOVERNANCE_COGNITO_* has never been
// provisioned in any real AWS environment, so there is no Hosted UI to test
// a redirect against yet. It is written to the real, documented Cognito
// Hosted UI contract (https://docs.aws.amazon.com/cognito/latest/developerguide/login-endpoint.html)
// so it is ready the moment a real user pool + app client exist — not a
// placeholder to be redesigned later.

const CODE_VERIFIER_STORAGE_KEY = "governance.auth.pkceVerifier";
export const ID_TOKEN_STORAGE_KEY = "governance.auth.idToken";

export async function beginSignIn(config: CognitoAuthConfig): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = await deriveCodeChallenge(verifier);
  sessionStorage.setItem(CODE_VERIFIER_STORAGE_KEY, verifier);

  const url = new URL(`${config.domain}/login`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  window.location.assign(url.toString());
}

export function buildSignOutUrl(config: CognitoAuthConfig, logoutRedirectUri: string): string {
  const url = new URL(`${config.domain}/logout`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("logout_uri", logoutRedirectUri);
  return url.toString();
}

export class AuthCallbackError extends Error {}

export async function completeSignIn(config: CognitoAuthConfig, authorizationCode: string): Promise<string> {
  const verifier = sessionStorage.getItem(CODE_VERIFIER_STORAGE_KEY);
  if (!verifier) {
    throw new AuthCallbackError("No PKCE verifier found for this browser session — sign-in must be restarted.");
  }
  sessionStorage.removeItem(CODE_VERIFIER_STORAGE_KEY);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: authorizationCode,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });

  const res = await fetch(`${config.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new AuthCallbackError(`Token exchange failed (${res.status}).`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) {
    throw new AuthCallbackError("Token exchange response did not include an ID token.");
  }
  sessionStorage.setItem(ID_TOKEN_STORAGE_KEY, json.id_token);
  return json.id_token;
}

export function decodeJwtExpiry(token: string): number | null {
  try {
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
