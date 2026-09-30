import { describe, expect, it } from "vitest";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { CHECKER, EXECUTOR, MAKER, MODEL_ID, TENANT, aiDeps, createFakeOwner, operator, seedAiOperators, type FakeOwnerOptions } from "../../helpers/aiOwnerFake.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import {
  ApprovalAlreadyExecutedError, ApprovalNotApprovedError, ApprovalPayloadMismatchError, ManagementApprovalStore, SelfApprovalNotAllowedError,
} from "../../../src/management/operations/managementApprovalStore.js";
import { InvalidAiRequestError } from "../../../src/management/operations/aiContract.js";
import {
  AI_APPROVAL_ROUTES, aiApprovalScope, executeAiApproval, isAiApproval, requestAiApproval,
} from "../../../src/management/operations/aiOperation.js";

// 1A.15 final closure — R3 maker-checker for the AI plane: tenant resume, model lifecycle, model certification.
// The properties under test: the checker approves a concrete safe diff; execution re-reads the owner's CURRENT
// facts and refuses BEFORE consuming the approval if they moved; the owner's assertion carries the signed
// maker/checker evidence; approvals are single-use and replay-safe.

const SUSPENSION = { state: "suspended", reason: "leaked key suspected", recoveryIntent: "restore after rotation", operationId: "00000000-0000-4000-8000-0000000000aa", since: "2026-02-01T00:00:00.000Z" };

async function setup(options: FakeOwnerOptions = {}) {
  const { client } = buildMigratedPgMemClient();
  await seedAiOperators(client);
  const owner = createFakeOwner(options);
  const base = await aiDeps(new ManagementOperationLedger(client), owner);
  const approvals = new ManagementApprovalStore(client);
  return { deps: { ...base, approvals }, owner, approvals, client, ledger: base.ledger };
}

const suspended = (owner: ReturnType<typeof createFakeOwner>) => { owner.state.emergency = { ...SUSPENSION }; };
const decide = (approvals: ManagementApprovalStore, approvalId: string, decision: "approved" | "rejected" = "approved") =>
  approvals.decideApproval({ approvalId, checkerOperatorId: CHECKER, decision });

const RESUME = { routeId: "tenant.resume", pathParams: { tenantId: TENANT }, fields: {} };
const LIFECYCLE = { routeId: "model.lifecycle.set", pathParams: { modelId: MODEL_ID }, fields: { lifecycle: "deprecated" } };
const CERTIFY = { routeId: "model.certification.set", pathParams: { modelId: MODEL_ID }, fields: { certification: "provider_certified", evidenceRef: "cert-run-2026-10-05" } };

describe("which actions are AI approvals", () => {
  it("are exactly the contract's R3 actions, each with its own contract scope", () => {
    expect(AI_APPROVAL_ROUTES.map((route) => route.action).sort()).toEqual(["ai.model.certification.set", "ai.model.lifecycle.set", "ai.tenant.emergency.resume"]);
    expect(aiApprovalScope({ requestedAction: "ai.tenant.emergency.resume" })).toBe("ai.emergency_suspend");
    expect(aiApprovalScope({ requestedAction: "ai.model.lifecycle.set" })).toBe("ai.provider_policy.write");
    expect(aiApprovalScope({ requestedAction: "ai.model.certification.set" })).toBe("ai.provider_policy.write");
    expect(isAiApproval({ requestedAction: "ai.tenant.emergency.suspend" })).toBe(false); // suspend is single-operator R4
    expect(isAiApproval({ requestedAction: "payment.adapter.approve" })).toBe(false);
    expect(aiApprovalScope({ requestedAction: "identity.force-reset" })).toBeUndefined();
  });
});

