import { randomUUID } from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AuditSink } from "../identity/auditSink.js";
import { isOperatorBearerAuthEnabled } from "../identity/bearerAuthPolicy.js";
import { sha256Base64Url } from "../identity/browserAuthCrypto.js";
import type { BrowserAuthStore } from "../identity/browserAuthStore.js";
import { parseCookies, sessionCookieCandidates } from "../identity/browserCookies.js";
import {
  BearerAuthDisabledError,
  ManagementAuthError,
  MissingTokenError,
  OperatorDisabledError,
  OperatorMfaRequiredError,
  OperatorNotProvisionedError,
  SessionRevokedError,
  InsufficientPrivilegeError,
} from "../identity/errors.js";
import type { IdentityProvider } from "../identity/identityProvider.js";
import type { OperatorDirectory } from "../identity/operatorDirectory.js";
import { ROLE_SCOPE_CEILING } from "../identity/roles.js";
import type { OperatorSessionStore } from "../identity/sessionStore.js";
import type { OperatorRecord } from "../identity/types.js";
import type { OperatorContext } from "../identity/types.js";

export interface ManagementAuthDeps {
  identityProvider: IdentityProvider;
  operatorDirectory: OperatorDirectory;
  sessionStore: OperatorSessionStore;
  auditSink: AuditSink;
  browserAuthStore?: BrowserAuthStore;
  /**
   * L8 — whether raw operator bearer tokens are accepted. Defaults to
   * isOperatorBearerAuthEnabled(process.env): on outside production, off in
   * production unless explicitly enabled for non-browser tooling.
   */
  bearerAuthEnabled?: boolean;
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function extractBrowserSessionToken(req: Request): string | undefined {
  const cookies = parseCookies(req.header("cookie"));
  for (const name of sessionCookieCandidates(process.env.NODE_ENV === "production")) {
    const value = cookies[name];
    if (value) return value;
  }
  return undefined;
}

function resolveCorrelationId(req: Request): string {
  const header = req.header("x-correlation-id");
  return header && header.trim() !== "" ? header.trim() : randomUUID();
}

/**
 * Authentication only. Verifies the Cognito-issued operator token, resolves
 * the governance-owned operator record, checks operator/session state, and
 * attaches `req.operatorContext`. Deliberately does not check role/scope
 * requirements for the target route — see middleware/authorize.ts for that.
 * This split is a direct §69 invariant: authentication and authorization
 * are kept explicitly separate so each can be reasoned about (and tested)
 * independently.
 *
 * Deny-by-default: any thrown ManagementAuthError short-circuits the
 * request with no fallback "allow" path. A route that forgets to mount
 * this middleware gets no operatorContext and therefore no legitimate way
 * through authorize.ts either — there is no default-allow branch anywhere
 * in this file.
 */
export function requireManagementApiAuth(deps: ManagementAuthDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = resolveCorrelationId(req);
    const route = req.originalUrl;
    const method = req.method;

    const fail = async (err: ManagementAuthError, operatorId?: string, operatorSessionId?: string) => {
      await deps.auditSink.record({
        eventType: "auth.failure",
        occurredAt: new Date().toISOString(),
        operatorId,
        operatorSessionId,
        reasonCode: err.code,
        route,
        method,
        correlationId,
      });
      res.status(err.httpStatus).json({ error: err.code, message: err.message, correlationId });
    };

    try {
      const rawToken = extractBearerToken(req);
      let operator: OperatorRecord | undefined;
      let operatorSessionId: string;

      if (rawToken) {
        // Rejected outright rather than silently falling through to the
        // cookie: a caller presenting a bearer token gets a clear, audited
        // refusal instead of an ambiguous identity.
        if (!(deps.bearerAuthEnabled ?? isOperatorBearerAuthEnabled())) {
          await fail(new BearerAuthDisabledError());
          return;
        }
        const claims = await deps.identityProvider.verifyToken(rawToken);
        operator = await deps.operatorDirectory.findByCognitoSub(claims.subject);
        operatorSessionId = claims.tokenId;
        req.operatorAuthMethod = "bearer";
      } else {
        const browserToken = extractBrowserSessionToken(req);
        if (!browserToken || !deps.browserAuthStore) {
          await fail(new MissingTokenError());
          return;
        }

        const browserSession = await deps.browserAuthStore.findSessionByTokenHash(sha256Base64Url(browserToken));
        if (!browserSession) {
          await fail(new SessionRevokedError());
          return;
        }

        operator = await deps.operatorDirectory.findByCognitoSub(browserSession.cognitoSub);
        if (operator && operator.operatorId !== browserSession.operatorId) {
          await fail(new InsufficientPrivilegeError("browser session operator binding does not match the operator directory"));
          return;
        }

        operatorSessionId = browserSession.sessionId;
        req.operatorAuthMethod = "browser-session";
        req.browserSessionCsrfToken = browserSession.csrfToken;
      }

      if (!operator) {
        await fail(new OperatorNotProvisionedError());
        return;
      }

      if (operator.status !== "active") {
        await fail(new OperatorDisabledError(operator.status), operator.operatorId);
        return;
      }

      if (!operator.mfaEnrolled) {
        await fail(new OperatorMfaRequiredError(), operator.operatorId);
        return;
      }

      if (await deps.sessionStore.isRevoked(operatorSessionId)) {
        await fail(new SessionRevokedError(), operator.operatorId, operatorSessionId);
        return;
      }

      // Defense in depth: an operator record must never carry a scope its
      // roles don't permit, even though the directory is governance-owned
      // and not attacker-controlled. Catches config/migration mistakes
      // before they become a live privilege escalation.
      const permittedScopes = new Set(operator.roles.flatMap((role) => ROLE_SCOPE_CEILING[role]));
      const excessScope = operator.scopes.find((scope) => !permittedScopes.has(scope));
      if (excessScope) {
        await fail(
          new InsufficientPrivilegeError(`scope '${excessScope}' is not permitted by roles [${operator.roles.join(", ")}]`),
          operator.operatorId,
          operatorSessionId,
        );
        return;
      }

      const operatorContext: OperatorContext = {
        operatorId: operator.operatorId,
        cognitoSub: operator.cognitoSub,
        operatorSessionId,
        email: operator.email,
        roles: operator.roles,
        scopes: operator.scopes,
        correlationId,
        authenticatedAt: new Date().toISOString(),
      };
      req.operatorContext = operatorContext;

      await deps.auditSink.record({
        eventType: "auth.success",
        occurredAt: operatorContext.authenticatedAt,
        operatorId: operator.operatorId,
        operatorSessionId,
        route,
        method,
        correlationId,
      });

      next();
    } catch (err) {
      if (err instanceof ManagementAuthError) {
        await fail(err);
        return;
      }
      next(err);
    }
  };
}
