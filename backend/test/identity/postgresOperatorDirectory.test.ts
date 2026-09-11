import { beforeEach, describe, expect, it } from "vitest";

import { PostgresOperatorDirectory } from "../../src/identity/adapters/postgresOperatorDirectory.js";
import { buildMigratedPgMemClient } from "../helpers/pgMemDb.js";

describe("identity/adapters/postgresOperatorDirectory", () => {
  let db: ReturnType<typeof buildMigratedPgMemClient>["db"];
  let directory: PostgresOperatorDirectory;

  beforeEach(() => {
    const built = buildMigratedPgMemClient();
    db = built.db;
    directory = new PostgresOperatorDirectory(built.client);
  });

  it("returns undefined for an unknown cognito_sub", async () => {
    await expect(directory.findByCognitoSub("no-such-sub")).resolves.toBeUndefined();
  });

  it("returns a full operator record with roles and scopes joined in", async () => {
    db.public.none(`
      INSERT INTO operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'sub-active', 'a@example.invalid', 'A', 'active', true, now(), now())
    `);
    db.public.none(`
      INSERT INTO operator_roles (operator_id, role, granted_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'platform_viewer', now())
    `);
    db.public.none(`
      INSERT INTO operator_scopes (operator_id, scope, granted_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'tenants.read', now())
    `);
    db.public.none(`
      INSERT INTO operator_scopes (operator_id, scope, granted_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'audit.read', now())
    `);

    const record = await directory.findByCognitoSub("sub-active");

    expect(record).toBeDefined();
    expect(record?.operatorId).toBe("11111111-1111-4111-8111-111111111111");
    expect(record?.status).toBe("active");
    expect(record?.mfaEnrolled).toBe(true);
    expect(record?.roles).toEqual(["platform_viewer"]);
    expect([...(record?.scopes ?? [])].sort()).toEqual(["audit.read", "tenants.read"]);
  });

  it("returns a disabled operator's record with disabledAt/disabledReason populated", async () => {
    db.public.none(`
      INSERT INTO operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at, disabled_at, disabled_reason)
      VALUES ('22222222-2222-4222-8222-222222222222', 'sub-disabled', 'b@example.invalid', 'B', 'disabled', false, now(), now(), now(), 'left the team')
    `);

    const record = await directory.findByCognitoSub("sub-disabled");

    expect(record?.status).toBe("disabled");
    expect(record?.disabledReason).toBe("left the team");
    expect(record?.disabledAt).toBeDefined();
    expect(record?.roles).toEqual([]);
    expect(record?.scopes).toEqual([]);
  });
});
