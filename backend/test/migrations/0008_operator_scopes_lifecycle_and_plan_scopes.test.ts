import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

// 1A.8/1A.11 schema-drift fix — widens operator_scopes' scope CHECK to
// include tenants.resume/tenants.decommission/tenants.plan.write, which
// identity/roles.ts's SCOPES catalog has defined and the application has
// enforced (requireScope) since those phases shipped, but which 0001's
// constraint never carried. Discovered 2026-09-21 during 1A.11 Step 8 live
// certification when granting these scopes to a real platform_admin
// operator failed with a CHECK violation.
//
// pg-mem's pg_constraint emulation does not expose a name for 0001's
// inline, unnamed CHECK (conname reads back as null for every constraint
// in this codebase's pg-mem version) — so it cannot execute 0008's
// `DROP CONSTRAINT operator_scopes_scope_check` against a table built by
// literally replaying 0001's SQL. That name is verified directly against
// the real production database (pg_constraint.conname), where Postgres's
// standard auto-naming (`<table>_<column>_check`) does apply — this is a
// pg-mem fidelity gap, not a defect in the migration. The first test below
// builds a minimal standalone table with that same constraint EXPLICITLY
// named (matching production), then applies 0008.sql on top of it — a
// faithful test of the real DDL transition without depending on pg-mem's
// incomplete catalog support. The remaining tests exercise the full
// 0001-0008 chain for everything other than that one DROP+ADD step.

function loadMigration(filename: string): string {
  return readFileSync(fileURLToPath(new URL(`../../migrations/${filename}`, import.meta.url)), "utf8");
}

const MIGRATION_0008_SQL = loadMigration("0008_operator_scopes_lifecycle_and_plan_scopes.sql");

const PRE_0008_SCOPES = [
  "tenants.read", "tenants.commission", "tenants.suspend",
  "engines.read", "engines.entitlement.write", "engines.platform_state.write", "engines.release.write",
  "identity.read", "identity.recovery", "identity.disable", "identity.mfa_reset",
  "credentials.metadata.read", "credentials.submit", "credentials.rotate", "credentials.revoke",
  "ai.read", "ai.entitlement.write", "ai.quota.write", "ai.provider_policy.write", "ai.emergency_suspend",
  "payments.adapters.read", "payments.adapters.certify", "payments.adapters.approve", "payments.adapters.revoke",
  "integrations.read", "integrations.manage",
  "runtime.read", "runtime.repair.request",
  "finops.read", "finops.policy.write",
  "audit.read",
];

const NEWLY_ALLOWED_SCOPES = ["tenants.resume", "tenants.decommission", "tenants.plan.write"];

// Standalone table with the constraint named exactly as it is in
// production today (confirmed via pg_get_constraintdef/pg_constraint on
// the real Governance database), independent of operators/FKs — isolates
// the one DDL statement pg-mem can't derive from replaying 0001 verbatim.
function dbWithProductionShapedConstraint() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE t (
      scope TEXT NOT NULL,
      CONSTRAINT operator_scopes_scope_check CHECK (scope IN (${PRE_0008_SCOPES.map((s) => `'${s}'`).join(", ")}))
    )
  `);
  return db;
}

describe("migrations/0008_operator_scopes_lifecycle_and_plan_scopes.sql", () => {
  it("drops and re-adds the real, named production constraint without error", () => {
    const db = dbWithProductionShapedConstraint();
    const sql = MIGRATION_0008_SQL.replace(/governance\.operator_scopes/g, "t");
    expect(() => db.public.none(sql)).not.toThrow();
  });

  it.each(NEWLY_ALLOWED_SCOPES)("accepts the previously-missing scope %s after the migration", (scope) => {
    const db = dbWithProductionShapedConstraint();
    db.public.none(MIGRATION_0008_SQL.replace(/governance\.operator_scopes/g, "t"));
    expect(() => db.public.none(`INSERT INTO t (scope) VALUES ('${scope}')`)).not.toThrow();
  });

  it("still accepts every scope the constraint allowed before this migration", () => {
    const db = dbWithProductionShapedConstraint();
    db.public.none(MIGRATION_0008_SQL.replace(/governance\.operator_scopes/g, "t"));
    for (const scope of PRE_0008_SCOPES) {
      expect(() => db.public.none(`INSERT INTO t (scope) VALUES ('${scope}')`)).not.toThrow();
    }
  });

  it("still rejects an unknown scope — this migration widens, it does not remove the vocabulary check", () => {
    const db = dbWithProductionShapedConstraint();
    db.public.none(MIGRATION_0008_SQL.replace(/governance\.operator_scopes/g, "t"));
    expect(() => db.public.none("INSERT INTO t (scope) VALUES ('tenants.made_up_scope')")).toThrow();
  });

  it("0001-0007 plus 0008 still apply cleanly as a full chain (0008 itself only exercised for its statement shape above, per the header note)", () => {
    const db = newDb();
    db.public.none("CREATE SCHEMA governance;");
    for (const filename of [
      "0001_operator_identity_schema.sql",
      "0002_governance_db_foundation.sql",
      "0003_management_operation_ledger.sql",
      "0004_browser_operator_sessions.sql",
      "0005_tenant_lifecycle_foundation.sql",
      "0006_commissioned_tenants_control_fields.sql",
      "0007_public_onboarding_service_operator.sql",
    ]) {
      db.public.none(loadMigration(filename));
    }
    const tables = db.public
      .many("SELECT table_name FROM information_schema.tables ORDER BY table_name")
      .map((row: { table_name: string }) => row.table_name);
    expect(tables).toEqual(expect.arrayContaining(["operator_scopes", "operators"]));
  });
});
