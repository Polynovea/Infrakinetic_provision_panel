import { Router } from "express";

import type { AuditSink } from "../../identity/auditSink.js";
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
// surface (/catalog, /tenants, ... — that is 1A.4's "management API
// transport and read-only contract" deliverable). These three routes exist
// only to prove requireManagementApiAuth/authorize.ts are correctly wired
// into a real Express router end-to-end:
//   - GET  /whoami        any authenticated operator, no extra scope
//   - POST /session/logout any authenticated operator revokes their own session
//   - POST /session/step-up  skeleton step-up marker (see authorize.ts)
//   - GET  /audit/self-test  requires audit.read scope, demonstrates
//                            requireScope() denying/allowing
// Deny-by-default is structural here: requireManagementApiAuth is mounted
// on the whole router below, and every route additionally declares its own
// requirement — there is no bare, unrestricted route on this router.
export function createManagementRouter(deps: ManagementRouterDeps): Router {
  const router = Router();
  const auth = requireManagementApiAuth(deps);

  router.use(auth);

  router.get("/whoami", (req, res) => {
    res.status(200).json({ operator: req.operatorContext });
  });

  router.post("/session/logout", async (req, res) => {
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
  });

  // Skeleton only — accepts a caller-asserted step-up completion. A real
  // implementation must verify a fresh Cognito MFA/step-up challenge before
  // calling sessionStore.recordStepUp; wiring that is pending live Cognito
  // provisioning (see docs/1A.2_status.md).
  router.post("/session/step-up", async (req, res) => {
    const ctx = req.operatorContext;
    if (!ctx) {
      res.status(403).json({ error: "NOT_AUTHENTICATED" });
      return;
    }
    const state = { verifiedAt: new Date().toISOString(), method: "skeleton-unverified" };
    await deps.sessionStore.recordStepUp(ctx.operatorSessionId, state);
    await deps.auditSink.record({
      eventType: "session.step_up_recorded",
      occurredAt: state.verifiedAt,
      operatorId: ctx.operatorId,
      operatorSessionId: ctx.operatorSessionId,
      route: req.originalUrl,
      method: req.method,
      correlationId: ctx.correlationId,
    });
    res.status(200).json({ status: "step_up_recorded", stepUp: state });
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

  return router;
}
