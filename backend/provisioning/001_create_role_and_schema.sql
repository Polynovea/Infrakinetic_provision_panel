-- 1A.3 — Governance DB provisioning script.
--
-- CORRECTED 2026-09-11: Phase 1A Governance uses the SAME existing
-- production Postgres database as Infrakinetic (polynoveacrm on the
-- existing RDS instance), not a separate database. Isolation is enforced
-- by a dedicated schema (`governance`) owned by a dedicated role
-- (`governance_app`), not by database-level separation. An earlier version
-- of this file (`001_create_role_and_database.sql`, superseded/renamed)
-- created a separate database — that was the wrong infrastructure
-- assumption and has been corrected per explicit instruction. See
-- docs/1A.3_status.md "Architecture correction" for the full record.
--
-- STATUS: authored, NOT executed anywhere. This session has no reachable
-- Postgres server/AWS access to run it yet — see docs/1A.3_status.md.
-- This is infrastructure setup, run once by a human/session with
-- privileged access to the existing RDS instance (the existing admin
-- identity documented in api-server/INFRASTRUCTURE.md — no new admin
-- account is created by this script). It is deliberately separate from
-- migrations/ (which the application's own migration runner applies as
-- the governance_app role against the already-existing database/schema
-- this script creates) — this script is what makes the role and schema
-- exist in the first place.
--
-- Run as the existing RDS/database admin identity, against the EXISTING
-- Infrakinetic database (polynoveacrm) — NOT a new database.
--
-- Usage:
--   1. Replace CHANGE_ME_BEFORE_RUNNING below with a real, generated secret
--      (this file must never be committed with a real password — it is
--      checked into git as a template with an intentionally-invalid
--      placeholder value so it cannot be run as-is by accident).
--   2. psql -h <tunnel-local-host> -p <tunnel-local-port> -U <admin> -d polynoveacrm -f 001_create_role_and_schema.sql
--   3. Record the resulting host/port/database/schema/role in whatever
--      secret store deploys GOVERNANCE_DB_* to the backend — never in
--      this repo.

-- Dedicated role for this application only. LOGIN so the backend and the
-- migration runner can both connect as it. Explicitly denied every
-- privilege that would let it act as an administrator of this shared
-- database or read/write outside its own schema:
--   NOSUPERUSER  — cannot bypass any permission check
--   NOCREATEDB   — cannot create further databases
--   NOCREATEROLE — cannot create or alter other roles
--   NOBYPASSRLS  — cannot bypass row-level security on any table, including
--                  Infrakinetic's own RLS-protected tenant tables
--   NOINHERIT    — does not automatically inherit privileges of any group
--                  role it might later be added to (explicit grants only)
-- Password policy at least as strong as Infrakinetic's own credentials —
-- this placeholder is intentionally invalid (fails Postgres's minimum
-- password requirements in most configurations) so this script cannot be
-- run unmodified and silently succeed with a known/weak password.
CREATE ROLE governance_app WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  NOINHERIT
  PASSWORD 'CHANGE_ME_BEFORE_RUNNING__min_32_random_chars';

-- Dedicated schema, owned by governance_app. Ownership of a schema grants
-- the owner full CREATE/USAGE within that schema automatically — no
-- further GRANT statements are needed for governance_app to run its own
-- migrations or serve its own runtime queries. It grants nothing outside
-- this schema.
CREATE SCHEMA governance AUTHORIZATION governance_app;

-- Makes `governance` the ONLY schema governance_app resolves unqualified
-- names against by default, for every future connection authenticated as
-- this role — server-enforced, not dependent on the application
-- remembering to set it. (The application layer additionally sets this
-- per-connection for defense in depth — see backend/src/db/pgDbClient.ts —
-- but this is the authoritative, harder-to-bypass layer.) Deliberately
-- does NOT include `public` — an unqualified reference to a table that
-- only exists in `public` (e.g. any Infrakinetic table) will fail to
-- resolve at all for this role, rather than silently succeeding against
-- the wrong table.
ALTER ROLE governance_app SET search_path = governance;

-- No GRANT statement of any kind appears below, on purpose. Postgres is
-- deny-by-default for table-level DML: a newly created role has zero
-- SELECT/INSERT/UPDATE/DELETE privilege on any existing table (including
-- every Infrakinetic table in `public`) until an explicit GRANT names it.
-- Nothing here grants anything on `public` or any other existing schema,
-- so governance_app cannot read or write a single Infrakinetic table —
-- provable by connecting as governance_app and attempting one (expected:
-- `permission denied for schema public` or `relation "..." does not
-- exist`, depending on whether the unqualified name resolves at all given
-- the search_path restriction above). Record that exact negative-test
-- output in docs/1A.3_status.md when this script is actually run against
-- the real database.
--
-- Also NOT done here, on purpose (out of scope for this bootstrap,
-- requires separate authorization if ever wanted): revoking the `public`
-- pseudo-role's own default USAGE grant on the `public` schema
-- (`REVOKE ALL ON SCHEMA public FROM PUBLIC`). That is a database-wide
-- security-posture change affecting every current and future role on this
-- shared instance, not something scoped to governance_app alone — it is
-- not required for governance_app's own isolation (USAGE alone does not
-- grant table-level DML) and was not asked for.
