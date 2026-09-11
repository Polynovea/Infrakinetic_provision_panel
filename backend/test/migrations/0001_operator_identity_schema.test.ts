import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";

// Proves the 1A.2 operator-identity migration is syntactically valid
// Postgres DDL and behaves as intended (status/role/scope vocabulary
// constraints, foreign keys, uniqueness) WITHOUT a real Postgres instance —
// there is no live Governance database access in this session. pg-mem is an
// in-memory PG emulator; this is schema verification, not proof the
// migration has been applied to any real database.
//
// The `governance` schema is created here explicitly, mirroring
// provisioning/001_create_role_and_schema.sql — real migrations never
// create it themselves (see that file's header).

const migrationPath = fileURLToPath(new URL("../../migrations/0001_operator_identity_schema.sql", import.meta.url));
const migrationSql = readFileSync(migrationPath, "utf8");

function freshDb() {
  const db = newDb();
  db.public.none("CREATE SCHEMA governance;");
  db.public.none(migrationSql);
  return db;
}

describe("migrations/0001_operator_identity_schema.sql", () => {
  let db: ReturnType<typeof newDb>;

  beforeEach(() => {
    db = freshDb();
  });

  it("applies cleanly and creates all five tables (qualified as governance.*)", () => {
    // Not filtered by table_schema: pg-mem always reports 'public' there
    // regardless of a table's real schema (confirmed by direct probe — see
    // migrationRunner.ts's ensureMigrationsTable comment). This proves the
    // qualified `governance.*` DDL itself is valid and executes; true
    // schema isolation is certified separately, against a real Postgres
    // server (docs/1A.3_status.md "Architecture correction").
    const tables = db.public
      .many("SELECT table_name FROM information_schema.tables ORDER BY table_name")
      .map((row: { table_name: string }) => row.table_name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "operators",
        "operator_roles",
        "operator_scopes",
        "operator_sessions",
        "operator_auth_audit_log",
      ]),
    );
  });

  it("accepts a valid operator row and rejects an unknown status", () => {
    db.public.none(`
      INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())
    `);
    const rows = db.public.many("SELECT * FROM governance.operators");
    expect(rows).toHaveLength(1);

    expect(() =>
      db.public.none(`
        INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
        VALUES ('22222222-2222-4222-8222-222222222222', 'sub-2', 'b@example.invalid', 'B', 'not_a_real_status', true, now(), now())
      `),
    ).toThrow();
  });

  it("rejects a disabled operator with no disabled_at (consistency check)", () => {
    expect(() =>
      db.public.none(`
        INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
        VALUES ('33333333-3333-4333-8333-333333333333', 'sub-3', 'c@example.invalid', 'C', 'disabled', true, now(), now())
      `),
    ).toThrow();
  });

  it("enforces cognito_sub uniqueness", () => {
    db.public.none(`
      INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
      VALUES ('44444444-4444-4444-8444-444444444444', 'dup-sub', 'd@example.invalid', 'D', 'active', true, now(), now())
    `);
    expect(() =>
      db.public.none(`
        INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
        VALUES ('55555555-5555-4555-8555-555555555555', 'dup-sub', 'e@example.invalid', 'E', 'active', true, now(), now())
      `),
    ).toThrow();
  });

  it("rejects a role outside the known role vocabulary", () => {
    db.public.none(`
      INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
      VALUES ('66666666-6666-4666-8666-666666666666', 'sub-6', 'f@example.invalid', 'F', 'active', true, now(), now())
    `);
    expect(() =>
      db.public.none(`
        INSERT INTO governance.operator_roles (operator_id, role, granted_at)
        VALUES ('66666666-6666-4666-8666-666666666666', 'super_root_god_mode', now())
      `),
    ).toThrow();
  });

  it("rejects a scope outside the known scope vocabulary", () => {
    db.public.none(`
      INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
      VALUES ('77777777-7777-4777-8777-777777777777', 'sub-7', 'g@example.invalid', 'G', 'active', true, now(), now())
    `);
    expect(() =>
      db.public.none(`
        INSERT INTO governance.operator_scopes (operator_id, scope, granted_at)
        VALUES ('77777777-7777-4777-8777-777777777777', 'tenants.delete_everything', now())
      `),
    ).toThrow();
  });

  it("cascades operator deletion into roles/scopes/sessions", () => {
    db.public.none(`
      INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
      VALUES ('88888888-8888-4888-8888-888888888888', 'sub-8', 'h@example.invalid', 'H', 'active', true, now(), now())
    `);
    db.public.none(`
      INSERT INTO governance.operator_roles (operator_id, role, granted_at)
      VALUES ('88888888-8888-4888-8888-888888888888', 'platform_admin', now())
    `);
    db.public.none(`
      INSERT INTO governance.operator_sessions (session_id, operator_id, issued_at, expires_at)
      VALUES ('99999999-9999-4999-8999-999999999999', '88888888-8888-4888-8888-888888888888', now(), now())
    `);

    db.public.none("DELETE FROM governance.operators WHERE operator_id = '88888888-8888-4888-8888-888888888888'");

    expect(db.public.many("SELECT * FROM governance.operator_roles")).toHaveLength(0);
    expect(db.public.many("SELECT * FROM governance.operator_sessions")).toHaveLength(0);
  });

  it("accepts a session row with no operator_id/issued_at/expires_at (no prior 'session established' event)", () => {
    expect(() =>
      db.public.none(`
        INSERT INTO governance.operator_sessions (session_id, revoked_at, revoked_reason)
        VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now(), 'operator-initiated logout')
      `),
    ).not.toThrow();
  });
});
