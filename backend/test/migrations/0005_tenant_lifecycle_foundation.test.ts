import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

const migration0001Sql = readFileSync(fileURLToPath(new URL("../../migrations/0001_operator_identity_schema.sql", import.meta.url)), "utf8");
const migration0002Sql = readFileSync(fileURLToPath(new URL("../../migrations/0002_governance_db_foundation.sql", import.meta.url)), "utf8");
const migration0003Sql = readFileSync(fileURLToPath(new URL("../../migrations/0003_management_operation_ledger.sql", import.meta.url)), "utf8");
const migration0004Sql = readFileSync(fileURLToPath(new URL("../../migrations/0004_browser_operator_sessions.sql", import.meta.url)), "utf8");
const migration0005Sql = readFileSync(fileURLToPath(new URL("../../migrations/0005_tenant_lifecycle_foundation.sql", import.meta.url)), "utf8");

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";

function dbAt0004() {
  const db = newDb();
  db.public.none("CREATE SCHEMA governance;");
  for (const sql of [migration0001Sql, migration0002Sql, migration0003Sql, migration0004Sql]) db.public.none(sql);
  db.public.none(`
    INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
    VALUES ('${OPERATOR_ID}', 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())
  `);
  return db;
}

function seedEngineOperation(db: ReturnType<typeof newDb>) {
  db.public.none(`
    INSERT INTO governance.management_idempotency_keys
      (idempotency_key, requested_action, operator_id, request_hash, status, created_at)
    VALUES ('engine-key-1', 'platform.engine-state.set', '${OPERATOR_ID}', 'persisted-hash', 'in_progress', now())
  `);
  db.public.none(`
    INSERT INTO governance.management_operations
      (operation_id, idempotency_key, operator_id, requested_action, target_engine, reason, risk_class,
       safe_payload_hash, contract_version, correlation_id, requested_at, status, created_at, updated_at)
    VALUES
      ('22222222-2222-4222-8222-222222222222', 'engine-key-1', '${OPERATOR_ID}', 'platform.engine-state.set',
       'module_ai', 'reason', 'R2', 'persisted-hash', 'platform-management.operation.v1',
       '33333333-3333-4333-8333-333333333333', now(), 'submitted', now(), now())
  `);
}

describe("migrations/0005_tenant_lifecycle_foundation.sql", () => {
  it("upgrades existing engine operations into generic resource addressing without changing persisted hashes", () => {
    const db = dbAt0004();
    seedEngineOperation(db);
    db.public.none(migration0005Sql);

    const row = db.public.one(`
      SELECT target_engine, target_resource_type, target_resource_id, safe_payload_hash
      FROM governance.management_operations WHERE idempotency_key = 'engine-key-1'
    `) as Record<string, unknown>;
    expect(row.target_engine).toBe("module_ai");
    expect(row.target_resource_type).toBe("engine");
    expect(row.target_resource_id).toBe("module_ai");
    expect(row.safe_payload_hash).toBe("persisted-hash");
  });

  it("accepts a non-engine operation only when the complete generic target pair is present", () => {
    const db = dbAt0004();
    db.public.none(migration0005Sql);
    db.public.none(`
      INSERT INTO governance.management_idempotency_keys
        (idempotency_key, requested_action, operator_id, request_hash, status, created_at)
      VALUES ('tenant-key-1', 'tenant.suspend', '${OPERATOR_ID}', 'hash-tenant', 'in_progress', now())
    `);
    expect(() => db.public.none(`
      INSERT INTO governance.management_operations
        (operation_id, idempotency_key, operator_id, requested_action, target_resource_type, target_resource_id,
         reason, risk_class, safe_payload_hash, contract_version, correlation_id, requested_at, status, created_at, updated_at)
      VALUES
        ('44444444-4444-4444-8444-444444444444', 'tenant-key-1', '${OPERATOR_ID}', 'tenant.suspend',
         'tenant', '55555555-5555-4555-8555-555555555555', 'reason', 'R2', 'hash-tenant',
         'platform-management.operation.v1', '66666666-6666-4666-8666-666666666666', now(), 'submitted', now(), now())
    `)).not.toThrow();

    db.public.none(`
      INSERT INTO governance.management_idempotency_keys
        (idempotency_key, requested_action, operator_id, request_hash, status, created_at)
      VALUES ('bad-target-key', 'tenant.suspend', '${OPERATOR_ID}', 'hash-bad', 'in_progress', now())
    `);
    expect(() => db.public.none(`
      INSERT INTO governance.management_operations
        (operation_id, idempotency_key, operator_id, requested_action, target_resource_type,
         reason, risk_class, safe_payload_hash, contract_version, correlation_id, requested_at, status, created_at, updated_at)
      VALUES
        ('77777777-7777-4777-8777-777777777777', 'bad-target-key', '${OPERATOR_ID}', 'tenant.suspend', 'tenant',
         'reason', 'R2', 'hash-bad', 'platform-management.operation.v1',
         '88888888-8888-4888-8888-888888888888', now(), 'submitted', now(), now())
    `)).toThrow();
  });

  it("enforces commissioned tenant lifecycle/provenance constraints without fabricating legacy history", () => {
    const db = dbAt0004();
    db.public.none(migration0005Sql);

    expect(() => db.public.none(`
      INSERT INTO governance.commissioned_tenants
        (projection_id, tenant_id, commission_request_id, lifecycle_state, provenance, created_at, updated_at)
      VALUES
        ('99999999-9999-4999-8999-999999999999', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL,
         'active', 'legacy_existing', now(), now())
    `)).not.toThrow();

    expect(() => db.public.none(`
      INSERT INTO governance.commissioned_tenants
        (projection_id, tenant_id, commission_request_id, lifecycle_state, provenance, created_at, updated_at)
      VALUES
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NULL, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
         'requested', 'governance_commissioned', now(), now())
    `)).not.toThrow();

    expect(() => db.public.none(`
      INSERT INTO governance.commissioned_tenants
        (projection_id, tenant_id, commission_request_id, lifecycle_state, provenance, created_at, updated_at)
      VALUES
        ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', NULL, NULL,
         'requested', 'governance_commissioned', now(), now())
    `)).toThrow();

    expect(() => db.public.none(`
      INSERT INTO governance.commissioned_tenants
        (projection_id, tenant_id, commission_request_id, lifecycle_state, provenance, created_at, updated_at)
      VALUES
        ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff', NULL,
         'invented-state', 'legacy_existing', now(), now())
    `)).toThrow();
  });
});
