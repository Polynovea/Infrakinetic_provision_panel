import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { listTenantRegistry, getTenantRegistryEntry, UnknownTenantError, type TenantRegistryEntry } from "./tenantRegistryQuery.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { OPERATIONS_LIST_MAX_LIMIT } from "./managementOperationLedger.js";
import { CommissionedTenantsRepository, type CommissionedTenantRecord } from "./commissionedTenants.js";

// 1A.10.3 — the reconciliation drift read (master plan §64). Deliberately
// R0/read-only, same "no idempotency key, no ledger row" reasoning
// tenantRegistryQuery.ts's own header already established for reads: this
// module never mutates anything, it only classifies drift that already
// exists in `governance.commissioned_tenants` and `governance.
// management_operations` against a fresh owner-side read where a drift
// class requires one.
//
// No new database table (Phase1A.10_Ground_Truth_and_Scoping §2/§3.2):
// stuck-operation drift is computed live from the ledger, which already
// generalizes across command families (1A.9's own retro finding); projection
// drift is computed live from a fresh tenant-registry read. Nothing about
// "drift" itself is durably recorded — only a REPAIR of it is (via the
// ledger, in reconciliationOperation.ts).

// Default staleness threshold for `commissioned_tenants.last_observed_at`.
// Chosen as a reasonable default, not derived from any master-plan number —
// this platform has no SLA yet for how fresh an observed-state cache must
// be; 24h flags a projection nothing has refreshed in over a day without
// being noisy for every tenant that simply hasn't changed state recently.
export const DEFAULT_STALE_OBSERVATION_SECONDS = 24 * 60 * 60;

// Audit remediation M3 — an operation still 'submitted'/'accepted'/'running'
// this long after its last transition is stranded (process restart mid-call,
// a hung owner call before L2's timeout existed, a projection failure before
// M4's fix), not merely in flight. Every operation module transitions to
// 'running' before its first owner mutation call, so a stranded 'submitted'/
// 'accepted' op provably never dispatched; a stranded 'running' op is
// outcome-ambiguous exactly like a post-dispatch transport failure.
export const DEFAULT_STRANDED_AFTER_SECONDS = 10 * 60;

export type StuckOperationDriftClass =
  | "transport_ambiguous"
  | "effective_mismatch"
  | "effective_observation_failed"
  | "owner_partial_success"
  | "stranded_before_dispatch"
  | "stranded_in_flight"
  | "unclassified";

export interface DriftProjectionMissing {
  tenantId: string;
  name: string;
  platformAccessState?: "active" | "suspended" | "decommissioned";
}

export interface DriftStuckOperation {
  operationId: string;
  requestedAction: string;
  targetTenantId?: string;
  targetEngine?: string;
  targetResourceType?: string;
  targetResourceId?: string;
  class: StuckOperationDriftClass;
  stage?: string;
  expected?: unknown;
  observed?: unknown;
}

export interface DriftStaleObservation {
  tenantId: string;
  lastObservedAt: string;
  ageSeconds: number;
}

export interface DriftDesiredProvisionedMismatch {
  tenantId: string;
  field: "name" | "slug" | "plan";
  desired: string;
  provisioned: string;
}

// Audit remediation M3 — master plan §64's FIRST 1A.10 drift class, "desired
// state differs from owner-provisioned state", for the lifecycle itself: the
// Governance projection's desired lifecycle_state vs the owner's freshly
// observed platform_access_state. SURFACE-ONLY. Locked decision §3.7 of
// Phase1A.10_Ground_Truth_and_Scoping lets reconciliation automatically
// repair provisioned!=effective drift by calling refreshObservedState() —
// refreshing Governance's observed cache from fresh owner truth — but never
// by a lifecycle transition and never by replaying the owner mutation. That
// refresh path is unchanged. This mismatch is the separate question of
// Governance's DESIRED lifecycle vs owner truth; reconciliation never issues
// suspend/resume/decommission to erase it — an operator decides (new
// lifecycle request, commission repair).
export interface DriftLifecycleMismatch {
  tenantId: string;
  projectionLifecycleState: string;
  observedPlatformAccessState: "active" | "suspended" | "decommissioned";
}

export interface ListDriftResult {
  observedAt: string;
  projectionMissing: DriftProjectionMissing[];
  stuckOperations: DriftStuckOperation[];
  staleObservations: DriftStaleObservation[];
  desiredProvisionedMismatch: DriftDesiredProvisionedMismatch[];
  lifecycleMismatch: DriftLifecycleMismatch[];
  /** Set instead of projectionMissing/desiredProvisionedMismatch when the fresh owner-side read itself failed — the ledger-derived classes above are still reported. */
  registryUnavailable?: { message: string };
}

export interface DriftQueryDeps {
  ledger: ManagementOperationLedger;
  commissionedTenants: CommissionedTenantsRepository;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface ListDriftParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  /** Narrow every drift class to one real tenant. Omit for the platform-wide sweep. */
  tenantId?: string;
  correlationId?: string;
  staleAfterSeconds?: number;
}

