import request from "supertest";
import { describe, expect, it } from "vitest";

import { buildTestApp } from "../../helpers/testApp.js";
import { activeAdminOperator } from "../../helpers/operators.js";
import { buildTestIdentityProvider } from "../../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken } from "../../helpers/testToken.js";

// 1A.14 — Governance route wiring for payment adapters / integrations:
// scope gates (including the new payments.adapters.submit, which the
// certify scope does not imply and security_operator does not hold) and
// fresh step-up on every R3/R4 request. Orchestration is covered against
// paymentAdapterOperation.ts directly (this layer has no fetchImpl hook).

const RELEASE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

async function appFor(roles: string[], scopes: string[]) {
  const keyPair = await generateTestKeyPair();
  const op = activeAdminOperator({ roles: roles as never, scopes: scopes as never });
  const { app } = buildTestApp(buildTestIdentityProvider(keyPair), [op]);
  return { app, token: await signTestToken(keyPair, { subject: op.cognitoSub }) };
}

describe("payment adapter route scopes", () => {
  it("submit requires payments.adapters.submit — certify is not enough", async () => {
    const { app, token } = await appFor(["platform_admin"], ["payments.adapters.certify"]);
    const res = await request(app).post("/management/v1/payment-adapters").set("authorization", `Bearer ${token}`).send({ reason: "x", idempotencyKey: "k" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("a security_operator (adapter revoke only) cannot submit adapters", async () => {
    const { app, token } = await appFor(["security_operator"], ["payments.adapters.revoke"]);
    const res = await request(app).post("/management/v1/payment-adapters").set("authorization", `Bearer ${token}`).send({ reason: "x", idempotencyKey: "k" });
    expect(res.status).toBe(403);
  });

  it("a viewer can read but cannot deprecate", async () => {
    const { app, token } = await appFor(["platform_viewer"], ["payments.adapters.read"]);
    const res = await request(app).post(`/management/v1/payment-adapters/${RELEASE}/deprecate`).set("authorization", `Bearer ${token}`).send({ reason: "x", idempotencyKey: "k" });
    expect(res.status).toBe(403);
  });

  it("R2 commands require a reason and an idempotency key", async () => {
    const { app, token } = await appFor(["security_operator"], ["payments.adapters.revoke"]);
    const noKey = await request(app).post(`/management/v1/payment-adapters/${RELEASE}/deprecate`).set("authorization", `Bearer ${token}`).send({ reason: "x" });
    expect(noKey.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    const noReason = await request(app).post(`/management/v1/payment-adapters/${RELEASE}/deprecate`).set("authorization", `Bearer ${token}`).send({ idempotencyKey: "k" });
    expect(noReason.body.error).toBe("REASON_REQUIRED");
  });

  it.each([
    ["approve", "payments.adapters.approve"],
    ["retire", "payments.adapters.revoke"],
    ["revoke", "payments.adapters.revoke"],
  ])("%s/request needs its scope and a fresh step-up", async (segment, scope) => {
    const withoutScope = await appFor(["platform_viewer"], ["payments.adapters.read"]);
    const denied = await request(withoutScope.app).post(`/management/v1/payment-adapters/${RELEASE}/${segment}/request`).set("authorization", `Bearer ${withoutScope.token}`).send({ reason: "x" });
    expect(denied.body.error).toBe("SCOPE_REQUIRED");

    const scoped = await appFor(["platform_admin"], [scope]);
    const stale = await request(scoped.app).post(`/management/v1/payment-adapters/${RELEASE}/${segment}/request`).set("authorization", `Bearer ${scoped.token}`).send({ reason: "x" });
    expect(stale.status).toBe(403);
    expect(stale.body.error).toBe("STEP_UP_REQUIRED");
  });

  it("tenant integrations require integrations.read", async () => {
    const { app, token } = await appFor(["platform_viewer"], ["credentials.metadata.read"]);
    const res = await request(app).get("/management/v1/tenants/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/integrations").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
