-- Phase 1A.8.1 — tenant lifecycle contract + Governance DB foundation.
-- Additive migration only. Applied migrations 0001-0004 are immutable history.
--
-- This migration intentionally does NOT read or write the Infrakinetic DB.
-- Legacy tenant projection rows are populated later through the authenticated
-- Management API/orchestration path; direct cross-database SQL is forbidden.

-- Generic management target addressing. Existing engine operations are
-- projected into the generic address pair without changing their original
-- target_engine value or any persisted request hash.
ALTER TABLE governance.management_operations
  ALTER COLUMN target_engine DROP NOT NULL,
  ADD COLUMN target_resource_type TEXT,
  ADD COLUMN target_resource_id TEXT;

UPDATE governance.management_operations
SET target_resource_type = 'engine',
    target_resource_id = target_engine
WHERE target_engine IS NOT NULL;

ALTER TABLE governance.management_operations
  ADD CONSTRAINT management_operations_target_resource_pair_consistent CHECK (
    (target_resource_type IS NULL AND target_resource_id IS NULL)
    OR (target_resource_type IS NOT NULL AND target_resource_id IS NOT NULL)
  ),
  ADD CONSTRAINT management_operations_target_address_required CHECK (
    target_engine IS NOT NULL
    OR (target_resource_type IS NOT NULL AND target_resource_id IS NOT NULL)
  ),
  ADD CONSTRAINT management_operations_engine_target_consistent CHECK (
    target_engine IS NULL
    OR target_resource_type IS NULL
    OR (target_resource_type = 'engine' AND target_resource_id = target_engine)
  );

CREATE INDEX management_operations_target_resource_idx
  ON governance.management_operations (target_resource_type, target_resource_id);

-- Governance-owned desired tenant lifecycle projection. It stores control
-- facts only — never tenant business data, billing state, admin PII, or
-- credentials. tenant_id is nullable for a governance_commissioned request
-- until the owner has actually created the tenant. legacy_existing rows must
-- identify an observed existing tenant and must not invent a commission
-- request/history that never occurred.
CREATE TABLE governance.commissioned_tenants (
  projection_id          UUID PRIMARY KEY,
  tenant_id              UUID UNIQUE,
  commission_request_id  UUID UNIQUE,
  lifecycle_state        TEXT NOT NULL CHECK (lifecycle_state IN (
    'draft', 'requested', 'approved', 'provisioning', 'active', 'suspended',
    'decommission_requested', 'decommissioning', 'decommissioned', 'failed'
  )),
  provenance             TEXT NOT NULL CHECK (provenance IN ('governance_commissioned', 'legacy_existing')),
  last_operation_id      UUID REFERENCES governance.management_operations (operation_id),
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL,
  CONSTRAINT commissioned_tenants_provenance_consistent CHECK (
    (provenance = 'governance_commissioned' AND commission_request_id IS NOT NULL)
    OR
    (provenance = 'legacy_existing' AND tenant_id IS NOT NULL AND commission_request_id IS NULL)
  )
);

CREATE INDEX commissioned_tenants_lifecycle_state_idx
  ON governance.commissioned_tenants (lifecycle_state);
CREATE INDEX commissioned_tenants_provenance_idx
  ON governance.commissioned_tenants (provenance);
