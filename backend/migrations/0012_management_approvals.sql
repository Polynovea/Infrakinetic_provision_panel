-- Phase 1A.12.5 — the minimal reusable maker-checker approval substrate
-- required for R3 identity operations (§10 of PlatformRectification/
-- Phase1A.12_Ground_Truth_and_Scoping_2026-09-22.md). Deliberately generic
-- (requested_action/target_resource_type/target_resource_id, not
-- identity-specific columns): 1A.12 is the first consumer, 1A.19 is
-- explicitly the phase that generalizes/hardens/certifies this across every
-- high-risk Phase-1A vertical — building an identity-only table now would
-- have to be thrown away then.
--
-- approval != execution. An approved row grants exactly one execution
-- (executed_at, set once); executing again requires a new approval bound to
-- a new safe_payload_hash, even if the underlying request is identical.

CREATE TABLE governance.management_approvals (
  approval_id           UUID PRIMARY KEY,
  requested_action      TEXT NOT NULL,
  target_tenant_id      UUID,
  target_resource_type  TEXT NOT NULL,
  target_resource_id    TEXT NOT NULL,
  -- Bound to the exact request this approval covers (same hashing as
  -- governance.management_operations.safe_payload_hash) — changing the
  -- target/action/payload after approval invalidates it: execution
  -- recomputes this hash from the request being executed and must match.
  safe_payload_hash     TEXT NOT NULL,
  risk_class            TEXT NOT NULL CHECK (risk_class IN ('R3', 'R4')),
  reason                TEXT NOT NULL,
  maker_operator_id     UUID NOT NULL REFERENCES governance.operators (operator_id),
  checker_operator_id   UUID REFERENCES governance.operators (operator_id),
  status                TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  correlation_id        UUID NOT NULL,
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at            TIMESTAMPTZ,
  executed_at           TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL,
  -- Maker cannot approve/reject their own request — enforced in the
  -- application layer (needs to produce a typed, audit-friendly error
  -- rather than a bare constraint violation) AND here as a fail-closed
  -- backstop against an application bug.
  CONSTRAINT management_approvals_maker_not_checker CHECK (checker_operator_id IS NULL OR checker_operator_id <> maker_operator_id),
  CONSTRAINT management_approvals_decided_consistency CHECK (
    (status = 'pending' AND checker_operator_id IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected') AND checker_operator_id IS NOT NULL AND decided_at IS NOT NULL)
    OR (status = 'expired')
  ),
  CONSTRAINT management_approvals_executed_requires_approved CHECK (executed_at IS NULL OR status = 'approved')
);

CREATE INDEX management_approvals_target_idx
  ON governance.management_approvals (target_resource_type, target_resource_id);

CREATE INDEX management_approvals_status_idx
  ON governance.management_approvals (status, expires_at);

COMMENT ON TABLE governance.management_approvals IS
  'Minimal reusable maker-checker approval substrate for R3/R4 management operations (1A.12). No sensitive credential material is ever stored here — only safe control metadata.';

-- Rollback (manual, before any deployment depends on it):
-- DROP TABLE governance.management_approvals;
