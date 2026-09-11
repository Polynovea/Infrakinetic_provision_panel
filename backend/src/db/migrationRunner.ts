import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { DbClient } from "./dbClient.js";

export interface MigrationResult {
  id: string;
  /** false means already applied in a previous run (skipped this time). */
  applied: boolean;
}

interface AppliedMigrationRow {
  id: string;
  checksum: string;
}

export function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

// The tracking table itself is a single DDL statement, so it does not need a
// multi-statement transaction. Create-then-tolerate avoids a check/create race.
export async function ensureMigrationsTable(client: DbClient): Promise<void> {
  try {
    await client.query(
      `CREATE TABLE governance.schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
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

async function appliedMigrationRows(client: DbClient): Promise<Map<string, string>> {
  const result = await client.query<AppliedMigrationRow>(
    "SELECT id, checksum FROM governance.schema_migrations",
  );
  return new Map(result.rows.map((row) => [row.id, row.checksum]));
}

// Applies each migration file atomically on one pinned PostgreSQL connection.
// The SQL file is sent as one simple-query payload inside that transaction;
// node-postgres supports multi-statement text when no parameters are supplied,
// so this avoids a home-grown SQL splitter that would break on dollar-quoted
// functions or semicolons inside string literals.
//
// Applied migrations are content-addressed with SHA-256. Editing an already-
// applied migration is therefore a hard failure rather than silent drift.
export async function runMigrations(
  client: DbClient,
  migrationsDir: string,
  options: { dryRun?: boolean } = {},
): Promise<MigrationResult[]> {
  await ensureMigrationsTable(client);
  const applied = await appliedMigrationRows(client);
  const files = listMigrationFiles(migrationsDir);
  const results: MigrationResult[] = [];

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const checksum = migrationChecksum(sql);
    const existingChecksum = applied.get(file);

    if (existingChecksum !== undefined) {
      if (existingChecksum !== checksum) {
        throw new Error(
          `Migration checksum mismatch for ${file}: database=${existingChecksum}, source=${checksum}. ` +
            "Applied migrations are immutable; add a new migration instead of editing history.",
        );
      }
      results.push({ id: file, applied: false });
      continue;
    }

    if (options.dryRun) {
      results.push({ id: file, applied: true });
      continue;
    }

    await client.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query(
        "INSERT INTO governance.schema_migrations (id, checksum, applied_at) VALUES ($1, $2, now())",
        [file, checksum],
      );
    });
    results.push({ id: file, applied: true });
  }

  return results;
}
