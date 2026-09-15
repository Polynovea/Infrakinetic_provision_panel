// 1A.2 — role/scope catalog. Sourced verbatim from the locked master plan
// (§15 "Operator identity") — do not add roles/scopes here without updating
// that document first; this file is the single source of truth the rest of
// the backend imports from, so the catalog never drifts by copy-paste.

export const ROLES = [
  "platform_viewer",
  "platform_operator",
  "provisioning_operator",
  "identity_operator",
  "security_operator",
  "finops_operator",
  "platform_admin",
  "break_glass",
] as const;

export type Role = (typeof ROLES)[number];

export const SCOPES = [
  "tenants.read",
  "tenants.commission",
  "tenants.suspend",
  "tenants.resume",
  "tenants.decommission",

  "engines.read",
  "engines.entitlement.write",
  "engines.platform_state.write",
  "engines.release.write",

  "identity.read",
  "identity.recovery",
  "identity.disable",
  "identity.mfa_reset",

  "credentials.metadata.read",
  "credentials.submit",
  "credentials.rotate",
  "credentials.revoke",

  "ai.read",
  "ai.entitlement.write",
  "ai.quota.write",
  "ai.provider_policy.write",
  "ai.emergency_suspend",

  "payments.adapters.read",
  "payments.adapters.certify",
  "payments.adapters.approve",
  "payments.adapters.revoke",

  "integrations.read",
  "integrations.manage",

  "runtime.read",
  "runtime.repair.request",

  "finops.read",
  "finops.policy.write",

  "audit.read",
] as const;

export type Scope = (typeof SCOPES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

// Authored 1A.2 RBAC default matrix — the master plan lists roles and scopes
// but does not pin an explicit role -> scope mapping. This matrix is this
// subphase's architecture decision, recorded so it can be revisited: it is
// the *ceiling* of scopes each role may hold, used defensively by
// requireManagementApiAuth to reject an operator record whose granted
// scopes exceed what their granted roles permit (see
// identity/operatorDirectory.ts "insufficient privilege" cross-check).
// Scopes are still the actual authorization unit per §15 ("use explicit
// scopes, not role checks alone") — this matrix bounds them, it does not
// replace them.
export const ROLE_SCOPE_CEILING: Readonly<Record<Role, readonly Scope[]>> = {
  platform_viewer: [
    "tenants.read",
    "engines.read",
    "identity.read",
    "credentials.metadata.read",
    "ai.read",
    "payments.adapters.read",
    "integrations.read",
    "runtime.read",
    "finops.read",
    "audit.read",
  ],
  platform_operator: [
    "tenants.read",
    "engines.read",
    "engines.entitlement.write",
    "engines.release.write",
    "identity.read",
    "credentials.metadata.read",
    "ai.read",
    "payments.adapters.read",
    "integrations.read",
    "runtime.read",
    "runtime.repair.request",
    "finops.read",
    "audit.read",
  ],
  provisioning_operator: [
    "tenants.read",
    "tenants.commission",
    "tenants.suspend",
    "tenants.resume",
    "tenants.decommission",
    "engines.read",
    "engines.entitlement.write",
    "identity.read",
    "audit.read",
  ],
  identity_operator: [
    "identity.read",
    "identity.recovery",
    "identity.disable",
    "identity.mfa_reset",
    "audit.read",
  ],
  security_operator: [
    "identity.read",
    "identity.recovery",
    "identity.disable",
    "identity.mfa_reset",
    "credentials.metadata.read",
    "credentials.submit",
    "credentials.rotate",
    "credentials.revoke",
    "ai.emergency_suspend",
    "payments.adapters.revoke",
    "integrations.manage",
    "audit.read",
  ],
  finops_operator: [
    "finops.read",
    "finops.policy.write",
    "ai.read",
    "audit.read",
  ],
  platform_admin: SCOPES,
  break_glass: SCOPES,
} as const;
