import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi, isNeverDispatchedNetworkError } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { MANAGEMENT_V1_PREFIX } from "./engineStateOperation.js";
import { CommissionedTenantsRepository } from "./commissionedTenants.js";
import { tenantRiskClassFor, type TenantLifecycleAction } from "./tenantLifecycle.js";

// Phase 1A.8.4 — Governance's tenant-commissioning orchestration. Mirrors
// engineStateOperation.ts's proven shape (fresh-before-read where
// meaningful -> ledger reservation -> mint -> mutate -> fresh-after-read ->
// compare -> complete/partial) but for the four tenant-lifecycle commands
// instead of engine state. Reuses the SAME ledger (governance.
// management_operations) and the SAME generic target-resource addressing
// 1A.8.1 introduced — no second ledger, no second assertion issuer.
//
// PII boundary (scoping doc §3.8): initialAdmin (name/email) is passed to
// Infrakinetic in the mutation call body (it needs it to actually invite
// the admin) but is NEVER placed into buildSafeSnapshot()/the ledger's
// persisted before/after snapshots, and management_operations has no raw
// `payload` column at all (managementOperationLedger.ts only ever hashes
// payload, never stores it) — so initialAdmin reaches the ledger only as
// part of the safe_payload_hash input, never as retrievable plaintext.
// commissioned_tenants likewise never stores admin_email/admin_name
// (0006's own header).

export class MissingTenantIdentifierError extends Error {
  constructor() {
    super("A tenant-lifecycle mutation requires a real tenantId.");
    this.name = "MissingTenantIdentifierError";
  }
}

// §8's corrected failure matrix (audit point 4): never-dispatched vs.
// outcome-ambiguous network failures. isNeverDispatchedNetworkError() was
// authored here originally; it now lives in managementApiClient.ts (1A.10.1)
// so engineStateOperation.ts and tenantEngineEntitlementOperation.ts apply
// the identical distinction instead of collapsing both cases into `failed`.

