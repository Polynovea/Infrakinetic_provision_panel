import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { getTenantRegistryEntry, UnknownTenantError } from "./tenantRegistryQuery.js";
import { MANAGEMENT_V1_PREFIX, ManagementApiUnreachableError } from "./engineStateOperation.js";
import { buildSafeSnapshot } from "./evidence.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { CommissionedTenantsRepository } from "./commissionedTenants.js";
import { ManagementOperationLedger, OPERATIONS_LIST_MAX_LIMIT, type ManagementOperationRecord } from "./managementOperationLedger.js";
import type { OperationStatus } from "./lifecycle.js";

// 1A.10.4 — the reconciliation repair orchestration (master plan §64). Every
// repair here either (a) writes Governance's OWN projection from a fresh
// owner read, never touching owner state, or (b) resolves a stuck ledger
// operation by reading a durable owner-side receipt, never resending the
// original mutation. Both are R1 ("low-impact metadata", no reason
// required) per Phase1A.10_Ground_Truth_and_Scoping §3.9 — this is not a
// new privileged mutation class.
//
// IMPORTANT asymmetry, found while building this (not anticipated by the
// scoping doc): tenant-lifecycle (1A.8) and tenant-engine-entitlement (1A.9)
// commands both have a durable owner-side receipt table on the CRM side —
// 1A.8's own addendum named this a standing requirement for exactly this
// reconciliation phase. `platform.engine-state.set` (1A.6) predates that
// requirement and has NO such receipt. A transport-ambiguous engine-state
// operation therefore cannot be resolved from a receipt at all — there is
// nothing to read, and the ledger stores only a HASH of the original
// request payload (managementOperationLedger.ts never persists raw
// payload), so reconciliation cannot even recover what desired state was
// being requested well enough to compare against a fresh effective-state
// read. This module surfaces that case rather than guessing; adding a
// receipt table for engine-state (extending 1A.8's pattern backward to
// 1A.6) is a real, well-scoped follow-up, not something invented here.

export interface ProjectionRepairResult {
  created: boolean;
  observedRefreshed: boolean;
}

export interface ResolvedStuckOperation {
  operationId: string;
  requestedAction: string;
  from: OperationStatus;
  to: OperationStatus;
  stage?: string;
}

export interface RemainingStuckOperation {
  operationId: string;
  requestedAction: string;
  class: string;
  note: string;
}

export interface ReconcileTenantResult {
  tenantId: string;
  projection: ProjectionRepairResult;
  resolvedOperations: ResolvedStuckOperation[];
  remainingDrift: RemainingStuckOperation[];
  observedAt: string;
}

export interface ReconciliationOperationDeps {
  ledger: ManagementOperationLedger;
  commissionedTenants: CommissionedTenantsRepository;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface ReconcileTenantParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  tenantId: string;
  correlationId?: string;
  causationId?: string;
}

const RECONCILIATION_RISK_CLASS = "R1" as const;

// §3.7 — only these three lifecycle states have a fixed expected observed
// value. Transitional states (approved/provisioning/decommission_requested/
// decommissioning/etc.) are a mutation in flight, not drift, and are
// intentionally left unmapped here.
const EXPECTED_OBSERVED_STATE: Partial<Record<string, "active" | "suspended" | "decommissioned">> = {
  active: "active",
  suspended: "suspended",
  decommissioned: "decommissioned",
};

const TENANT_LIFECYCLE_ACTIONS = new Set(["tenant.commission", "tenant.suspend", "tenant.resume", "tenant.decommission"]);

interface CommandReceipt {
  status: "accepted" | "executing" | "partially_completed" | "completed" | "failed";
}

