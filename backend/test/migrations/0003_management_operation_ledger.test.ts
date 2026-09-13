import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";

// Proves migration 0003 is valid Postgres DDL, applies cleanly on top of
// 0001+0002 in the governance schema, and behaves as intended — WITHOUT a
// real Postgres instance. Same technique as 0001/0002's own migration tests.

const migration0001Path = fileURLToPath(new URL("../../migrations/0001_operator_identity_schema.sql", import.meta.url));
const migration0002Path = fileURLToPath(new URL("../../migrations/0002_governance_db_foundation.sql", import.meta.url));
const migration0003Path = fileURLToPath(new URL("../../migrations/0003_management_operation_ledger.sql", import.meta.url));
const migration0001Sql = readFileSync(migration0001Path, "utf8");
const migration0002Sql = readFileSync(migration0002Path, "utf8");
const migration0003Sql = readFileSync(migration0003Path, "utf8");

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";

const seedOperator = `
  INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
  VALUES ('${OPERATOR_ID}', 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())
`;

function seedIdempotencyKey(db: ReturnType<typeof newDb>, key: string) {
  db.public.none(`
    INSERT INTO governance.management_idempotency_keys (idempotency_key, requested_action, operator_id, request_hash, status, created_at)
    VALUES ('${key}', 'platform.engine-state.set', '${OPERATOR_ID}', 'hash-1', 'in_progress', now())
  `);
}

function baseOperationInsert(overrides: Record<string, string> = {}) {
  const fields = {
    operation_id: "'22222222-2222-4222-8222-222222222222'",
    idempotency_key: "'op-key-1'",
    operator_id: `'${OPERATOR_ID}'`,
    requested_action: "'platform.engine-state.set'",
    target_engine: "'module_ai'",
    reason: "'synthetic certification'",
    risk_class: "'R2'",
    safe_payload_hash: "'hash-1'",
    contract_version: "'platform-management.operation.v1'",
    correlation_id: "'33333333-3333-4333-8333-333333333333'",
    requested_at: "now()",
    status: "'submitted'",
    created_at: "now()",
    updated_at: "now()",
    ...overrides,
  };
  const columns = Object.keys(fields).join(", ");
  const values = Object.values(fields).join(", ");
  return `INSERT INTO governance.management_operations (${columns}) VALUES (${values})`;
}

function freshDb() {
  const db = newDb();
  db.public.none("CREATE SCHEMA governance;");
  db.public.none(migration0001Sql);
  db.public.none(migration0002Sql);
  db.public.none(migration0003Sql);
  return db;
}

describe("migrations/0003_management_operation_ledger.sql", () => {
  let db: ReturnType<typeof newDb>;

  beforeEach(() => {
    db = freshDb();
    db.public.none(seedOperator);
  });

  it("applies cleanly on top of 0001+0002 and creates management_operations", () => {
    const tables = db.public
      .many("SELECT table_name FROM information_schema.tables ORDER BY table_name")
      .map((row: { table_name: string }) => row.table_name);
    expect(tables).toEqual(expect.arrayContaining(["management_operations"]));
  });

  it("does not alter 0002's management_idempotency_keys status vocabulary", () => {
    seedIdempotencyKey(db, "still-3-values");
    expect(() =>
      db.public.none(`
        INSERT INTO governance.management_idempotency_keys (idempotency_key, requested_action, request_hash, status, created_at, completed_at)
        VALUES ('still-3-values-2', 'x', 'h', 'partially_completed', now(), now())
      `),
    ).toThrow();
  });

  describe("management_operations", () => {
    it("accepts a valid R2 row with a reason and requires idempotency_key to pre-exist", () => {
      seedIdempotencyKey(db, "op-key-1");
      expect(() => db.public.none(baseOperationInsert())).not.toThrow();
    });

    it("rejects an operation whose idempotency_key does not exist", () => {
      expect(() => db.public.none(baseOperationInsert())).toThrow();
    });

    it("rejects R2 with no reason", () => {
      seedIdempotencyKey(db, "op-key-1");
      expect(() => db.public.none(baseOperationInsert({ reason: "NULL" }))).toThrow();
    });

    it("rejects R2 with an empty-string reason", () => {
      seedIdempotencyKey(db, "op-key-1");
      expect(() => db.public.none(baseOperationInsert({ reason: "''" }))).toThrow();
    });

    it("allows R0 with no reason", () => {
      seedIdempotencyKey(db, "op-key-1");
      expect(() =>
        db.public.none(baseOperationInsert({ risk_class: "'R0'", reason: "NULL" })),
      ).not.toThrow();
    });

    it("rejects an unknown risk class", () => {
      seedIdempotencyKey(db, "op-key-1");
      expect(() => db.public.none(baseOperationInsert({ risk_class: "'R99'" }))).toThrow();
    });

    it("rejects an unknown status", () => {
      seedIdempotencyKey(db, "op-key-1");
      expect(() => db.public.none(baseOperationInsert({ status: "'not_a_real_status'" }))).toThrow();
    });

    it("rejects status='completed' with completed_at NULL", () => {
      seedIdempotencyKey(db, "op-key-1");
      expect(() => db.public.none(baseOperationInsert({ status: "'completed'" }))).toThrow();
    });

    it("accepts status='completed' with completed_at set", () => {
      seedIdempotencyKey(db, "op-key-1");
      expect(() =>
        db.public.none(baseOperationInsert({ status: "'completed'", completed_at: "now()" })),
      ).not.toThrow();
    });

    it("rejects status='failed' with failed_at NULL", () => {
      seedIdempotencyKey(db, "op-key-1");
      expect(() => db.public.none(baseOperationInsert({ status: "'failed'" }))).toThrow();
    });

    it("enforces one operation per idempotency_key (UNIQUE)", () => {
      seedIdempotencyKey(db, "op-key-1");
      db.public.none(baseOperationInsert());
      expect(() =>
        db.public.none(baseOperationInsert({ operation_id: "'44444444-4444-4444-8444-444444444444'" })),
      ).toThrow();
    });
  });

  describe("operator_audit_log operation/causation columns", () => {
    it("accepts a ledger row carrying operation_id and causation_id", () => {
      seedIdempotencyKey(db, "op-key-1");
      db.public.none(baseOperationInsert());
      expect(() =>
        db.public.none(`
          INSERT INTO governance.operator_audit_log
            (occurred_at, operator_id, action, risk_class, idempotency_key, result, operation_id, causation_id, contract_version)
          VALUES
            (now(), '${OPERATOR_ID}', 'platform.engine-state.set', 'R2', 'op-key-1', 'submitted',
             '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', 'platform-management.operation.v1')
        `),
      ).not.toThrow();
    });

    it("rejects a ledger row referencing an operation_id that does not exist", () => {
      expect(() =>
        db.public.none(`
          INSERT INTO governance.operator_audit_log (occurred_at, action, risk_class, result, operation_id)
          VALUES (now(), 'platform.engine-state.set', 'R2', 'submitted', '99999999-9999-4999-8999-999999999999')
        `),
      ).toThrow();
    });
  });
});
