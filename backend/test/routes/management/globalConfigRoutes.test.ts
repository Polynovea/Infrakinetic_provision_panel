import request from "supertest";
import { describe, expect, it } from "vitest";

import { buildTestApp } from "../../helpers/testApp.js";
import { activeAdminOperator } from "../../helpers/operators.js";
import { buildTestIdentityProvider } from "../../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken } from "../../helpers/testToken.js";

// 1A.14 §8 — Governance restore route gates. Orchestration (validation,
// dry-run, maker-checker, execution, rollback, observation) is covered in
// test/management/operations/globalConfigRestoreOperation.test.ts.

const PACKAGE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

async function appFor(roles: string[], scopes: string[]) {
  const keyPair = await generateTestKeyPair();
  const op = activeAdminOperator({ roles: roles as never, scopes: scopes as never });
  const { app } = buildTestApp(buildTestIdentityProvider(keyPair), [op]);
  return { app, token: await signTestToken(keyPair, { subject: op.cognitoSub }) };
}

describe("global-config route gates", () => {
  it.each([
    ["get", "/management/v1/global-config/classes"],
    ["get", "/management/v1/global-config/packages"],
    ["post", "/management/v1/global-config/payment_provider_catalog/snapshots"],
    ["post", "/management/v1/global-config/packages"],
    ["post", `/management/v1/global-config/packages/${PACKAGE}/dry-run`],
  ])("%s %s requires global_config.restore", async (method, path) => {
    const { app, token } = await appFor(["platform_operator"], ["tenants.read", "payments.adapters.read"]);
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path).set("authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("apply/request needs global_config.restore.apply — the restore scope alone is not enough", async () => {
    const { app, token } = await appFor(["platform_admin"], ["global_config.restore"]);
    const res = await request(app).post(`/management/v1/global-config/packages/${PACKAGE}/apply/request`).set("authorization", `Bearer ${token}`).send({ reason: "x" });
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("apply/request needs a fresh step-up", async () => {
    const { app, token } = await appFor(["platform_admin"], ["global_config.restore.apply"]);
    const res = await request(app).post(`/management/v1/global-config/packages/${PACKAGE}/apply/request`).set("authorization", `Bearer ${token}`).send({ reason: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("STEP_UP_REQUIRED");
  });

  it("an unknown staged package 404s without leaking anything", async () => {
    const { app, token } = await appFor(["platform_admin"], ["global_config.restore"]);
    const res = await request(app).get(`/management/v1/global-config/packages/${PACKAGE}`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("GLOBAL_CONFIG_PACKAGE_NOT_FOUND");
  });
});