// A confirmed 404 ("not_found") is a positive signal — Infrakinetic
// durably reserves the receipt row very early in its handler, before the
// mutation itself, so a genuine absence means the request never reached
// that point. Any OTHER failure to read the receipt (non-200/non-404
// status, an unparseable body) is NOT the same thing and must not be
// treated as it — it means the outcome is still unknown, not that it's
// confirmed never-executed. Collapsing these two cases together (an
// earlier version of this function did, via a shared `undefined` return)
// would let a transient 500 on this read resolve a stuck operation to
// `failed` and invite a retry of a mutation that may have actually
// succeeded — exactly the mistake this phase exists to prevent.
type ReceiptLookup =
  | { kind: "found"; receipt: CommandReceipt }
  | { kind: "not_found" }
  | { kind: "unknown"; detail: string };

// Honest sentinel, same reasoning tenantRegistryQuery.ts's own
// TENANT_REGISTRY_TARGET comment gives: a receipt lookup by idempotencyKey
// isn't really engine-scoped, but target_engine is a required claim on
// every assertion, and neither commands route checks it.
const RECONCILIATION_RECEIPT_TARGET = "reconciliation-receipt";

async function mintAndCall(
  deps: ReconciliationOperationDeps,
  params: ReconcileTenantParams,
  requestedAction: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["tenants.read"],
    targetEngine: RECONCILIATION_RECEIPT_TARGET,
    requestedAction,
    correlationId: params.correlationId,
  });
  return callInfrakineticManagementApi({
    baseUrl: deps.infrakineticBaseUrl,
    path,
    assertion,
    method: "GET",
    correlationId: params.correlationId,
    fetchImpl: deps.fetchImpl,
  });
}