// Whether a projection's desired lifecycle_state disagrees with fresh owner
// truth:
//   - active/suspended/decommissioned: any differing observed state.
//   - provisioning: owner 'active' is the normal state of a (possibly
//     partial) commission awaiting completion/repair — not drift; owner
//     'suspended'/'decommissioned' means a later lifecycle action succeeded
//     at the owner while the projection could not follow (the M4 case).
//     NOTE: this is a deliberate audit-driven EXTENSION of §3.7, not
//     something §3.7 already said — §3.7 skips every transitional state,
//     including provisioning. Without it the M4 stranded projection is
//     invisible to reconciliation. It is surface-only, so it widens what is
//     reported, never what reconciliation does.
//   - other transitional states: a mutation in flight, not drift (as §3.7).
export function isLifecycleDrift(
  lifecycleState: string,
  observed: "active" | "suspended" | "decommissioned" | undefined,
): boolean {
  if (!observed) return false;
  switch (lifecycleState) {
    case "active":
    case "suspended":
    case "decommissioned":
      return observed !== lifecycleState;
    case "provisioning":
      return observed !== "active";
    default:
      return false;
  }
}

function isStranded(op: ManagementOperationRecord, now: Date, strandedAfterSeconds: number): boolean {
  return now.getTime() - new Date(op.updatedAt).getTime() >= strandedAfterSeconds * 1000;
}

// Shared by listDrift (surface) and reconciliationOperation.ts (repair) so
// both see the identical population:
//   - every partially_completed op;
//   - every submitted/accepted/running op older than strandedAfterSeconds;
//   - for a per-tenant sweep, commission ops too: they are addressed by
//     commission_request (targetTenantId is null because no tenant exists
//     yet when they start), so a tenant filter alone never found them.
export async function listStuckOperationCandidates(
  ledger: ManagementOperationLedger,
  commissionedTenants: CommissionedTenantsRepository,
  params: { tenantId?: string; now?: Date; strandedAfterSeconds?: number; commissionRequestId?: string },
): Promise<ManagementOperationRecord[]> {
  const now = params.now ?? new Date();
  const strandedAfterSeconds = params.strandedAfterSeconds ?? DEFAULT_STRANDED_AFTER_SECONDS;

  const filters: Array<{ targetTenantId?: string; targetResourceType?: string; targetResourceId?: string }> = [];
  if (params.commissionRequestId) {
    filters.push({ targetResourceType: "commission_request", targetResourceId: params.commissionRequestId });
  } else {
    filters.push({ targetTenantId: params.tenantId });
    if (params.tenantId) {
      const projection = await commissionedTenants.getByTenantId(params.tenantId);
      if (projection?.commissionRequestId) {
        filters.push({ targetResourceType: "commission_request", targetResourceId: projection.commissionRequestId });
      }
    }
  }

  const byId = new Map<string, ManagementOperationRecord>();
  for (const filter of filters) {
    for (const status of ["partially_completed", "submitted", "accepted", "running"] as const) {
      const ops = await ledger.listOperations({ ...filter, status, limit: OPERATIONS_LIST_MAX_LIMIT });
      for (const op of ops) {
        if (status !== "partially_completed" && !isStranded(op, now, strandedAfterSeconds)) continue;
        byId.set(op.operationId, op);
      }
    }
  }
  return [...byId.values()];
}

function classifyStuckOperation(op: ManagementOperationRecord): DriftStuckOperation {
  const partial = op.partialFailureState as { stage?: string; expected?: unknown; observed?: unknown } | undefined;
  const stage = partial?.stage;
  const base = {
    operationId: op.operationId,
    requestedAction: op.requestedAction,
    targetTenantId: op.targetTenantId,
    targetEngine: op.targetEngine,
    // H3 — lets the operator surface address a commission op by its
    // commission request (the repair action) without inspecting the ledger.
    targetResourceType: op.targetResourceType,
    targetResourceId: op.targetResourceId,
    stage,
  };
  if (op.status === "submitted" || op.status === "accepted") return { ...base, class: "stranded_before_dispatch" };
  if (op.status === "running") return { ...base, class: "stranded_in_flight" };
  switch (stage) {
    // Same classification tenantLifecycleOperation.ts/engineStateOperation.ts/
    // tenantEngineEntitlementOperation.ts already all produce post-1A.10.1:
    // the mutation call landed in an unknown state — read the owner receipt
    // before any repair, never resend.
    case "mutation-call":
      return { ...base, class: "transport_ambiguous" };
    // The mutation succeeded and the owner side confirmed a value that
    // differs from what was requested — already known, nothing left to read.
    case "effective-mismatch":
      return { ...base, class: "effective_mismatch", expected: partial?.expected, observed: partial?.observed };
    // The mutation call itself succeeded but the independent post-mutation
    // read failed — the owner mutation almost certainly happened; our own
    // confirmation of it did not.
    case "effective-observation":
      return { ...base, class: "effective_observation_failed" };
    // tenant.commission-specific: Infrakinetic itself reported a partial
    // outcome (e.g. identity invite failed after the tenant row was created).
    case "commission-partial":
      return { ...base, class: "owner_partial_success" };
    default:
      return { ...base, class: "unclassified" };
  }
}

