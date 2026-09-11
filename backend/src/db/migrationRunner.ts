import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DbClient } from "./dbClient.js";

export interface MigrationResult {
  id: string;
  /** false means already applied in a previous run (skipped this time). */
  applied: boolean;
}

// Strips full-line `--` comments, then splits on `;`. Every migration file
// in this repository (0001, 0002) uses only full-line comments and no
// dollar-quoted function/trigger bodies, so this simple approach is safe for
// them; it is NOT a general SQL statement splitter and would need
// strengthening (or a real SQL-aware split) before a migration used
// dollar-quoting or a `;` inside a string literal. Chosen over passing the
// whole file to a single query() call because that relies on the "simple
// query protocol" supporting multiple statements per call — true for `pg`
// today, unverified for pg-mem's pg-compatible adapter used in tests — so
// splitting keeps the runner's behavior identical (and testable) against
// both.
function splitStatements(sql: string): string[] {
  const withoutLineComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutLineComments
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

// Create-then-tolerate-already-exists, rather than an existence check
// followed by a plain CREATE TABLE, or `CREATE TABLE IF NOT EXISTS`. Two
// independent tooling limitations ruled out the more obvious forms:
//   - `CREATE TABLE IF NOT EXISTS` fails pg-mem's AST-coverage check when
//     the table already exists (a pg-mem parser limitation, not a real
//     Postgres restriction).
//   - An existence check via `information_schema.tables WHERE table_schema
//     = 'governance'` always returns zero rows against pg-mem — it reports
//     every table's table_schema as 'public' regardless of which schema it
//     was actually created in (confirmed by direct probe; pg_namespace/
//     pg_class are similarly non-functional stubs in pg-mem). Real
//     Postgres reports this correctly; pg-mem does not.
// This form sidesteps both: attempt the CREATE, and treat "already exists"
// as success. It is also strictly safer than a check-then-create pattern
// against a REAL database — no TOCTOU race if two migration runs started
// simultaneously against a brand-new database.
//
// Lives in the `governance` schema, like every other object this
// application owns (CORRECTED 2026-09-11 — see docs/1A.3_status.md
// "Architecture correction"). governance_app owns that schema (granted by
// provisioning/001_create_role_and_schema.sql), so it can create this
// table without any further grant; it has no privilege to create anything
// in `public`.
export async function ensureMigrationsTable(client: DbClient): Promise<void> {
  try {
    await client.query(
      `CREATE TABLE governance.schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      )`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("already exists")) throw err;
  }
}

export async function appliedMigrationIds(client: DbClient): Promise<Set<string>> {
  const result = await client.query<{ id: string }>("SELECT id FROM governance.schema_migrations");
  return new Set(result.rows.map((row) => row.id));
}

// Applies every migration file in migrationsDir, in filename order, that is
// not already recorded in schema_migrations. Idempotent: re-running with
// nothing new to apply is a safe no-op that reports every file as
// already-applied.
//
// NOT transactional across statements or across files — each statement is
// its own query() call (see splitStatements' comment for why), and this
// module's minimal DbClient interface has no cross-call transaction
// primitive. Acceptable for 1A.3's own small, additive-only migrations
// (0001, 0002); a partially-applied migration on failure is a known,
// documented limitation (see docs/1A.3_status.md), not a claim of
// atomicity, and should be hardened before this runner is trusted with a
// migration large or risky enough for partial application to matter.
export async function runMigrations(
  client: DbClient,
  migrationsDir: string,
  options: { dryRun?: boolean } = {},
): Promise<MigrationResult[]> {
  await ensureMigrationsTable(client);
  const applied = await appliedMigrationIds(client);
  const files = listMigrationFiles(migrationsDir);
  const results: MigrationResult[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      results.push({ id: file, applied: false });
      continue;
    }
    if (options.dryRun) {
      results.push({ id: file, applied: true });
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    for (const statement of splitStatements(sql)) {
      await client.query(statement);
    }
    await client.query("INSERT INTO governance.schema_migrations (id, applied_at) VALUES ($1, now())", [file]);
    results.push({ id: file, applied: true });
  }

  return results;
}