async function readCommandReceipt(
  deps: ReconciliationOperationDeps,
  params: ReconcileTenantParams,
  requestedAction: string,
  idempotencyKey: string,
): Promise<ReceiptLookup> {
  const receiptPath = TENANT_LIFECYCLE_ACTIONS.has(requestedAction)
    ? `${MANAGEMENT_V1_PREFIX}/tenant-lifecycle-commands/${encodeURIComponent(idempotencyKey)}`
    : `${MANAGEMENT_V1_PREFIX}/tenant-engine-entitlement-commands/${encodeURIComponent(idempotencyKey)}`;
  const readAction = TENANT_LIFECYCLE_ACTIONS.has(requestedAction)
    ? "tenants.lifecycle-commands.read"
    : "tenants.entitlement-commands.read";
  let result;
  try {
    result = await mintAndCall(deps, params, readAction, receiptPath);
  } catch (err) {
    return { kind: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
  if (result.status === 404) return { kind: "not_found" };
  if (result.status !== 200) return { kind: "unknown", detail: `unexpected status ${result.status} from ${receiptPath}` };
  const body = result.body as { command?: { status?: string } };
  const status = body.command?.status;
  if (status === "accepted" || status === "executing" || status === "partially_completed" || status === "completed" || status === "failed") {
    return { kind: "found", receipt: { status } };
  }
  return { kind: "unknown", detail: `unparseable receipt body from ${receiptPath}` };
}

function hasDurableReceipt(requestedAction: string): boolean {
  return TENANT_LIFECYCLE_ACTIONS.has(requestedAction) || requestedAction === "tenant.engine.entitlement.set";
}

async function repairProjection(
  deps: ReconciliationOperationDeps,
  params: ReconcileTenantParams,
): Promise<ProjectionRepairResult> {
  // Unlike listDrift() (reconciliationQuery.ts), which degrades gracefully
  // on a registry read failure because it has other drift classes still
  // worth returning, a repair has no fallback data to act on — but the
  // failure must still surface as a typed, clean error (same
  // ManagementApiUnreachableError the 1A.9 retro introduced for
  // engineStateOperation.ts's own pre-reservation resolve-read), not the
  // uncaught-network-exception shape that retro flagged as a known,
  // deferred gap on every GET route in this router — this is exactly the
  // read route the gap now had to be closed on.
  let fresh;
  try {
    fresh = await getTenantRegistryEntry(deps, { ...params, identifier: params.tenantId });
  } catch (err) {
    if (err instanceof UnknownTenantError) throw err;
    throw new ManagementApiUnreachableError(`${MANAGEMENT_V1_PREFIX}/tenants/${params.tenantId}`, err);
  }
  const observedState = fresh.tenant.platform_access_state;
  const existing = await deps.commissionedTenants.getByTenantId(params.tenantId);

  if (!existing) {
    if (!observedState) {
      // Master plan §64 forbids fabricating history — without a freshly
      // observed platform_access_state (e.g. a stale Infrakinetic deploy
      // that doesn't send the field yet) there is nothing safe to create.
      return { created: false, observedRefreshed: false };
    }
    const { record, created } = await deps.commissionedTenants.getOrCreateLegacyExisting({
      tenantId: params.tenantId,
      createdAt: fresh.tenant.created_at,
      observedPlatformAccessState: observedState,
    });
    if (created) {
      const { operation: submitted } = await deps.ledger.createOrReplayOperation({
        idempotencyKey: `${params.idempotencyKey}:projection`,
        operatorId: params.operatorId,
        operatorSessionId: params.operatorSessionId,
        requestedAction: "tenant.projection.reconcile",
        targetTenantId: params.tenantId,
        targetResourceType: "commissioned_tenant_projection",
        targetResourceId: record.projectionId,
        riskClass: RECONCILIATION_RISK_CLASS,
        payload: { action: "create_legacy_existing", observedState },
        contractVersion: MANAGEMENT_COMMAND_CONTRACT,
        correlationId: params.correlationId ?? randomUUID(),
        causationId: params.causationId,
      });
      await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
      await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });
      await deps.ledger.transitionOperation(submitted.operationId, {
        toStatus: "completed",
        afterStateSafeSnapshot: buildSafeSnapshot({ tenantId: params.tenantId, provenance: record.provenance, lifecycleState: record.lifecycleState }),
        result: { projectionId: record.projectionId },
      });
    }
    return { created, observedRefreshed: false };
  }

  const expected = EXPECTED_OBSERVED_STATE[existing.lifecycleState];
  const needsRefresh = expected !== undefined && observedState !== undefined && existing.lastObservedPlatformAccessState !== observedState;
  if (!needsRefresh) {
    return { created: false, observedRefreshed: false };
  }

  const { operation: submitted } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: `${params.idempotencyKey}:projection`,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: "tenant.projection.reconcile",
    targetTenantId: params.tenantId,
    targetResourceType: "commissioned_tenant_projection",
    targetResourceId: existing.projectionId,
    riskClass: RECONCILIATION_RISK_CLASS,
    payload: { action: "refresh_observed_state", from: existing.lastObservedPlatformAccessState ?? null, to: observedState },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId: params.correlationId ?? randomUUID(),
    causationId: params.causationId,
  });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });
  await deps.commissionedTenants.refreshObservedState(existing.projectionId, observedState as "active" | "suspended" | "decommissioned");
  await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot({ tenantId: params.tenantId, observedState }),
    result: { projectionId: existing.projectionId, refreshedTo: observedState },
  });
  return { created: false, observedRefreshed: true };
}

