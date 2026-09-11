-- 1A.3 — Governance DB foundation: base ledger/idempotency schema, plus one
-- correction to 0001 surfaced while building the Postgres-backed adapters.
--
-- STATUS: authored, verified against pg-mem (test/migrations/
-- 0002_governance_db_foundation.test.ts). Applying it to a real Postgres
-- instance requires the database/role this subphase's provisioning script
-- (provisioning/001_create_role_and_database.sql) creates — that script has
-- not been run against anything real (no AWS/RDS/local Postgres access in
-- this session). See docs/1A.3_status.md.
--
-- No tenant business data, no Infrakinetic table, no shared credential
-- appears here (README.md hard rules #2/#3/#8).

-- --- Correction: operator_sessions rows have no "creation" event ----------
--
-- 0001 modeled operator_sessions as one row per verified token, with
-- operator_id/issued_at/expires_at NOT NULL. Building the Postgres-backed
-- OperatorSessionStore against the actual OperatorSessionStore port
-- (src/identity/sessionStore.ts) surfaced a mismatch: 1A.2 never mints a
-- separate management assertion and never calls a "session established"
-- write — the interface only exposes revoke(sessionId, reason) and
-- recordStepUp(sessionId, state), both of which may be the *first* write for
-- a given session id (the Cognito token's own jti). Neither call carries an
-- operator id, issued-at, or expiry, so a strict NOT NULL here made the
-- literal 1A.2 contract impossible to satisfy without changing the
-- middleware/port signatures — which 1A.2's own status doc explicitly says
-- 1A.3 must not do ("swaps in Postgres-backed implementations without
-- touching the middleware, routes, or any test above the adapter layer").
--
-- Relaxed to nullable rather than widening the port: a row with NULL
-- operator_id/issued_at/expires_at represents "we only ever observed a
-- revocation or step-up event for this session id, never an establishment
-- event" — an accurate, honest representation of 1A.2's actual session
-- model, not a data-integrity gap. A future subphase that mints its own
-- management assertion (with a real issuance event) can populate these
-- fields normally; existing rows are unaffected either way.
ALTER TABLE operator_sessions ALTER COLUMN operator_id DROP NOT NULL;
ALTER TABLE operator_sessions ALTER COLUMN issued_at DROP NOT NULL;
ALTER TABLE operator_sessions ALTER COLUMN expires_at DROP NOT NULL;

-- --- Idempotency store (master plan §59) -----------------------------------
--
-- Base schema only — no privileged mutation surface exists to write into
-- this yet (that begins at 1A.6, "first real vertical: platform engine
-- state"). Rules this table exists to support, per §59: same key + same
-- payload -> safe replay/same result; same key + different payload ->
-- reject; state survives restart; partial-failure result retained.
CREATE TABLE management_idempotency_keys (
  idempotency_key   TEXT PRIMARY KEY,
  requested_action  TEXT NOT NULL,
  operator_id       UUID REFERENCES operators (operator_id),
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

CREATE INDEX management_idempotency_keys_operator_id_idx ON management_idempotency_keys (operator_id);

-- --- Base operator action ledger (master plan §19) -------------------------
--
-- Distinct from 0001's operator_auth_audit_log, which only records
-- "who did/didn't get past requireManagementApiAuth/authorize.ts and why".
-- This table is the base shape of the immutable privileged-*action* ledger
-- — schema only at 1A.3; wiring every mutation path to write into it is
-- 1A.5's deliverable ("Audit, attribution and idempotency"). No application
-- code writes to this table yet, because no privileged mutation route exists
-- yet (1A.4/1A.6). Append-only by convention, matching 0001's
-- operator_auth_audit_log: no UPDATE/DELETE path in application code, and
-- the dedicated governance_app role's grants (provisioning/
-- 001_create_role_and_database.sql) intentionally omit UPDATE/DELETE on
-- this table and on operator_auth_audit_log.
CREATE TABLE operator_audit_log (
  id                   BIGSERIAL PRIMARY KEY,
  occurred_at          TIMESTAMPTZ NOT NULL,
  operator_id          UUID REFERENCES operators (operator_id),
  operator_session_id  UUID,
  action               TEXT NOT NULL,
  target_type          TEXT,
  target_id            TEXT,
  risk_class           TEXT CHECK (risk_class IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  reason               TEXT,
  idempotency_key      TEXT REFERENCES management_idempotency_keys (idempotency_key),
  correlation_id       UUID,
  result               TEXT NOT NULL CHECK (result IN (
    'submitted', 'accepted', 'running', 'partially_completed',
    'failed', 'compensating', 'completed'
  )),
  before_state         JSONB,
  after_state          JSONB,
  detail               JSONB
);

CREATE INDEX operator_audit_log_operator_id_idx ON operator_audit_log (operator_id);
CREATE INDEX operator_audit_log_occurred_at_idx ON operator_audit_log (occurred_at);
CREATE INDEX operator_audit_log_correlation_id_idx ON operator_audit_log (correlation_id);
