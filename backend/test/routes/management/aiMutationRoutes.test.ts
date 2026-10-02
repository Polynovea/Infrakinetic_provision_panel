import request from "supertest";
import { describe, expect, it } from "vitest";

import { buildTestApp } from "../../helpers/testApp.js";
import { activeAdminOperator } from "../../helpers/operators.js";
import { buildTestIdentityProvider } from "../../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken } from "../../helpers/testToken.js";
import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { AI_SCOPES, CHECKER, EXECUTOR, MAKER, MODEL_ID, TENANT, createFakeOwner, testSigningKeys } from "../../helpers/aiOwnerFake.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import { ManagementApprovalStore } from "../../../src/management/operations/managementApprovalStore.js";
import { AI_CONTRACT } from "../../../src/management/operations/aiContract.js";
import { AI_LEDGERED_ROUTES } from "../../../src/management/operations/aiOperation.js";
import { ROLE_SCOPE_CEILING } from "../../../src/identity/roles.js";
import type { OperatorRecord } from "../../../src/identity/types.js";

// 1A.15 final closure — Governance HTTP routes for the AI mutation plane, exercised end to end:
// router -> requireScope / requireStepUp -> operation -> signed assertion -> fake owner, with the ledger and
// approval store on a real (pg-mem) migrated schema. Rejected paths first-class.

const BASE = "/management/v1";
const SUSPENSION = { state: "suspended", reason: "leaked key suspected", recoveryIntent: "restore after rotation", operationId: "00000000-0000-4000-8000-0000000000aa", since: "2026-02-01T00:00:00.000Z" };

const person = (id: string, sub: string, roles: OperatorRecord["roles"], scopes: string[]): OperatorRecord =>
  activeAdminOperator({ operatorId: id, cognitoSub: `sub-${sub}`, email: `${sub}@example.invalid`, displayName: sub, roles, scopes: scopes as never });

const PEOPLE = {
  admin: person(MAKER, "admin", ["platform_admin"], [...AI_SCOPES, "identity.read"]),
  checker: person(CHECKER, "checker", ["platform_admin"], [...AI_SCOPES, "identity.read"]),
  executor: person(EXECUTOR, "executor", ["platform_admin"], [...AI_SCOPES, "identity.read"]),
  finops: person("44444444-4444-4444-8444-444444444444", "finops", ["finops_operator"], ["ai.read", "ai.quota.write", "finops.policy.write"]),
  security: person("55555555-5555-4555-8555-555555555555", "security", ["security_operator"], ["ai.read", "ai.emergency_suspend", "credentials.revoke", "identity.read"]),
  viewer: person("66666666-6666-4666-8666-666666666666", "viewer", ["platform_viewer"], ["ai.read"]),
  blind: person("88888888-8888-4888-8888-888888888888", "blind", ["platform_viewer"], ["tenants.read"]),
};
type Who = keyof typeof PEOPLE;

async function harness(ownerOptions: Parameters<typeof createFakeOwner>[0] = {}) {
  const keyPair = await generateTestKeyPair();
  const provider = buildTestIdentityProvider(keyPair);
  const client = buildMigratedPgMemClient().client;
  for (const op of Object.values(PEOPLE)) {
    await client.query(
      `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', true, now(), now())`,
      [op.operatorId, op.cognitoSub, op.email, op.displayName],
    );
  }
  const owner = createFakeOwner(ownerOptions);
  const ledger = new ManagementOperationLedger(client);
  const approvals = new ManagementApprovalStore(client);
  const signingKeys = await testSigningKeys();
  const { app, sessionStore } = buildTestApp(provider, Object.values(PEOPLE), {
    ledger, approvals, commissionedTenants: new CommissionedTenantsRepository(client),
    getManagementSigningKeys: async () => signingKeys,
    loadTransportConfig: () => ({ issuer: "https://governance.test.invalid", audience: "infrakinetic-management-api-test" }),
    infrakineticBaseUrl: "https://infrakinetic.test.invalid",
    fetchImpl: owner.fetchImpl,
  });
  async function as(who: Who, options: { stepUp?: boolean } = {}) {
    const token = await signTestToken(keyPair, { subject: PEOPLE[who].cognitoSub });
    if (options.stepUp) {
      const jti = JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString()).jti as string;
      await sessionStore.recordStepUp(jti, { verifiedAt: new Date().toISOString(), method: "cognito-fresh-reauth" });
    }
    const call = (method: "get" | "post" | "put" | "delete", path: string) => request(app)[method](`${BASE}${path}`).set("authorization", `Bearer ${token}`);
    return call;
  }
  return { app, owner, ledger, approvals, as };
}

