-- Phase 1A.8.1 (reconciliation follow-up) — extends
-- governance.commissioned_tenants (0005) with the desired/control fields the
-- 1A.8.0 scoping document locks as part of this record's required shape
-- (Phase1A.8_Ground_Truth_and_Scoping_2026-09-16.md §8: "commission
-- reference, runtime tenant ID once known, desired slug/name, desired plan,
-- account type, Governance lifecycle state, last observed runtime status,
-- responsible operator, created/requested/approved/provisioning/active/
-- suspended/decommissioned timestamps, last observed timestamp, last
-- operation ID"). 0005 shipped lifecycle_state/provenance/last_operation_id/
-- created_at/updated_at; this migration adds the remaining fields the same
-- document names, purely additively — no ALTER on any 0001-0005 constraint
-- or column, no data migration required (every new column is nullable, safe
-- for the zero existing rows this table has at 1A.8.1).
--
-- PII boundary (scoping doc §3.8/§4.12): deliberately does NOT add
-- admin_email/admin_name or any other tenant business data/PII — that stays
-- Infrakinetic-owned (tenant_pending_admins/app_users/Cognito). This is
-- fleet/control metadata only.
--
-- last_observed_platform_access_state mirrors Infrakinetic's
-- tenants.platform_access_state (fact #2 of the scoping doc's three-fact
-- model, added by the sibling Infrakinetic-side migration) — a denormalized
-- read-cache for fast UI display, never the source of truth (a fresh
-- GET /management/v1/tenants/:identifier read always is). It deliberately
-- excludes 'trial'/'cancelled' — those belong only to Infrakinetic's
-- Billing-owned commercial tenants.status, which Governance never observes
-- into this projection.

ALTER TABLE governance.commissioned_tenants
  ADD COLUMN desired_name                        TEXT,
  ADD COLUMN desired_slug                        TEXT,
  ADD COLUMN desired_plan                        TEXT,
  ADD COLUMN account_type                        TEXT CHECK (account_type IS NULL OR account_type IN ('demo', 'live')),
  ADD COLUMN last_observed_platform_access_state  TEXT CHECK (last_observed_platform_access_state IS NULL OR last_observed_platform_access_state IN ('active', 'suspended', 'decommissioned')),
  ADD COLUMN last_observed_at                     TIMESTAMPTZ,
  ADD COLUMN responsible_operator_id              UUID REFERENCES governance.operators (operator_id),
  ADD COLUMN requested_at                         TIMESTAMPTZ,
  ADD COLUMN approved_at                          TIMESTAMPTZ,
  ADD COLUMN provisioning_started_at              TIMESTAMPTZ,
  ADD COLUMN active_at                            TIMESTAMPTZ,
  ADD COLUMN suspended_at                         TIMESTAMPTZ,
  ADD COLUMN decommission_requested_at            TIMESTAMPTZ,
  ADD COLUMN decommissioned_at                    TIMESTAMPTZ;
