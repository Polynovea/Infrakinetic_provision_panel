import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  fileURLToPath(new URL("../../migrations/0010_retire_tenant_plan_write_scope.sql", import.meta.url)),
  "utf8",
);

const PRE_0010_SCOPES = [
  "tenants.read", "tenants.commission", "tenants.suspend", "tenants.resume", "tenants.decommission", "tenants.plan.write",
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

function dbWithProductionShapedConstraint() {
  const db = newDb();
  db.public.none(`
    CREATE TABLE t (
      scope TEXT NOT NULL,
      CONSTRAINT operator_scopes_scope_check CHECK (scope IN (${PRE_0010_SCOPES.map((scope) => `'${scope}'`).join(", ")}))
    )
  `);
  return db;
}

describe("migrations/0010_retire_tenant_plan_write_scope.sql", () => {
  it("removes existing tenants.plan.write grants and rejects the retired scope afterwards", () => {
    const db = dbWithProductionShapedConstraint();
    db.public.none("INSERT INTO t(scope) VALUES ('tenants.plan.write'), ('tenants.resume')");

    db.public.none(migrationSql.replace(/governance\.operator_scopes/g, "t"));

    expect(db.public.many("SELECT scope FROM t ORDER BY scope").map((row: { scope: string }) => row.scope)).toEqual(["tenants.resume"]);
    expect(() => db.public.none("INSERT INTO t(scope) VALUES ('tenants.plan.write')")).toThrow();
  });

  it("preserves the real lifecycle scopes and rejects unknown vocabulary", () => {
    const db = dbWithProductionShapedConstraint();
    db.public.none(migrationSql.replace(/governance\.operator_scopes/g, "t"));

    expect(() => db.public.none("INSERT INTO t(scope) VALUES ('tenants.resume'), ('tenants.decommission')")).not.toThrow();
    expect(() => db.public.none("INSERT INTO t(scope) VALUES ('tenants.made_up_scope')")).toThrow();
  });
});
