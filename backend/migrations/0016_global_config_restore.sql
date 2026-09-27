-- (Hash columns use plain non-empty CHECKs, same pg-mem-compatible convention
-- as 0003; 64-hex format is validated in globalConfigRestoreOperation.ts.)
--
-- Phase 1A.14 §8/§9 — Governance-side persistence for the global
-- configuration restore framework (master plan §18's conceptual
-- global_config_restore_packages / global_config_restore_operations).
--
-- What lives here is DESIRED/CONTROL state only: packages an operator
-- submitted or authored, their validation/dry-run results, and restore
-- operations with the before-snapshot the owner returned (the rollback
-- source). Live effective state is never stored as truth here — master plan
-- §68: a Governance DB restore must not overwrite live Infrakinetic state; on
-- restore, every applied operation is re-observed against the owner snapshot
-- and drift is surfaced, never auto-reapplied.
--
-- The seven classes are platform-global, non-secret reference data (the
-- owner contract publishes no secret-bearing field), so storing package rows
-- and before-snapshots here does not replicate tenant business data.

CREATE TABLE governance.global_config_restore_packages (
  package_id            UUID PRIMARY KEY,
  class_key             TEXT NOT NULL,
  class_schema_version  TEXT NOT NULL CHECK (class_schema_version <> ''),
  content_hash          TEXT NOT NULL CHECK (content_hash <> ''),
  package_format        TEXT NOT NULL,
  source_environment    TEXT NOT NULL,
  produced_at           TIMESTAMPTZ NOT NULL,
  produced_by           JSONB NOT NULL,
  -- 'owner-export' (verified against the owner export key ring) or
  -- 'operator-authored' (attested by Governance's management key, binding
  -- the maker) — including rollback/forward-fix packages.
  provenance            TEXT NOT NULL CHECK (provenance IN ('owner-export', 'operator-authored')),
  signature_alg         TEXT NOT NULL,
  signature_key_id      TEXT NOT NULL,
  signature_value       TEXT NOT NULL,
  row_count             INTEGER NOT NULL CHECK (row_count >= 0),
  rows                  JSONB NOT NULL,
  purpose               TEXT NOT NULL CHECK (purpose IN ('backup', 'restore', 'rollback', 'forward_fix')),
  rollback_of_operation_id UUID,
  status                TEXT NOT NULL CHECK (status IN ('validated', 'dry_run', 'approval_requested', 'applied', 'superseded')),
  last_dry_run          JSONB,
  last_dry_run_at       TIMESTAMPTZ,
  submitted_by          UUID NOT NULL REFERENCES governance.operators (operator_id),
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A given class content may be staged for apply only once while still
-- actionable; re-staging identical content is the "duplicate package"
-- refusal. Backups are storage, not staged intent, so they never block a
-- restore/rollback to the same state; applied or superseded packages do not
-- block a later identical package either (e.g. rolling back to a previously
-- applied state). The same package_id is always refused (primary key).
CREATE UNIQUE INDEX global_config_restore_packages_active_content_uq
  ON governance.global_config_restore_packages (class_key, content_hash)
  WHERE status IN ('validated', 'dry_run', 'approval_requested') AND purpose <> 'backup';

CREATE INDEX global_config_restore_packages_class_idx
  ON governance.global_config_restore_packages (class_key, submitted_at DESC);

CREATE TABLE governance.global_config_restore_operations (
  restore_operation_id     UUID PRIMARY KEY,
  package_id               UUID NOT NULL REFERENCES governance.global_config_restore_packages (package_id),
  class_key                TEXT NOT NULL,
  management_operation_id  UUID NOT NULL,
  approval_id              UUID NOT NULL REFERENCES governance.management_approvals (approval_id),
  approved_before_hash     TEXT NOT NULL,
  approved_diff_hash       TEXT NOT NULL,
  expected_after_hash      TEXT NOT NULL,
  after_snapshot_hash      TEXT,
  -- Owner-returned before-state (the rollback source). Set once.
  before_snapshot          JSONB,
  status                   TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'partially_completed')),
  last_observation         JSONB,
  last_observed_at         TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX global_config_restore_operations_class_idx
  ON governance.global_config_restore_operations (class_key, created_at DESC);

COMMENT ON TABLE governance.global_config_restore_packages IS
  'Staged global configuration packages (1A.14). Desired/control state only; never live effective truth.';
COMMENT ON TABLE governance.global_config_restore_operations IS
  'Governed restore applies with the owner-returned before-snapshot (rollback source) and effective-state observations (1A.14).';

-- Rollback (manual, before any deployment depends on it):
-- DROP TABLE governance.global_config_restore_operations;
-- DROP TABLE governance.global_config_restore_packages;
