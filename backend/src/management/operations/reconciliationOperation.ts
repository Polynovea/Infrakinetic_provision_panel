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
import { ManagementOperationLedger, type ManagementOperationRecord } from "./managementOperationLedger.js";
import { listStuckOperationCandidates } from "./reconciliationQuery.js";
import type { OperationStatus } from "./lifecycle.js";

// 1A.10.4 — the reconciliation repair orchestration (master plan §64). Every
// repair here either (a) writes Governance's OWN projection from a fresh
// owner read, never touching owner state, or (b) resolves a stuck ledger
// operation by reading a durable owner-side receipt, never resending the
// original mutation. Both are R1 ("low-impact metadata", no reason
// required) per Phase1A.10_Ground_Truth_and_Scoping §3.9 — this is not a
// new privileged mutation class.
//
// IMPORTANT asymmetry: tenant-lifecycle (1A.8), tenant-engine-entitlement
// (1A.9), identity (1A.12) and credential (1A.13) commands all have a
// durable owner-side receipt table on the CRM side. `platform.engine-state.
// set` (1A.6) predates that requirement and has NO such receipt, and the
// ledger stores only a hash of the request payload — so an ambiguous
// engine-state op is surfaced for manual resolution, never guessed at.
//
// Audit remediation M3 (2026-09-25) closed the gaps between this module and
// its own §64 exit gates:
//   - operations stranded in 'submitted'/'accepted'/'running' (restart
//     mid-call, hung owner call, M4's projection failure) are now in scope,
//     not just 'partially_completed' ones;
//   - commission operations (addressed by commission_request, not tenant)
//     are reachable from the per-tenant sweep and from a per-commission-
//     request sweep;
//   - identity and credential receipts are read, so ambiguous R3 rotate/
//     revoke/MFA-reset operations no longer need hand resolution.
// Desired-vs-observed LIFECYCLE drift is surfaced by listDrift (surface-
// only per locked decision §3.7), not realigned here.
// Audit remediation L4: a 404 counts as "confirmed never executed" only when
// the owner says so with its own UNKNOWN_*_COMMAND code; a proxy or
// mis-routed 404 is an unknown outcome.

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
  // Projection repair and stuck-operation resolution are independent
  // activities (neither reads nor mutates data the other depends on) and
  // run isolated from each other — a failure in one must never prevent the
  // other from making progress. `projection` falls back to an inert
  // "nothing happened" value when its own repair attempt failed;
  // `projectionError`/`stuckOperationsError` are set whenever that
  // sub-task did not complete, so a failure is always visible in the
  // response, never silently reported as if it were a clean no-op.
  projection: ProjectionRepairResult;
  projectionError?: string;
  resolvedOperations: ResolvedStuckOperation[];
  remainingDrift: RemainingStuckOperation[];
  stuckOperationsError?: string;
  // Truthful summary: "complete" only when BOTH sub-tasks ran without
  // error (independent of whether either found anything to repair);
  // "partial" when exactly one failed; "failed" when both did.
  outcome: "complete" | "partial" | "failed";
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

interface ReconcileCallerParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
  causationId?: string;
}

export interface ReconcileTenantParams extends ReconcileCallerParams {
  tenantId: string;
}

export interface ReconcileCommissionRequestParams extends ReconcileCallerParams {
  commissionRequestId: string;
}

const RECONCILIATION_RISK_CLASS = "R1" as const;

// §3.7 — only these three lifecycle states have a fixed expected observed
// value. Transitional states are a mutation in flight, not drift, and are
// intentionally left unmapped here.
const EXPECTED_OBSERVED_STATE: Partial<Record<string, "active" | "suspended" | "decommissioned">> = {
  active: "active",
  suspended: "suspended",
  decommissioned: "decommissioned",
};

const TENANT_LIFECYCLE_ACTIONS = new Set(["tenant.commission", "tenant.suspend", "tenant.resume", "tenant.decommission"]);

interface ReceiptFamily {
  pathSegment: string;
  readAction: string;
  scope: string;
  unknownCode: string;
}

