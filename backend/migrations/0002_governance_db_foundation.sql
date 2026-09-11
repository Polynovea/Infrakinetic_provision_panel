-- 1A.3 — Governance DB foundation: base ledger/idempotency schema.
--
-- CORRECTED 2026-09-11: rewritten to target the `governance` schema
-- instead of `public`, per the same architecture correction described in
-- 0001's header. The operator_sessions nullability fix this file
-- originally introduced (as a correction to 0001) has been folded directly
-- into 0001 instead, since 0001 has never been applied to any real
-- database — see docs/1A.3_status.md "Architecture correction". This file
-- is now purely additive: two new tables, no ALTER statements.
--
-- STATUS: authored, verified against pg-mem
-- (test/migrations/0002_governance_db_foundation.test.ts). Applying it to
-- the real database requires the role/database/schema this subphase's
-- provisioning script (provisioning/001_create_role_database_and_schema.sql)
-- creates — that script has not been run against anything real (no
-- AWS/RDS access in this session). See docs/1A.3_status.md.
--
-- No tenant business data, no Infrakinetic table, no shared credential
-- appears here (README.md hard rules #2/#3/#8).

-- --- Idempotency store (master plan §59) -----------------------------------
--
-- Base schema only — no privileged mutation surface exists to write into
-- this yet (that begins at 1A.6, "first real vertical: platform engine
-- state"). Rules this table exists to support, per §59: same key + same
-- payload -> safe replay/same result; same key + different payload ->
-- reject; state survives restart; partial-failure result retained.
CREATE TABLE governance.management_idempotency_keys (
  idempotency_key   TEXT PRIMARY KEY,
  requested_action  TEXT NOT NULL,
  operator_id       UUID REFERENCES governance.operators (operator_id),
  request_hash      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  result_snapshot   JSONB,
  created_at        TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  CONSTRAINT management_idempotency_keys_completion_consistent CHECK (
    (status = 'in_progress' AND completed_at IS NULL)
    OR (status <> 'in_progress' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX management_idempotency_keys_operator_id_idx ON governance.management_idempotency_keys (operator_id);

-- --- Base operator action ledger (master plan §19) -------------------------
--
-- Distinct from 0001's governance.operator_auth_audit_log, which only
-- records "who did/didn't get past requireManagementApiAuth/authorize.ts
-- and why". This table is the base shape of the immutable privileged
-- *action* ledger — schema only at 1A.3; wiring every mutation path to
-- write into it is 1A.5's deliverable. No application code writes to this
-- table yet, because no privileged mutation route exists yet (1A.4/1A.6).
-- Append-only by convention, matching 0001's operator_auth_audit_log: no
-- UPDATE/DELETE path in application code, and governance_app's grants
-- (which arise entirely from schema ownership — see
-- provisioning/001_create_role_database_and_schema.sql — not from any per-table
-- grant list) are not narrowed further than that at 1A.3; enforcing true
-- database-level append-only (e.g. revoking UPDATE/DELETE specifically on
-- this table even from its own owning role) is deferred, matching the
-- rest of this codebase's "documented interim, hardened later" pattern.
CREATE TABLE governance.operator_audit_log (
  id                   BIGSERIAL PRIMARY KEY,
  occurred_at          TIMESTAMPTZ NOT NULL,
  operator_id          UUID REFERENCES governance.operators (operator_id),
  operator_session_id  UUID,
  action               TEXT NOT NULL,
  target_type          TEXT,
  target_id            TEXT,
  risk_class           TEXT CHECK (risk_class IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  reason               TEXT,
  idempotency_key      TEXT REFERENCES governance.management_idempotency_keys (idempotency_key),
  correlation_id       UUID,
  result               TEXT NOT NULL CHECK (result IN (
    'submitted', 'accepted', 'running', 'partially_completed',
    'failed', 'compensating', 'completed'
  )),
  before_state         JSONB,
  after_state          JSONB,
  detail               JSONB
);

CREATE INDEX operator_audit_log_operator_id_idx ON governance.operator_audit_log (operator_id);
CREATE INDEX operator_audit_log_occurred_at_idx ON governance.operator_audit_log (occurred_at);
CREATE INDEX operator_audit_log_correlation_id_idx ON governance.operator_audit_log (correlation_id);
