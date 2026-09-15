import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";

import type { AuditSink } from "../../identity/auditSink.js";
import type { BrowserAuthConfig } from "../../identity/browserAuthConfig.js";
import { browserAuthAppearsConfigured, loadBrowserAuthConfig } from "../../identity/browserAuthConfig.js";
import {
  pkceChallenge,
  randomOpaqueSecret,
  safeEqualText,
  safeRelativeReturnPath,
  sha256Base64Url,
} from "../../identity/browserAuthCrypto.js";
import type { BrowserAuthStore } from "../../identity/browserAuthStore.js";
import { browserCookieNames, parseCookies } from "../../identity/browserCookies.js";
import type { IdentityProvider } from "../../identity/identityProvider.js";
import type { OperatorDirectory } from "../../identity/operatorDirectory.js";
import { ROLE_SCOPE_CEILING } from "../../identity/roles.js";

export interface BrowserAuthRouterDeps {
  identityProvider: IdentityProvider;
  operatorDirectory: OperatorDirectory;
  browserAuthStore: BrowserAuthStore;
  auditSink: AuditSink;
  loadConfig?: () => BrowserAuthConfig;
  fetchImpl?: typeof fetch;
}

function remoteAddress(req: Request): string | undefined {
  return req.ip || req.socket.remoteAddress || undefined;
}

function clearOAuthCookie(res: Response, config: BrowserAuthConfig): void {
  const names = browserCookieNames(config.secureCookies);
  res.clearCookie(names.oauth, { httpOnly: true, secure: config.secureCookies, sameSite: "lax", path: "/" });
}

function clearSessionCookies(res: Response, config: BrowserAuthConfig): void {
  const names = browserCookieNames(config.secureCookies);
  res.clearCookie(names.session, { httpOnly: true, secure: config.secureCookies, sameSite: "lax", path: "/" });
}

function redirectAuthFailure(res: Response, config: BrowserAuthConfig, code: string): void {
  const url = new URL(config.frontendOrigin);
  url.searchParams.set("auth", code);
  res.redirect(302, url.toString());
}

function operatorPrivilegeIsConsistent(roles: readonly string[], scopes: readonly string[]): boolean {
  const permitted = new Set<string>();
  for (const role of roles) {
    const ceiling = ROLE_SCOPE_CEILING[role as keyof typeof ROLE_SCOPE_CEILING];
    if (!ceiling) return false;
    for (const scope of ceiling) permitted.add(scope);
  }
  return scopes.every((scope) => permitted.has(scope));
}

