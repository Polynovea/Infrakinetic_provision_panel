# Governance DB provisioning

Infrastructure setup, run once by a human/session with privileged access to the existing RDS instance. This is not part of the application's normal migration chain (`backend/migrations/`); it creates the dedicated Governance role/database/schema that the migration runner then uses.

## Topology

Same RDS PostgreSQL instance as Infrakinetic, but a separate database and role:

```text
RDS PostgreSQL instance
├── polynoveacrm
│   └── Infrakinetic application/admin roles
└── polynovea_governance
    └── governance schema
        └── governance_app
```

`governance_app` is intentionally **not** the database owner. The provisioning admin owns `polynovea_governance`; `governance_app` owns only the `governance` schema. `PUBLIC` receives no privileges on the new Governance database.

Nothing in this directory has been executed against live RDS as part of the local 1A.3 implementation. Live evidence remains required before 1A.3 can close.

## Steps

1. Generate a strong random `governance_app` password out of band. Never copy an Infrakinetic credential.
2. Establish the existing SSH tunnel through EC2 to the RDS instance. Use EC2 only as the bastion path; do not treat it as the development environment.
3. Run `001_create_role_database_and_schema.sql` with **psql** as the existing privileged RDS admin/master identity. Pass the Governance password as a psql variable rather than editing it into the tracked file:

   ```text
   psql -h 127.0.0.1 -p 5433 -U <admin> -d polynoveacrm \
     -v governance_password='<generated-secret>' \
     -f backend/provisioning/001_create_role_database_and_schema.sql
   ```

4. Still as the privileged admin, run the read-only effective-privilege audit against the existing Infrakinetic database:

   ```text
   psql -h 127.0.0.1 -p 5433 -U <admin> -d polynoveacrm \
     -f backend/provisioning/002_verify_cross_database_isolation.sql
   ```

   This is deliberately an **effective privilege** check, not a direct-GRANT check. PostgreSQL permissions are additive: `REVOKE ... FROM governance_app` does not override privileges inherited from `PUBLIC`. The verifier therefore fails if `governance_app` can effectively `CONNECT` to `polynoveacrm`, has administrative role attributes, or inherits another role.

5. If the verifier reports that `PUBLIC` still gives effective access to `polynoveacrm`, do **not** guess an allow-list and do not blindly revoke `PUBLIC` in production. First inventory every legitimate login role that currently needs the database, then perform a separately reviewed ACL hardening change that revokes `CONNECT` from `PUBLIC` and explicitly grants the legitimate roles. Rerun the verifier until it passes.

6. Positive-path checks as `governance_app` against `polynovea_governance`:
   - connection succeeds;
   - `SHOW search_path` resolves `governance`;
   - `governance` schema exists and is owned by `governance_app`;
   - `CREATE ROLE` fails;
   - `CREATE DATABASE` fails.

7. Run the Governance migrations as `governance_app`:

   ```text
   GOVERNANCE_DB_HOST=127.0.0.1
   GOVERNANCE_DB_PORT=5433
   GOVERNANCE_DB_NAME=polynovea_governance
   GOVERNANCE_DB_USER=governance_app
   GOVERNANCE_DB_PASSWORD=<secret>
   npm run db:migrate
   ```

   The migration runner applies each migration on one pinned PostgreSQL connection inside a transaction and records a SHA-256 checksum. Re-running is idempotent; modifying an already-applied migration is rejected as checksum drift.

8. Re-run `npm run db:migrate` to prove idempotency, then run `npm run db:migrate -- --dry-run` and the full test suite against the real database where applicable.
9. Configure the deployed Governance backend with the same `GOVERNANCE_DB_*` runtime values. The RDS admin/master credential must never appear in Governance runtime configuration.
10. Boot the backend and prove `/healthz` remains independent of DB/Cognito configuration. Then perform the real Postgres-backed operator/session smoke tests required by `docs/1A.3_status.md`.

## Important isolation details

A direct statement such as:

```sql
REVOKE CONNECT ON DATABASE polynoveacrm FROM governance_app;
```

is **not a deny rule**. If `PUBLIC` has `CONNECT`, `governance_app` still has effective `CONNECT`. PostgreSQL also commonly grants function `EXECUTE` to `PUBLIC`; Infrakinetic contains `SECURITY DEFINER` functions. This is why 1A.3 must certify effective cross-database privileges against real RDS rather than infer isolation from an absence of explicit grants.

The bootstrap script therefore does not make blind ACL changes inside `polynoveacrm`. It creates the new Governance database safely, while `002_verify_cross_database_isolation.sql` supplies the mandatory live gate for the existing database.

## What this deliberately does not do

- It does not put Governance objects in `polynoveacrm`.
- It does not give `governance_app` `SUPERUSER`, `CREATEDB`, `CREATEROLE`, or `BYPASSRLS`.
- It does not make `governance_app` owner of the whole Governance database.
- It does not create or modify Cognito, EC2, DNS, Vercel, tenants, or real operators.
- It does not configure backups, PgBouncer, or RDS Proxy; those are outside 1A.3.

## Separate Infrakinetic credential finding

If the RDS admin/master identity used for the one-time bootstrap is also used as an Infrakinetic runtime credential, treat that as an Infrakinetic least-privilege/security-hardening item. Governance must still use only `governance_app` at runtime. Do not expand 1A.3 into a general Infrakinetic DB-role migration unless that issue directly blocks Governance provisioning.
