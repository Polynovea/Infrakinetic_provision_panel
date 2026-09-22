import { randomUUID } from "node:crypto";
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
  ManagementApiUnreachableError,
} from "../../management/operations/engineStateOperation.js";
import { ManagementOperationError, OperationNotFoundError } from "../../management/operations/managementOperationErrors.js";
import { listTenantRegistry, getTenantRegistryEntry, getTenantRegistryUsers, UnknownTenantError } from "../../management/operations/tenantRegistryQuery.js";
import { listEngineCatalog } from "../../management/operations/engineCatalogQuery.js";
import { isOperationStatus, type OperationStatus } from "../../management/operations/lifecycle.js";
import {
  requestTenantCommission,
  requestTenantSuspend,
  requestTenantResume,
  requestTenantDecommission,
  MissingTenantIdentifierError,
} from "../../management/operations/tenantLifecycleOperation.js";
import type { CommissionedTenantsRepository } from "../../management/operations/commissionedTenants.js";
import {
  requestTenantEngineEntitlementChange,
  UnknownEntitlementEngineError,
  UnknownEntitlementTenantError,
  MissingEntitlementTenantIdentifierError,
} from "../../management/operations/tenantEngineEntitlementOperation.js";
import {
  getTenantEngineEntitlementRead,
  listTenantEngineEntitlements,
} from "../../management/operations/tenantEngineEntitlementQuery.js";
import { listDrift } from "../../management/operations/reconciliationQuery.js";
import { reconcileTenant } from "../../management/operations/reconciliationOperation.js";
import {
  listTenantIdentities,
  getIdentityDetail,
  getIdentityHistory,
  UnknownIdentityError,
} from "../../management/operations/identityQuery.js";
import {
  requestIdentityInvitation,
  requestIdentityInvitationResend,
  requestIdentityInvitationCancel,
  requestIdentityRecovery,
  requestIdentitySuspend,
  requestIdentityRestore,
  requestIdentityGlobalSignout,
  requestIdentitySessionsRevoke,
  MissingIdentityTargetError,
} from "../../management/operations/identityOperation.js";

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
  // 1A.8.4 — the desired-tenant-lifecycle projection (governance.
  // commissioned_tenants), read/written by the commission/suspend/resume/
  // decommission routes below.
  commissionedTenants: CommissionedTenantsRepository;
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

  // Tenant-user inventory, read-only (same R0/no-ledger reasoning as the
  // registry routes above). Governance never reads app_users directly —
  // this goes through Infrakinetic's own Management API contract only,
  // same as every other tenant-registry read.
  router.get("/tenants/:identifier/users", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getTenantRegistryUsers(
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

  // 1A.1–1A.7 closure pass — the engine catalog + per-engine platform state,
  // read-only (R0, same reasoning as the /tenants routes above). This is
  // what lets the Platform page show a real engine list instead of asking
  // the operator to type a raw engine key by hand.
  router.get("/engines", requireScope("engines.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listEngineCatalog(
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
      next(err);
    }
  });

  // 1A.1–1A.7 closure pass — bounded, newest-first read of the 1A.5 ledger.
  // Powers the Overview dashboard's "recent privileged operations" feed.
  // Purely a Governance-DB read (no Infrakinetic call, no assertion minted)
  // — same scope as the existing single-operation GET below, for
  // consistency; no new scope invented.
  router.get("/operations", requireScope("engines.read", deps.auditSink), async (req, res, next) => {
    try {
      const rawLimit = req.query.limit;
      let limit: number | undefined;
      if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed) || parsed < 1) {
          res.status(400).json({ error: "INVALID_LIMIT" });
          return;
        }
        limit = parsed;
      }

      const rawStatus = req.query.status;
      let status: OperationStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus.trim() !== "") {
        if (!isOperationStatus(rawStatus)) {
          res.status(400).json({ error: "INVALID_STATUS" });
          return;
        }
        status = rawStatus;
      }

      const action = typeof req.query.action === "string" && req.query.action.trim() !== "" ? req.query.action : undefined;
      const tenantId = typeof req.query.tenantId === "string" && req.query.tenantId.trim() !== "" ? req.query.tenantId : undefined;
      const engineKey = typeof req.query.engineKey === "string" && req.query.engineKey.trim() !== "" ? req.query.engineKey : undefined;

      const operations = await deps.ledger.listOperations({
        limit,
        status,
        requestedAction: action,
        targetTenantId: tenantId,
        targetEngine: engineKey,
      });

      res.status(200).json({
        operations: operations.map((op) => ({
          operationId: op.operationId,
          requestedAction: op.requestedAction,
          targetTenantId: op.targetTenantId,
          targetEngine: op.targetEngine,
          riskClass: op.riskClass,
          status: op.status,
          reason: op.reason,
          correlationId: op.correlationId,
          requestedAt: op.requestedAt,
          acceptedAt: op.acceptedAt,
          completedAt: op.completedAt,
          failedAt: op.failedAt,
        })),
      });
    } catch (err) {
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
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) {
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

  // 1A.8.4 — the real tenant-commissioning vertical, mirroring the engine-
  // state vertical's own shape above (requireScope, R2 reason requirement,
  // idempotencyKey requirement, ManagementOperationError/DatabaseUnavailableError
  // mapping). commissionRequestId is Governance-generated here (not
  // caller-supplied) — the operator's browser has no legitimate reason to
  // mint its own commission identity.
  router.post(
    "/tenants/commission",
    requireScope("tenants.commission", deps.auditSink),
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
        if (typeof body.name !== "string" || body.name.trim() === "") {
          res.status(400).json({ error: "NAME_REQUIRED" });
          return;
        }
        if (typeof body.plan !== "string" || body.plan.trim() === "") {
          res.status(400).json({ error: "PLAN_REQUIRED" });
          return;
        }
        if (body.accountType !== "demo" && body.accountType !== "live") {
          res.status(400).json({ error: "INVALID_ACCOUNT_TYPE" });
          return;
        }
        const sendInvite = body.sendInvite !== false;
        const initialAdmin = body.initialAdmin as { name?: string; email?: string } | undefined;
        if (sendInvite && (!initialAdmin?.name || !initialAdmin?.email)) {
          res.status(400).json({ error: "INITIAL_ADMIN_REQUIRED" });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await requestTenantCommission(
          { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            commissionRequestId: randomUUID(),
            name: body.name,
            slug: typeof body.slug === "string" ? body.slug : undefined,
            plan: body.plan,
            industry: typeof body.industry === "string" ? body.industry : undefined,
            country: typeof body.country === "string" ? body.country : undefined,
            timezone: typeof body.timezone === "string" ? body.timezone : undefined,
            accountType: body.accountType,
            trialDays: typeof body.trialDays === "number" ? body.trialDays : undefined,
            initialAdmin: sendInvite || initialAdmin ? (initialAdmin as { name: string; email: string }) : undefined,
            sendInvite,
            reason: body.reason,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
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

  const TENANT_TRANSITION_ROUTES = [
    { segment: "suspend", scope: "tenants.suspend", fn: requestTenantSuspend },
    { segment: "resume", scope: "tenants.resume", fn: requestTenantResume },
    { segment: "decommission", scope: "tenants.decommission", fn: requestTenantDecommission },
  ] as const;

  for (const { segment, scope, fn } of TENANT_TRANSITION_ROUTES) {
    router.post(
      `/tenants/:tenantId/${segment}`,
      requireScope(scope, deps.auditSink),
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

          const result = await fn(
            { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
            {
              idempotencyKey: body.idempotencyKey,
              operatorId: ctx.operatorId,
              operatorSessionId: ctx.operatorSessionId,
              operatorRoles: ctx.roles,
              operatorGrantedScopes: ctx.scopes,
              tenantId: req.params.tenantId,
              reason: body.reason,
              correlationId: ctx.correlationId,
            },
          );
          res.status(200).json({ operation: result.operation, replay: result.replay });
        } catch (err) {
          if (err instanceof MissingTenantIdentifierError) {
            res.status(400).json({ error: "TENANT_ID_REQUIRED", message: err.message });
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
  }

  // 1A.9.4 — engine entitlement lifecycle, read half (R0, no ledger — same
  // reasoning as /tenants and /engines above). tenants.read already existed,
  // unused for this purpose, in the 1A.2 scope catalog; no new scope was
  // introduced for the reads.
  router.get("/tenants/:tenantId/engines/:engineKey/entitlement", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getTenantEngineEntitlementRead(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          tenantId: req.params.tenantId,
          engineKeyOrAlias: req.params.engineKey,
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownEntitlementTenantError) {
        res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
        return;
      }
      if (err instanceof UnknownEntitlementEngineError) {
        res.status(404).json({ error: "UNKNOWN_ENGINE", message: err.message });
        return;
      }
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/tenants/:tenantId/engines", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listTenantEngineEntitlements(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          tenantId: req.params.tenantId,
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownEntitlementTenantError) {
        res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
        return;
      }
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      next(err);
    }
  });

  // 1A.9.4 — the real mutation vertical, mirroring the engine-state and
  // tenant-lifecycle verticals' own shape (requireScope, R2 reason
  // requirement, idempotencyKey requirement, ManagementOperationError/
  // DatabaseUnavailableError mapping). Uniformly R2 (§3.2 of the scoping
  // doc) — no step-up/maker-checker gate, same bar as tenant suspend/
  // resume/decommission.
  router.put(
    "/tenants/:tenantId/engines/:engineKey/entitlement",
    requireScope("engines.entitlement.write", deps.auditSink),
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
        if (typeof body.enabled !== "boolean") {
          res.status(400).json({ error: "INVALID_ENABLED" });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await requestTenantEngineEntitlementChange(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            tenantId: req.params.tenantId,
            engineKeyOrAlias: req.params.engineKey,
            enabled: body.enabled,
            reason: body.reason,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (err instanceof MissingEntitlementTenantIdentifierError) {
          res.status(400).json({ error: "TENANT_ID_REQUIRED", message: err.message });
          return;
        }
        if (err instanceof UnknownEntitlementTenantError) {
          res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
          return;
        }
        if (err instanceof UnknownEntitlementEngineError) {
          res.status(404).json({ error: "UNKNOWN_ENGINE", message: err.message });
          return;
        }
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) {
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

  // 1A.10.5 — reconciliation drift read (R0). runtime.read already existed,
  // unused, in the 1A.2 scope catalog. Optional ?tenantId narrows every
  // drift class to one real tenant, same shape as /operations' own optional
  // filters above.
  router.get("/reconciliation/drift", requireScope("runtime.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const tenantId = typeof req.query.tenantId === "string" && req.query.tenantId.trim() !== "" ? req.query.tenantId : undefined;
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listDrift(
        { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
          tenantId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownTenantError) {
        res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
        return;
      }
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  // 1A.10.5 — the reconciliation repair vertical. R1 (§3.9 of the scoping
  // doc — low-impact metadata, no reason required): every repair here
  // either writes Governance's own projection from a fresh owner read or
  // resolves a stuck ledger operation from a durable owner-side receipt —
  // it never mutates owner state and never resends the original mutation.
  // runtime.repair.request already existed, unused, in the 1A.2 scope
  // catalog.
  router.post(
    "/reconciliation/tenants/:tenantId/recheck",
    requireScope("runtime.repair.request", deps.auditSink),
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

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await reconcileTenant(
          { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            tenantId: req.params.tenantId,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json(result);
      } catch (err) {
        if (err instanceof UnknownTenantError) {
          res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
          return;
        }
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) {
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

  // ───────────────────────────────────────────────────────────────────────
  // 1A.12 — identity administration. Reads (R0, no ledger, same reasoning
  // as /tenants above) plus the routine (R2) invitation/recovery/access-
  // lifecycle commands. R3 actions (force-reset, mfa.reset) are a separate
  // vertical (identityApprovalOperation.ts, 1A.12.5) requiring step-up and
  // maker-checker approval — not wired here.
  // ───────────────────────────────────────────────────────────────────────

  router.get("/tenants/:tenantId/identities", requireScope("identity.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listTenantIdentities(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  router.get("/tenants/:tenantId/identities/:userId", requireScope("identity.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getIdentityDetail(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, userId: req.params.userId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownIdentityError) { res.status(404).json({ error: "IDENTITY_NOT_FOUND", message: err.message }); return; }
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  router.get("/tenants/:tenantId/identities/:userId/history", requireScope("identity.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getIdentityHistory(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, userId: req.params.userId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownIdentityError) { res.status(404).json({ error: "IDENTITY_NOT_FOUND", message: err.message }); return; }
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  function identityOperationErrorResponse(err: unknown, res: import("express").Response): boolean {
    if (err instanceof MissingIdentityTargetError) { res.status(400).json({ error: "IDENTITY_TARGET_REQUIRED", message: err.message }); return true; }
    if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return true; }
    return false;
  }

  router.post("/tenants/:tenantId/identity-invitations", requireScope("identity.recovery", deps.auditSink), async (req, res, next) => {
    const ctx = req.operatorContext;
    try {
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") { res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" }); return; }
      if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return; }
      if (typeof body.email !== "string" || body.email.trim() === "") { res.status(400).json({ error: "EMAIL_REQUIRED" }); return; }

      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await requestIdentityInvitation(
        { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          idempotencyKey: body.idempotencyKey, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, tenantId: req.params.tenantId,
          invitationRequestId: randomUUID(), email: body.email,
          fullName: typeof body.fullName === "string" ? body.fullName : undefined,
          roleKey: typeof body.roleKey === "string" ? body.roleKey : undefined,
          reason: body.reason, correlationId: ctx.correlationId,
        },
      );
      res.status(200).json({ operation: result.operation, replay: result.replay });
    } catch (err) {
      if (identityOperationErrorResponse(err, res)) return;
      if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof ManagementOperationError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  const IDENTITY_INVITATION_ACTIONS = [
    { segment: "resend", fn: requestIdentityInvitationResend },
    { segment: "cancel", fn: requestIdentityInvitationCancel },
  ] as const;

  for (const { segment, fn } of IDENTITY_INVITATION_ACTIONS) {
    router.post(`/tenants/:tenantId/identity-invitations/:invitationId/${segment}`, requireScope("identity.recovery", deps.auditSink), async (req, res, next) => {
      const ctx = req.operatorContext;
      try {
        if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") { res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" }); return; }
        if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return; }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();
        const result = await fn(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, tenantId: req.params.tenantId,
            invitationId: req.params.invitationId, reason: body.reason, correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (identityOperationErrorResponse(err, res)) return;
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
        if (err instanceof ManagementOperationError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
        next(err);
      }
    });
  }

  const IDENTITY_USER_ACTIONS = [
    { segment: "recovery", scope: "identity.recovery", fn: requestIdentityRecovery },
    { segment: "suspend", scope: "identity.disable", fn: requestIdentitySuspend },
    { segment: "restore", scope: "identity.disable", fn: requestIdentityRestore },
    { segment: "global-signout", scope: "identity.disable", fn: requestIdentityGlobalSignout },
    { segment: "sessions/revoke", scope: "identity.disable", fn: requestIdentitySessionsRevoke },
  ] as const;

  for (const { segment, scope, fn } of IDENTITY_USER_ACTIONS) {
    router.post(`/tenants/:tenantId/identities/:userId/${segment}`, requireScope(scope, deps.auditSink), async (req, res, next) => {
      const ctx = req.operatorContext;
      try {
        if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") { res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" }); return; }
        if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return; }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();
        const result = await fn(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, tenantId: req.params.tenantId,
            userId: req.params.userId, reason: body.reason, correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (identityOperationErrorResponse(err, res)) return;
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
        if (err instanceof ManagementOperationError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
        next(err);
      }
    });
  }

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
