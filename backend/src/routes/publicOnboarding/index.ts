import { Router, type ErrorRequestHandler } from "express";

import type { AuditSink } from "../../identity/auditSink.js";
import { requirePublicOnboardingServiceAuth, PUBLIC_ONBOARDING_SYSTEM_OPERATOR_ID } from "../../middleware/requirePublicOnboardingServiceAuth.js";
import type { ManagementOperationLedger } from "../../management/operations/managementOperationLedger.js";
import type { ManagementSigningKeySet } from "../../management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../management/managementConfig.js";
import { DatabaseUnavailableError } from "../../db/errors.js";
import { requestTenantCommission } from "../../management/operations/tenantLifecycleOperation.js";
import { UnexpectedManagementApiResponseError } from "../../management/operations/engineStateOperation.js";
import { ManagementOperationError } from "../../management/operations/managementOperationErrors.js";
import type { CommissionedTenantsRepository } from "../../management/operations/commissionedTenants.js";
import { getTenantRegistryEntry } from "../../management/operations/tenantRegistryQuery.js";
import { ManagementAuthError } from "../../identity/errors.js";
import { deterministicUuidFrom } from "../../management/deterministicId.js";

// Phase 1A.11 — the public self-service signup boundary. Deliberately a
// SEPARATE router from routes/management/index.ts, mounted at its own base
// path (/public-onboarding/v1), never under /management/v1: that keeps this
// machine-authenticated, no-CSRF, no-browser-session path from ever sharing
// middleware ordering or assumptions with the human-operator router (no
// requireBrowserCsrf() here — a server-to-server caller has no cookie to
// forge against in the first place).
//
// Reuses requestTenantCommission() verbatim — the SAME governed
// commissioning path (ledger, idempotency, signed assertion to
// Infrakinetic, fresh effective read) the operator-facing
// POST /management/v1/tenants/commission uses. Decision log 2026-09-19:
// "Reuse the existing tenants.commission owner path rather than creating
// another tenant-provisioning implementation." This route is a second
// AUTHENTICATION boundary onto that one existing operation, not a second
// implementation of commissioning itself.
//
// Exactly one action is reachable here — tenants.commission — enforced by
// requirePublicOnboardingServiceAuth hardcoding the scope, not by this
// route trusting anything from the request. accountType is always "demo"
// here: a public, unauthenticated signup form has no legitimate way to
// assert "live" (billing-relevant) status for itself; that remains an
// operator-only distinction via the existing commission route.
// send_invite is always true: a self-service signup with no invite would
// leave a tenant no one can ever log into.
//
// CORRECTED 2026-09-19 (pre-commit review), two fixes:
//
// 1. commissionRequestId is now DERIVED from the caller's idempotencyKey
//    (deterministicUuidFrom), never crypto.randomUUID(). Governance's own
//    ledger request-hash includes target_resource_id (=commissionRequestId,
//    see managementOperationLedger.ts), so a random commissionRequestId on
//    every call meant a genuine public-signup RETRY — same idempotencyKey,
//    because Infrakinetic's signup.js derives it from the full normalized
//    intent — still produced a DIFFERENT request hash and hit a spurious
//    IdempotencyConflictError instead of a clean replay. This still never
//    trusts a caller-supplied commissionRequestId (same "the operator's
//    browser has no legitimate reason to mint its own commission identity"
//    principle as the operator-facing route) — it is derived here, by
//    Governance, from a value (idempotencyKey) that is already the trusted
//    idempotency boundary.
// 2. trialDays is fixed at 14 explicitly (SIGNUP_TRIAL_DAYS below), not
//    left undefined to depend on provision_tenant()'s own hardcoded
//    default — see tenantLifecycle.js's commissionTenant() for why an
//    explicit trialDays is what actually governs the final trial_ends_at
//    for a Governance-issued commission. After a completed commission, a
//    fresh tenant-registry read supplies the REAL observed trial_ends_at
//    in the response (result.trialEndsAt) — owner truth, never a value
//    fabricated here as `now() + 14 days`.

export interface PublicOnboardingRouterDeps {
  auditSink: AuditSink;
  ledger: ManagementOperationLedger;
  commissionedTenants: CommissionedTenantsRepository;
  getManagementSigningKeys: () => Promise<ManagementSigningKeySet>;
  loadTransportConfig: () => ManagementTransportConfig;
  infrakineticBaseUrl: string;
  /** Test-only injection point — production never sets this (undefined -> global fetch). */
  fetchImpl?: typeof fetch;
}

const SIGNUP_REASON = "Public self-service signup";
const SIGNUP_TRIAL_DAYS = 14;

export function createPublicOnboardingRouter(deps: PublicOnboardingRouterDeps): Router {
  const router = Router();
  router.use(requirePublicOnboardingServiceAuth({ auditSink: deps.auditSink }));

  router.post("/commission", async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx || ctx.operatorId !== PUBLIC_ONBOARDING_SYSTEM_OPERATOR_ID) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
        res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
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
      const initialAdmin = body.initialAdmin as { name?: string; email?: string } | undefined;
      if (!initialAdmin?.name || !initialAdmin?.email) {
        res.status(400).json({ error: "INITIAL_ADMIN_REQUIRED" });
        return;
      }

      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const registryDeps = { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl, fetchImpl: deps.fetchImpl };

      const result = await requestTenantCommission(
        { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl, fetchImpl: deps.fetchImpl },
        {
          idempotencyKey: body.idempotencyKey,
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          commissionRequestId: deterministicUuidFrom(body.idempotencyKey),
          name: body.name,
          slug: typeof body.slug === "string" ? body.slug : undefined,
          plan: body.plan,
          industry: typeof body.industry === "string" ? body.industry : undefined,
          country: typeof body.country === "string" ? body.country : undefined,
          timezone: typeof body.timezone === "string" ? body.timezone : undefined,
          // Never operator/caller-supplied — see header. A public form
          // cannot assert "live" for itself, and cannot skip inviting its
          // own admin.
          accountType: "demo",
          trialDays: SIGNUP_TRIAL_DAYS,
          initialAdmin: initialAdmin as { name: string; email: string },
          sendInvite: true,
          reason: SIGNUP_REASON,
          correlationId: ctx.correlationId,
        },
      );

      const commissionResult = result.operation.result as { tenantId?: string } | undefined;
      let trialEndsAt: string | null = null;
      if (result.operation.status === "completed" && commissionResult?.tenantId) {
        // Owner truth, not `now() + 14 days` computed here — a fresh read
        // of the exact same registry the operator-facing UI shows. Best
        // effort: if this read itself fails, the commission already
        // succeeded and must not be reported as a failure over a display
        // detail — trialEndsAt stays null and the caller (Infrakinetic's
        // signup.js) already tolerates that.
        try {
          const registryEntry = await getTenantRegistryEntry(registryDeps, {
            identifier: commissionResult.tenantId,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            correlationId: ctx.correlationId,
          });
          trialEndsAt = registryEntry.tenant.trial_ends_at;
        } catch {
          trialEndsAt = null;
        }
      }

      res.status(200).json({
        operation: {
          ...result.operation,
          result: result.operation.result ? { ...result.operation.result, trialEndsAt } : result.operation.result,
        },
        replay: result.replay,
      });
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
  });

  const publicOnboardingErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
    if (!(err instanceof ManagementAuthError)) {
      next(err);
      return;
    }
    res.status(err.httpStatus).json({ error: err.code, message: err.message });
  };
  router.use(publicOnboardingErrorHandler);

  return router;
}
