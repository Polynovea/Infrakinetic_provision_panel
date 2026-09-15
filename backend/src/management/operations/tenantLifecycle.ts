// Phase 1A.8.1 — Governance-owned desired tenant lifecycle model.
// This is deliberately separate from Infrakinetic's runtime access fact
// (tenants.platform_access_state) and its Billing-owned commercial status.

export const TENANT_LIFECYCLE_STATES = [
  "draft",
  "requested",
  "approved",
  "provisioning",
  "active",
  "suspended",
  "decommission_requested",
  "decommissioning",
  "decommissioned",
  "failed",
] as const;

export type TenantLifecycleState = (typeof TENANT_LIFECYCLE_STATES)[number];

export const TENANT_LIFECYCLE_PROVENANCE = ["governance_commissioned", "legacy_existing"] as const;
export type TenantLifecycleProvenance = (typeof TENANT_LIFECYCLE_PROVENANCE)[number];

export const TENANT_LIFECYCLE_ACTIONS = [
  "tenant.commission",
  "tenant.suspend",
  "tenant.resume",
  "tenant.decommission",
] as const;
export type TenantLifecycleAction = (typeof TENANT_LIFECYCLE_ACTIONS)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<TenantLifecycleState, readonly TenantLifecycleState[]>> = {
  draft: ["requested", "failed"],
  requested: ["approved", "failed"],
  approved: ["provisioning", "failed"],
  provisioning: ["active", "failed"],
  active: ["suspended", "decommission_requested", "failed"],
  suspended: ["active", "failed"],
  decommission_requested: ["decommissioning", "failed"],
  decommissioning: ["decommissioned", "failed"],
  decommissioned: [],
  // A failed operation is repaired through a new idempotency key/operation.
  // Re-opening a failed lifecycle projection is intentionally left to the
  // later orchestration slice, which has enough context to know the correct
  // recovery stage rather than guessing here.
  failed: [],
};

export function isTenantLifecycleState(value: string): value is TenantLifecycleState {
  return (TENANT_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isValidTenantLifecycleTransition(from: TenantLifecycleState, to: TenantLifecycleState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminalTenantLifecycleState(state: TenantLifecycleState): boolean {
  return state === "decommissioned";
}

export function tenantRiskClassFor(action: TenantLifecycleAction): "R2" {
  void action;
  return "R2";
}