describe("who may execute an approval", () => {
  it("only the maker or the checker: a third party is refused before the owner is read or the approval consumed", async () => {
    const { deps, owner, approvals } = await setup();
    suspended(owner);
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...RESUME, reason: "r" });
    await decide(approvals, approval.approvalId);
    const readsBefore = owner.calls.length;
    await expect(executeAiApproval(deps, { ...operator(EXECUTOR), approvalId: approval.approvalId, idempotencyKey: "third-1" })).rejects.toMatchObject({ code: "AI_EXECUTOR_NOT_PARTY", httpStatus: 403 });
    expect(owner.calls.length).toBe(readsBefore);
    expect((await approvals.getApproval(approval.approvalId)).executedAt).toBeUndefined();

    // The checker may execute what they approved (the owner accepts either party), signed as themselves.
    const result = await executeAiApproval(deps, { ...operator(CHECKER), approvalId: approval.approvalId, idempotencyKey: "checker-exec" });
    expect(result.operation.status).toBe("completed");
    expect(owner.mutations()[0]!.claims).toMatchObject({ operator_id: CHECKER, approval: { approval_id: approval.approvalId, maker_operator_id: MAKER, checker_operator_id: CHECKER } });
  });

  it("the contract declares the rule for exactly the R3 routes, and the owner fake refuses a non-party the way the real owner does", async () => {
    for (const route of AI_APPROVAL_ROUTES) expect(route.approvalExecutor, route.id).toBe("maker_or_checker");
    const { owner } = await setup();
    // Bypass Governance's own gate: a signed non-party assertion straight at the owner.
    const { mintManagementAssertion } = await import("../../../src/management/managementAssertionIssuer.js");
    const { testSigningKeys } = await import("../../helpers/aiOwnerFake.js");
    const assertion = await mintManagementAssertion(await testSigningKeys(), { issuer: "i", audience: "a" }, {
      operatorId: EXECUTOR, operatorSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operatorRoles: ["platform_admin"], operatorGrantedScopes: ["ai.emergency_suspend"], requestedScopes: ["ai.emergency_suspend"],
      targetTenantId: TENANT, targetResourceType: "tenant", targetResourceId: TENANT, requestedAction: "ai.tenant.emergency.resume",
      approvalEvidence: { approvalId: "44444444-4444-4444-8444-444444444444", makerOperatorId: MAKER, checkerOperatorId: CHECKER },
    });
    const res = await owner.fetchImpl(`https://x.test/management/v1/ai/tenants/${TENANT}/resume`, { method: "POST", headers: { authorization: `Bearer ${assertion}` }, body: JSON.stringify({ idempotencyKey: "k", reason: "r" }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "APPROVAL_OPERATOR_MISMATCH" });
  });
});

