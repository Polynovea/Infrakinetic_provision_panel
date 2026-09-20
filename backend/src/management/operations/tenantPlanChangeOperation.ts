import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi, isNeverDispatchedNetworkError } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError, ManagementApiUnreachableError } from "./engineStateOperation.js";
import { getTenantRegistryEntry, UnknownTenantError } from "./tenantRegistryQuery.js";
import type { CommissionedTenantsRepository } from "./commissionedTenants.js";
import type { RiskClass } from "./riskClassification.js";

// Phase 1A.11 — tenant.plan.change. Governance owns desired tenant plan
// going forward (decision log 2026-09-19, PlatformRectification/
// 1A.11_caller_migration_matrix.md): no billing/subscription system in
// Infrakinetic currently syncs tenants.plan post-commission, and 1A.10's
// own reconciliation already treats desiredPlan as the Governance-owned
// comparison point (desiredProvisionedMismatch). This is the first
// operation to close that loop — before this, nothing could change plan
// through a governed path at all; only the legacy, unauthenticated-by-
// design PATCH /admin/tenants/:id could.
//
// Mirrors tenantEngineEntitlementOperation.ts's proven shape (resolve via
// an EXISTING read route -> ledger reservation -> mint -> mutate -> fresh
// independent after-read -> compare -> complete/partial), reusing
// tenantRegistryQuery.ts's getTenantRegistryEntry() for both the before-
// and after-read rather than inventing a second tenant-plan read
// primitive — the registry already carries `plan`.
//
// Risk class is R2, same bar as engine entitlement and tenant suspend/
// resume/decommission — deliberately not elevated to R3/R4 merely because
// a plan change has pricing implications (2026-09-19 decision log:
// "determine the risk class from the existing Governance risk policy
// rather than inventing one"). No maker-checker/step-up gate.
//
// CORRECTED 2026-09-19 (pre-commit review), two fixes:
//
// 1. Desired-state convergence. This operation previously never touched
//    governance.commissioned_tenants.desired_plan at all — a successful
//    command changed Infrakinetic's tenants.plan but left Governance's own
//    desired_plan stale, which is EXACTLY the desiredProvisionedMismatch
//    1A.10 exists to catch, self-inflicted by the very command meant to
//    resolve it. updateDesiredPlan() now runs right after ledger
//    reservation, BEFORE the owner mutation attempt — desired state is
//    Governance's to declare immediately (same "commission sets initial
//    desired state" precedent as 1A.8.4's own projection transitions), not
//    something gated on whether Infrakinetic can or does apply it. If the
//    owner apply then fails or is blocked (see fix 2), desired_plan
//    legitimately stays at the new value and 1A.10 will report it as
//    drift — deliberate and documented, not accidental: an operator
//    declared new intent and the owner side hasn't (yet) converged.
//    updateDesiredPlan() is never called on an unapplied/rolled-back
//    request — only after this operation's own ledger row exists for a
//    genuinely new (non-replay) request.
// 2. projection_missing handling. A tenant the registry knows about but
//    Governance has no governance.commissioned_tenants row for at all
//    (the exact "projectionMissing" case reconciliationQuery.ts already
//    classifies) previously would have had its owner tenants.plan mutated
//    anyway — there is no desired_plan to converge in the first place.
//    Step 1 now fails explicitly (ProjectionMissingForPlanChangeError)
//    before any ledger reservation or owner mutation is attempted; the
//    correct repair is 1A.10.2's own getOrCreateLegacyExisting() backfill,
//    not a plan-change command papering over a missing projection.
//
// Explicitly does NOT touch Billing/Razorpay/invoice state directly from
// Governance — the owner-side apply (Infrakinetic's applyTenantPlanChange())
// is what checks for a live Razorpay binding and blocks if one exists; this
// operation only observes that outcome via the mutation response, exactly
// like any other mutation-response failure.

export class MissingTenantIdentifierForPlanChangeError extends Error {
  constructor() {
    super("A plan-change mutation requires a real tenantId.");
    this.name = "MissingTenantIdentifierForPlanChangeError";
  }
}

export class ProjectionMissingForPlanChangeError extends Error {
  constructor(readonly tenantId: string) {
    super(`No commissioned-tenant projection exists for '${tenantId}' — cannot converge a desired plan Governance has no record of. Backfill via 1A.10.2's getOrCreateLegacyExisting() first.`);
    this.name = "ProjectionMissingForPlanChangeError";
  }
}

export interface TenantPlanChangeOperationDeps {
  ledger: ManagementOperationLedger;
  commissionedTenants: CommissionedTenantsRepository;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — every path below adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface RequestTenantPlanChangeParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  tenantId: string;
  plan: string;
  reason: string;
  correlationId?: string;
  causationId?: string;
}

export interface TenantPlanChangeOperationResult {
  operation: ManagementOperationRecord;
  replay: boolean;
}

interface PlanMutationResponseBody {
  previousPlan: string | null;
  resultingPlan: string | null;
}

const PLAN_CHANGE_RISK_CLASS: RiskClass = "R2";

