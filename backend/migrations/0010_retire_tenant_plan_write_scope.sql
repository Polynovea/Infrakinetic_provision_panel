-- Phase 1A.11 architecture correction — retire the temporary tenant plan-write
-- authority introduced while 1A.11 had drifted into commercial/billing scope.
--
-- InfraKinetic is commissioned as B2B enterprise software. Commercial terms,
-- subscriptions, invoices and payment state do not authorize tenant provisioning
-- and the temporary tenant.plan.change runtime has been removed. Keep the
-- historical 0008 migration immutable because it may already have been applied,
-- then remove the dead authority additively here.

BEGIN;

DELETE FROM governance.operator_scopes
WHERE scope = 'tenants.plan.write';

ALTER TABLE governance.operator_scopes
  DROP CONSTRAINT operator_scopes_scope_check;

ALTER TABLE governance.operator_scopes
  ADD CONSTRAINT operator_scopes_scope_check CHECK (scope IN (
    'tenants.read', 'tenants.commission', 'tenants.suspend', 'tenants.resume', 'tenants.decommission',
    'engines.read', 'engines.entitlement.write', 'engines.platform_state.write', 'engines.release.write',
    'identity.read', 'identity.recovery', 'identity.disable', 'identity.mfa_reset',
    'credentials.metadata.read', 'credentials.submit', 'credentials.rotate', 'credentials.revoke',
    'ai.read', 'ai.entitlement.write', 'ai.quota.write', 'ai.provider_policy.write', 'ai.emergency_suspend',
    'payments.adapters.read', 'payments.adapters.certify', 'payments.adapters.approve', 'payments.adapters.revoke',
    'integrations.read', 'integrations.manage',
    'runtime.read', 'runtime.repair.request',
    'finops.read', 'finops.policy.write',
    'audit.read'
  ));

COMMIT;
