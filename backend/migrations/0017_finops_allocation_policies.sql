-- Phase 1A.17 — explicit, versioned FinOps allocation policy.
--
-- Platform operating-cost facts come from Infrakinetic/provider evidence. This
-- table stores only Governance CONTROL state: the operator-authored policy that
-- says how otherwise-shared cost may be attributed for analysis. It never posts
-- accounting entries and never mutates module_finance.
--
-- Each replace creates a new immutable policy_version and supersedes the prior
-- active version in one transaction. No implicit/default tenant attribution is
-- stored here: any unmatched fraction remains shared/unallocated.

CREATE TABLE governance.finops_allocation_policies (
  policy_version             UUID PRIMARY KEY,
  supersedes_policy_version  UUID REFERENCES governance.finops_allocation_policies (policy_version),
  status                     TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  -- Array/object shape is enforced by finOpsAllocationPolicy.ts before persistence;
  -- avoid jsonb_typeof here so the production SQL remains executable in the repo's pg-mem test harness.
  rules                      JSONB NOT NULL,
  reason                     TEXT NOT NULL CHECK (reason <> ''),
  created_by                 UUID NOT NULL REFERENCES governance.operators (operator_id),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at              TIMESTAMPTZ
);

CREATE UNIQUE INDEX finops_allocation_policies_one_active_uq
  ON governance.finops_allocation_policies ((1))
  WHERE status = 'active';

CREATE INDEX finops_allocation_policies_created_idx
  ON governance.finops_allocation_policies (created_at DESC);

COMMENT ON TABLE governance.finops_allocation_policies IS
  'Versioned Phase-1A FinOps allocation control state. Unmatched cost remains shared/unallocated; never Finance accounting state.';

-- Rollback (before any deployed policy depends on it):
-- DROP TABLE governance.finops_allocation_policies;
