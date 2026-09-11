-- 1A.3 — Governance DB provisioning script.
--
-- STATUS: authored, NOT executed anywhere. This session has neither AWS
-- credentials nor a reachable Postgres server (local or RDS) — see
-- docs/1A.3_status.md "DB/AWS provisioning required to finish live 1A.3".
-- This is infrastructure setup, run once by a human with superuser access
-- to the target Postgres server. It is deliberately separate from
-- migrations/ (which the application's own migration runner applies as
-- the governance_app role against an already-existing database) — this
-- script is what makes that database and role exist in the first place.
--
-- Run as a Postgres superuser (or a role with CREATEROLE/CREATEDB), against
-- the target server, NOT against Infrakinetic's existing database or
-- instance role (README.md hard rules #2/#3/#8; master plan §18 "no grants
-- on Infrakinetic business DB").
--
-- Usage:
--   1. Replace CHANGE_ME_BEFORE_RUNNING below with a real, generated secret
--      (this file must never be committed with a real password — it is
--      checked into git as a template with an intentionally-invalid
--      placeholder value so it cannot be run as-is by accident).
--   2. psql -h <host> -U <superuser> -d postgres -f 001_create_role_and_database.sql
--   3. Record the resulting host/port/database/role in whatever secret
--      store deploys GOVERNANCE_DB_* to the backend — never in this repo.

-- Dedicated role for this application only. LOGIN so the backend and the
-- migration runner can both connect as it; NOSUPERUSER/NOCREATEROLE so a
-- compromised backend process cannot escalate or create further roles.
-- Password policy at least as strong as Infrakinetic's own credentials —
-- this placeholder is intentionally invalid (fails Postgres's minimum
-- password requirements in most configurations) so this script cannot be
-- run unmodified and silently succeed with a known/weak password.
CREATE ROLE governance_app WITH
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  PASSWORD 'CHANGE_ME_BEFORE_RUNNING__min_32_random_chars';

-- Separate database. This role owns it (needed to run CREATE TABLE via the
-- migration runner) — there is no separate migration-owner vs.
-- runtime-DML-only role split at 1A.3. That split is a reasonable future
-- hardening (tracked for 1A.19) but is not required to satisfy this
-- subphase's literal exit criterion ("Governance backend can access its
-- own DB; zero grants on Infrakinetic DB") and is left undone now rather
-- than built speculatively.
CREATE DATABASE polynovea_platform_governance OWNER governance_app;

-- Zero grants on any Infrakinetic database or role are issued anywhere in
-- this file, on purpose — there is nothing to revoke because nothing was
-- ever granted. This is the literal mechanism behind the 1A.3 exit
-- criterion "zero grants on Infrakinetic DB": provable by the absence of
-- any statement here (or anywhere in this repository) naming
-- Infrakinetic's database, and independently provable by connecting to
-- Infrakinetic's actual database as `governance_app` and observing that no
-- such role exists there at all — a role created on one Postgres server
-- (or even one CREATE ROLE statement scoped to this database's own
-- instance) is not visible to a separate instance/database it was never
-- granted against.
