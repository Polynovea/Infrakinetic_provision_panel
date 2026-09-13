import { createHash } from "node:crypto";
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
const migration0002Sql = readFileSync(
  fileURLToPath(new URL("../../migrations/0002_governance_db_foundation.sql", import.meta.url)),
  "utf8",
);

describe("db/migrationRunner", () => {
  it("applies every migration file in order, against real DDL execution (pg-mem)", async () => {
    const client = buildEmptyPgMemClient();

    const results = await runMigrations(client, migrationsDir);

    expect(results.map((r) => r.id)).toEqual([
      "0001_operator_identity_schema.sql",
      "0002_governance_db_foundation.sql",
      "0003_management_operation_ledger.sql",
    ]);
    expect(results.every((r) => r.applied)).toBe(true);

    // Not filtered by table_schema: pg-mem always reports 'public' in
    // information_schema.tables.table_schema regardless of the table's
    // real schema (confirmed by direct probe — a pg-mem introspection
    // limitation, not a real Postgres restriction). This proves every
    // expected table and the runner's own bookkeeping table exist and were
    // created via the qualified `governance.*` DDL in the migration files
    // (which pg-mem DOES resolve/execute correctly — only its
    // introspection views mislabel the result); it does not re-prove true
    // schema isolation, which can only be certified against a real
    // Postgres server (see docs/1A.3_status.md "Architecture correction").
    const tables = (
      await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables ORDER BY table_name",
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
        "management_operations",
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

  it("fails closed when an applied migration checksum no longer matches source", async () => {
    const client = buildEmptyPgMemClient();
    await runMigrations(client, migrationsDir);
    await client.query(
      "UPDATE governance.schema_migrations SET checksum = 'tampered' WHERE id = $1",
      ["0001_operator_identity_schema.sql"],
    );

    await expect(runMigrations(client, migrationsDir)).rejects.toThrow(/Migration checksum mismatch/);
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
      await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables ORDER BY table_name")
    ).rows.map((r) => r.table_name);
    expect(tables).not.toContain("operators");
  });

  it("applies only the newly-added migration when one is already recorded as applied", async () => {
    const client = buildEmptyPgMemClient();

    // Simulate "0001 was applied previously, in a prior run of this same
    // runner" by actually applying 0001's real DDL and recording it in
    // governance.schema_migrations directly — not via the runner under
    // test, so this test exercises the runner's own "skip already-applied"
    // branch, not its "apply" branch, for 0001.
    await client.query(migration0001Sql);
    await client.query(
      `CREATE TABLE governance.schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL)`,
    );
    const checksum = createHash("sha256").update(migration0001Sql, "utf8").digest("hex");
    await client.query("INSERT INTO governance.schema_migrations (id, checksum, applied_at) VALUES ($1, $2, now())", [
      "0001_operator_identity_schema.sql",
      checksum,
    ]);

    const results = await runMigrations(client, migrationsDir);
    expect(results).toEqual([
      { id: "0001_operator_identity_schema.sql", applied: false },
      { id: "0002_governance_db_foundation.sql", applied: true },
      { id: "0003_management_operation_ledger.sql", applied: true },
    ]);
  });

  // 1A.5 migration-upgrade proof (instruction #14): a database already at
  // exactly 1A.4's live schema state (0001+0002 applied, matching
  // docs/1A.3_status.md's live evidence) upgrades cleanly to 1A.5 by
  // applying only 0003 — proving 0003 is a genuine additive upgrade path,
  // not something that assumes a from-scratch install.
  it("upgrades a database already at the 1A.4 live schema state by applying only 0003", async () => {
    const client = buildEmptyPgMemClient();

    await client.query(migration0001Sql);
    await client.query(migration0002Sql);
    await client.query(
      `CREATE TABLE governance.schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL)`,
    );
    for (const [id, sql] of [
      ["0001_operator_identity_schema.sql", migration0001Sql],
      ["0002_governance_db_foundation.sql", migration0002Sql],
    ] as const) {
      const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
      await client.query("INSERT INTO governance.schema_migrations (id, checksum, applied_at) VALUES ($1, $2, now())", [
        id,
        checksum,
      ]);
    }

    const results = await runMigrations(client, migrationsDir);
    expect(results).toEqual([
      { id: "0001_operator_identity_schema.sql", applied: false },
      { id: "0002_governance_db_foundation.sql", applied: false },
      { id: "0003_management_operation_ledger.sql", applied: true },
    ]);

    // Idempotent from here on, same as every other migration.
    const secondRun = await runMigrations(client, migrationsDir);
    expect(secondRun.every((r) => r.applied === false)).toBe(true);

    const tables = (
      await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables ORDER BY table_name")
    ).rows.map((r) => r.table_name);
    expect(tables).toContain("management_operations");
  });
});
