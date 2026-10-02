import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

import { ROLE_SCOPE_CEILING, SCOPES } from "../../src/identity/roles.js";

const migrationSql = readFileSync(
  fileURLToPath(new URL("../../migrations/0018_ai_credentials_manage_scope.sql", import.meta.url)),
  "utf8",
);

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

describe("migrations/0018_ai_credentials_manage_scope.sql", () => {
  it("the latest DB constraint and roles.ts SCOPES are exactly the same set", () => {
    expect(new Set(constraintScopes())).toEqual(new Set(SCOPES));
    expect(constraintScopes()).toHaveLength(SCOPES.length);
  });

  it("accepts ai.credentials.manage and still rejects unknown vocabulary", () => {
    const db = migratedDb();
    expect(() => db.public.none("INSERT INTO t(scope) VALUES ('ai.credentials.manage')")).not.toThrow();
    expect(() => db.public.none("INSERT INTO t(scope) VALUES ('ai.credentials.read_secret')")).toThrow();
  });

  it("keeps ai.credentials.manage ceiling-limited to the intended privileged roles", () => {
    const holders = Object.entries(ROLE_SCOPE_CEILING)
      .filter(([, scopes]) => (scopes as readonly string[]).includes("ai.credentials.manage"))
      .map(([role]) => role)
      .sort();
    expect(holders).toEqual(["break_glass", "platform_admin"]);
  });
});
