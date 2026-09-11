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

// Builds an *unmigrated* pg-mem instance (no schema applied yet) as a
// DbClient — used to test the migration runner itself (schema_migrations
// bookkeeping, idempotent re-run, dry-run) against real DDL execution.
export function buildEmptyPgMemClient(): DbClient {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return {
    query: (text: string, params?: readonly unknown[]) => pool.query(text, params as unknown[] | undefined),
  };
}
