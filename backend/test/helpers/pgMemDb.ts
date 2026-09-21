import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import type pg from "pg";

import type { DbClient } from "../../src/db/dbClient.js";
import { PgDbClient } from "../../src/db/pgDbClient.js";

// Builds a fresh pg-mem instance with the pg-mem-compatible Governance migrations applied, then wraps
// its pg-compatible Pool in the same PgDbClient used in production. This
// exercises the real query and pinned-connection transaction behavior rather
// than a hand-rolled DbClient mock.
export function buildMigratedPgMemClient(): { db: ReturnType<typeof newDb>; client: DbClient } {
  const db = newDb();
  db.public.none("CREATE SCHEMA governance;");

  const migration0001Path = fileURLToPath(
    new URL("../../migrations/0001_operator_identity_schema.sql", import.meta.url),
  );
  const migration0002Path = fileURLToPath(
    new URL("../../migrations/0002_governance_db_foundation.sql", import.meta.url),
  );
  const migration0003Path = fileURLToPath(
    new URL("../../migrations/0003_management_operation_ledger.sql", import.meta.url),
  );
  const migration0004Path = fileURLToPath(
    new URL("../../migrations/0004_browser_operator_sessions.sql", import.meta.url),
  );
  const migration0005Path = fileURLToPath(
    new URL("../../migrations/0005_tenant_lifecycle_foundation.sql", import.meta.url),
  );
  const migration0006Path = fileURLToPath(
    new URL("../../migrations/0006_commissioned_tenants_control_fields.sql", import.meta.url),
  );
  const migration0007Path = fileURLToPath(
    new URL("../../migrations/0007_public_onboarding_service_operator.sql", import.meta.url),
  );
  const migration0009Path = fileURLToPath(
    new URL("../../migrations/0009_retire_public_onboarding_service_operator.sql", import.meta.url),
  );
  db.public.none(readFileSync(migration0001Path, "utf8"));
  db.public.none(readFileSync(migration0002Path, "utf8"));
  db.public.none(readFileSync(migration0003Path, "utf8"));
  db.public.none(readFileSync(migration0004Path, "utf8"));
  db.public.none(readFileSync(migration0005Path, "utf8"));
  db.public.none(readFileSync(migration0006Path, "utf8"));
  db.public.none(readFileSync(migration0007Path, "utf8"));
  db.public.none(readFileSync(migration0009Path, "utf8"));

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const client = new PgDbClient(pool as unknown as pg.Pool);

  return { db, client };
}

// Builds a pg-mem instance with the Governance schema already provisioned but
// no application migrations applied yet.
export function buildEmptyPgMemClient(): DbClient {
  const db = newDb();
  db.public.none("CREATE SCHEMA governance;");
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return new PgDbClient(pool as unknown as pg.Pool);
}