const QUOTA_KEY = encodeURIComponent("tenant:*:*:daily:requests:*");

describe("scope gates (role ceilings are unchanged; a scope is the authorization unit)", () => {
  it("the AI scope ceilings match the approved matrix", () => {
    expect(ROLE_SCOPE_CEILING.finops_operator).toEqual(expect.arrayContaining(["ai.quota.write", "finops.policy.write"]));
    expect(ROLE_SCOPE_CEILING.finops_operator).not.toContain("ai.emergency_suspend");
    expect(ROLE_SCOPE_CEILING.security_operator).toEqual(expect.arrayContaining(["ai.emergency_suspend", "credentials.revoke"]));
    for (const scope of ["ai.quota.write", "ai.entitlement.write", "ai.provider_policy.write", "finops.policy.write"]) expect(ROLE_SCOPE_CEILING.security_operator).not.toContain(scope);
    for (const role of ["platform_viewer", "platform_operator"] as const) {
      for (const scope of ["ai.quota.write", "ai.entitlement.write", "ai.provider_policy.write", "ai.emergency_suspend"]) expect(ROLE_SCOPE_CEILING[role]).not.toContain(scope);
    }
    // Only the two break-glass-class roles hold entitlement / provider-policy write.
    const holders = (scope: string) => (Object.keys(ROLE_SCOPE_CEILING) as Array<keyof typeof ROLE_SCOPE_CEILING>).filter((role) => (ROLE_SCOPE_CEILING[role] as readonly string[]).includes(scope)).sort();
    expect(holders("ai.entitlement.write")).toEqual(["break_glass", "platform_admin"]);
    expect(holders("ai.provider_policy.write")).toEqual(["break_glass", "platform_admin"]);
  });

  it.each(AI_LEDGERED_ROUTES.map((route) => [route.id, route] as const))("%s: a read-only viewer is refused with SCOPE_REQUIRED before anything else", async (_id, route) => {
    const { as, owner, ledger } = await harness();
    const call = await as("viewer", { stepUp: true });
    const path = route.path.replace(":tenantId", TENANT).replace(":capabilityKey", "marketing.seo_fix_draft").replace(":policyKey", QUOTA_KEY).replace(":providerKey", "nvidia_nim")
      .replace(":modelId", MODEL_ID).replace(":refId", "aicred_x").replace(":exceptionId", TENANT).replace(":reconciliationId", TENANT);
    const method = route.approval === "maker_checker" ? "post" : (route.method.toLowerCase() as "put" | "post" | "delete");
    const res = await call(method, route.approval === "maker_checker" ? `${path}/request` : path).send({ reason: "r", idempotencyKey: "k" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
    expect(owner.calls).toHaveLength(0);
    expect(await ledger.listOperations({ limit: 10 })).toHaveLength(0);
  });

  it("finops can run quota, billing anchor and the two resolves — and cannot suspend, change planes or touch providers", async () => {
    const { as, owner } = await harness();
    const finops = await as("finops");
    const quota = await finops("put", `/ai/tenants/${TENANT}/quotas/${QUOTA_KEY}`).send({
      idempotencyKey: "fq-1", reason: "raise the cap for the pilot",
      policy: { scopeType: "tenant", aiPlane: null, period: "daily", limitType: "requests", hardLimit: 900, enabled: true },
    });
    expect(quota.status).toBe(200);
    expect(quota.body.operation).toMatchObject({ status: "completed", riskClass: "R2", requestedAction: "ai.tenant.quota.set" });
    expect((await finops("put", `/ai/tenants/${TENANT}/billing-anchor`).send({ idempotencyKey: "fa-1", reason: "align", billingAnchorDay: 12 })).status).toBe(200);
    expect((await finops("post", "/ai/metering-exceptions/00000000-0000-4000-8000-000000000038/resolve").send({ idempotencyKey: "fm-1", reason: "investigated" })).status).toBe(200);
    expect((await finops("post", "/ai/reconciliation/lines/00000000-0000-4000-8000-000000000044/resolve").send({ idempotencyKey: "fr-1", reason: "vendor confirmed" })).status).toBe(200);
    const before = owner.mutations().length;
    for (const [method, path, body] of [
      ["post", `/ai/tenants/${TENANT}/suspend`, { idempotencyKey: "x1", reason: "r", recoveryIntent: "i" }],
      ["put", `/ai/tenants/${TENANT}/planes`, { idempotencyKey: "x2", reason: "r", planes: ["embedded_managed"] }],
      ["put", "/ai/providers/nvidia_nim/state", { idempotencyKey: "x3", reason: "r", status: "active" }],
      ["put", `/ai/tenants/${TENANT}/model-policy`, { idempotencyKey: "x4", reason: "r", providerKey: "nvidia_nim", decision: "deny" }],
      ["post", `/ai/tenants/${TENANT}/credentials/aicred_x/revoke`, { idempotencyKey: "x5", reason: "r" }],
    ] as const) {
      const res = await finops(method, path).send(body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(owner.mutations().length).toBe(before);
  });

  it("security can suspend (with step-up) and revoke a credential — and cannot change quotas or resolve exceptions", async () => {
    const { as } = await harness();
    const security = await as("security", { stepUp: true });
    const suspend = await security("post", `/ai/tenants/${TENANT}/suspend`).send({ idempotencyKey: "ss-1", reason: "abuse", recoveryIntent: "restore after rotation" });
    expect(suspend.status).toBe(200);
    expect(suspend.body.operation).toMatchObject({ status: "completed", riskClass: "R4" });
    const revoke = await security("post", `/ai/tenants/${TENANT}/credentials/aicred_00000000-0000-4000-8000-000000000035/revoke`).send({ idempotencyKey: "sr-1", reason: "employee left" });
    expect(revoke.status).toBe(200);
    expect(revoke.body.operation).toMatchObject({ status: "completed", riskClass: "R2" });
    expect((await security("put", `/ai/tenants/${TENANT}/quotas/${QUOTA_KEY}`).send({ idempotencyKey: "sq", reason: "r", policy: {} })).status).toBe(403);
    expect((await security("post", "/ai/metering-exceptions/00000000-0000-4000-8000-000000000038/resolve").send({ idempotencyKey: "sm", reason: "r" })).status).toBe(403);
  });
});

describe("fresh step-up", () => {
  it("suspend (R4) needs it: without, nothing is ledgered or sent", async () => {
    const { as, owner, ledger } = await harness();
    const res = await (await as("admin"))("post", `/ai/tenants/${TENANT}/suspend`).send({ idempotencyKey: "su-1", reason: "abuse", recoveryIntent: "later" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("STEP_UP_REQUIRED");
    expect(owner.calls).toHaveLength(0);
    expect(await ledger.listOperations({ limit: 10 })).toHaveLength(0);
  });

  it("provider state: narrowing needs step-up, activating does not", async () => {
    const { as } = await harness();
    const call = await as("admin");
    const disable = await call("put", "/ai/providers/nvidia_nim/state").send({ idempotencyKey: "pv-1", reason: "outage", status: "disabled", recoveryIntent: "vendor fix" });
    expect(disable.status).toBe(403);
    expect(disable.body.error).toBe("STEP_UP_REQUIRED");
    const deprecate = await call("put", "/ai/providers/nvidia_nim/state").send({ idempotencyKey: "pv-2", reason: "sunset", status: "deprecated", recoveryIntent: "n/a" });
    expect(deprecate.body.error).toBe("STEP_UP_REQUIRED");
    const activate = await call("put", "/ai/providers/nvidia_nim/state").send({ idempotencyKey: "pv-3", reason: "restore", status: "active" });
    expect(activate.status).toBe(200);
    expect(activate.body.operation).toMatchObject({ status: "completed", riskClass: "R2" });

    const stepped = await as("admin", { stepUp: true });
    const ok = await stepped("put", "/ai/providers/nvidia_nim/state").send({ idempotencyKey: "pv-4", reason: "outage", status: "disabled", recoveryIntent: "vendor fix VND-9" });
    expect(ok.status).toBe(200);
    expect(ok.body.operation.riskClass).toBe("R4");
  });

  it.each([
    ["tenant.resume", `/ai/tenants/${TENANT}/resume/request`],
    ["model.lifecycle.set", `/ai/models/${MODEL_ID}/lifecycle/request`],
    ["model.certification.set", `/ai/models/${MODEL_ID}/certification/request`],
  ])("%s: the maker's request needs step-up", async (_id, path) => {
    const { as, owner } = await harness();
    const res = await (await as("admin"))("post", path).send({ reason: "r", lifecycle: "deprecated", certification: "provider_certified", evidenceRef: "cert-1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("STEP_UP_REQUIRED");
    expect(owner.calls).toHaveLength(0);
  });

  it("the checker's decision and the execution each need their own step-up", async () => {
    const { as, owner, approvals } = await harness();
    owner.state.emergency = { ...SUSPENSION };
    const requested = await (await as("admin", { stepUp: true }))("post", `/ai/tenants/${TENANT}/resume/request`).send({ reason: "rotated" });
    const id = requested.body.approval.approvalId as string;

    const noStepUp = await (await as("checker"))("post", `/approvals/${id}/approve`).send({});
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body.error).toBe("STEP_UP_REQUIRED");
    expect((await approvals.getApproval(id)).status).toBe("pending");

    await (await as("checker", { stepUp: true }))("post", `/approvals/${id}/approve`).send({});
    const execNoStepUp = await (await as("admin"))("post", `/approvals/${id}/execute`).send({ idempotencyKey: "ex-0" });
    expect(execNoStepUp.body.error).toBe("STEP_UP_REQUIRED");
    expect(owner.mutations()).toHaveLength(0);
  });
});

describe("request validation", () => {
  it("requires an idempotency key and a reason", async () => {
    const { as } = await harness();
    const call = await as("admin");
    expect((await call("put", `/ai/tenants/${TENANT}/billing-anchor`).send({ reason: "r", billingAnchorDay: 3 })).body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await call("put", `/ai/tenants/${TENANT}/billing-anchor`).send({ idempotencyKey: "k", billingAnchorDay: 3 })).body.error).toBe("REASON_REQUIRED");
  });

  it("refuses a body the contract does not allow: unknown fields, bad enums, out-of-range values — before the ledger", async () => {
    const { as, owner, ledger } = await harness();
    const call = await as("admin");
    const unknown = await call("put", `/ai/tenants/${TENANT}/billing-anchor`).send({ idempotencyKey: "k1", reason: "r", billingAnchorDay: 3, smuggled: "x" });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: "AI_REQUEST_INVALID" });
    expect(unknown.body.violations).toContain("$.smuggled: unknown property");
    expect((await call("put", `/ai/tenants/${TENANT}/billing-anchor`).send({ idempotencyKey: "k2", reason: "r", billingAnchorDay: 31 })).status).toBe(400);
    expect((await call("put", `/ai/tenants/${TENANT}/commissioning-mode`).send({ idempotencyKey: "k3", reason: "r", mode: "sideways" })).status).toBe(400);
    expect(owner.calls).toHaveLength(0);
    expect(await ledger.listOperations({ limit: 10 })).toHaveLength(0);
  });

  it("a credential revoke rejects any attempt to smuggle material through it", async () => {
    const { as, owner } = await harness();
    const res = await (await as("security"))("post", `/ai/tenants/${TENANT}/credentials/aicred_x/revoke`).send({ idempotencyKey: "rv", reason: "r", apiKey: "sk-live-abcdef", secret: "x" });
    expect(res.status).toBe(400);
    expect(res.body.violations).toEqual(expect.arrayContaining(["$.apiKey: unknown property", "$.secret: unknown property"]));
    expect(owner.calls).toHaveLength(0);
  });

  it("replays through HTTP: the same key returns the recorded operation and the owner is called once", async () => {
    const { as, owner } = await harness();
    const call = await as("admin");
    const body = { idempotencyKey: "rp-1", reason: "align to invoice", billingAnchorDay: 9 };
    const first = await call("put", `/ai/tenants/${TENANT}/billing-anchor`).send(body);
    const second = await call("put", `/ai/tenants/${TENANT}/billing-anchor`).send(body);
    expect(first.body.replay).toBe(false);
    expect(second.body.replay).toBe(true);
    expect(second.body.operation.operationId).toBe(first.body.operation.operationId);
    expect(owner.mutations()).toHaveLength(1);
    const conflict = await call("put", `/ai/tenants/${TENANT}/billing-anchor`).send({ ...body, billingAnchorDay: 10 });
    expect(conflict.status).toBeGreaterThanOrEqual(400);
    expect(owner.mutations()).toHaveLength(1);
  });
});

describe("R3 maker-checker over HTTP", () => {
  it("resume: request (maker, step-up) -> approve (a different, scoped checker) -> execute — signed evidence, fresh state, single use", async () => {
    const { as, owner, approvals } = await harness();
    owner.state.emergency = { ...SUSPENSION };
    const requested = await (await as("admin", { stepUp: true }))("post", `/ai/tenants/${TENANT}/resume/request`).send({ reason: "rotation confirmed with customer" });
    expect(requested.status).toBe(201);
    expect(requested.body.approval).toMatchObject({ riskClass: "R3", status: "pending", requestedAction: "ai.tenant.emergency.resume", makerOperatorId: MAKER });
    const id = requested.body.approval.approvalId as string;

    // The maker cannot approve their own request.
    const self = await (await as("admin", { stepUp: true }))("post", `/approvals/${id}/approve`).send({});
    expect(self.status).toBe(403);
    expect(self.body.error).toBe("SELF_APPROVAL_NOT_ALLOWED");
    // An operator without the action's scope cannot decide it (finops has no ai.emergency_suspend).
    const wrong = await (await as("finops", { stepUp: true }))("post", `/approvals/${id}/approve`).send({});
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("SCOPE_REQUIRED");

    const decided = await (await as("checker", { stepUp: true }))("post", `/approvals/${id}/approve`).send({});
    expect(decided.body.approval).toMatchObject({ status: "approved", checkerOperatorId: CHECKER });

    // A scoped operator who is neither the maker nor the checker cannot execute it (the owner would refuse; Governance refuses first).
    const third = await (await as("executor", { stepUp: true }))("post", `/approvals/${id}/execute`).send({ idempotencyKey: "res-third" });
    expect(third.status).toBe(403);
    expect(third.body.error).toBe("AI_EXECUTOR_NOT_PARTY");
    expect(owner.mutations()).toHaveLength(0);
    expect((await approvals.getApproval(id)).executedAt).toBeUndefined();

    const executed = await (await as("admin", { stepUp: true }))("post", `/approvals/${id}/execute`).send({ idempotencyKey: "res-1" });
    expect(executed.status).toBe(200);
    expect(executed.body.operation).toMatchObject({ status: "completed", riskClass: "R3", requestedAction: "ai.tenant.emergency.resume" });
    expect(executed.body.approval.executedAt).toBeTruthy();
    expect(owner.mutations()).toHaveLength(1);
    expect(owner.mutations()[0]!.claims).toMatchObject({
      operator_id: MAKER, scopes: ["ai.emergency_suspend"],
      approval: { approval_id: id, maker_operator_id: MAKER, checker_operator_id: CHECKER },
    });

    const again = await (await as("admin", { stepUp: true }))("post", `/approvals/${id}/execute`).send({ idempotencyKey: "res-2" });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("APPROVAL_ALREADY_EXECUTED");
    const replay = await (await as("admin", { stepUp: true }))("post", `/approvals/${id}/execute`).send({ idempotencyKey: "res-1" });
    expect(replay.body.replay).toBe(true);
    expect(owner.mutations()).toHaveLength(1);
    expect((await approvals.getApproval(id)).status).toBe("approved");
  });

  it("resume of a tenant that is not suspended is refused with a typed 409 and creates no approval", async () => {
    const { as, approvals } = await harness();
    const res = await (await as("admin", { stepUp: true }))("post", `/ai/tenants/${TENANT}/resume/request`).send({ reason: "r" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("AI_TENANT_NOT_SUSPENDED");
    expect(await approvals.listApprovals({})).toHaveLength(0);
  });

  it("execution is refused with 409 AI_APPROVAL_TARGET_CHANGED when the owner's facts moved, and the approval stays usable", async () => {
    const { as, owner, approvals } = await harness();
    const requested = await (await as("admin", { stepUp: true }))("post", `/ai/models/${MODEL_ID}/lifecycle/request`).send({ reason: "vendor sunset", lifecycle: "deprecated" });
    expect(requested.status).toBe(201);
    expect(requested.body.approval.safeRequestSummary).toMatchObject({ capabilitiesUsingAsDefault: ["marketing.seo_fix_draft"] });
    const id = requested.body.approval.approvalId as string;
    await (await as("checker", { stepUp: true }))("post", `/approvals/${id}/approve`).send({});

    owner.catalog.providers[0].models[0].lifecycle = "deprecated";
    const stale = await (await as("admin", { stepUp: true }))("post", `/approvals/${id}/execute`).send({ idempotencyKey: "lc-x" });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("AI_APPROVAL_TARGET_CHANGED");
    expect(owner.mutations()).toHaveLength(0);
    expect((await approvals.getApproval(id)).executedAt).toBeUndefined();
  });

  it("model approvals need ai.provider_policy.write to decide or execute — security cannot", async () => {
    const { as } = await harness();
    const requested = await (await as("admin", { stepUp: true }))("post", `/ai/models/${MODEL_ID}/certification/request`).send({ reason: "run passed", certification: "provider_certified", evidenceRef: "cert-run-7" });
    expect(requested.status).toBe(201);
    expect(requested.body.approval.safeRequestSummary).toMatchObject({ evidenceRef: "cert-run-7", requestedCertification: "provider_certified" });
    const id = requested.body.approval.approvalId as string;
    const asSecurity = await (await as("security", { stepUp: true }))("post", `/approvals/${id}/approve`).send({});
    expect(asSecurity.status).toBe(403);
    expect(asSecurity.body.error).toBe("SCOPE_REQUIRED");
  });

  it("a certification request without a real evidence reference, or with one shaped like a credential, is refused", async () => {
    const { as, approvals } = await harness();
    const call = await as("admin", { stepUp: true });
    expect((await call("post", `/ai/models/${MODEL_ID}/certification/request`).send({ reason: "r", certification: "provider_certified" })).status).toBe(400);
    const secretShaped = await call("post", `/ai/models/${MODEL_ID}/certification/request`).send({ reason: "r", certification: "provider_certified", evidenceRef: "nvapi-abcdef0123456789" });
    expect(secretShaped.status).toBe(400);
    expect(secretShaped.body.error).toBe("EVIDENCE_REF_LOOKS_LIKE_SECRET");
    expect(await approvals.listApprovals({})).toHaveLength(0);
  });

  it("an R3 approval request must not carry an idempotency key (it belongs to the execute step)", async () => {
    const { as } = await harness();
    const res = await (await as("admin", { stepUp: true }))("post", `/ai/models/${MODEL_ID}/lifecycle/request`).send({ reason: "r", lifecycle: "deprecated", idempotencyKey: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.violations).toContain("$.idempotencyKey: unknown property");
  });
});

describe("reads", () => {
  it("credential metadata is safe fields only and needs ai.read", async () => {
    const { as, owner } = await harness();
    const ok = await (await as("viewer"))("get", `/ai/tenants/${TENANT}/credentials`);
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body.credentials[0]).sort()).toEqual(["createdAt", "maskedHint", "providerKey", "refId", "revokedAt", "status", "version"]);
    const denied = await (await as("blind"))("get", `/ai/tenants/${TENANT}/credentials`);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("SCOPE_REQUIRED");
    for (const path of ["/ai/metering-exceptions", "/ai/reconciliation", "/ai-admin-commands/any"]) {
      expect((await (await as("blind"))("get", path)).status, path).toBe(403);
    }
    expect(owner.calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("a secret-shaped field in an owner read is refused at the boundary (502) and never relayed", async () => {
    const { as, owner } = await harness();
    owner.state.credentialRefs[0].ciphertext = "AAAA";
    const res = await (await as("viewer"))("get", `/ai/tenants/${TENANT}/credentials`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("AI_OWNER_RESPONSE_UNSAFE");
    expect(JSON.stringify(res.body)).not.toContain("AAAA");
  });

  it("filters are validated before the owner is called", async () => {
    const { as, owner } = await harness();
    const call = await as("viewer");
    expect((await call("get", "/ai/metering-exceptions?state=sideways")).status).toBe(400);
    expect((await call("get", "/ai/metering-exceptions?tenantId=not-a-uuid")).status).toBe(400);
    expect((await call("get", "/ai/reconciliation?outcome=made_up")).status).toBe(400);
    expect((await call("get", "/ai/reconciliation?limit=0")).status).toBe(400);
    expect(owner.calls).toHaveLength(0);
    expect((await call("get", "/ai/reconciliation?outcome=credential_mismatch&state=open&providerKey=nvidia_nim&limit=50")).status).toBe(200);
    expect(owner.calls[0]!.path).toBe("/management/v1/ai/reconciliation?outcome=credential_mismatch&state=open&providerKey=nvidia_nim&limit=50");
  });

  it("the command receipt is readable only for AI commands Governance itself recorded", async () => {
    const { as, ledger } = await harness();
    const admin = await as("admin");
    await admin("put", `/ai/tenants/${TENANT}/billing-anchor`).send({ idempotencyKey: "rc-1", reason: "align", billingAnchorDay: 7 });
    const receipt = await (await as("viewer"))("get", "/ai-admin-commands/rc-1");
    expect(receipt.status).toBe(200);
    expect(receipt.body.command).toMatchObject({ idempotencyKey: "rc-1", action: "ai.tenant.billing-anchor.set", status: "completed" });
    expect((await (await as("viewer"))("get", "/ai-admin-commands/never-issued")).status).toBe(404);

    // A ledger row of another domain under some key is not an AI command receipt.
    await ledger.createOrReplayOperation({
      idempotencyKey: "other-domain", operatorId: MAKER, requestedAction: "platform.engine-state.set", targetEngine: "module_ai", reason: "r", riskClass: "R2",
      payload: {}, contractVersion: "platform-management.command.v1", correlationId: "77777777-7777-4777-8777-777777777777",
    });
    expect((await (await as("viewer"))("get", "/ai-admin-commands/other-domain")).status).toBe(404);
  });

  it("the commissioning-mode preview needs ai.entitlement.write and returns the diff hash the apply is bound to", async () => {
    const { as, ledger } = await harness();
    expect((await (await as("finops"))("post", `/ai/tenants/${TENANT}/commissioning-mode/preview`).send({ mode: "explicit" })).status).toBe(403);
    const ok = await (await as("admin"))("post", `/ai/tenants/${TENANT}/commissioning-mode/preview`).send({ mode: "explicit" });
    expect(ok.status).toBe(200);
    expect(ok.body.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await ledger.listOperations({ limit: 10 })).toHaveLength(0);
    expect((await (await as("admin"))("post", `/ai/tenants/${TENANT}/commissioning-mode/preview`).send({ mode: "nope" })).status).toBe(400);
  });
});

describe("the AI route surface is exactly what the contract declares", () => {
  interface Layer { route?: { path: string; methods: Record<string, boolean> }; name?: string; handle?: { stack?: Layer[] } }

  function aiRoutes(app: unknown): string[] {
    const found: string[] = [];
    const walk = (stack: Layer[]) => {
      for (const layer of stack) {
        if (layer.route) for (const method of Object.keys(layer.route.methods)) found.push(`${method.toUpperCase()} ${layer.route.path}`);
        else if (layer.name === "router" && layer.handle?.stack) walk(layer.handle.stack);
      }
    };
    walk(((app as { _router: { stack: Layer[] } })._router).stack);
    return found.filter((entry) => /^\w+ \/(ai\/|ai-admin-commands)/.test(entry)).sort();
  }

  it("has no AI route the contract does not declare — and none that could carry credential material", async () => {
    const { app } = await harness();
    const expected = [
      "GET /ai/tenants/:tenantId/state", "GET /ai/fleet/summary", "GET /ai/catalog", "GET /ai/tenants/:tenantId/credentials",
      "GET /ai/managed-credentials", "GET /ai/metering-exceptions", "GET /ai/reconciliation", "GET /ai-admin-commands/:idempotencyKey",
      "POST /ai/tenants/:tenantId/commissioning-mode/preview",
      ...AI_LEDGERED_ROUTES.map((route) => (route.approval === "maker_checker" ? `POST ${route.path}/request` : `${route.method} ${route.path}`)),
    ].sort();
    expect(aiRoutes(app)).toEqual(expected);
    // Tenant BYOAI remains metadata + revoke only. Platform-managed credentials
    // intentionally have add/rotate/status routes under their own root scope.
    for (const entry of aiRoutes(app).filter((route) => route.includes("/ai/tenants/") && route.includes("/credentials"))) {
      expect(entry, entry).not.toMatch(/submit|rotate|decrypt|secret|token|\/test\b|upload/i);
    }
    // Every contract read + mutation is reachable on Governance (the preview is the one unreceipted POST).
    const declared = AI_CONTRACT.routes.filter((route) => route.kind === "mutation").map((route) => route.id);
    expect(declared.length).toBe(AI_LEDGERED_ROUTES.length + 1);
  });
});