export interface TenantLifecycleOperationDeps {
  ledger: ManagementOperationLedger;
  commissionedTenants: CommissionedTenantsRepository;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface TenantLifecycleOperationResult {
  operation: ManagementOperationRecord;
  replay: boolean;
}

function mintAndCall(
  deps: TenantLifecycleOperationDeps,
  params: {
    operatorId: string;
    operatorSessionId: string;
    operatorRoles: readonly string[];
    operatorGrantedScopes: readonly string[];
    requestedScope: string;
    targetResourceType: string;
    targetResourceId: string;
    requestedAction: string;
    correlationId: string;
  },
) {
  return async (method: "GET" | "POST", path: string, body?: unknown) => {
    const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
      operatorId: params.operatorId,
      operatorSessionId: params.operatorSessionId,
      operatorRoles: params.operatorRoles,
      operatorGrantedScopes: params.operatorGrantedScopes,
      requestedScopes: [params.requestedScope],
      targetResourceType: params.targetResourceType,
      targetResourceId: params.targetResourceId,
      requestedAction: params.requestedAction,
      correlationId: params.correlationId,
    });
    return callInfrakineticManagementApi({
      baseUrl: deps.infrakineticBaseUrl,
      path,
      assertion,
      method,
      body,
      correlationId: params.correlationId,
      fetchImpl: deps.fetchImpl,
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Commission
// ─────────────────────────────────────────────────────────────────────────

export interface RequestTenantCommissionParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  commissionRequestId: string;
  name: string;
  slug?: string;
  plan: string;
  industry?: string;
  country?: string;
  timezone?: string;
  accountType: "demo" | "live";
  trialDays?: number;
  initialAdmin?: { name: string; email: string };
  sendInvite?: boolean;
  reason: string;
  correlationId?: string;
  causationId?: string;
}

export async function requestTenantCommission(
  deps: TenantLifecycleOperationDeps,
  params: RequestTenantCommissionParams,
): Promise<TenantLifecycleOperationResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: "tenant.commission",
    targetTenantId: null,
    targetResourceType: "commission_request",
    targetResourceId: params.commissionRequestId,
    reason: params.reason,
    riskClass: tenantRiskClassFor("tenant.commission"),
    payload: {
      name: params.name,
      slug: params.slug ?? null,
      plan: params.plan,
      industry: params.industry ?? null,
      country: params.country ?? null,
      timezone: params.timezone ?? null,
      accountType: params.accountType,
      trialDays: params.trialDays ?? null,
      initialAdmin: params.initialAdmin ?? null,
      sendInvite: params.sendInvite ?? true,
    },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: params.causationId,
  });

  if (replay) {
    return { operation: submitted, replay: true };
  }

  // A repair (new idempotencyKey, same commissionRequestId per §3.13/§5)
  // reuses the existing projection row rather than creating a second one —
  // commission_request_id is UNIQUE on governance.commissioned_tenants.
  let projection = await deps.commissionedTenants.getByCommissionRequestId(params.commissionRequestId);
  if (!projection) {
    projection = await deps.commissionedTenants.createForCommissionRequest({
      commissionRequestId: params.commissionRequestId,
      desiredName: params.name,
      desiredSlug: params.slug,
      desiredPlan: params.plan,
      accountType: params.accountType,
      responsibleOperatorId: params.operatorId,
    });
  }
  if (projection.lifecycleState === "requested") {
    projection = await deps.commissionedTenants.transitionLifecycleState(projection.projectionId, { toState: "approved" });
  }
  if (projection.lifecycleState === "approved") {
    projection = await deps.commissionedTenants.transitionLifecycleState(projection.projectionId, {
      toState: "provisioning",
      lastOperationId: submitted.operationId,
    });
  }

  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const call = mintAndCall(deps, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScope: "tenants.commission",
    targetResourceType: "commission_request",
    targetResourceId: params.commissionRequestId,
    requestedAction: "tenant.commission",
    correlationId,
  });

  const commandId = randomUUID();
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/commission`;
  let result;
  try {
    result = await call("POST", path, {
      name: params.name,
      slug: params.slug,
      plan: params.plan,
      industry: params.industry,
      country: params.country,
      timezone: params.timezone,
      accountType: params.accountType,
      trialDays: params.trialDays,
      initialAdmin: params.initialAdmin,
      sendInvite: params.sendInvite,
      reason: params.reason,
      commissionRequestId: params.commissionRequestId,
      idempotencyKey: params.idempotencyKey,
      commandId,
    });
  } catch (err) {
    if (isNeverDispatchedNetworkError(err)) {
      const failed = await deps.ledger.transitionOperation(submitted.operationId, {
        toStatus: "failed",
        partialFailureState: { stage: "mutation-call-never-dispatched", message: err instanceof Error ? err.message : String(err) },
      });
      await deps.commissionedTenants.transitionLifecycleState(projection.projectionId, { toState: "failed" });
      return { operation: failed, replay: false };
    }
    // §6 corrected classification: a transport failure AFTER dispatch is
    // outcome-ambiguous, not a plain failure — the owner side may already
    // have executed. Read the reconciliation receipt before repairing.
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      partialFailureState: { stage: "mutation-call", message: err instanceof Error ? err.message : String(err) },
    });
    return { operation: partial, replay: false };
  }

  if (result.status !== 200) {
    const failed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: { stage: "mutation-response", status: result.status, body: redactSecretShapedFields(result.body) },
    });
    await deps.commissionedTenants.transitionLifecycleState(projection.projectionId, { toState: "failed" });
    return { operation: failed, replay: false };
  }

  const body = result.body as { tenantId: string; lifecycleOutcome: string; warnings?: unknown[] };

  if (body.lifecycleOutcome === "completed") {
    await deps.commissionedTenants.transitionLifecycleState(projection.projectionId, {
      toState: "active",
      tenantId: body.tenantId,
      lastOperationId: submitted.operationId,
      observedPlatformAccessState: "active",
    });
    const completed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "completed",
      afterStateSafeSnapshot: buildSafeSnapshot({ tenantId: body.tenantId, lifecycleOutcome: body.lifecycleOutcome }),
      result: { tenantId: body.tenantId, lifecycleOutcome: body.lifecycleOutcome, warnings: body.warnings ?? [] },
    });
    return { operation: completed, replay: false };
  }

  // 'partially_completed' from Infrakinetic — the tenant WAS created; stay
  // in 'provisioning' (not 'failed') and record the real tenantId so a
  // later reconciliation read/UI can find it. Never fabricate 'active'.
  await deps.commissionedTenants.transitionLifecycleState(projection.projectionId, {
    toState: "provisioning",
    tenantId: body.tenantId,
    lastOperationId: submitted.operationId,
  });
  const partial = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "partially_completed",
    afterStateSafeSnapshot: buildSafeSnapshot({ tenantId: body.tenantId, lifecycleOutcome: body.lifecycleOutcome }),
    partialFailureState: { stage: "commission-partial", warnings: body.warnings ?? [] },
    result: { tenantId: body.tenantId, lifecycleOutcome: body.lifecycleOutcome, warnings: body.warnings ?? [] },
  });
  return { operation: partial, replay: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Suspend / Resume / Decommission
// ─────────────────────────────────────────────────────────────────────────

export interface RequestTenantTransitionParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  tenantId: string;
  reason: string;
  correlationId?: string;
  causationId?: string;
}

const ROUTE_SEGMENT: Record<Exclude<TenantLifecycleAction, "tenant.commission">, string> = {
  "tenant.suspend": "suspend",
  "tenant.resume": "resume",
  "tenant.decommission": "decommission",
};

async function projectionTransitionsFor(
  repo: CommissionedTenantsRepository,
  projectionId: string,
  action: Exclude<TenantLifecycleAction, "tenant.commission">,
  operationId: string,
  observedState: "active" | "suspended" | "decommissioned",
) {
  if (action === "tenant.suspend") {
    await repo.transitionLifecycleState(projectionId, {
      toState: "suspended", lastOperationId: operationId, observedPlatformAccessState: observedState,
    });
    return;
  }
  if (action === "tenant.resume") {
    await repo.transitionLifecycleState(projectionId, {
      toState: "active", lastOperationId: operationId, observedPlatformAccessState: observedState,
    });
    return;
  }
  // decommission — the projection's desired-lifecycle machine models this
  // as a three-step chain (requested -> decommissioning -> decommissioned)
  // even though the real owner-side mutation is a single atomic call; this
  // slice runs all three transitions back-to-back rather than introducing
  // an artificial delay, leaving room for a future maker-checker gap
  // between "requested" and "decommissioning" without a schema change.
  await repo.transitionLifecycleState(projectionId, { toState: "decommission_requested", lastOperationId: operationId });
  await repo.transitionLifecycleState(projectionId, { toState: "decommissioning", lastOperationId: operationId });
  await repo.transitionLifecycleState(projectionId, {
    toState: "decommissioned", lastOperationId: operationId, observedPlatformAccessState: observedState,
  });
}

async function requestTenantTransition(
  action: Exclude<TenantLifecycleAction, "tenant.commission">,
  deps: TenantLifecycleOperationDeps,
  params: RequestTenantTransitionParams,
): Promise<TenantLifecycleOperationResult> {
  if (!params.tenantId || params.tenantId.trim() === "") throw new MissingTenantIdentifierError();

  const correlationId = params.correlationId ?? randomUUID();
  const scope = `tenants.${ROUTE_SEGMENT[action]}`;

  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: action,
    targetTenantId: params.tenantId,
    targetResourceType: "tenant",
    targetResourceId: params.tenantId,
    reason: params.reason,
    riskClass: tenantRiskClassFor(action),
    payload: { tenantId: params.tenantId },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: params.causationId,
  });

  if (replay) {
    return { operation: submitted, replay: true };
  }

  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const call = mintAndCall(deps, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScope: scope,
    targetResourceType: "tenant",
    targetResourceId: params.tenantId,
    requestedAction: action,
    correlationId,
  });

  const commandId = randomUUID();
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/${ROUTE_SEGMENT[action]}`;
  let result;
  try {
    result = await call("POST", path, { reason: params.reason, idempotencyKey: params.idempotencyKey, commandId });
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

  if (result.status !== 200) {
    const failed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: { stage: "mutation-response", status: result.status, body: redactSecretShapedFields(result.body) },
    });
    return { operation: failed, replay: false };
  }

  const body = result.body as {
    previousPlatformAccessState: string | null;
    resultingPlatformAccessState: "active" | "suspended" | "decommissioned" | null;
  };

  // Audit remediation M4 — master plan §64 (1A.10) "owner truth wins": the
  // owner mutation is durable at this point, so the ledger must record the
  // completed truth even when the Governance projection cannot follow (e.g.
  // suspending a tenant whose projection is still 'provisioning' after a
  // partial commission — provisioning -> suspended is not a valid projection
  // transition). A projection failure used to throw here and strand the
  // operation in 'running' with a 500. Now the projection outcome is
  // recorded on the operation and a stale projection is left for
  // reconciliation to repair from a fresh owner read — never by replaying
  // the mutation.
  let projectionSync: { status: "synced" | "not_found" | "stale"; message?: string } = { status: "not_found" };
  try {
    const projection = await deps.commissionedTenants.getByTenantId(params.tenantId);
    if (projection && body.resultingPlatformAccessState) {
      await projectionTransitionsFor(deps.commissionedTenants, projection.projectionId, action, submitted.operationId, body.resultingPlatformAccessState);
      projectionSync = { status: "synced" };
    }
  } catch (err) {
    projectionSync = { status: "stale", message: err instanceof Error ? err.message : String(err) };
  }

  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    beforeStateSafeSnapshot: buildSafeSnapshot({ platformAccessState: body.previousPlatformAccessState }),
    afterStateSafeSnapshot: buildSafeSnapshot({ platformAccessState: body.resultingPlatformAccessState }),
    result: { ...body, projectionSync },
  });
  return { operation: completed, replay: false };
}

export function requestTenantSuspend(deps: TenantLifecycleOperationDeps, params: RequestTenantTransitionParams) {
  return requestTenantTransition("tenant.suspend", deps, params);
}
export function requestTenantResume(deps: TenantLifecycleOperationDeps, params: RequestTenantTransitionParams) {
  return requestTenantTransition("tenant.resume", deps, params);
}
export function requestTenantDecommission(deps: TenantLifecycleOperationDeps, params: RequestTenantTransitionParams) {
  return requestTenantTransition("tenant.decommission", deps, params);
}
