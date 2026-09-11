import { Router, type ErrorRequestHandler } from "express";

import type { AuditSink } from "../../identity/auditSink.js";
import { ManagementAuthError, StepUpNotConfiguredError } from "../../identity/errors.js";
import type { IdentityProvider } from "../../identity/identityProvider.js";
import type { OperatorDirectory } from "../../identity/operatorDirectory.js";
import type { OperatorSessionStore } from "../../identity/sessionStore.js";
import { requireRole, requireScope, requireStepUp } from "../../middleware/authorize.js";
import { requireManagementApiAuth } from "../../middleware/requireManagementApiAuth.js";

export interface ManagementRouterDeps {
  identityProvider: IdentityProvider;
  operatorDirectory: OperatorDirectory;
  sessionStore: OperatorSessionStore;
  auditSink: AuditSink;
}

// 1A.2 route integration points. This is deliberately not the read-contract
// surface (/catalog, /tenants, ... — that is 1A.4's management API transport
// and read-only contract deliverable). These routes only prove the operator
// authentication/authorization/session seams end-to-end.
export function createManagementRouter(deps: ManagementRouterDeps): Router {
  const router = Router();
  const auth = requireManagementApiAuth(deps);

  router.use(auth);

  router.get("/whoami", (req, res) => {
    res.status(200).json({ operator: req.operatorContext });
  });

  router.post("/session/logout", async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      await deps.sessionStore.revoke(ctx.operatorSessionId, "operator-initiated logout");
      await deps.auditSink.record({
        eventType: "session.revoked",
        occurredAt: new Date().toISOString(),
        operatorId: ctx.operatorId,
        operatorSessionId: ctx.operatorSessionId,
        reasonCode: "OPERATOR_LOGOUT",
        route: req.originalUrl,
        method: req.method,
        correlationId: ctx.correlationId,
      });
      res.status(200).json({ status: "revoked" });
    } catch (err) {
      next(err);
    }
  });

  // Never persist caller-asserted step-up evidence. Real step-up must be
  // backed by a fresh Cognito MFA challenge before this route is enabled.
  router.post("/session/step-up", (_req, _res, next) => {
    next(new StepUpNotConfiguredError());
  });

  router.get("/audit/self-test", requireScope("audit.read", deps.auditSink), (req, res) => {
    res.status(200).json({ status: "ok", operatorId: req.operatorContext?.operatorId });
  });

  router.get(
    "/audit/self-test/step-up",
    requireStepUp(300, deps.sessionStore, deps.auditSink),
    requireRole("platform_admin", deps.auditSink),
    (req, res) => {
      res.status(200).json({ status: "ok", operatorId: req.operatorContext?.operatorId });
    },
  );

  // Express 4 does not auto-forward rejected async promises. Async handlers
  // above explicitly call next(err), and this router-local typed boundary
  // preserves fail-closed responses for failures after authentication.
  const managementErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
    if (!(err instanceof ManagementAuthError)) {
      next(err);
      return;
    }
    const ctx = req.operatorContext;
    void Promise.resolve(
      deps.auditSink.record({
        eventType: "authz.denied",
        occurredAt: new Date().toISOString(),
        operatorId: ctx?.operatorId,
        operatorSessionId: ctx?.operatorSessionId,
        reasonCode: err.code,
        route: req.originalUrl,
        method: req.method,
        correlationId: ctx?.correlationId,
      }),
    )
      .then(() => {
        res.status(err.httpStatus).json({
          error: err.code,
          message: err.message,
          correlationId: ctx?.correlationId,
        });
      })
      .catch(next);
  };
  router.use(managementErrorHandler);

  return router;
}