describe("tenant resume (R3)", () => {
  it("binds the owner's current suspension into the approval; execution carries the signed checker and the fresh state proves the result", async () => {
    const { deps, owner, approvals, ledger } = await setup();
    suspended(owner);
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...RESUME, reason: "key rotated, customer verified" });
    expect(approval).toMatchObject({ riskClass: "R3", requestedAction: "ai.tenant.emergency.resume", targetTenantId: TENANT, targetResourceType: "tenant", targetResourceId: TENANT, status: "pending", makerOperatorId: MAKER });
    expect(approval.safeRequestSummary).toEqual({
      tenantId: TENANT, emergencyStateAtRequest: "suspended", suspendedSince: SUSPENSION.since, suspendOperationId: SUSPENSION.operationId,
      suspendReason: SUSPENSION.reason, recoveryIntent: SUSPENSION.recoveryIntent, resumesTo: "none",
    });
    expect(owner.mutations()).toHaveLength(0);

    await decide(approvals, approval.approvalId);
    const result = await executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "resume-1" });
    expect(result.operation.status).toBe("completed");
    expect(result.operation.riskClass).toBe("R3");
    expect(result.operation.approvalEvidence).toMatchObject({ approvalId: approval.approvalId, checkerOperatorId: CHECKER });
    expect((result.operation.result as { observation: { status: string } }).observation.status).toBe("verified");

    const [call] = owner.mutations();
    expect(call).toMatchObject({ method: "POST", path: `/management/v1/ai/tenants/${TENANT}/resume` });
    expect(call!.body).toEqual({ idempotencyKey: "resume-1", reason: "key rotated, customer verified" });
    expect(call!.claims).toMatchObject({
      operator_id: MAKER, scopes: ["ai.emergency_suspend"], requested_action: "ai.tenant.emergency.resume", target_tenant_id: TENANT,
      approval: { approval_id: approval.approvalId, maker_operator_id: MAKER, checker_operator_id: CHECKER },
    });
    expect(await ledger.getByIdempotencyKey("resume-1")).toMatchObject({ requestedAction: "ai.tenant.emergency.resume" });
  });

  it("a tenant that is not suspended has nothing to resume: no approval is created", async () => {
    const { deps, approvals } = await setup();
    await expect(requestAiApproval(deps, { ...operator(MAKER), ...RESUME, reason: "r" })).rejects.toMatchObject({ code: "AI_TENANT_NOT_SUSPENDED" });
    expect(await approvals.listApprovals({})).toHaveLength(0);
  });

  it("the maker cannot decide their own request", async () => {
    const { deps, approvals, owner } = await setup();
    suspended(owner);
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...RESUME, reason: "r" });
    await expect(approvals.decideApproval({ approvalId: approval.approvalId, checkerOperatorId: MAKER, decision: "approved" })).rejects.toBeInstanceOf(SelfApprovalNotAllowedError);
  });

  it("an undecided or rejected approval cannot execute, and refuses before reading any owner state", async () => {
    const { deps, approvals, owner } = await setup();
    suspended(owner);
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...RESUME, reason: "r" });
    const readsBefore = owner.calls.length;
    await expect(executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "e0" })).rejects.toBeInstanceOf(ApprovalNotApprovedError);
    await decide(approvals, approval.approvalId, "rejected");
    await expect(executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "e0" })).rejects.toBeInstanceOf(ApprovalNotApprovedError);
    expect(owner.calls.length).toBe(readsBefore);
    expect(owner.mutations()).toHaveLength(0);
  });

  it("executes exactly once: the same key replays the durable result, a new key is refused, and the owner is called once", async () => {
    const { deps, approvals, owner } = await setup();
    suspended(owner);
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...RESUME, reason: "r" });
    await decide(approvals, approval.approvalId);
    const first = await executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "once-1" });
    // The owner state has since changed (the tenant IS resumed now) — a replay must not trip over the freshness gate.
    const replay = await executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "once-1" });
    expect(replay.replay).toBe(true);
    expect(replay.operation.operationId).toBe(first.operation.operationId);
    await expect(executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "once-2" })).rejects.toBeInstanceOf(ApprovalAlreadyExecutedError);
    expect(owner.mutations()).toHaveLength(1);
  });

  it("refuses to execute when the suspension the checker approved is no longer the owner's — and leaves the approval unconsumed", async () => {
    const { deps, approvals, owner } = await setup();
    suspended(owner);
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...RESUME, reason: "r" });
    await decide(approvals, approval.approvalId);

    // Someone re-suspended the tenant with a new recovery plan (a different suspension event).
    owner.state.emergency = { ...SUSPENSION, operationId: "00000000-0000-4000-8000-0000000000ff", since: "2026-02-03T00:00:00.000Z" };
    await expect(executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "stale-1" })).rejects.toMatchObject({
      code: "AI_APPROVAL_TARGET_CHANGED", httpStatus: 409,
    });
    expect(owner.mutations()).toHaveLength(0);
    expect((await approvals.getApproval(approval.approvalId)).executedAt).toBeUndefined();

    // Or already resumed by another path.
    owner.state.emergency = { state: "none", reason: null, recoveryIntent: null, operationId: null, since: null };
    await expect(executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "stale-2" })).rejects.toMatchObject({ code: "AI_APPROVAL_TARGET_CHANGED" });

    // The facts return to what was approved: the same approval still works, proving it was never consumed.
    suspended(owner);
    const result = await executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "stale-3" });
    expect(result.operation.status).toBe("completed");
  });

  it("an approval whose bound summary was altered after approval is refused by the payload hash, before the owner is called", async () => {
    const { deps, approvals, owner, client } = await setup();
    suspended(owner);
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...RESUME, reason: "r" });
    await decide(approvals, approval.approvalId);
    await client.query(`UPDATE governance.management_approvals SET safe_request_summary = $2::jsonb WHERE approval_id = $1`, [approval.approvalId, JSON.stringify({ ...approval.safeRequestSummary, resumesTo: "something-else" })]);
    await expect(executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "t-1" })).rejects.toBeInstanceOf(ApprovalPayloadMismatchError);
    expect(owner.mutations()).toHaveLength(0);
  });

  it("an operator who cannot read AI state cannot request or execute (the fresh read is part of the control)", async () => {
    const { deps, owner } = await setup();
    suspended(owner);
    await expect(requestAiApproval(deps, { ...operator(MAKER, ["ai.emergency_suspend"]), ...RESUME, reason: "r" })).rejects.toThrow(/not granted/);
  });
});

