import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const provisioning001 = readFileSync(
  fileURLToPath(new URL("../../provisioning/001_create_role_database_and_schema.sql", import.meta.url)),
  "utf8",
);
const provisioning002 = readFileSync(
  fileURLToPath(new URL("../../provisioning/002_verify_cross_database_isolation.sql", import.meta.url)),
  "utf8",
);

function executableSql(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("1A.3 provisioning contract", () => {
  it("creates a separate Governance database but does not make governance_app the database owner", () => {
    const sql = executableSql(provisioning001);
    expect(sql).toContain("CREATE DATABASE polynovea_governance;");
    expect(sql).not.toMatch(/CREATE\s+DATABASE\s+polynovea_governance\s+OWNER\s+governance_app/i);
  });

  it("locks PUBLIC out of the new Governance database and grants governance_app CONNECT explicitly", () => {
    const sql = executableSql(provisioning001);
    expect(sql).toContain("REVOKE ALL ON DATABASE polynovea_governance FROM PUBLIC;");
    expect(sql).toContain("GRANT CONNECT ON DATABASE polynovea_governance TO governance_app;");
  });

  it("keeps governance_app least-privilege and limits ownership to the governance schema", () => {
    const sql = executableSql(provisioning001);
    for (const flag of ["NOSUPERUSER", "NOCREATEDB", "NOCREATEROLE", "NOBYPASSRLS", "NOINHERIT"]) {
      expect(sql).toContain(flag);
    }
    expect(sql).toContain("CREATE SCHEMA governance AUTHORIZATION governance_app;");
    expect(sql).toContain(
      "ALTER ROLE governance_app IN DATABASE polynovea_governance SET search_path = governance;",
    );
  });

  it("does not use the ineffective direct per-role CONNECT revoke against polynoveacrm", () => {
    const sql = executableSql(provisioning001);
    expect(sql).not.toContain("REVOKE CONNECT ON DATABASE polynoveacrm FROM governance_app;");
  });

  it("requires a password through psql variable substitution rather than a committed literal", () => {
    expect(provisioning001).toContain(":'governance_password'");
    expect(provisioning001).not.toContain("CHANGE_ME_BEFORE_RUNNING");
  });

  it("makes the cross-database verifier check effective CONNECT and fail when it is present", () => {
    expect(provisioning002).toContain(
      "has_database_privilege('governance_app', current_database(), 'CONNECT')",
    );
    expect(provisioning002).toContain("IF v_can_connect THEN");
    expect(provisioning002).toContain("RAISE EXCEPTION");
  });

  it("keeps the isolation verifier read-only with respect to persistent database state", () => {
    const executableLines = provisioning002
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("--"));
    const mutatingStatement = executableLines.find((line) =>
      /^(GRANT|REVOKE|CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i.test(line),
    );
    expect(mutatingStatement).toBeUndefined();
  });
});