function desiredProvisionedMismatches(
  projection: CommissionedTenantRecord,
  registryEntry: TenantRegistryEntry,
): DriftDesiredProvisionedMismatch[] {
  const mismatches: DriftDesiredProvisionedMismatch[] = [];
  const tenantId = registryEntry.id;
  if (projection.desiredName !== undefined && projection.desiredName !== registryEntry.name) {
    mismatches.push({ tenantId, field: "name", desired: projection.desiredName, provisioned: registryEntry.name });
  }
  if (projection.desiredSlug !== undefined && projection.desiredSlug !== registryEntry.slug) {
    mismatches.push({ tenantId, field: "slug", desired: projection.desiredSlug, provisioned: registryEntry.slug });
  }
  if (projection.desiredPlan !== undefined && projection.desiredPlan !== registryEntry.plan) {
    mismatches.push({ tenantId, field: "plan", desired: projection.desiredPlan, provisioned: registryEntry.plan });
  }
  return mismatches;
}

function staleObservation(projection: CommissionedTenantRecord, now: Date, staleAfterSeconds: number): DriftStaleObservation | undefined {
  if (!projection.tenantId || !projection.lastObservedAt) return undefined;
  const ageSeconds = Math.floor((now.getTime() - new Date(projection.lastObservedAt).getTime()) / 1000);
  if (ageSeconds < staleAfterSeconds) return undefined;
  return { tenantId: projection.tenantId, lastObservedAt: projection.lastObservedAt, ageSeconds };
}

export async function listDrift(deps: DriftQueryDeps, params: ListDriftParams): Promise<ListDriftResult> {
  const staleAfterSeconds = params.staleAfterSeconds ?? DEFAULT_STALE_OBSERVATION_SECONDS;
  const now = new Date();

  // Ledger-derived drift needs no owner read at all — computed first so it
  // is still returned even if the registry is unreachable below.
  const stuckOperations = (
    await listStuckOperationCandidates(deps.ledger, deps.commissionedTenants, { tenantId: params.tenantId, now })
  ).map(classifyStuckOperation);

  const registryParams = {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    correlationId: params.correlationId,
  };

  let registryEntries: TenantRegistryEntry[];
  let observedAt: string;
  try {
    if (params.tenantId) {
      const detail = await getTenantRegistryEntry({ ...deps }, { ...registryParams, identifier: params.tenantId });
      registryEntries = [detail.tenant];
      observedAt = detail.observedAt;
    } else {
      const list = await listTenantRegistry({ ...deps }, registryParams);
      registryEntries = list.tenants;
      observedAt = list.observedAt;
    }
  } catch (err) {
    // §5's "observation stale/unavailable" class — a failed fresh-read
    // attempt during the sweep itself, distinct from a merely-old cached
    // observation (staleObservations below, computed without needing a
    // live read). The ledger-derived classes above are still meaningful and
    // are still returned.
    if (err instanceof UnknownTenantError) throw err;
    return {
      observedAt: now.toISOString(),
      projectionMissing: [],
      stuckOperations,
      staleObservations: [],
      desiredProvisionedMismatch: [],
      lifecycleMismatch: [],
      registryUnavailable: { message: err instanceof Error ? err.message : String(err) },
    };
  }

  const projections = params.tenantId
    ? [await deps.commissionedTenants.getByTenantId(params.tenantId)].filter((p): p is CommissionedTenantRecord => p !== undefined)
    : await deps.commissionedTenants.listAll();
  const projectionByTenantId = new Map(projections.filter((p) => p.tenantId).map((p) => [p.tenantId as string, p]));

  const projectionMissing: DriftProjectionMissing[] = [];
  const desiredProvisionedMismatch: DriftDesiredProvisionedMismatch[] = [];
  const lifecycleMismatch: DriftLifecycleMismatch[] = [];
  for (const entry of registryEntries) {
    // §3.3 — the master plan names this class over "customer" tenants only;
    // the reserved platform-kind tenant is not a projection_missing case.
    if (entry.tenant_kind !== "customer") continue;
    const projection = projectionByTenantId.get(entry.id);
    if (!projection) {
      projectionMissing.push({ tenantId: entry.id, name: entry.name, platformAccessState: entry.platform_access_state });
      continue;
    }
    desiredProvisionedMismatch.push(...desiredProvisionedMismatches(projection, entry));
    if (entry.platform_access_state && isLifecycleDrift(projection.lifecycleState, entry.platform_access_state)) {
      lifecycleMismatch.push({
        tenantId: entry.id,
        projectionLifecycleState: projection.lifecycleState,
        observedPlatformAccessState: entry.platform_access_state,
      });
    }
  }

  const staleObservations = projections
    .map((p) => staleObservation(p, now, staleAfterSeconds))
    .filter((s): s is DriftStaleObservation => s !== undefined);

  return { observedAt, projectionMissing, stuckOperations, staleObservations, desiredProvisionedMismatch, lifecycleMismatch };
}
