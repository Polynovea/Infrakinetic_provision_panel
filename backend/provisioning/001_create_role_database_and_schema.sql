-- 1A.3 — Governance DB provisioning script.
--
-- Topology (corrected 2026-09-11, twice — see docs/1A.3_status.md
-- "Architecture correction" for the full record of both passes):
--
--   existing RDS PostgreSQL instance
--   ├── existing Infrakinetic database (polynoveacrm)
--   │   └── existing Infrakinetic application role(s)
--   └── polynovea_governance database   <- this script creates this
--       └── governance_app role         <- and this
--           └── governance schema       <- and this, inside the new database
--
-- Same RDS instance as Infrakinetic (co-location is an explicitly allowed
-- temporary deployment optimization per the master plan's §14/§18) —
-- SEPARATE database, separate role. The `governance` schema inside
-- `polynovea_governance` is defense in depth on top of that, not a
-- substitute for it.
--
-- STATUS: authored, NOT executed anywhere. This session has no reachable
-- Postgres server/AWS access to run it yet — see docs/1A.3_status.md.
-- This is infrastructure setup, run once by a human/session with
-- privileged access to the existing RDS instance (the existing admin
-- identity documented in api-server/INFRASTRUCTURE.md — no new admin
-- account is created by this script).
--
-- REQUIRES psql specifically (not just any Postgres client / the `pg`
-- driver): the `\connect` meta-commands below switch databases mid-script,
-- which is a psql feature, not standard SQL — a single Postgres connection
-- cannot change which database it is attached to. Run as:
--   psql -h <tunnel-local-host> -p <tunnel-local-port> -U <admin> -d polynoveacrm -f 001_create_role_database_and_schema.sql
--
-- Usage:
--   1. Replace CHANGE_ME_BEFORE_RUNNING below with a real, generated secret
--      (this file must never be committed with a real password — it is
--      checked into git as a template with an intentionally-invalid
--      placeholder value so it cannot be run as-is by accident).
--   2. Run as above.
--   3. Record the resulting host/port/database/role in whatever secret
--      store deploys GOVERNANCE_DB_* to the backend — never in this repo.
--
-- Bootstrap credential: per explicit instruction, it is acceptable to use
-- the existing privileged RDS master/admin identity for this ONE-TIME
-- role/database/schema creation, provided (a) it is verified to actually
-- have sufficient authority on this instance before relying on it, (b) it
-- is used only for this bootstrap step, never copied into
-- GOVERNANCE_DB_USER/PASSWORD, and (c) its password is never committed.
-- After this script finishes, every subsequent Governance operation
-- (migrations, runtime) connects as governance_app only. If that admin
-- identity is also currently reused as an ordinary Infrakinetic runtime
-- application credential, that is a pre-existing condition on the shared
-- instance, not something this script changes or is responsible for
-- correcting — record it separately as a security-hardening finding
-- (see docs/1A.3_status.md) rather than expanding this subphase's scope.

-- --- Role -------------------------------------------------------------
--
-- Dedicated role for this application only. LOGIN so the backend and the
-- migration runner can both connect as it. Explicitly denied every
-- privilege that would let it act as an administrator of this shared
-- instance or read/write outside its own database:
--   NOSUPERUSER  — cannot bypass any permission check
--   NOCREATEDB   — cannot create further databases
--   NOCREATEROLE — cannot create or alter other roles (cannot escalate
--                  itself or create a new privileged identity)
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

-- --- Database -----------------------------------------------------------
--
-- Separate database on the SAME RDS instance — co-location is allowed
-- (master plan §14/§18); a separate physical instance is a later,
-- independently-authorized move, not required for 1A.3. Owned by
-- governance_app directly: it has NOCREATEDB (cannot create further
-- databases) but full authority to administer this one database it
-- already owns — no further per-object grants are needed for it to run
-- its own migrations or serve its own runtime queries inside it.
CREATE DATABASE polynovea_governance OWNER governance_app;

-- --- Explicit isolation proof, not an absence-of-grant assumption -------
--
-- A brand-new role is not automatically able to read/write any existing
-- table (Postgres denies table-level DML by default), but it CAN by
-- default CONNECT to every existing database — `CONNECT` is granted to
-- the `PUBLIC` pseudo-role on every database unless explicitly revoked,
-- and every role is implicitly a member of PUBLIC. Without the statement
-- below, governance_app could open a session against `polynoveacrm` (even
-- though it could not read/write anything once connected, absent further
-- grants) — "we never granted it anything" is not the same claim as "it
-- cannot even connect." This makes the boundary explicit and independently
-- provable: attempting to connect as governance_app to polynoveacrm after
-- this line must fail at the connection step itself.
--
-- Database-level GRANT/REVOKE targets a cluster-wide object and does not
-- require being connected to that specific database, so this line runs
-- here, before the \connect below.
REVOKE CONNECT ON DATABASE polynoveacrm FROM governance_app;

-- Belt-and-suspenders inside polynoveacrm itself, in case CONNECT is ever
-- mistakenly re-granted later: explicit schema/table/sequence/function
-- revokes rather than relying on nothing having been granted. Safe no-ops
-- if nothing was ever granted (REVOKE on a privilege that was never held
-- is not an error).
\connect polynoveacrm
REVOKE ALL ON SCHEMA public FROM governance_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM governance_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM governance_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM governance_app;

-- --- Schema, inside the new Governance database --------------------------
--
-- Schemas are per-database objects — creating one requires being connected
-- to the database it will live in, hence the \connect. Defense in depth on
-- top of the database-level separation above, not a substitute for it:
-- even within its own database, governance_app's objects are confined to
-- this schema rather than the default `public` schema of
-- polynovea_governance.
\connect polynovea_governance

CREATE SCHEMA governance AUTHORIZATION governance_app;

-- Makes `governance` the ONLY schema governance_app resolves unqualified
-- names against by default, for every future connection authenticated as
-- this role — server-enforced, not dependent on the application
-- remembering to set it. (The application layer additionally sets this
-- per-connection for defense in depth — see backend/src/db/pgDbClient.ts —
-- but this is the authoritative, harder-to-bypass layer.) Deliberately
-- does NOT include `public` — an unqualified reference to a table that
-- only exists in polynovea_governance's own default `public` schema will
-- fail to resolve at all for this role, rather than silently succeeding
-- against the wrong table.
ALTER ROLE governance_app SET search_path = governance;

-- No further GRANT statement of any kind appears below. governance_app
-- owns both the database and the schema it will use, which already grants
-- it everything it needs for its own migrations/runtime — and it has no
-- privilege of any kind, anywhere, on `polynoveacrm`, per the explicit
-- revokes above.
--
-- Live certification (docs/1A.3_status.md) must record, verbatim, the
-- actual SQL output of:
--   - connecting as governance_app to polynovea_governance and running the
--     Governance migrations (positive path);
--   - attempting to connect as governance_app to polynoveacrm (must fail
--     at the connection step — negative path);
--   - attempting CREATE ROLE / CREATE DATABASE as governance_app (must
--     fail — self-escalation path).
