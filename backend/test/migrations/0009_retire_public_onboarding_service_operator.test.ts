import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

const migration0001 = readFileSync(fileURLToPath(new URL("../../migrations/0001_operator_identity_schema.sql", import.meta.url)), "utf8");
const migration0007 = readFileSync(fileURLToPath(new URL("../../migrations/0007_public_onboarding_service_operator.sql", import.meta.url)), "utf8");
const migration0009 = readFileSync(fileURLToPath(new URL("../../migrations/0009_retire_public_onboarding_service_operator.sql", import.meta.url)), "utf8");

const SYSTEM_OPERATOR_ID = "00000000-0000-0000-0000-0000000000f0";

describe("0009_retire_public_onboarding_service_operator", () => {
  it("disables the historical service identity and removes any defensive grants", () => {
    const db = newDb();
    db.public.none("CREATE SCHEMA governance;");
    db.public.none(migration0001);
    db.public.none(migration0007);

    // Defensive proof: even if grants were added manually after 0007, the
    // retirement migration strips them before disabling the identity.
    db.public.none(`
      INSERT INTO governance.operator_roles (operator_id, role, granted_at)
      VALUES ('${SYSTEM_OPERATOR_ID}', 'platform_viewer', now());
      INSERT INTO governance.operator_scopes (operator_id, scope, granted_at)
      VALUES ('${SYSTEM_OPERATOR_ID}', 'tenants.read', now());
    `);

    db.public.none(migration0009);

    const operator = db.public.one(`
      SELECT status, disabled_at, disabled_reason
      FROM governance.operators
      WHERE operator_id = '${SYSTEM_OPERATOR_ID}'
    `);
    expect(operator.status).toBe("disabled");
    expect(operator.disabled_at).toBeTruthy();
    expect(String(operator.disabled_reason)).toMatch(/Retired Phase 1A\.11 public-onboarding/i);

    expect(db.public.query(`SELECT * FROM governance.operator_roles WHERE operator_id = '${SYSTEM_OPERATOR_ID}'`).rows).toHaveLength(0);
    expect(db.public.query(`SELECT * FROM governance.operator_scopes WHERE operator_id = '${SYSTEM_OPERATOR_ID}'`).rows).toHaveLength(0);
  });

  it("is safe to re-run after the identity is already disabled", () => {
    const db = newDb();
    db.public.none("CREATE SCHEMA governance;");
    db.public.none(migration0001);
    db.public.none(migration0007);
    db.public.none(migration0009);
    db.public.none(migration0009);

    const operator = db.public.one(`SELECT status FROM governance.operators WHERE operator_id = '${SYSTEM_OPERATOR_ID}'`);
    expect(operator.status).toBe("disabled");
  });
});
