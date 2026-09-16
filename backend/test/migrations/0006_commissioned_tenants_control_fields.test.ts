import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

// Reconciliation follow-up to 0005: adds the desired/control fields the
// 1A.8.0 scoping document locks for governance.commissioned_tenants
// (Phase1A.8_Ground_Truth_and_Scoping_2026-09-16.md §8) that 0005 did not
// yet carry — desired_name/slug/plan, account_type,
// last_observed_platform_access_state, last_observed_at,
// responsible_operator_id, and the per-transition timestamps.

const migration0001Sql = readFileSync(fileURLToPath(new URL("../../migrations/0001_operator_identity_schema.sql", import.meta.url)), "utf8");
const migration0002Sql = readFileSync(fileURLToPath(new URL("../../migrations/0002_governance_db_foundation.sql", import.meta.url)), "utf8");
const migration0003Sql = readFileSync(fileURLToPath(new URL("../../migrations/0003_management_operation_ledger.sql", import.meta.url)), "utf8");
const migration0004Sql = readFileSync(fileURLToPath(new URL("../../migrations/0004_browser_operator_sessions.sql", import.meta.url)), "utf8");
const migration0005Sql = readFileSync(fileURLToPath(new URL("../../migrations/0005_tenant_lifecycle_foundation.sql", import.meta.url)), "utf8");
const migration0006Sql = readFileSync(fileURLToPath(new URL("../../migrations/0006_commissioned_tenants_control_fields.sql", import.meta.url)), "utf8");

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";

function dbAt0006() {
  const db = newDb();
  db.public.none("CREATE SCHEMA governance;");
  for (const sql of [migration0001Sql, migration0002Sql, migration0003Sql, migration0004Sql, migration0005Sql, migration0006Sql]) {
    db.public.none(sql);
  }
  db.public.none(`
    INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
    VALUES ('${OPERATOR_ID}', 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())
  `);
  return db;
}

describe("migrations/0006_commissioned_tenants_control_fields.sql", () => {
  it("applies cleanly on top of 0001-0005 without altering any existing column/constraint", () => {
    const db = dbAt0006();
    const tables = db.public
      .many("SELECT table_name FROM information_schema.tables ORDER BY table_name")
      .map((row: { table_name: string }) => row.table_name);
    expect(tables).toEqual(expect.arrayContaining(["commissioned_tenants"]));
  });

  it("0005's own lifecycle/provenance constraints still hold — this migration is purely additive", () => {
    const db = dbAt0006();
    expect(() => db.public.none(`
      INSERT INTO governance.commissioned_tenants
        (projection_id, tenant_id, commission_request_id, lifecycle_state, provenance, created_at, updated_at)
      VALUES
        ('99999999-9999-4999-8999-999999999999', NULL, NULL, 'requested', 'governance_commissioned', now(), now())
    `)).toThrow(); // governance_commissioned still requires a commission_request_id
  });

  it("accepts a full desired/control row with every new field populated", () => {
    const db = dbAt0006();
    expect(() => db.public.none(`
      INSERT INTO governance.commissioned_tenants
        (projection_id, commission_request_id, lifecycle_state, provenance,
         desired_name, desired_slug, desired_plan, account_type,
         last_observed_platform_access_state, last_observed_at, responsible_operator_id,
         requested_at, approved_at, provisioning_started_at, active_at,
         created_at, updated_at)
      VALUES
        ('11111111-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
         'active', 'governance_commissioned',
         'Synthetic Co', 'synthetic-co', 'starter', 'demo',
         'active', now(), '${OPERATOR_ID}',
         now(), now(), now(), now(),
         now(), now())
    `)).not.toThrow();
  });

  it("rejects an unknown account_type", () => {
    const db = dbAt0006();
    expect(() => db.public.none(`
      INSERT INTO governance.commissioned_tenants
        (projection_id, commission_request_id, lifecycle_state, provenance, account_type, created_at, updated_at)
      VALUES
        ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
         'requested', 'governance_commissioned', 'freemium', now(), now())
    `)).toThrow();
  });

  it("rejects an unknown last_observed_platform_access_state, and specifically rejects 'trial'/'cancelled' — those belong only to Infrakinetic's Billing-owned tenants.status, never to this Governance-owned projection", () => {
    const db = dbAt0006();
    const cases: Array<[string, string, string]> = [
      ["trial", "91111111-1111-4111-8111-111111111111", "81111111-1111-4111-8111-111111111111"],
      ["cancelled", "92222222-2222-4222-8222-222222222222", "82222222-2222-4222-8222-222222222222"],
      ["made-up", "93333333-3333-4333-8333-333333333333", "83333333-3333-4333-8333-333333333333"],
    ];
    for (const [badValue, projectionId, tenantId] of cases) {
      expect(() => db.public.none(`
        INSERT INTO governance.commissioned_tenants
          (projection_id, tenant_id, lifecycle_state, provenance, last_observed_platform_access_state, created_at, updated_at)
        VALUES
          ('${projectionId}', '${tenantId}', 'active', 'legacy_existing', '${badValue}', now(), now())
      `)).toThrow();
    }
  });

  it("accepts NULL for every new column — 0005's minimal rows (and pre-existing legacy_existing backfill rows) remain valid", () => {
    const db = dbAt0006();
    expect(() => db.public.none(`
      INSERT INTO governance.commissioned_tenants
        (projection_id, tenant_id, commission_request_id, lifecycle_state, provenance, created_at, updated_at)
      VALUES
        ('66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', NULL,
         'active', 'legacy_existing', now(), now())
    `)).not.toThrow();
  });

  it("responsible_operator_id references a real operator when set", () => {
    const db = dbAt0006();
    expect(() => db.public.none(`
      INSERT INTO governance.commissioned_tenants
        (projection_id, tenant_id, lifecycle_state, provenance, responsible_operator_id, created_at, updated_at)
      VALUES
        ('a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222',
         'active', 'legacy_existing', '99999999-9999-4999-8999-999999999999', now(), now())
    `)).toThrow(); // '999...' is not a real governance.operators row
  });
});
