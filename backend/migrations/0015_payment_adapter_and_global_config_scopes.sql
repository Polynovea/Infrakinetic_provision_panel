-- Phase 1A.14 — three new operator scopes, approved 2026-09-27 (Governance
-- PlatformRectification/Phase1A.14_Ground_Truth_and_Scoping_2026-09-27.md
-- §15 Q2) and added to master plan §15 and identity/roles.ts together:
--
--   payments.adapters.submit     — submit a third-party payment adapter
--                                  manifest (supply-chain entry; separately
--                                  grantable from certify)
--   global_config.restore        — submit/validate/dry-run a global
--                                  configuration restore package
--   global_config.restore.apply  — execute an approved restore
--
-- Role ceilings: platform_admin and break_glass only (security_operator is
-- deliberately NOT widened — it holds adapter revoke, not supply-chain
-- submission).
--
-- Same DROP + re-ADD widening as 0008 — learned there: a scope the
-- application enforces but this CHECK omits cannot be granted to anyone.
-- Widening only; every previously valid value stays valid.

ALTER TABLE governance.operator_scopes
  DROP CONSTRAINT operator_scopes_scope_check;

ALTER TABLE governance.operator_scopes
  ADD CONSTRAINT operator_scopes_scope_check CHECK (scope IN (
    'tenants.read', 'tenants.commission', 'tenants.suspend', 'tenants.resume', 'tenants.decommission',
    'engines.read', 'engines.entitlement.write', 'engines.platform_state.write', 'engines.release.write',
    'identity.read', 'identity.recovery', 'identity.disable', 'identity.mfa_reset',
    'credentials.metadata.read', 'credentials.submit', 'credentials.rotate', 'credentials.revoke',
    'ai.read', 'ai.entitlement.write', 'ai.quota.write', 'ai.provider_policy.write', 'ai.emergency_suspend',
    'payments.adapters.read', 'payments.adapters.submit', 'payments.adapters.certify', 'payments.adapters.approve', 'payments.adapters.revoke',
    'integrations.read', 'integrations.manage',
    'runtime.read', 'runtime.repair.request',
    'finops.read', 'finops.policy.write',
    'global_config.restore', 'global_config.restore.apply',
    'audit.read'
  ));