export async function requestTenantPlanChange(
  deps: TenantPlanChangeOperationDeps,
  params: RequestTenantPlanChangeParams,
): Promise<TenantPlanChangeOperationResult> {
  if (!params.tenantId || params.tenantId.trim() === "") {
    throw new MissingTenantIdentifierForPlanChangeError();
  }

  const correlationId = params.correlationId ?? randomUUID();

  // Step 1 — resolve + capture "before" state via the EXISTING 1A.7 tenant-
  // registry read (never a second read primitive for the same field).
  // UnknownTenantError/UnexpectedManagementApiResponseError propagate
  // as-is (the route layer maps them to 404/502); a raw connection failure
  // (nothing to record against yet, no ledger row exists) is normalized to
  // ManagementApiUnreachableError, same discipline as
  // tenantEngineEntitlementOperation.ts's own Step 1.
  const registryDeps = { signingKeys: deps.signingKeys, transportConfig: deps.transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl, fetchImpl: deps.fetchImpl };
  const resolveReadPath = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}`;
  let before;
  try {
    before = await getTenantRegistryEntry(registryDeps, {
      identifier: params.tenantId,
      operatorId: params.operatorId,
      operatorSessionId: params.operatorSessionId,
      operatorRoles: params.operatorRoles,
      operatorGrantedScopes: params.operatorGrantedScopes,
      correlationId,
    });
  } catch (err) {
    if (err instanceof UnknownTenantError || err instanceof UnexpectedManagementApiResponseError) throw err;
    throw new ManagementApiUnreachableError(resolveReadPath, err);
  }
  const previousPlan = before.tenant.plan;

  // Step 1b — projection_missing gate (fix 2 above). Fails BEFORE any
  // ledger reservation or owner mutation — there is no desired_plan to
  // converge for a tenant Governance has no commissioned_tenants row for.
  const projection = await deps.commissionedTenants.getByTenantId(params.tenantId);
  if (!projection) {
    throw new ProjectionMissingForPlanChangeError(params.tenantId);
  }

  // Step 2 — idempotency reservation + immutable ledger entry (1A.5).
  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: "tenant.plan.change",
    targetTenantId: params.tenantId,
    targetResourceType: "tenant",
    targetResourceId: params.tenantId,
    reason: params.reason,
    riskClass: PLAN_CHANGE_RISK_CLASS,
    payload: { tenantId: params.tenantId, plan: params.plan },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: params.causationId,
  });

  if (replay) {
    return { operation: submitted, replay: true };
  }

  await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "accepted",
    beforeStateSafeSnapshot: buildSafeSnapshot({ tenantId: params.tenantId, plan: previousPlan }),
  });

  // Governance declares desired intent immediately, before attempting the
  // owner apply — see this file's own header (fix 1) for why this is
  // deliberate and not reverted on a later owner-side failure.
  await deps.commissionedTenants.updateDesiredPlan(projection.projectionId, params.plan);

  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const commandId = randomUUID();
  const mutatePath = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/plan`;
  const mutateAssertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["tenants.plan.write"],
    targetResourceType: "tenant",
    targetResourceId: params.tenantId,
    requestedAction: "tenant.plan.change",
    correlationId,
  });

  let mutateResult;
  try {
    mutateResult = await callInfrakineticManagementApi({
      baseUrl: deps.infrakineticBaseUrl,
      path: mutatePath,
      assertion: mutateAssertion,
      method: "PUT",
      body: { plan: params.plan, reason: params.reason, commandId, idempotencyKey: params.idempotencyKey },
      correlationId,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    if (isNeverDispatchedNetworkError(err)) {
      const failed = await deps.ledger.transitionOperation(submitted.operationId, {
        toStatus: "failed",
        partialFailureState: { stage: "mutation-call-never-dispatched", message: err instanceof Error ? err.message : String(err) },
      });
      return { operation: failed, replay: false };
    }
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      partialFailureState: { stage: "mutation-call", message: err instanceof Error ? err.message : String(err) },
    });
    return { operation: partial, replay: false };
  }

  if (mutateResult.status !== 200) {
    const failed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: { stage: "mutation-response", status: mutateResult.status, body: redactSecretShapedFields(mutateResult.body) },
    });
    return { operation: failed, replay: false };
  }

  // Step 3 — independent effective-state observation: a FRESH registry
  // read, never trusting the mutation response alone as proof the change
  // actually stuck (same discipline engineStateOperation.ts and
  // tenantEngineEntitlementOperation.ts apply).
  let effective;
  try {
    effective = await getTenantRegistryEntry(registryDeps, {
      identifier: params.tenantId,
      operatorId: params.operatorId,
      operatorSessionId: params.operatorSessionId,
      operatorRoles: params.operatorRoles,
      operatorGrantedScopes: params.operatorGrantedScopes,
      correlationId,
    });
  } catch (err) {
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      afterStateSafeSnapshot: buildSafeSnapshot({ mutationResult: mutateResult.body }),
      partialFailureState: { stage: "effective-observation", message: err instanceof Error ? err.message : String(err) },
    });
    return { operation: partial, replay: false };
  }

  if (effective.tenant.plan !== params.plan) {
    const mismatch = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      afterStateSafeSnapshot: buildSafeSnapshot({ tenantId: params.tenantId, plan: effective.tenant.plan }),
      partialFailureState: { stage: "effective-mismatch", expected: params.plan, observed: effective.tenant.plan },
    });
    return { operation: mismatch, replay: false };
  }

  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot({ tenantId: params.tenantId, plan: effective.tenant.plan }),
    result: {
      commandId,
      previousPlan,
      requestedPlan: params.plan,
      resultingPlan: effective.tenant.plan,
    } satisfies { commandId: string } & PlanMutationResponseBody & { requestedPlan: string },
  });
  return { operation: completed, replay: false };
}

export { UnknownTenantError, UnexpectedManagementApiResponseError, ManagementApiUnreachableError };
