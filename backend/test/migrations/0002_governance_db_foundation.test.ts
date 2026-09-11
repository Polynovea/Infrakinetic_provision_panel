import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";

// Proves migration 0002 is valid Postgres DDL, applies cleanly on top of
// 0001, and behaves as intended — WITHOUT a real Postgres instance. Same
// technique as test/migrations/0001_operator_identity_schema.test.ts; see
// that file's header for what this does and does not prove.

const migration0001Path = fileURLToPath(new URL("../../migrations/0001_operator_identity_schema.sql", import.meta.url));
const migration0002Path = fileURLToPath(new URL("../../migrations/0002_governance_db_foundation.sql", import.meta.url));
const migration0001Sql = readFileSync(migration0001Path, "utf8");
const migration0002Sql = readFileSync(migration0002Path, "utf8");

const seedOperator = `
  INSERT INTO operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
  VALUES ('11111111-1111-4111-8111-111111111111', 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())
`;

function freshDb() {
  const db = newDb();
  db.public.none(migration0001Sql);
  db.public.none(migration0002Sql);
  return db;
}

describe("migrations/0002_governance_db_foundation.sql", () => {
  let db: ReturnType<typeof newDb>;

  beforeEach(() => {
    db = freshDb();
  });

  it("applies cleanly on top of 0001 and creates the new tables", () => {
    const tables = db.public
      .many("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name")
      .map((row: { table_name: string }) => row.table_name);

    expect(tables).toEqual(
      expect.arrayContaining(["management_idempotency_keys", "operator_audit_log"]),
    );
  });

  describe("operator_sessions nullability correction", () => {
    it("accepts a session row with no operator_id/issued_at/expires_at (revoke-only, no establishment event)", () => {
      expect(() =>
        db.public.none(`
          INSERT INTO operator_sessions (session_id, revoked_at, revoked_reason)
          VALUES ('22222222-2222-4222-8222-222222222222', now(), 'operator-initiated logout')
        `),
      ).not.toThrow();
    });

    it("still accepts a fully-populated session row (forward compatible)", () => {
      db.public.none(seedOperator);
      expect(() =>
        db.public.none(`
          INSERT INTO operator_sessions (session_id, operator_id, issued_at, expires_at)
          VALUES ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', now(), now())
        `),
      ).not.toThrow();
    });
  });

  describe("management_idempotency_keys", () => {
    it("rejects an unknown status", () => {
      expect(() =>
        db.public.none(`
          INSERT INTO management_idempotency_keys (idempotency_key, requested_action, request_hash, status, created_at, completed_at)
          VALUES ('key-1', 'tenant.commission', 'hash-1', 'not_a_real_status', now(), now())
        `),
      ).toThrow();
    });

    it("rejects in_progress with a completed_at set (consistency check)", () => {
      expect(() =>
        db.public.none(`
          INSERT INTO management_idempotency_keys (idempotency_key, requested_action, request_hash, status, created_at, completed_at)
          VALUES ('key-2', 'tenant.commission', 'hash-1', 'in_progress', now(), now())
        `),
      ).toThrow();
    });

    it("rejects completed with no completed_at (consistency check)", () => {
      expect(() =>
        db.public.none(`
          INSERT INTO management_idempotency_keys (idempotency_key, requested_action, request_hash, status, created_at)
          VALUES ('key-3', 'tenant.commission', 'hash-1', 'completed', now())
        `),
      ).toThrow();
    });

    it("accepts a valid in_progress row, then a valid completed row", () => {
      db.public.none(`
        INSERT INTO management_idempotency_keys (idempotency_key, requested_action, request_hash, status, created_at)
        VALUES ('key-4', 'tenant.commission', 'hash-1', 'in_progress', now())
      `);
      expect(db.public.many("SELECT * FROM management_idempotency_keys")).toHaveLength(1);

      expect(() =>
        db.public.none(`
          INSERT INTO management_idempotency_keys (idempotency_key, requested_action, request_hash, status, created_at, completed_at)
          VALUES ('key-5', 'tenant.commission', 'hash-2', 'completed', now(), now())
        `),
      ).not.toThrow();
    });

    it("enforces idempotency_key uniqueness", () => {
      db.public.none(`
        INSERT INTO management_idempotency_keys (idempotency_key, requested_action, request_hash, status, created_at)
        VALUES ('dup-key', 'tenant.commission', 'hash-1', 'in_progress', now())
      `);
      expect(() =>
        db.public.none(`
          INSERT INTO management_idempotency_keys (idempotency_key, requested_action, request_hash, status, created_at)
          VALUES ('dup-key', 'tenant.suspend', 'hash-2', 'in_progress', now())
        `),
      ).toThrow();
    });
  });

  describe("operator_audit_log", () => {
    it("rejects a risk_class outside the known vocabulary", () => {
      expect(() =>
        db.public.none(`
          INSERT INTO operator_audit_log (occurred_at, action, risk_class, result)
          VALUES (now(), 'platform.engine-state.set', 'R99', 'completed')
        `),
      ).toThrow();
    });

    it("rejects a result outside the known vocabulary", () => {
      expect(() =>
        db.public.none(`
          INSERT INTO operator_audit_log (occurred_at, action, risk_class, result)
          VALUES (now(), 'platform.engine-state.set', 'R2', 'made_up_result')
        `),
      ).toThrow();
    });

    it("accepts a valid row referencing an existing idempotency key", () => {
      db.public.none(seedOperator);
      db.public.none(`
        INSERT INTO management_idempotency_keys (idempotency_key, requested_action, request_hash, status, created_at)
        VALUES ('key-audit-1', 'platform.engine-state.set', 'hash-1', 'in_progress', now())
      `);
      expect(() =>
        db.public.none(`
          INSERT INTO operator_audit_log (occurred_at, operator_id, action, risk_class, idempotency_key, result)
          VALUES (now(), '11111111-1111-4111-8111-111111111111', 'platform.engine-state.set', 'R2', 'key-audit-1', 'submitted')
        `),
      ).not.toThrow();
    });

    it("rejects a foreign idempotency_key that does not exist", () => {
      expect(() =>
        db.public.none(`
          INSERT INTO operator_audit_log (occurred_at, action, risk_class, idempotency_key, result)
          VALUES (now(), 'platform.engine-state.set', 'R2', 'no-such-key', 'submitted')
        `),
      ).toThrow();
    });
  });
});
