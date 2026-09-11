import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AuditSink } from "../identity/auditSink.js";
import { MissingRoleError, MissingScopeError, StepUpRequiredError } from "../identity/errors.js";
import type { Role, Scope } from "../identity/roles.js";
import type { OperatorSessionStore } from "../identity/sessionStore.js";

// Authorization middleware — separate module from requireManagementApiAuth
// on purpose (§69 invariant: authn and authz stay explicitly separate).
// Every function here assumes requireManagementApiAuth has already run and
// populated req.operatorContext; if it hasn't, these fail closed (403), they
// never treat a missing context as "no restrictions apply".

function operatorContextOrDeny(req: Request, res: Response): Request["operatorContext"] {
  if (!req.operatorContext) {
    res.status(403).json({
      error: "NOT_AUTHENTICATED",
      message: "requireManagementApiAuth must run before authorization checks.",
    });
    return undefined;
  }
  return req.operatorContext;
}

async function deny(
  auditSink: AuditSink,
  req: Request,
  res: Response,
  err: MissingRoleError | MissingScopeError | StepUpRequiredError,
): Promise<void> {
  await auditSink.record({
    eventType: "authz.denied",
    occurredAt: new Date().toISOString(),
    operatorId: req.operatorContext?.operatorId,
    operatorSessionId: req.operatorContext?.operatorSessionId,
    reasonCode: err.code,
    route: req.originalUrl,
    method: req.method,
    correlationId: req.operatorContext?.correlationId,
  });
  res.status(err.httpStatus).json({
    error: err.code,
    message: err.message,
    correlationId: req.operatorContext?.correlationId,
  });
}

export function requireRole(role: Role, auditSink: AuditSink): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ctx = operatorContextOrDeny(req, res);
    if (!ctx) return;
    if (!ctx.roles.includes(role)) {
      try {
        await deny(auditSink, req, res, new MissingRoleError(role));
      } catch (err) {
        next(err);
      }
      return;
    }
    next();
  };
}

export function requireScope(scope: Scope, auditSink: AuditSink): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ctx = operatorContextOrDeny(req, res);
    if (!ctx) return;
    if (!ctx.scopes.includes(scope)) {
      try {
        await deny(auditSink, req, res, new MissingScopeError(scope));
      } catch (err) {
        next(err);
      }
      return;
    }
    next();
  };
}

// Step-up *skeleton* only (1A.2 exit criterion). This checks freshness of a
// step-up marker recorded via POST /management/v1/session/step-up. It does
// not implement a real MFA re-challenge — Cognito adaptive/step-up
// authentication is pending live provisioning. R3+ actions (§20) must not
// be wired to only this check until the real challenge exists.
export function requireStepUp(maxAgeSeconds: number, sessionStore: OperatorSessionStore, auditSink: AuditSink): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = operatorContextOrDeny(req, res);
      if (!ctx) return;
      const stepUp = await sessionStore.getStepUp(ctx.operatorSessionId);
      const ageSeconds = stepUp ? (Date.now() - Date.parse(stepUp.verifiedAt)) / 1000 : Infinity;
      if (!stepUp || stepUp.method === "skeleton-unverified" || ageSeconds > maxAgeSeconds) {
        await deny(auditSink, req, res, new StepUpRequiredError());
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
