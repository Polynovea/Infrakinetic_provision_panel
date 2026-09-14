import { Router, type ErrorRequestHandler } from "express";

import type { AuditSink } from "../../identity/auditSink.js";
import type { BrowserAuthStore } from "../../identity/browserAuthStore.js";
import { ManagementAuthError, StepUpNotConfiguredError } from "../../identity/errors.js";
import type { IdentityProvider } from "../../identity/identityProvider.js";
import type { OperatorDirectory } from "../../identity/operatorDirectory.js";
import type { OperatorSessionStore } from "../../identity/sessionStore.js";
import { requireRole, requireScope, requireStepUp } from "../../middleware/authorize.js";
import { requireBrowserCsrf } from "../../middleware/requireBrowserCsrf.js";
import { requireManagementApiAuth } from "../../middleware/requireManagementApiAuth.js";
import type { ManagementOperationLedger } from "../../management/operations/managementOperationLedger.js";
import type { ManagementSigningKeySet } from "../../management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../management/managementConfig.js";
import { DatabaseUnavailableError } from "../../db/errors.js";
import {
  requestEngineStateChange,
  recoverEngineState,
  UnknownEngineError,
  MissingRecoveryIntentError,
  UnexpectedManagementApiResponseError,
} from "../../management/operations/engineStateOperation.js";
import { ManagementOperationError, OperationNotFoundError } from "../../management/operations/managementOperationErrors.js";
import { listTenantRegistry, getTenantRegistryEntry, UnknownTenantError } from "../../management/operations/tenantRegistryQuery.js";

export interface ManagementRouterDeps {
  identityProvider: IdentityProvider;
  operatorDirectory: OperatorDirectory;
  sessionStore: OperatorSessionStore;
  auditSink: AuditSink;
  browserAuthStore?: BrowserAuthStore;
  // 1A.6 — the real engine-state mutation vertical. getManagementSigningKeys
  // and loadTransportConfig are injected as functions (not resolved values)
  // so server boot never requires GOVERNANCE_MANAGEMENT_* to be set — only
  // an actual PUT to this route does, matching every other lazy dependency
  // in this backend.
  ledger: ManagementOperationLedger;
  getManagementSigningKeys: () => Promise<ManagementSigningKeySet>;
  loadTransportConfig: () => ManagementTransportConfig;
  infrakineticBaseUrl: string;
}

// 1A.2 route integration points (whoami/session/audit) prove the operator
// authentication/authorization/session seams end-to-end. /tenants and
// /tenants/:identifier (1A.7) and /engine-state/:engineKey (1A.6) are the
// real operator-facing verticals built on top of that seam.
export function createManagementRouter(deps: ManagementRouterDeps): Router {
  const router = Router();
  const auth = requireManagementApiAuth(deps);

  router.use(auth);
  router.use(requireBrowserCsrf());

  router.get("/whoami", (req, res) => {
    res.status(200).json({
      operator: req.operatorContext,
      csrfToken: req.operatorAuthMethod === "browser-session" ? req.browserSessionCsrfToken : undefined,
    });
  });

  router.post("/session/logout", async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      if (req.operatorAuthMethod === "browser-session" && deps.browserAuthStore) {
        await deps.browserAuthStore.revokeSession(ctx.operatorSessionId, "operator-initiated logout");
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
      res.clearCookie("__Host-governance_session", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
      res.clearCookie("__Host-governance_csrf", { httpOnly: false, secure: true, sameSite: "lax", path: "/" });
      res.clearCookie("governance_session", { httpOnly: true, secure: false, sameSite: "lax", path: "/" });
      res.clearCookie("governance_csrf", { httpOnly: false, secure: false, sameSite: "lax", path: "/" });
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

  // 1A.7 — tenant registry, read-only (R0, no ledger — see
  // tenantRegistryQuery.ts's header for why). tenants.read already existed,
  // unused, in the 1A.2 scope catalog; no new scope was introduced.
  router.get("/tenants", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listTenantRegistry(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/tenants/:identifier", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getTenantRegistryEntry(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          identifier: req.params.identifier,
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownTenantError) {
        res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
        return;
      }
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  // 1A.6 — the real vertical. requireStepUp is deliberately NOT used here:
  // authorize.ts's own header calls it a skeleton and explicitly warns "R3+
  // actions must not be wired to only this check until the real challenge
  // exists" — wiring an R4 action to a fake step-up would be worse than not
  // gating on step-up at all (false assurance). engines.platform_state.write
  // is granted only to platform_admin/break_glass by ROLE_SCOPE_CEILING
  // (roles.ts), which is the real control this phase relies on; R3/R4
  // maker-checker remains 1A.19's deliverable (1A.5's own approval_evidence
  // column exists precisely so that can be added later without a schema
  // change).
  router.put(
    "/engine-state/:engineKey",
    requireScope("engines.platform_state.write", deps.auditSink),
    async (req, res, next) => {
      try {
        const ctx = req.operatorContext;
        if (!ctx) {
          res.status(403).json({ error: "NOT_AUTHENTICATED" });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
          res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
          return;
        }
        if (typeof body.reason !== "string" || body.reason.trim() === "") {
          res.status(400).json({ error: "REASON_REQUIRED" });
          return;
        }
        const desiredState = body.desiredState;
        if (desiredState !== "operational" && desiredState !== "degraded" && desiredState !== "disabled") {
          res.status(400).json({ error: "INVALID_DESIRED_STATE" });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await requestEngineStateChange(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            engineKeyOrAlias: req.params.engineKey,
            desiredState,
            reason: body.reason,
            metadata: typeof body.metadata === "object" && body.metadata !== null ? (body.metadata as Record<string, unknown>) : undefined,
            recoveryIntent: typeof body.recoveryIntent === "string" ? body.recoveryIntent : undefined,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (err instanceof UnknownEngineError) {
          res.status(404).json({ error: "UNKNOWN_ENGINE", message: err.message });
          return;
        }
        if (err instanceof MissingRecoveryIntentError) {
          res.status(400).json({ error: "RECOVERY_INTENT_REQUIRED", message: err.message });
          return;
        }
        if (err instanceof UnexpectedManagementApiResponseError) {
          res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
          return;
        }
        if (err instanceof ManagementOperationError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        if (err instanceof DatabaseUnavailableError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  router.get("/operations/:operationId", requireScope("engines.read", deps.auditSink), async (req, res, next) => {
    try {
      const operation = await deps.ledger.getOperation(req.params.operationId);
      res.status(200).json({ operation });
    } catch (err) {
      if (err instanceof OperationNotFoundError) {
        res.status(404).json({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  router.post(
    "/operations/:operationId/recover",
    requireScope("engines.platform_state.write", deps.auditSink),
    async (req, res, next) => {
      try {
        const ctx = req.operatorContext;
        if (!ctx) {
          res.status(403).json({ error: "NOT_AUTHENTICATED" });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
          res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
          return;
        }
        if (typeof body.reason !== "string" || body.reason.trim() === "") {
          res.status(400).json({ error: "REASON_REQUIRED" });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await recoverEngineState(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          deps.ledger,
          {
            originalOperationId: req.params.operationId,
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            reason: body.reason,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (err instanceof OperationNotFoundError) {
          res.status(404).json({ error: err.code, message: err.message });
          return;
        }
        if (err instanceof ManagementOperationError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        if (err instanceof DatabaseUnavailableError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      }
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
