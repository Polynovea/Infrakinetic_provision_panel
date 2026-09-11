\set ON_ERROR_STOP on

-- 1A.3 — Governance DB initial provisioning.
--
-- Final topology:
--
--   existing RDS PostgreSQL instance
--   ├── polynoveacrm                 (existing Infrakinetic DB)
--   └── polynovea_governance         (new, separate DB)
--       └── governance               (Governance-owned schema)
--           └── governance_app       (runtime + migration role for 1A.3)
--
-- Same RDS instance, separate PostgreSQL database, separate role. No
-- Infrakinetic application credential is reused by Governance.
--
-- This script is intentionally one-time and non-idempotent. It must be run by
-- the existing privileged RDS admin/master identity through the established
-- EC2-bastion tunnel. It must NEVER be run by the Governance application.
--
-- Password handling: do not edit a real password into this file. Invoke psql
-- with a session variable, for example:
--
--   psql -h 127.0.0.1 -p 5433 -U <admin> -d polynoveacrm \
--     -v governance_password='<generated-secret>' \
--     -f backend/provisioning/001_create_role_database_and_schema.sql
--
-- psql substitutes :'governance_password' as a quoted SQL literal. Shell
-- history/secret-manager handling still matters; use the deployment secret
-- mechanism available in the real provisioning session.

\if :{?governance_password}
\else
  \echo 'ERROR: governance_password psql variable is required; refusing to provision.'
  \quit 3
\endif

-- --- Runtime/migration role ------------------------------------------------
--
-- This role is deliberately incapable of administering the shared RDS
-- instance. NOINHERIT does not negate PUBLIC privileges; effective privileges
-- on the existing Infrakinetic DB are verified separately by 002.
CREATE ROLE governance_app WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  NOINHERIT
  PASSWORD :'governance_password';

-- --- Separate Governance database -----------------------------------------
--
-- Do NOT make governance_app the database owner. The provisioning admin owns
-- the database, so governance_app cannot create arbitrary schemas or change
-- database-level ACLs merely because it is the application role.
CREATE DATABASE polynovea_governance;

-- A new PostgreSQL database normally inherits CONNECT/TEMP privileges for the
-- PUBLIC pseudo-role. This is a brand-new Governance-only database, so it is
-- safe to remove those defaults before any workload exists and grant only the
-- Governance role explicit CONNECT. The database owner/admin retains implicit
-- owner rights.
REVOKE ALL ON DATABASE polynovea_governance FROM PUBLIC;
GRANT CONNECT ON DATABASE polynovea_governance TO governance_app;

\connect polynovea_governance

-- Keep Governance objects out of the default public schema. On PostgreSQL
-- versions/upgrades where PUBLIC might retain schema privileges, remove them
-- explicitly before creating any application object.
REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC;

-- governance_app owns only its application schema. Schema ownership is enough
-- for the migration runner to CREATE/ALTER Governance tables while leaving the
-- surrounding database under the bootstrap/admin owner.
CREATE SCHEMA governance AUTHORIZATION governance_app;

-- Scope the search_path setting to the Governance database. A global
-- `ALTER ROLE ... SET search_path` would also apply if the credential were
-- mistakenly pointed at another database on the same RDS instance.
ALTER ROLE governance_app IN DATABASE polynovea_governance SET search_path = governance;

-- --- Existing Infrakinetic database: do not mutate blindly -----------------
--
-- PostgreSQL permissions are additive. In particular, a direct
--
--   REVOKE CONNECT ON DATABASE polynoveacrm FROM governance_app;
--
-- does NOT override CONNECT inherited from the PUBLIC pseudo-role. The same
-- issue applies to PUBLIC EXECUTE on functions, and Infrakinetic contains
-- SECURITY DEFINER functions. Therefore this bootstrap script deliberately
-- makes no ACL changes inside polynoveacrm and makes no false claim that a
-- per-role REVOKE is a DENY.
--
-- Before 1A.3 may close, run the read-only effective-privilege audit in:
--
--   backend/provisioning/002_verify_cross_database_isolation.sql
--
-- If that audit finds dangerous PUBLIC-derived access, harden polynoveacrm's
-- PUBLIC posture only after inventorying every legitimate production/admin
-- role and explicitly re-granting what those roles require. That is safer than
-- embedding a guessed production allow-list in this one-time bootstrap.
--
-- Required live evidence also includes:
--   * governance_app connects to polynovea_governance and runs migrations;
--   * governance_app cannot CREATE ROLE or CREATE DATABASE;
--   * effective cross-database privileges satisfy the 002 verifier;
--   * Governance runtime/migrations use governance_app, never the admin user.
