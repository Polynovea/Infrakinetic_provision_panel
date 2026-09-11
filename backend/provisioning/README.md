# Governance DB provisioning

Infrastructure setup, run once by a human/session with privileged access to
the existing RDS instance. Not part of the application's own migration
chain (`backend/migrations/`, applied by `npm run db:migrate` as the
`governance_app` role against the already-existing database/schema) — this
is what makes that role, database and schema exist in the first place.

**Topology** (see `001_create_role_database_and_schema.sql`'s own header
for the full record of two corrections along the way): same RDS instance
as Infrakinetic, but a SEPARATE database (`polynovea_governance`, not
`polynoveacrm`) and a separate role (`governance_app`). The `governance`
schema inside `polynovea_governance` is defense in depth on top of the
database-level separation, not a substitute for it.

**Not executed anywhere as of 1A.3.** This session has neither AWS
credentials nor a reachable path to the production RDS instance. See
`docs/1A.3_status.md`.

## Steps

1. Generate a strong random password out-of-band (not derived from, or
   related to, any Infrakinetic credential).
2. Edit `001_create_role_database_and_schema.sql` locally, replacing the
   placeholder password. **Never commit the edited file with a real
   password** — run it and discard the local edit, or keep the real
   version only in a secret manager.
3. Open a tunnel to the existing production RDS instance (through the
   existing EC2 host — do not treat EC2 itself as a development
   environment; it is only the path to RDS). Run the script with **psql
   specifically** (it uses `\connect` to switch databases mid-script,
   which only psql supports) as the existing database admin identity:
   `psql -h <tunnel-local-host> -p <tunnel-local-port> -U <admin> -d polynoveacrm -f 001_create_role_database_and_schema.sql`.
4. **Immediately after running it, prove the negative path before doing
   anything else** — record the exact output of each in
   `docs/1A.3_status.md`:
   - `psql -h <host> -p <port> -U governance_app -d polynoveacrm` — must
     fail to even connect (`REVOKE CONNECT` from the script).
   - As `governance_app` connected to `polynovea_governance`: attempt
     `CREATE DATABASE x;` and `CREATE ROLE y;` — both must fail
     (`NOCREATEDB`/`NOCREATEROLE`).
5. Prove the positive path: as `governance_app` connected to
   `polynovea_governance`, confirm `SHOW search_path;` reports `governance`
   and `\dn` shows the `governance` schema owned by `governance_app`.
6. Run the application's own migrations against the new database:
   `GOVERNANCE_DB_HOST=<tunnel-local-host> GOVERNANCE_DB_PORT=<tunnel-local-port> GOVERNANCE_DB_NAME=polynovea_governance GOVERNANCE_DB_USER=governance_app GOVERNANCE_DB_PASSWORD=... npm run db:migrate` (from `backend/`).
7. Set the same `GOVERNANCE_DB_*` values on the deployed backend's
   environment (see `backend/.env.example`).
8. Verify: boot the backend, confirm `/healthz` still returns 200 (it must
   never depend on the database — see `src/db/dbConfig.ts`), then exercise
   one real `/management/v1/whoami` call with a valid bearer token and
   confirm the operator record now round-trips through Postgres instead of
   the in-memory fixture.

## What this deliberately does not do

- Does not put Governance objects inside `polynoveacrm` (Infrakinetic's own
  database) — even with a dedicated schema, that was an earlier, corrected
  mistake. See `docs/1A.3_status.md` "Architecture correction".
- Does not grant `governance_app` anything on `polynoveacrm` — and
  explicitly revokes `CONNECT` on it, rather than relying on "nothing was
  ever granted" (PostgreSQL grants `CONNECT` to `PUBLIC` on every database
  by default, so an explicit revoke is required to actually prove
  isolation — see the script's own comment).
- Does not grant `governance_app` `SUPERUSER`, `CREATEDB`, `CREATEROLE`, or
  `BYPASSRLS` — see the `CREATE ROLE` statement's explicit `NO*` flags.
- Does not configure backups or connection pooling infrastructure
  (PgBouncer, RDS Proxy, etc.) — none of those are 1A.3 deliverables per
  the master plan's §64 "1A.3 — Governance DB" scope.

## Known, separately-tracked historical finding (not 1A.3 scope)

If the RDS master/admin identity used for this bootstrap is *also*
Infrakinetic's own ordinary runtime application credential (as it appears
to be, per `api-server/INFRASTRUCTURE.md` and `api-server/.env` — the same
`polynovea2021` account is both), that is a pre-existing condition on the
shared instance unrelated to Governance. Record it as a security-hardening
finding (least-privilege: an application should not run as the instance's
master/admin account); do not fold remediating it into 1A.3 scope.