export function createBrowserAuthRouter(deps: BrowserAuthRouterDeps): Router {
  const router = Router();
  const loadConfig = deps.loadConfig ?? loadBrowserAuthConfig;
  const fetchImpl = deps.fetchImpl ?? fetch;

  router.get("/status", (_req, res) => {
    res.status(200).json({ configured: browserAuthAppearsConfigured() });
  });

  router.get("/login", async (req, res, next) => {
    try {
      const config = loadConfig();
      const names = browserCookieNames(config.secureCookies);
      const transactionSecret = randomOpaqueSecret();
      const state = randomOpaqueSecret();
      const nonce = randomOpaqueSecret();
      const codeVerifier = randomOpaqueSecret(48);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + config.oauthTransactionTtlSeconds * 1000);

      await deps.browserAuthStore.createLoginTransaction({
        transactionHash: sha256Base64Url(transactionSecret),
        stateHash: sha256Base64Url(state),
        nonce,
        codeVerifier,
        returnPath: safeRelativeReturnPath(req.query.returnTo),
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      res.cookie(names.oauth, transactionSecret, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: config.oauthTransactionTtlSeconds * 1000,
      });

      const url = new URL(`${config.cognitoDomain}/login`);
      url.searchParams.set("client_id", config.appClientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email");
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      res.redirect(302, url.toString());
    } catch (err) {
      next(err);
    }
  });

  router.get("/callback", async (req, res, next) => {
    let config: BrowserAuthConfig;
    try {
      config = loadConfig();
    } catch (err) {
      next(err);
      return;
    }

    try {
      const names = browserCookieNames(config.secureCookies);
      const cookies = parseCookies(req.header("cookie"));
      const transactionSecret = cookies[names.oauth];
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;

      if (!transactionSecret || !code || !state || typeof req.query.error === "string") {
        clearOAuthCookie(res, config);
        redirectAuthFailure(res, config, "failed");
        return;
      }

      const transaction = await deps.browserAuthStore.consumeLoginTransaction(sha256Base64Url(transactionSecret));
      clearOAuthCookie(res, config);
      if (!transaction || !safeEqualText(transaction.stateHash, sha256Base64Url(state))) {
        await deps.auditSink.record({ eventType: "auth.failure", occurredAt: new Date().toISOString(), reasonCode: "OAUTH_STATE_INVALID" });
        redirectAuthFailure(res, config, "failed");
        return;
      }

      const basicAuth = Buffer.from(`${config.appClientId}:${config.appClientSecret}`, "utf8").toString("base64");
      const tokenResponse = await fetchImpl(`${config.cognitoDomain}/oauth2/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basicAuth}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.appClientId,
          code,
          redirect_uri: config.redirectUri,
          code_verifier: transaction.codeVerifier,
        }).toString(),
      });
      if (!tokenResponse.ok) {
        await deps.auditSink.record({ eventType: "auth.failure", occurredAt: new Date().toISOString(), reasonCode: "OAUTH_TOKEN_EXCHANGE_FAILED" });
        redirectAuthFailure(res, config, "failed");
        return;
      }

      const tokenBody = (await tokenResponse.json()) as { id_token?: string };
      if (!tokenBody.id_token) {
        await deps.auditSink.record({ eventType: "auth.failure", occurredAt: new Date().toISOString(), reasonCode: "OAUTH_ID_TOKEN_MISSING" });
        redirectAuthFailure(res, config, "failed");
        return;
      }

      const claims = await deps.identityProvider.verifyToken(tokenBody.id_token);
      if (claims.rawClaims.nonce !== transaction.nonce) {
        await deps.auditSink.record({ eventType: "auth.failure", occurredAt: new Date().toISOString(), reasonCode: "OAUTH_NONCE_INVALID" });
        redirectAuthFailure(res, config, "failed");
        return;
      }

      let operator = await deps.operatorDirectory.findByCognitoSub(claims.subject);
      let selfActivatedPendingMfa = false;
      // An operator bootstrapped pending their first MFA'd login lands as
      // status='disabled', mfaEnrolled=false (bootstrapOperatorDb.ts) — never
      // the shape a for-cause disable produces (that always starts from an
      // operator who already had mfaEnrolled=true). On a pool with
      // MfaConfiguration=ON, MFA is mandatory for every sign-in and Cognito
      // enforces it itself; reaching this line at all means the ID token we
      // just verified could not have been issued without it. So this exact
      // login IS the MFA proof — no human/CLI step is needed to activate the
      // operator, here or for any future one.
      if (operator && operator.status === "disabled" && !operator.mfaEnrolled) {
        await deps.operatorDirectory.activatePendingOperator(operator.operatorId);
        operator = { ...operator, status: "active", mfaEnrolled: true, disabledAt: undefined, disabledReason: undefined };
        selfActivatedPendingMfa = true;
      }

      if (!operator || operator.status !== "active" || !operator.mfaEnrolled || !operatorPrivilegeIsConsistent(operator.roles, operator.scopes)) {
        await deps.auditSink.record({
          eventType: "auth.failure",
          occurredAt: new Date().toISOString(),
          operatorId: operator?.operatorId,
          reasonCode: !operator ? "OPERATOR_NOT_PROVISIONED" : operator.status !== "active" ? "OPERATOR_DISABLED" : !operator.mfaEnrolled ? "OPERATOR_MFA_REQUIRED" : "INSUFFICIENT_PRIVILEGE",
        });
        redirectAuthFailure(res, config, "forbidden");
        return;
      }

      const sessionSecret = randomOpaqueSecret();
      const csrfSecret = randomOpaqueSecret();
      const sessionId = randomUUID();
      const issuedAt = new Date();
      const maxExpiry = issuedAt.getTime() + config.browserSessionMaxSeconds * 1000;
      const expiresAt = new Date(Math.min(claims.expiresAt.getTime(), maxExpiry));
      if (expiresAt.getTime() <= issuedAt.getTime()) {
        redirectAuthFailure(res, config, "expired");
        return;
      }

      await deps.browserAuthStore.createSession({
        sessionId,
        sessionTokenHash: sha256Base64Url(sessionSecret),
        csrfToken: csrfSecret,
        operatorId: operator.operatorId,
        cognitoSub: operator.cognitoSub,
        cognitoTokenId: claims.tokenId,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ipAddress: remoteAddress(req),
        userAgent: req.header("user-agent") ?? undefined,
      });

      const maxAge = expiresAt.getTime() - issuedAt.getTime();
      res.cookie(names.session, sessionSecret, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge,
      });

      await deps.auditSink.record({
        eventType: "auth.success",
        occurredAt: issuedAt.toISOString(),
        operatorId: operator.operatorId,
        operatorSessionId: sessionId,
        route: req.originalUrl,
        method: req.method,
        detail: selfActivatedPendingMfa ? { selfActivatedPendingMfa: true } : undefined,
      });

      res.redirect(302, `${config.frontendOrigin}${transaction.returnPath}`);
    } catch (err) {
      clearSessionCookies(res, config);
      next(err);
    }
  });

  router.get("/cognito-logout", (_req, res, next) => {
    try {
      const config = loadConfig();
      clearSessionCookies(res, config);
      const url = new URL(`${config.cognitoDomain}/logout`);
      url.searchParams.set("client_id", config.appClientId);
      url.searchParams.set("logout_uri", config.frontendOrigin);
      res.redirect(302, url.toString());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
