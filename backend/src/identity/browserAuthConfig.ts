import { ConfigurationError } from "./errors.js";

export interface BrowserAuthConfig {
  cognitoDomain: string;
  appClientId: string;
  redirectUri: string;
  frontendOrigin: string;
  secureCookies: boolean;
  oauthTransactionTtlSeconds: number;
  browserSessionMaxSeconds: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required browser-auth configuration '${name}'.`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError(`${name} must be a positive number.`);
  }
  return value;
}

export function loadBrowserAuthConfig(): BrowserAuthConfig {
  const cognitoDomain = required("GOVERNANCE_COGNITO_DOMAIN").replace(/\/$/, "");
  const appClientId = required("GOVERNANCE_COGNITO_APP_CLIENT_ID");
  const redirectUri = required("GOVERNANCE_COGNITO_REDIRECT_URI");
  const frontendOrigin = required("GOVERNANCE_FRONTEND_ORIGIN").replace(/\/$/, "");

  let domainUrl: URL;
  let redirectUrl: URL;
  let frontendUrl: URL;
  try {
    domainUrl = new URL(cognitoDomain);
    redirectUrl = new URL(redirectUri);
    frontendUrl = new URL(frontendOrigin);
  } catch {
    throw new ConfigurationError("Browser-auth URLs must be absolute URLs.");
  }

  if (!/^https?:$/.test(domainUrl.protocol) || !/^https?:$/.test(redirectUrl.protocol) || !/^https?:$/.test(frontendUrl.protocol)) {
    throw new ConfigurationError("Browser-auth URLs must use HTTP or HTTPS.");
  }

  const production = process.env.NODE_ENV === "production";
  if (production && (domainUrl.protocol !== "https:" || redirectUrl.protocol !== "https:" || frontendUrl.protocol !== "https:")) {
    throw new ConfigurationError("Production browser-auth URLs must use HTTPS.");
  }

  return {
    cognitoDomain,
    appClientId,
    redirectUri,
    frontendOrigin,
    secureCookies: redirectUrl.protocol === "https:",
    oauthTransactionTtlSeconds: positiveNumber("GOVERNANCE_OAUTH_TRANSACTION_TTL_SEC", 600),
    browserSessionMaxSeconds: positiveNumber("GOVERNANCE_BROWSER_SESSION_MAX_SEC", 3600),
  };
}

export function browserAuthAppearsConfigured(): boolean {
  return Boolean(
    process.env.GOVERNANCE_COGNITO_DOMAIN?.trim() &&
      process.env.GOVERNANCE_COGNITO_APP_CLIENT_ID?.trim() &&
      process.env.GOVERNANCE_COGNITO_REDIRECT_URI?.trim() &&
      process.env.GOVERNANCE_FRONTEND_ORIGIN?.trim(),
  );
}