describe("model lifecycle (R3)", () => {
  it("shows the checker which capabilities use the model as their default, and executes the approved lifecycle", async () => {
    const { deps, owner, approvals } = await setup();
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...LIFECYCLE, reason: "vendor deprecating the model" });
    expect(approval).toMatchObject({ riskClass: "R3", requestedAction: "ai.model.lifecycle.set", targetResourceType: "ai_model", targetResourceId: MODEL_ID });
    expect(approval.targetTenantId).toBeUndefined();
    expect(approval.safeRequestSummary).toMatchObject({
      modelId: MODEL_ID, providerKey: "nvidia_nim", modelKey: "chat_default", lifecycleAtRequest: "active", requestedLifecycle: "deprecated",
      capabilitiesUsingAsDefault: ["marketing.seo_fix_draft"],
    });

    await decide(approvals, approval.approvalId);
    const result = await executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "lc-1" });
    expect(result.operation.status).toBe("completed");
    expect((result.operation.result as { observation: { via: string; status: string } }).observation).toMatchObject({ via: "catalog", status: "verified" });
    const call = owner.mutations()[0]!;
    expect(call).toMatchObject({ method: "PUT", path: `/management/v1/ai/models/${MODEL_ID}/lifecycle` });
    expect(call.body).toEqual({ lifecycle: "deprecated", idempotencyKey: "lc-1", reason: "vendor deprecating the model" });
    expect(call.claims).toMatchObject({
      scopes: ["ai.provider_policy.write"], requested_action: "ai.model.lifecycle.set", target_resource_type: "ai_model", target_resource_id: MODEL_ID,
      approval: { approval_id: approval.approvalId, maker_operator_id: MAKER, checker_operator_id: CHECKER },
    });
    expect(call.claims.target_tenant_id).toBeUndefined();
  });

  it("refuses at request time: retired is terminal, no-change is pointless, an unknown model is a 404", async () => {
    const { deps, owner, approvals } = await setup();
    await expect(requestAiApproval(deps, { ...operator(MAKER), ...LIFECYCLE, fields: { lifecycle: "active" }, reason: "r" })).rejects.toMatchObject({ code: "AI_NO_CHANGE" });
    await expect(requestAiApproval(deps, { ...operator(MAKER), ...LIFECYCLE, pathParams: { modelId: "00000000-0000-4000-8000-00000000dead" }, reason: "r" })).rejects.toMatchObject({ code: "AI_MODEL_NOT_FOUND", httpStatus: 404 });
    owner.catalog.providers[0].models[0].lifecycle = "retired";
    await expect(requestAiApproval(deps, { ...operator(MAKER), ...LIFECYCLE, reason: "r" })).rejects.toMatchObject({ code: "AI_MODEL_RETIRED" });
    expect(await approvals.listApprovals({})).toHaveLength(0);
  });

  it("refuses to execute if the model's lifecycle changed after approval", async () => {
    const { deps, owner, approvals } = await setup();
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...LIFECYCLE, reason: "r" });
    await decide(approvals, approval.approvalId);
    owner.catalog.providers[0].models[0].lifecycle = "deprecated"; // another operator got there first
    await expect(executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "lc-stale" })).rejects.toMatchObject({ code: "AI_APPROVAL_TARGET_CHANGED" });
    expect(owner.mutations()).toHaveLength(0);
    expect((await approvals.getApproval(approval.approvalId)).executedAt).toBeUndefined();
  });

  it("an owner that answers 200 without applying the lifecycle leaves a partially_completed operation, not a success", async () => {
    const { deps, approvals } = await setup({ applyEffects: false });
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...LIFECYCLE, reason: "r" });
    await decide(approvals, approval.approvalId);
    const result = await executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "lc-mm" });
    expect(result.operation.status).toBe("partially_completed");
    expect(result.operation.partialFailureState).toMatchObject({ stage: "effective-mismatch", via: "catalog", expected: "deprecated", observed: "active" });
  });
});

