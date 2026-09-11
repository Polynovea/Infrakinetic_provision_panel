import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";

import type { DbClient } from "../../src/db/dbClient.js";

// Builds a fresh pg-mem instance with 0001 + 0002 applied via pg-mem's own
// DDL executor (proves the migrations are valid DDL, matching the existing
// migrations/0001_operator_identity_schema.test.ts technique), then exposes
// it as a DbClient using pg-mem's pg-compatible Pool adapter (the same
// object shape a real pg.Pool has) — so code written against DbClient
// (PostgresOperatorDirectory, PostgresSessionStore, migrationRunner) can be
// exercised through its real SQL, not a hand-rolled mock.
export function buildMigratedPgMemClient(): { db: ReturnType<typeof newDb>; client: DbClient } {
  const db = newDb();

  // Real provisioning creates this schema as a separate, privileged
  // bootstrap step (provisioning/001_create_role_and_schema.sql) — the
  // migrations themselves never create it, since governance_app has no
  // database-level CREATE privilege, only ownership of this
  // already-existing schema. Replicated here so the migration files can be
  // applied exactly as governance_app would apply them for real.
  db.public.none("CREATE SCHEMA governance;");

  const migration0001Path = fileURLToPath(
    new URL("../../migrations/0001_operator_identity_schema.sql", import.meta.url),
  );
  const migration0002Path = fileURLToPath(
    new URL("../../migrations/0002_governance_db_foundation.sql", import.meta.url),
  );
  db.public.none(readFileSync(migration0001Path, "utf8"));
  db.public.none(readFileSync(migration0002Path, "utf8"));

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const client: DbClient = {
    query: (text: string, params?: readonly unknown[]) => pool.query(text, params as unknown[] | undefined),
  };

  return { db, client };
}

// Builds a pg-mem instance with the `governance` schema created (mirroring
// provisioning having already run) but no migrations applied yet — used to
// test the migration runner itself (schema_migrations bookkeeping,
// idempotent re-run, dry-run) against real DDL execution. Named "empty" for
// migration-application state, not for the schema/role bootstrap step,
// which always precedes migrations in real deployment sequencing too.
export function buildEmptyPgMemClient(): DbClient {
  const db = newDb();
  db.public.none("CREATE SCHEMA governance;");
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return {
    query: (text: string, params?: readonly unknown[]) => pool.query(text, params as unknown[] | undefined),
  };
}
