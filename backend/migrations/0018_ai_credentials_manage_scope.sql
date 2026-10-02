-- Phase 1A.15 rectification — persist the managed-provider credential control
-- scope that is already enforced by identity/roles.ts and the AI management
-- contract. This is an additive widening of the operator_scopes vocabulary;
-- no existing grant or role assignment is changed.
--
-- Do NOT edit 0015 in place: it is an earlier migration that may already be
-- applied in deployed Governance databases. A fresh migration is required so
-- an existing database can safely accept `ai.credentials.manage`.

ALTER TABLE governance.operator_scopes
  DROP CONSTRAINT operator_scopes_scope_check;

ALTER TABLE governance.operator_scopes
  ADD CONSTRAINT operator_scopes_scope_check CHECK (scope IN (
    'tenants.read', 'tenants.commission', 'tenants.suspend', 'tenants.resume', 'tenants.decommission',
    'engines.read', 'engines.entitlement.write', 'engines.platform_state.write', 'engines.release.write',
    'identity.read', 'identity.recovery', 'identity.disable', 'identity.mfa_reset',
    'credentials.metadata.read', 'credentials.submit', 'credentials.rotate', 'credentials.revoke',
    'ai.read', 'ai.entitlement.write', 'ai.quota.write', 'ai.provider_policy.write', 'ai.emergency_suspend', 'ai.credentials.manage',
    'payments.adapters.read', 'payments.adapters.submit', 'payments.adapters.certify', 'payments.adapters.approve', 'payments.adapters.revoke',
    'integrations.read', 'integrations.manage',
    'runtime.read', 'runtime.repair.request',
    'finops.read', 'finops.policy.write',
    'global_config.restore', 'global_config.restore.apply',
    'audit.read'
  ));