async function resolveStuckOperation(
  deps: ReconciliationOperationDeps,
  params: ReconcileTenantParams,
  op: ManagementOperationRecord,
): Promise<{ resolved?: ResolvedStuckOperation; remaining?: RemainingStuckOperation }> {
  const stage = (op.partialFailureState as { stage?: string } | undefined)?.stage;

  // Only the transport-ambiguous class (§64's first required drift class)
  // is auto-resolved here. effective-mismatch's outcome is already known on
  // the row itself (§3.5 — surfaced, an operator decides whether to
  // re-request); effective-observation and commission-partial need their
  // own dedicated handling this phase deliberately keeps out of MVP scope
  // (Phase1A.10_Ground_Truth_and_Scoping §3.5/§8) — surfaced, not silently
  // dropped.
  if (stage !== "mutation-call") {
    return {
      remaining: {
        operationId: op.operationId,
        requestedAction: op.requestedAction,
        class: stage ?? "unclassified",
        note: "surfaced only — not auto-repaired by 1A.10 (see Phase1A.10_Ground_Truth_and_Scoping §3.5)",
      },
    };
  }

  if (!hasDurableReceipt(op.requestedAction)) {
    return {
      remaining: {
        operationId: op.operationId,
        requestedAction: op.requestedAction,
        class: "transport_ambiguous",
        note: "no durable owner-side receipt exists for this command family (platform.engine-state.set predates the 1A.8 standing-receipt requirement) — resolve manually",
      },
    };
  }

  const lookup = await readCommandReceipt(deps, params, op.requestedAction, op.idempotencyKey);

  if (lookup.kind === "unknown") {
    // Could not determine the real outcome (transient error, unexpected
    // status, unparseable body) — this is NOT the same as a confirmed
    // absence and must never be treated as "safe to conclude failed".
    // Surfaced, left exactly as-is, retried on the next recheck.
    return {
      remaining: {
        operationId: op.operationId,
        requestedAction: op.requestedAction,
        class: "transport_ambiguous",
        note: `could not read the owner-side receipt (${lookup.detail}) — recheck later`,
      },
    };
  }

  if (lookup.kind === "found" && lookup.receipt.status === "completed") {
    const updated = await deps.ledger.transitionOperation(op.operationId, {
      toStatus: "completed",
      result: { resolvedByReconciliation: true, receiptStatus: "completed" },
    });
    return { resolved: { operationId: op.operationId, requestedAction: op.requestedAction, from: "partially_completed", to: updated.status, stage } };
  }

  if (lookup.kind === "not_found" || (lookup.kind === "found" && lookup.receipt.status === "failed")) {
    // A confirmed 404 means the request never reached the point where
    // Infrakinetic durably records one (reservation happens very early in
    // its handler, before the actual mutation) — as confident a "this never
    // executed" signal as an explicit 'failed' receipt.
    const updated = await deps.ledger.transitionOperation(op.operationId, {
      toStatus: "failed",
      partialFailureState: {
        stage: "mutation-call-resolved-not-dispatched",
        receiptStatus: lookup.kind === "found" ? lookup.receipt.status : "not_found",
        message: "resolved via reconciliation: owner-side receipt confirms this command never completed",
      },
    });
    return { resolved: { operationId: op.operationId, requestedAction: op.requestedAction, from: "partially_completed", to: updated.status, stage } };
  }

  // accepted / executing / partially_completed on the owner side — still
  // genuinely in flight or itself ambiguous; nothing safe to conclude yet.
  return {
    remaining: {
      operationId: op.operationId,
      requestedAction: op.requestedAction,
      class: "transport_ambiguous",
      note: `owner-side receipt still '${lookup.kind === "found" ? lookup.receipt.status : "unknown"}' — recheck later`,
    },
  };
}

export async function reconcileTenant(
  deps: ReconciliationOperationDeps,
  params: ReconcileTenantParams,
): Promise<ReconcileTenantResult> {
  const [projection, stuckOperations] = await Promise.all([
    repairProjection(deps, params),
    deps.ledger.listOperations({ status: "partially_completed", targetTenantId: params.tenantId, limit: OPERATIONS_LIST_MAX_LIMIT }),
  ]);

  const resolvedOperations: ResolvedStuckOperation[] = [];
  const remainingDrift: RemainingStuckOperation[] = [];
  for (const op of stuckOperations) {
    const outcome = await resolveStuckOperation(deps, params, op);
    if (outcome.resolved) resolvedOperations.push(outcome.resolved);
    if (outcome.remaining) remainingDrift.push(outcome.remaining);
  }

  return {
    tenantId: params.tenantId,
    projection,
    resolvedOperations,
    remainingDrift,
    observedAt: new Date().toISOString(),
  };
}