function receiptFamilyFor(requestedAction: string): ReceiptFamily | undefined {
  if (TENANT_LIFECYCLE_ACTIONS.has(requestedAction)) {
    return { pathSegment: "tenant-lifecycle-commands", readAction: "tenants.lifecycle-commands.read", scope: "tenants.read", unknownCode: "UNKNOWN_LIFECYCLE_COMMAND" };
  }
  if (requestedAction === "tenant.engine.entitlement.set") {
    return { pathSegment: "tenant-engine-entitlement-commands", readAction: "tenants.entitlement-commands.read", scope: "tenants.read", unknownCode: "UNKNOWN_ENTITLEMENT_COMMAND" };
  }
  if (requestedAction.startsWith("identity.")) {
    return { pathSegment: "identity-admin-commands", readAction: "identity.admin-commands.read", scope: "identity.read", unknownCode: "UNKNOWN_IDENTITY_ADMIN_COMMAND" };
  }
  // credential.test is read-tier and never ledgered.
  if (requestedAction.startsWith("credential.") && requestedAction !== "credential.test") {
    return { pathSegment: "credential-admin-commands", readAction: "credential.admin-commands.read", scope: "credentials.metadata.read", unknownCode: "UNKNOWN_CREDENTIAL_ADMIN_COMMAND" };
  }
  return undefined;
}

type ReceiptStatus = "accepted" | "executing" | "partially_completed" | "completed" | "failed";

interface CommandReceipt {
  status: ReceiptStatus;
  tenantId?: string;
}

// A confirmed "not_found" is a positive signal — Infrakinetic durably
// reserves the receipt row very early in its handler, before the mutation
// itself, so a genuine absence means the request never reached that point.
// Any OTHER failure to read the receipt is NOT the same thing and must not
// be treated as it — it means the outcome is still unknown. Collapsing
// these would let a transient failure resolve a stuck operation to
// `failed` and invite a retry of a mutation that may have succeeded.
type ReceiptLookup =
  | { kind: "found"; receipt: CommandReceipt }
  | { kind: "not_found" }
  | { kind: "unknown"; detail: string };

// Audit remediation L10 — Infrakinetic returns a receipt only to an
// assertion bound to the receipt's own tenant (or, for a commission receipt,
// its commission request). The read is therefore minted with the stranded
// operation's OWN signed target — exactly what the original mutation was
// addressed to — never a fleet-wide sentinel. A mismatch comes back 409,
// which lands in "unknown" below (surfaced, never resolved).
type ReceiptTarget = Pick<ManagementOperationRecord,"targetTenantId" | "targetEngine" | "targetResourceType" | "targetResourceId">;

function receiptAssertionTarget(op: ReceiptTarget) {
  const target = op.targetResourceType === "engine" || (!op.targetResourceType && op.targetEngine)
    ? { targetEngine: op.targetEngine }
    : { targetResourceType: op.targetResourceType, targetResourceId: op.targetResourceId };
  return { ...target, ...(op.targetTenantId ? { targetTenantId: op.targetTenantId } : {}) };
}

async function readCommandReceipt(
  deps: ReconciliationOperationDeps,
  params: ReconcileCallerParams,
  family: ReceiptFamily,
  op: ReceiptTarget & { idempotencyKey: string },
): Promise<ReceiptLookup> {
  const idempotencyKey = op.idempotencyKey;
  const receiptPath = `${MANAGEMENT_V1_PREFIX}/${family.pathSegment}/${encodeURIComponent(idempotencyKey)}`;
  let result;
  try {
    // Minted with the family's own read scope: an operator who does not
    // hold it gets an "unknown" outcome (surfaced), never a wrong answer.
    const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
      operatorId: params.operatorId,
      operatorSessionId: params.operatorSessionId,
      operatorRoles: params.operatorRoles,
      operatorGrantedScopes: params.operatorGrantedScopes,
      requestedScopes: [family.scope],
      ...receiptAssertionTarget(op),
      requestedAction: family.readAction,
      correlationId: params.correlationId,
    });
    result = await callInfrakineticManagementApi({
      baseUrl: deps.infrakineticBaseUrl,
      path: receiptPath,
      assertion,
      method: "GET",
      correlationId: params.correlationId,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    return { kind: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
  if (result.status === 404) {
    const code = (result.body as { error?: unknown } | undefined)?.error;
    if (code === family.unknownCode) return { kind: "not_found" };
    return { kind: "unknown", detail: `404 from ${receiptPath} without the owner's ${family.unknownCode} code — not treated as a confirmed absence` };
  }
  if (result.status !== 200) return { kind: "unknown", detail: `unexpected status ${result.status} from ${receiptPath}` };
  const body = result.body as { command?: { status?: string; tenantId?: string | null } };
  const status = body.command?.status;
  if (status === "accepted" || status === "executing" || status === "partially_completed" || status === "completed" || status === "failed") {
    return { kind: "found", receipt: { status, tenantId: body.command?.tenantId ?? undefined } };
  }
  return { kind: "unknown", detail: `unparseable receipt body from ${receiptPath}` };
}

async function recordProjectionReconcile(
  deps: ReconciliationOperationDeps,
  params: ReconcileTenantParams,
  projectionId: string,
  payload: Record<string, unknown>,
  apply: () => Promise<void>,
  snapshot: Record<string, unknown>,
): Promise<void> {
  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: `${params.idempotencyKey}:projection`,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: "tenant.projection.reconcile",
    targetTenantId: params.tenantId,
    targetResourceType: "commissioned_tenant_projection",
    targetResourceId: projectionId,
    riskClass: RECONCILIATION_RISK_CLASS,
    payload,
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId: params.correlationId ?? randomUUID(),
    causationId: params.causationId,
  });
  if (replay) return;
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });
  await apply();
  await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot(snapshot),
    result: { projectionId, ...payload },
  });
}

