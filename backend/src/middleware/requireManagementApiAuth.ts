import { randomUUID } from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AuditSink } from "../identity/auditSink.js";
import {
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
import type { OperatorContext } from "../identity/types.js";

export interface ManagementAuthDeps {
  identityProvider: IdentityProvider;
  operatorDirectory: OperatorDirectory;
  sessionStore: OperatorSessionStore;
  auditSink: AuditSink;
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
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
      if (!rawToken) {
        await fail(new MissingTokenError());
        return;
      }

      const claims = await deps.identityProvider.verifyToken(rawToken);

      const operator = await deps.operatorDirectory.findByCognitoSub(claims.subject);
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

      const operatorSessionId = claims.tokenId;
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
