import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

import { ROLE_SCOPE_CEILING, SCOPES } from "../../src/identity/roles.js";

const migrationSql = readFileSync(
  fileURLToPath(new URL("../../migrations/0015_payment_adapter_and_global_config_scopes.sql", import.meta.url)),
  "utf8",
);

const NEW_SCOPES = ["payments.adapters.submit", "global_config.restore", "global_config.restore.apply"];

function constraintScopes(): string[] {
  const body = migrationSql.slice(migrationSql.indexOf("CHECK (scope IN ("));
  return [...body.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
}

function migratedDb() {
  const db = newDb();
  db.public.none(`CREATE TABLE t (scope TEXT NOT NULL, CONSTRAINT operator_scopes_scope_check CHECK (scope IN ('tenants.read')))`);
  db.public.none(migrationSql.replace(/governance\.operator_scopes/g, "t"));
  return db;
}

describe("migrations/0015_payment_adapter_and_global_config_scopes.sql", () => {
  it("the DB constraint and roles.ts SCOPES are exactly the same set (the 0008 lesson)", () => {
    expect(new Set(constraintScopes())).toEqual(new Set(SCOPES));
    expect(constraintScopes()).toHaveLength(SCOPES.length);
  });

  it("accepts the three new scopes and still rejects unknown vocabulary", () => {
    const db = migratedDb();
    for (const scope of NEW_SCOPES) expect(() => db.public.none(`INSERT INTO t(scope) VALUES ('${scope}')`)).not.toThrow();
    expect(() => db.public.none("INSERT INTO t(scope) VALUES ('global_config.restore.everything')")).toThrow();
    expect(() => db.public.none("INSERT INTO t(scope) VALUES ('tenants.plan.write')")).toThrow();
  });

  it("new scopes are ceiling-limited to platform_admin and break_glass (security_operator not widened)", () => {
    for (const scope of NEW_SCOPES) {
      const holders = Object.entries(ROLE_SCOPE_CEILING).filter(([, scopes]) => (scopes as readonly string[]).includes(scope)).map(([role]) => role).sort();
      expect(holders).toEqual(["break_glass", "platform_admin"]);
    }
  });
});
