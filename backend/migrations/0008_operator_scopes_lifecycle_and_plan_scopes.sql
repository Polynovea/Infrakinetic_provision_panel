-- Phase 1A.8/1A.11 — widen governance.operator_scopes' scope CHECK
-- constraint to include three scopes the application has defined and
-- enforced since those phases shipped (identity/roles.ts's SCOPES catalog)
-- but that 0001's constraint was never updated for: tenants.resume,
-- tenants.decommission (1A.8 tenant lifecycle — routes/management/
-- index.ts's TENANT_TRANSITION_ROUTES) and tenants.plan.write (1A.11
-- tenant plan change — PUT /management/v1/tenants/:tenantId/plan).
--
-- This is schema catching up to an already-shipped, already-enforced
-- application contract, not a new capability: requireScope() has checked
-- for these exact scope strings since those routes landed. Confirmed by
-- diff against identity/roles.ts's SCOPES (33 entries) — these three are
-- the only entries missing from the 30 this constraint previously allowed;
-- every other value matches exactly.
--
-- Discovered 2026-09-21 during 1A.11 Step 8 live certification: granting
-- tenants.resume/tenants.decommission/tenants.plan.write to the
-- platform_admin operator conducting certification failed with a CHECK
-- constraint violation. Because operator_scopes has no operator-specific
-- branching, this blocked the governed suspend/resume/decommission and
-- plan-change verticals for EVERY operator on this schema, not one
-- account — no operator could ever have held these scopes before this
-- migration.
--
-- DROP + re-ADD, not ALTER TYPE ... ADD VALUE: `scope` is a plain TEXT
-- column with an inline CHECK (see 0001), not a Postgres ENUM type. This
-- widens only — every value the old constraint allowed remains allowed,
-- so no existing row can be invalidated by this change.

ALTER TABLE governance.operator_scopes
  DROP CONSTRAINT operator_scopes_scope_check;

ALTER TABLE governance.operator_scopes
  ADD CONSTRAINT operator_scopes_scope_check CHECK (scope IN (
    'tenants.read', 'tenants.commission', 'tenants.suspend', 'tenants.resume', 'tenants.decommission', 'tenants.plan.write',
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
