# Governance DB provisioning

Infrastructure setup, run once by a human/session with privileged access to
the existing RDS instance. Not part of the application's own migration
chain (`backend/migrations/`, applied by `npm run db:migrate` as the
`governance_app` role against the already-existing database/schema) — this
is what makes that role and schema exist in the first place.

**Corrected 2026-09-11**: Phase 1A Governance shares the SAME existing
production Postgres database as Infrakinetic — it does not get its own
database. Isolation is a dedicated schema (`governance`) owned by a
dedicated role (`governance_app`), not database-level separation. An
earlier version of this script created a separate database; that was the
wrong infrastructure assumption and has been corrected. See
`docs/1A.3_status.md` "Architecture correction" for the full record.

**Not executed anywhere as of 1A.3.** This session has neither AWS
credentials nor a reachable path to the production RDS instance. See
`docs/1A.3_status.md`.

## Steps

1. Generate a strong random password out-of-band (not derived from, or
   related to, any Infrakinetic credential).
2. Edit `001_create_role_and_schema.sql` locally, replacing the placeholder
   password. **Never commit the edited file with a real password** — run
   it and discard the local edit, or keep the real version only in a
   secret manager.
3. Open a tunnel to the existing production database (through the existing
   EC2 host — do not treat EC2 itself as a development environment; it is
   only the path to RDS). Run the script as the existing database admin
   identity against the EXISTING `polynoveacrm` database — not a new one:
   `psql -h <tunnel-local-host> -p <tunnel-local-port> -U <admin> -d polynoveacrm -f 001_create_role_and_schema.sql`.
4. Run the application's own migrations against the new schema:
   `GOVERNANCE_DB_HOST=<tunnel-local-host> GOVERNANCE_DB_PORT=<tunnel-local-port> GOVERNANCE_DB_NAME=polynoveacrm GOVERNANCE_DB_USER=governance_app GOVERNANCE_DB_PASSWORD=... npm run db:migrate` (from `backend/`).
5. Set the same `GOVERNANCE_DB_*` values on the deployed backend's
   environment (see `backend/.env.example`) — `GOVERNANCE_DB_NAME` is the
   same database name Infrakinetic uses (`polynoveacrm`); isolation comes
   from connecting as `governance_app`, not from a different database
   name.
6. Verify: boot the backend, confirm `/healthz` still returns 200 (it must
   never depend on the database — see `src/db/dbConfig.ts`), then exercise
   one real `/management/v1/whoami` call with a valid bearer token and
   confirm the operator record now round-trips through Postgres instead of
   the in-memory fixture.
7. **Prove the negative**, and record the exact output in
   `docs/1A.3_status.md`: connect as `governance_app` and attempt to read
   an actual Infrakinetic table (e.g. `SELECT 1 FROM public.tenants
   LIMIT 1;` or whatever table is safe to reference read-only) — must be
   rejected. This is the real evidence for "zero access to Infrakinetic
   application tables," not an assertion.

## What this deliberately does not do

- Does not create a second database. Governance and Infrakinetic share one
  Postgres database (`polynoveacrm`) on the existing RDS instance.
- Does not grant `governance_app` anything on `public` or any other
  existing schema — provable by the total absence of any `GRANT`
  statement referencing `public` (or any Infrakinetic table/schema)
  anywhere in `001_create_role_and_schema.sql` or this repository.
- Does not grant `governance_app` `SUPERUSER`, `CREATEDB`, `CREATEROLE`, or
  `BYPASSRLS` — see the CREATE ROLE statement's explicit `NO*` flags.
- Does not revoke the `PUBLIC` pseudo-role's own default schema-level
  grants (a database-wide posture change, out of scope for this bootstrap
  — see the script's own trailing comment).
- Does not configure backups or connection pooling infrastructure
  (PgBouncer, RDS Proxy, etc.) — none of those are 1A.3 deliverables per
  the master plan's §64 "1A.3 — Governance DB" scope.
