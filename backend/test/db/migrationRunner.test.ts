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
const migration0008Sql = readFileSync(
  fileURLToPath(new URL("../../migrations/0008_operator_scopes_lifecycle_and_plan_scopes.sql", import.meta.url)),
  "utf8",
);
const migration0010Sql = readFileSync(
  fileURLToPath(new URL("../../migrations/0010_retire_tenant_plan_write_scope.sql", import.meta.url)),
  "utf8",
);

// pg-mem does not preserve PostgreSQL's auto-generated name for 0001's
// inline operator_scopes CHECK constraint. 0008 correctly drops that real
// production name, but pg-mem therefore cannot replay that one DDL step from
// the literal 0001 source. The dedicated 0008 migration test exercises the
// DDL against a production-shaped, explicitly named constraint. Generic
// migration-runner tests pre-record 0008 and 0010 as applied so they can continue
// proving ordering, checksums, idempotency and upgrade behavior for the rest
// of the real migration chain without falsifying the production migrations.
async function runMigrationsWithPgMem0008FidelityGap(client: Parameters<typeof runMigrations>[0]) {
  const trackingTable = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_name = 'schema_migrations'",
  );
  if (trackingTable.rows.length === 0) {
    await client.query(
      `CREATE TABLE governance.schema_migrations (
         id TEXT PRIMARY KEY,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL
       )`,
    );
  }
  for (const [id, sql] of [
    ["0008_operator_scopes_lifecycle_and_plan_scopes.sql", migration0008Sql],
    ["0010_retire_tenant_plan_write_scope.sql", migration0010Sql],
  ] as const) {
    const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
    await client.query(
      `INSERT INTO governance.schema_migrations (id, checksum, applied_at)
       VALUES ($1, $2, now()) ON CONFLICT (id) DO NOTHING`,
      [id, checksum],
    );
  }
  return runMigrations(client, migrationsDir);
}

describe("db/migrationRunner", () => {
  it("applies every pg-mem-executable migration in order; 0008 is covered by its production-shaped DDL test", async () => {
    const client = buildEmptyPgMemClient();

    const results = await runMigrationsWithPgMem0008FidelityGap(client);

    expect(results.map((r) => r.id)).toEqual([
      "0001_operator_identity_schema.sql",
      "0002_governance_db_foundation.sql",
      "0003_management_operation_ledger.sql",
      "0004_browser_operator_sessions.sql",
      "0005_tenant_lifecycle_foundation.sql",
      "0006_commissioned_tenants_control_fields.sql",
      "0007_public_onboarding_service_operator.sql",
      "0008_operator_scopes_lifecycle_and_plan_scopes.sql",
      "0009_retire_public_onboarding_service_operator.sql",
      "0010_retire_tenant_plan_write_scope.sql",
      "0011_step_up_transactions.sql",
    ]);
    expect(results.filter((r) => !["0008_operator_scopes_lifecycle_and_plan_scopes.sql", "0010_retire_tenant_plan_write_scope.sql"].includes(r.id)).every((r) => r.applied)).toBe(true);
    expect(results.find((r) => r.id === "0008_operator_scopes_lifecycle_and_plan_scopes.sql")?.applied).toBe(false);
    expect(results.find((r) => r.id === "0010_retire_tenant_plan_write_scope.sql")?.applied).toBe(false);

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
        "commissioned_tenants",
        "schema_migrations",
        "step_up_transactions",
      ]),
    );
  });

  it("is idempotent — re-running reports every file as already-applied and does not error", async () => {
    const client = buildEmptyPgMemClient();

    await runMigrationsWithPgMem0008FidelityGap(client);
    const secondRun = await runMigrationsWithPgMem0008FidelityGap(client);

    expect(secondRun.every((r) => r.applied === false)).toBe(true);
  });

  it("fails closed when an applied migration checksum no longer matches source", async () => {
    const client = buildEmptyPgMemClient();
    await runMigrationsWithPgMem0008FidelityGap(client);
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

    const results = await runMigrationsWithPgMem0008FidelityGap(client);
    expect(results).toEqual([
      { id: "0001_operator_identity_schema.sql", applied: false },
      { id: "0002_governance_db_foundation.sql", applied: true },
      { id: "0003_management_operation_ledger.sql", applied: true },
      { id: "0004_browser_operator_sessions.sql", applied: true },
      { id: "0005_tenant_lifecycle_foundation.sql", applied: true },
      { id: "0006_commissioned_tenants_control_fields.sql", applied: true },
      { id: "0007_public_onboarding_service_operator.sql", applied: true },
      { id: "0008_operator_scopes_lifecycle_and_plan_scopes.sql", applied: false },
      { id: "0009_retire_public_onboarding_service_operator.sql", applied: true },
      { id: "0010_retire_tenant_plan_write_scope.sql", applied: false },
      { id: "0011_step_up_transactions.sql", applied: true },
    ]);
  });

  // 1A.5 migration-upgrade proof (instruction #14): a database already at
  // exactly 1A.4's live schema state (0001+0002 applied, matching
  // docs/1A.3_status.md's live evidence) upgrades cleanly to 1A.5 by
  // applying only 0003 — proving 0003 is a genuine additive upgrade path,
  // not something that assumes a from-scratch install.
  it("upgrades a database already at the 1A.4 live schema state by applying additive 0003 and 0004", async () => {
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

    const results = await runMigrationsWithPgMem0008FidelityGap(client);
    expect(results).toEqual([
      { id: "0001_operator_identity_schema.sql", applied: false },
      { id: "0002_governance_db_foundation.sql", applied: false },
      { id: "0003_management_operation_ledger.sql", applied: true },
      { id: "0004_browser_operator_sessions.sql", applied: true },
      { id: "0005_tenant_lifecycle_foundation.sql", applied: true },
      { id: "0006_commissioned_tenants_control_fields.sql", applied: true },
      { id: "0007_public_onboarding_service_operator.sql", applied: true },
      { id: "0008_operator_scopes_lifecycle_and_plan_scopes.sql", applied: false },
      { id: "0009_retire_public_onboarding_service_operator.sql", applied: true },
      { id: "0010_retire_tenant_plan_write_scope.sql", applied: false },
      { id: "0011_step_up_transactions.sql", applied: true },
    ]);

    // Idempotent from here on, same as every other migration.
    const secondRun = await runMigrationsWithPgMem0008FidelityGap(client);
    expect(secondRun.every((r) => r.applied === false)).toBe(true);

    const tables = (
      await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables ORDER BY table_name")
    ).rows.map((r) => r.table_name);
    expect(tables).toContain("management_operations");
    expect(tables).toContain("browser_sessions");
    expect(tables).toContain("oauth_login_transactions");
    expect(tables).toContain("step_up_transactions");
  });
});
