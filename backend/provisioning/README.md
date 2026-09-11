# Governance DB provisioning

Infrastructure setup, run once by a human with Postgres superuser access.
Not part of the application's own migration chain (`backend/migrations/`,
applied by `npm run db:migrate` as the `governance_app` role against an
already-existing database) — this is what makes that database and role
exist in the first place.

**Not executed anywhere as of 1A.3.** This session has neither AWS
credentials nor a reachable Postgres server (local or RDS). See
`docs/1A.3_status.md`.

## Steps

1. Provision (or identify) a Postgres server for this application. It must
   be a physically/logically separate database instance or database from
   Infrakinetic's business database (README.md hard rule #2: "no shared
   database credentials with Infrakinetic's business database"). Same-host
   co-location as a temporary deployment optimization is allowed by the
   master plan (§14) provided the database, role and credentials are fully
   separate — this is about database/role isolation, not physical server
   count.
2. Generate a strong random password out-of-band (not derived from, or
   related to, any Infrakinetic credential).
3. Edit `001_create_role_and_database.sql` locally, replacing the
   placeholder password. **Never commit the edited file with a real
   password** — run it and discard the local edit, or keep the real
   version only in a secret manager.
4. Run it as a superuser: `psql -h <host> -U <superuser> -d postgres -f 001_create_role_and_database.sql`.
5. Run the application's own migrations against the new database:
   `GOVERNANCE_DB_HOST=... GOVERNANCE_DB_PORT=... GOVERNANCE_DB_NAME=polynovea_platform_governance GOVERNANCE_DB_USER=governance_app GOVERNANCE_DB_PASSWORD=... npm run db:migrate` (from `backend/`).
6. Set the same `GOVERNANCE_DB_*` values on the deployed backend's
   environment (see `backend/.env.example`).
7. Verify: boot the backend, confirm `/healthz` still returns 200 (it must
   never depend on the database — see `src/db/dbConfig.ts`), then exercise
   one real `/management/v1/whoami` call with a valid bearer token and
   confirm the operator record now round-trips through Postgres instead of
   the in-memory fixture.

## What this deliberately does not do

- Does not touch, reference, or grant anything on Infrakinetic's database
  or its Postgres role(s).
- Does not create a second migration-owner role vs. runtime role split —
  `governance_app` both owns the database and is what the backend connects
  as. A stricter split is a reasonable future hardening (tracked loosely
  against 1A.19 "hardening") but is not required to satisfy 1A.3's literal
  exit criterion and was not built speculatively.
- Does not configure backups, RLS, or connection pooling infrastructure
  (PgBouncer, RDS Proxy, etc.) — none of those are 1A.3 deliverables per
  the master plan's §64 "1A.3 — Governance DB" scope (separate DB; separate
  role; migrations; base ledger/idempotency schema).
