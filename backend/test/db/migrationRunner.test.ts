import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { appliedMigrationIds, runMigrations } from "../../src/db/migrationRunner.js";
import { buildEmptyPgMemClient } from "../helpers/pgMemDb.js";

const migrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));
const migration0001Sql = readFileSync(
  fileURLToPath(new URL("../../migrations/0001_operator_identity_schema.sql", import.meta.url)),
  "utf8",
);

describe("db/migrationRunner", () => {
  it("applies every migration file in order, against real DDL execution (pg-mem)", async () => {
    const client = buildEmptyPgMemClient();

    const results = await runMigrations(client, migrationsDir);

    expect(results.map((r) => r.id)).toEqual([
      "0001_operator_identity_schema.sql",
      "0002_governance_db_foundation.sql",
    ]);
    expect(results.every((r) => r.applied)).toBe(true);

    const tables = (
      await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      )
    ).rows.map((r) => r.table_name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "operators",
        "operator_roles",
        "operator_scopes",
        "operator_sessions",
        "operator_auth_audit_log",
        "management_idempotency_keys",
        "operator_audit_log",
        "schema_migrations",
      ]),
    );
  });

  it("is idempotent — re-running reports every file as already-applied and does not error", async () => {
    const client = buildEmptyPgMemClient();

    await runMigrations(client, migrationsDir);
    const secondRun = await runMigrations(client, migrationsDir);

    expect(secondRun.every((r) => r.applied === false)).toBe(true);
  });

  it("dry-run reports pending migrations without applying them", async () => {
    const client = buildEmptyPgMemClient();

    const dryRunResults = await runMigrations(client, migrationsDir, { dryRun: true });
    expect(dryRunResults.every((r) => r.applied)).toBe(true);

    // Nothing was actually written to schema_migrations beyond the tracking
    // table itself, and no application tables exist yet.
    const applied = await appliedMigrationIds(client);
    expect(applied.size).toBe(0);

    const tables = (
      await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      )
    ).rows.map((r) => r.table_name);
    expect(tables).not.toContain("operators");
  });

  it("applies only the newly-added migration when one is already recorded as applied", async () => {
    const client = buildEmptyPgMemClient();

    // Simulate "0001 was applied previously, in a prior run of this same
    // runner" by actually applying 0001's real DDL and recording it in
    // schema_migrations directly — not via the runner under test, so this
    // test exercises the runner's own "skip already-applied" branch, not
    // its "apply" branch, for 0001.
    await client.query(migration0001Sql);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)`,
    );
    await client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, now())", [
      "0001_operator_identity_schema.sql",
    ]);

    const results = await runMigrations(client, migrationsDir);
    expect(results).toEqual([
      { id: "0001_operator_identity_schema.sql", applied: false },
      { id: "0002_governance_db_foundation.sql", applied: true },
    ]);
  });
});