async function repairProjection(
  deps: ReconciliationOperationDeps,
  params: ReconcileTenantParams,
): Promise<ProjectionRepairResult> {
  // Unlike listDrift() (reconciliationQuery.ts), which degrades gracefully
  // on a registry read failure because it has other drift classes still
  // worth returning, a repair has no fallback data to act on — but the
  // failure must still surface as a typed, clean error.
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
      // observed platform_access_state there is nothing safe to create.
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

  // Locked decision §3.7: the repair is a refresh of the observed cache,
  // never a lifecycle transition — a desired-vs-observed lifecycle
  // disagreement is surfaced by listDrift's lifecycleMismatch instead.
  const expected = EXPECTED_OBSERVED_STATE[existing.lifecycleState];
  const needsRefresh = expected !== undefined && observedState !== undefined && existing.lastObservedPlatformAccessState !== observedState;
  if (!needsRefresh) {
    return { created: false, observedRefreshed: false };
  }

  await recordProjectionReconcile(
    deps,
    params,
    existing.projectionId,
    { action: "refresh_observed_state", from: existing.lastObservedPlatformAccessState ?? null, to: observedState },
    async () => { await deps.commissionedTenants.refreshObservedState(existing.projectionId, observedState as "active" | "suspended" | "decommissioned"); },
    { tenantId: params.tenantId, observedState },
  );
  return { created: false, observedRefreshed: true };
}

// A resolved tenant.commission operation also settles its projection, which
// is keyed by commission request (the tenant id may only be learned here,
// from the owner receipt).
async function syncCommissionProjection(
  deps: ReconciliationOperationDeps,
  op: ManagementOperationRecord,
  outcome: { status: ReceiptStatus | "not_found"; tenantId?: string },
): Promise<void> {
  if (op.requestedAction !== "tenant.commission" || op.targetResourceType !== "commission_request" || !op.targetResourceId) return;
  const projection = await deps.commissionedTenants.getByCommissionRequestId(op.targetResourceId);
  if (!projection || projection.lifecycleState !== "provisioning") return;
  if (outcome.status === "completed" && outcome.tenantId) {
    await deps.commissionedTenants.transitionLifecycleState(projection.projectionId, { toState: "active", tenantId: outcome.tenantId, lastOperationId: op.operationId });
    return;
  }
  if (outcome.status === "partially_completed" && outcome.tenantId && !projection.tenantId) {
    await deps.commissionedTenants.transitionLifecycleState(projection.projectionId, { toState: "provisioning", tenantId: outcome.tenantId, lastOperationId: op.operationId });
    return;
  }
  // Never fail a projection whose tenant an EARLIER attempt already created.
  if ((outcome.status === "failed" || outcome.status === "not_found") && !projection.tenantId) {
    await deps.commissionedTenants.transitionLifecycleState(projection.projectionId, { toState: "failed" });
  }
}

const COMMISSION_REPAIR_NOTE = "owner reported a partial commission — finish it with POST /management/v1/tenants/commission-requests/:commissionRequestId/repair";