describe("model certification (R3)", () => {
  it("binds the evidence reference the checker sees, and forwards exactly the approved certification and evidence", async () => {
    const { deps, owner, approvals } = await setup();
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...CERTIFY, reason: "certification run passed" });
    expect(approval.safeRequestSummary).toMatchObject({ modelId: MODEL_ID, certificationAtRequest: "synthetic_certified", requestedCertification: "provider_certified", evidenceRef: "cert-run-2026-10-05" });

    await decide(approvals, approval.approvalId);
    const result = await executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "cert-1" });
    expect(result.operation.status).toBe("completed");
    expect(owner.mutations()[0]!.body).toEqual({ certification: "provider_certified", evidenceRef: "cert-run-2026-10-05", idempotencyKey: "cert-1", reason: "certification run passed" });
    expect(owner.catalog.providers[0].models[0]).toMatchObject({ certification: "provider_certified", certificationEvidenceRef: "cert-run-2026-10-05" });
  });

  it("requires a real evidence reference and refuses one shaped like a credential", async () => {
    const { deps, approvals } = await setup();
    await expect(requestAiApproval(deps, { ...operator(MAKER), ...CERTIFY, fields: { certification: "provider_certified" }, reason: "r" })).rejects.toBeInstanceOf(InvalidAiRequestError);
    await expect(requestAiApproval(deps, { ...operator(MAKER), ...CERTIFY, fields: { certification: "provider_certified", evidenceRef: "   " }, reason: "r" })).rejects.toMatchObject({ code: "AI_EVIDENCE_REF_REQUIRED" });
    await expect(requestAiApproval(deps, { ...operator(MAKER), ...CERTIFY, fields: { certification: "provider_certified", evidenceRef: "aicred_00000000-0000-4000-8000-000000000035" }, reason: "r" })).rejects.toMatchObject({ code: "EVIDENCE_REF_LOOKS_LIKE_SECRET" });
    await expect(requestAiApproval(deps, { ...operator(MAKER), ...CERTIFY, fields: { certification: "provider_certified", evidenceRef: "nvapi-0123456789abcdef" }, reason: "r" })).rejects.toMatchObject({ code: "EVIDENCE_REF_LOOKS_LIKE_SECRET" });
    expect(await approvals.listApprovals({})).toHaveLength(0);
  });

  it("refuses to execute if the model's certification changed after approval", async () => {
    const { deps, owner, approvals } = await setup();
    const approval = await requestAiApproval(deps, { ...operator(MAKER), ...CERTIFY, reason: "r" });
    await decide(approvals, approval.approvalId);
    owner.catalog.providers[0].models[0].certification = "uncertified";
    await expect(executeAiApproval(deps, { ...operator(MAKER), approvalId: approval.approvalId, idempotencyKey: "cert-stale" })).rejects.toMatchObject({ code: "AI_APPROVAL_TARGET_CHANGED" });
    expect(owner.mutations()).toHaveLength(0);
  });
});

describe("misuse of the approval pair", () => {
  it("cannot request an approval for a route that is not R3", async () => {
    const { deps } = await setup();
    await expect(requestAiApproval(deps, { ...operator(MAKER), routeId: "tenant.suspend", pathParams: { tenantId: TENANT }, fields: { recoveryIntent: "x" }, reason: "r" })).rejects.toMatchObject({ code: "AI_ROUTE_NOT_APPROVAL_GATED" });
  });

  it("cannot execute an approval that belongs to another domain through the AI executor", async () => {
    const { deps, approvals } = await setup();
    const foreign = await approvals.createApproval({
      approvalId: "44444444-4444-4444-8444-444444444444", requestedAction: "payment.adapter.approve", targetResourceType: "payment_adapter_release", targetResourceId: "r",
      safePayloadHash: "h", safeRequestSummary: {}, riskClass: "R3", reason: "r", makerOperatorId: MAKER, correlationId: "55555555-5555-4555-8555-555555555555", ttlSeconds: 60,
    });
    await expect(executeAiApproval(deps, { ...operator(MAKER), approvalId: foreign.approvalId, idempotencyKey: "x" })).rejects.toMatchObject({ code: "AI_ROUTE_NOT_APPROVAL_GATED" });
  });
});
