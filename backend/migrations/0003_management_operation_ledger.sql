-- 1A.5 — durable management-operation ledger, on top of 0002's base
-- idempotency/audit schema. Purely additive: no ALTER on any 0001/0002
-- table's existing columns or constraints (both have been applied to the
-- real `polynovea_governance` database — see docs/1A.3_status.md — so they
-- are immutable history, not editable in place).
--
-- governance.management_idempotency_keys (0002) keeps its exact original
-- shape and 3-value status vocabulary ('in_progress' | 'completed' |
-- 'failed'). This migration does not need a 4th value for
-- 'partially_completed': from the idempotency guard's own point of view,
-- "we have a durable result, replay is safe" is true the moment an
-- operation leaves the in-flight set, whether the underlying business
-- outcome was a full success, a partial success, or a failure — so
-- management_operations.status (the richer 7-state lifecycle) maps onto
-- idempotency_keys.status as: {submitted, accepted, running, compensating}
-- -> 'in_progress'; {completed, partially_completed} -> 'completed';
-- {failed} -> 'failed'. That mapping lives in application code
-- (managementOperationLedger.ts), not in a schema constraint here.
--
-- governance.operator_audit_log (0002) already anticipated the full
-- 7-state lifecycle in its own `result` CHECK vocabulary
-- ('submitted'/'accepted'/'running'/'partially_completed'/'failed'/
-- 'compensating'/'completed') — this migration only ADDs the columns
-- needed to thread operation/causation identity through each ledger row;
-- it does not touch any existing column or constraint on that table.
--
-- No tenant business data, no Infrakinetic table, no shared credential
-- appears here (README.md hard rules #2/#3/#8). No secret or raw
-- credential is ever a column here — evidence snapshots are
-- application-redacted before they ever reach a query parameter (see
-- src/management/operations/evidence.ts).

-- --- The operation entity itself (master plan §19) --------------------------
--
-- One row per idempotency key (1:1, enforced by the UNIQUE FK below), but
-- kept as its own table rather than widening management_idempotency_keys
-- in place, so 0002's already-applied shape never needs an ALTER. This is
-- the durable object the whole 1A.5 substrate revolves around: created once
-- (atomically, alongside its idempotency_keys row, in the same DB
-- transaction — see managementOperationLedger.ts) and then only ever
-- transitioned forward through the lifecycle in §60, never re-created for
-- the same idempotency key.
CREATE TABLE governance.management_operations (
  operation_id                UUID PRIMARY KEY,
  idempotency_key             TEXT NOT NULL UNIQUE REFERENCES governance.management_idempotency_keys (idempotency_key),
  operator_id                 UUID NOT NULL REFERENCES governance.operators (operator_id),
  operator_session_id         UUID,
  requested_action            TEXT NOT NULL,
  target_tenant_id            UUID,
  target_engine               TEXT NOT NULL,
  reason                      TEXT,
  risk_class                  TEXT NOT NULL CHECK (risk_class IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  approval_evidence           JSONB,
  safe_payload_hash           TEXT NOT NULL,
  contract_version            TEXT NOT NULL,
  correlation_id              UUID NOT NULL,
  causation_id                UUID,
  requested_at                TIMESTAMPTZ NOT NULL,
  accepted_at                 TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  failed_at                   TIMESTAMPTZ,
  status                      TEXT NOT NULL CHECK (status IN (
    'submitted', 'accepted', 'running', 'partially_completed',
    'failed', 'compensating', 'completed'
  )),
  before_state_safe_snapshot  JSONB,
  after_state_safe_snapshot   JSONB,
  result                      JSONB,
  partial_failure_state       JSONB,
  rollback_reference          JSONB,
  created_at                  TIMESTAMPTZ NOT NULL,
  updated_at                  TIMESTAMPTZ NOT NULL,
  -- R2 and above require a non-empty reason at creation (master plan §20:
  -- "requires reason and idempotency"). R3's step-up/maker-checker
  -- requirement is deliberately NOT enforced here — approval_evidence
  -- exists so that control can be layered on without a schema change, per
  -- instruction #5, but 1A.5 does not implement the workflow itself.
  -- Deliberately a plain non-empty-string check (no btrim/trim call) —
  -- pg-mem, used by this repo's migration tests, implements very few
  -- native SQL functions. Whitespace-only "reason" values are rejected one
  -- layer up, by managementOperationLedger.ts's own validation, before a
  -- query is ever issued.
  CONSTRAINT management_operations_risk_requires_reason CHECK (
    risk_class IN ('R0', 'R1') OR (reason IS NOT NULL AND reason <> '')
  ),
  -- Fail-closed data integrity: a row cannot claim a terminal status
  -- without the matching terminal timestamp. Does not constrain
  -- non-terminal statuses, which legitimately have both timestamps NULL.
  CONSTRAINT management_operations_terminal_timestamps_consistent CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status = 'failed' AND failed_at IS NOT NULL)
    OR (status NOT IN ('completed', 'failed'))
  )
);

CREATE INDEX management_operations_operator_id_idx ON governance.management_operations (operator_id);
CREATE INDEX management_operations_correlation_id_idx ON governance.management_operations (correlation_id);
CREATE INDEX management_operations_status_idx ON governance.management_operations (status);
CREATE INDEX management_operations_target_tenant_id_idx ON governance.management_operations (target_tenant_id);

-- --- Thread operation/causation identity through the existing event ledger --
--
-- Additive only. operator_audit_log's own append-only convention, indexes,
-- and every existing column/constraint from 0002 are untouched.
ALTER TABLE governance.operator_audit_log
  ADD COLUMN operation_id     UUID REFERENCES governance.management_operations (operation_id),
  ADD COLUMN causation_id     UUID,
  ADD COLUMN contract_version TEXT;

CREATE INDEX operator_audit_log_operation_id_idx ON governance.operator_audit_log (operation_id);