async function resolveStuckOperation(
  deps: ReconciliationOperationDeps,
  params: ReconcileCallerParams,
  op: ManagementOperationRecord,
): Promise<{ resolved?: ResolvedStuckOperation; remaining?: RemainingStuckOperation }> {
  const stage = (op.partialFailureState as { stage?: string } | undefined)?.stage;
  const from = op.status;
  const resolved = (to: OperationStatus, resolvedStage?: string): { resolved: ResolvedStuckOperation } => ({
    resolved: { operationId: op.operationId, requestedAction: op.requestedAction, from, to, stage: resolvedStage ?? stage },
  });
  const remaining = (cls: string, note: string): { remaining: RemainingStuckOperation } => ({
    remaining: { operationId: op.operationId, requestedAction: op.requestedAction, class: cls, note },
  });

  // Stranded before dispatch: every operation module transitions to
  // 'running' before its first owner mutation call, so this op provably
  // never reached the owner. Safe to conclude failed without a receipt.
  if (op.status === "submitted" || op.status === "accepted") {
    const updated = await deps.ledger.transitionOperation(op.operationId, {
      toStatus: "failed",
      partialFailureState: { stage: "stranded-before-dispatch", message: "resolved via reconciliation: operation never reached the owner mutation call" },
    });
    await syncCommissionProjection(deps, op, { status: "not_found" });
    return resolved(updated.status, "stranded-before-dispatch");
  }

  const ambiguous = op.status === "running" || (op.status === "partially_completed" && stage === "mutation-call");
  if (!ambiguous) {
    if (stage === "commission-partial") return remaining("owner_partial_success", COMMISSION_REPAIR_NOTE);
    // effective-mismatch's outcome is already known on the row itself;
    // effective-observation needs its own handling — surfaced, not dropped.
    return remaining(stage ?? "unclassified", "surfaced only — not auto-repaired by 1A.10 (see Phase1A.10_Ground_Truth_and_Scoping §3.5)");
  }

  const cls = op.status === "running" ? "stranded_in_flight" : "transport_ambiguous";
  const family = receiptFamilyFor(op.requestedAction);
  if (!family) {
    return remaining(cls, "no durable owner-side receipt exists for this command family (platform.engine-state.set predates the 1A.8 standing-receipt requirement) — resolve manually");
  }

  const lookup = await readCommandReceipt(deps, params, family, op);

  if (lookup.kind === "unknown") {
    return remaining(cls, `could not read the owner-side receipt (${lookup.detail}) — recheck later`);
  }

  if (lookup.kind === "found" && lookup.receipt.status === "completed") {
    const updated = await deps.ledger.transitionOperation(op.operationId, {
      toStatus: "completed",
      result: { resolvedByReconciliation: true, receiptStatus: "completed", tenantId: lookup.receipt.tenantId ?? null },
    });
    await syncCommissionProjection(deps, op, lookup.receipt);
    return resolved(updated.status);
  }

  if (lookup.kind === "not_found" || (lookup.kind === "found" && lookup.receipt.status === "failed")) {
    const updated = await deps.ledger.transitionOperation(op.operationId, {
      toStatus: "failed",
      partialFailureState: {
        stage: "mutation-call-resolved-not-dispatched",
        receiptStatus: lookup.kind === "found" ? lookup.receipt.status : "not_found",
        message: "resolved via reconciliation: owner-side receipt confirms this command never completed",
      },
    });
    await syncCommissionProjection(deps, op, lookup.kind === "found" ? lookup.receipt : { status: "not_found" });
    return resolved(updated.status, "mutation-call-resolved-not-dispatched");
  }

  if (lookup.receipt.status === "partially_completed") {
    await syncCommissionProjection(deps, op, lookup.receipt);
    if (op.status === "running") {
      const updated = await deps.ledger.transitionOperation(op.operationId, {
        toStatus: "partially_completed",
        partialFailureState: {
          stage: op.requestedAction === "tenant.commission" ? "commission-partial" : "owner-partial",
          receiptStatus: "partially_completed",
          message: "resolved via reconciliation: owner-side receipt reports a partial outcome",
        },
      });
      return resolved(updated.status, op.requestedAction === "tenant.commission" ? "commission-partial" : "owner-partial");
    }
    return remaining("owner_partial_success", op.requestedAction === "tenant.commission" ? COMMISSION_REPAIR_NOTE : "owner-side receipt reports a partial outcome — inspect and re-request if needed");
  }

  // accepted / executing on the owner side — still genuinely in flight.
  return remaining(cls, `owner-side receipt still '${lookup.receipt.status}' — recheck later`);
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface StuckOperationsSweepResult {
  resolvedOperations: ResolvedStuckOperation[];
  remainingDrift: RemainingStuckOperation[];
}

// The list-then-resolve sweep as its own unit, so reconcileTenant() can run
// it independently of, and isolated from, projection repair. A single stuck
// operation whose own resolution attempt throws unexpectedly is caught here
// too, so one bad row can't erase the already-committed results of the rows
// resolved before it in the same sweep.
async function resolveStuckOperations(
  deps: ReconciliationOperationDeps,
  params: ReconcileCallerParams,
  scope: { tenantId?: string; commissionRequestId?: string },
): Promise<StuckOperationsSweepResult> {
  const stuckOperations = await listStuckOperationCandidates(deps.ledger, deps.commissionedTenants, scope);

  const resolvedOperations: ResolvedStuckOperation[] = [];
  const remainingDrift: RemainingStuckOperation[] = [];
  for (const op of stuckOperations) {
    try {
      const outcome = await resolveStuckOperation(deps, params, op);
      if (outcome.resolved) resolvedOperations.push(outcome.resolved);
      if (outcome.remaining) remainingDrift.push(outcome.remaining);
    } catch (err) {
      remainingDrift.push({
        operationId: op.operationId,
        requestedAction: op.requestedAction,
        class: "unclassified",
        note: `resolution attempt failed unexpectedly (${describeError(err)}) — recheck later`,
      });
    }
  }
  return { resolvedOperations, remainingDrift };
}

export async function reconcileTenant(
  deps: ReconciliationOperationDeps,
  params: ReconcileTenantParams,
): Promise<ReconcileTenantResult> {
  // Projection repair and stuck-operation resolution are independent —
  // Promise.allSettled so a failure on one side can never prevent the other
  // from completing and being reported.
  const [projectionSettled, stuckOpsSettled] = await Promise.allSettled([
    repairProjection(deps, params),
    resolveStuckOperations(deps, params, { tenantId: params.tenantId }),
  ]);

  const projection = projectionSettled.status === "fulfilled" ? projectionSettled.value : { created: false, observedRefreshed: false };
  const projectionError = projectionSettled.status === "rejected" ? describeError(projectionSettled.reason) : undefined;

  const { resolvedOperations, remainingDrift } =
    stuckOpsSettled.status === "fulfilled" ? stuckOpsSettled.value : { resolvedOperations: [], remainingDrift: [] };
  const stuckOperationsError = stuckOpsSettled.status === "rejected" ? describeError(stuckOpsSettled.reason) : undefined;

  const outcome: ReconcileTenantResult["outcome"] = projectionError
    ? (stuckOperationsError ? "failed" : "partial")
    : (stuckOperationsError ? "partial" : "complete");

  return {
    tenantId: params.tenantId,
    projection,
    projectionError,
    resolvedOperations,
    remainingDrift,
    stuckOperationsError,
    outcome,
    observedAt: new Date().toISOString(),
  };
}

export interface ReconcileCommissionRequestResult {
  commissionRequestId: string;
  resolvedOperations: ResolvedStuckOperation[];
  remainingDrift: RemainingStuckOperation[];
  observedAt: string;
}

// Audit remediation M3 — a commission that went ambiguous BEFORE the owner
// reported a tenant id has a projection with no tenant, so no per-tenant
// recheck can ever reach it. This sweeps that commission request's own
// stuck operations from the owner receipts (which carry the tenant id once
// one exists), settling the projection as it goes. Same R1, read-receipt-
// only rules as reconcileTenant: nothing is ever resent.
export async function reconcileCommissionRequest(
  deps: ReconciliationOperationDeps,
  params: ReconcileCommissionRequestParams,
): Promise<ReconcileCommissionRequestResult> {
  const { resolvedOperations, remainingDrift } = await resolveStuckOperations(deps, params, { commissionRequestId: params.commissionRequestId });
  return { commissionRequestId: params.commissionRequestId, resolvedOperations, remainingDrift, observedAt: new Date().toISOString() };
}
