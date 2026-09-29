import { describe, expect, it } from "vitest";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { AI_SCOPES, MODEL_ID, OPERATOR, TENANT, aiDeps, createFakeOwner, operator, seedAiOperators, type FakeOwner, type FakeOwnerOptions } from "../../helpers/aiOwnerFake.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { IdempotencyConflictError } from "../../../src/management/operations/managementOperationErrors.js";
import {
  AI_CONTRACT, InvalidAiRequestError, aiRoute, effectiveRisk, ownerPath, resolveTarget,
} from "../../../src/management/operations/aiContract.js";
import {
  AI_LEDGERED_ROUTES, AiOperationRefusedError, executeAiCommand, previewCommissioningMode,
} from "../../../src/management/operations/aiOperation.js";

// 1A.15 final closure — Governance's AI mutation plane. The fake owner (test/helpers/aiOwnerFake.ts) dispatches
// by the PUBLISHED contract, validates bodies against the strict request schemas and records the decoded
// assertion of every call, so these tests prove what Governance actually puts on the wire and in the ledger.

const PATH_SAMPLES: Record<string, string> = {
  tenantId: TENANT,
  capabilityKey: "marketing.seo_fix_draft",
  policyKey: "tenant:*:*:daily:requests:*",
  providerKey: "nvidia_nim",
  modelId: MODEL_ID,
  refId: "aicred_00000000-0000-4000-8000-000000000035",
  exceptionId: "00000000-0000-4000-8000-000000000038",
  reconciliationId: "00000000-0000-4000-8000-000000000044",
};

const pathParamsFor = (routeId: string) =>
  Object.fromEntries([...aiRoute(routeId).path.matchAll(/:([A-Za-z]+)/g)].map((match) => [match[1] as string, PATH_SAMPLES[match[1] as string] as string]));

function sampleFields(routeId: string): Record<string, unknown> {
  const vector = AI_CONTRACT.schemaVectors.find((entry) => entry.routeId === routeId && entry.name === "valid-full");
  if (!vector) return {};
  const fields = { ...(vector.body as Record<string, unknown>) };
  delete fields.idempotencyKey;
  delete fields.reason;
  return fields;
}

async function setup(options: FakeOwnerOptions = {}) {
  const { client } = buildMigratedPgMemClient();
  await seedAiOperators(client);
  const ledger = new ManagementOperationLedger(client);
  const owner: FakeOwner = createFakeOwner(options);
  const deps = await aiDeps(ledger, owner);
  return { deps, owner, ledger, client };
}

const DIRECT_ROUTES = AI_LEDGERED_ROUTES.filter((route) => route.approval === "none");

describe("contract coverage", () => {
  it("the ledgered, non-approval routes are exactly the R1/R2/R4 commands", () => {
    expect(DIRECT_ROUTES.map((route) => route.id).sort()).toEqual([
      "metering-exception.resolve", "provider.state.set",
      "reconciliation.line.resolve", "tenant.billing-anchor.set", "tenant.capability.commission", "tenant.commissioning-mode.set",
      "tenant.credential.revoke", "tenant.model-policy.set", "tenant.planes.set", "tenant.quota.grace.grant", "tenant.quota.remove", "tenant.quota.set", "tenant.suspend",
    ].sort());
  });
});

describe.each(DIRECT_ROUTES.map((route) => [route.id, route] as const))("%s", (routeId, route) => {
  it("executes through the ledger and the signed contract route, verified by an independent observation", async () => {
    const { deps, owner, ledger } = await setup();
    const fields = sampleFields(routeId);
    const pathParams = pathParamsFor(routeId);
    const result = await executeAiCommand(deps, { ...operator(), routeId, pathParams, fields, reason: `operator reason for ${routeId}`, idempotencyKey: `key-${routeId}` });

    expect(result.replay).toBe(false);
    expect(result.operation.status).toBe("completed");
    expect(result.operation.riskClass).toBe(effectiveRisk(route, fields));
    expect(result.operation.requestedAction).toBe(route.action);
    expect(result.operation.reason).toBe(`operator reason for ${routeId}`);
    const observation = (result.operation.result as { observation: { status: string; via: string } }).observation;
    expect(observation.status).toBe("verified");

    const mutation = owner.mutations();
    expect(mutation).toHaveLength(1);
    const call = mutation[0]!;
    const target = resolveTarget(route, pathParams, fields);
    expect(call.method).toBe(route.method);
    expect(decodeURIComponent(call.path)).toBe(decodeURIComponent(ownerPath(route, pathParams)));
    expect(call.body).toEqual({ ...fields, idempotencyKey: `key-${routeId}`, reason: `operator reason for ${routeId}` });
    expect(call.claims).toMatchObject({
      operator_id: OPERATOR, scopes: [route.scope], requested_action: route.action,
      target_resource_type: target.targetResourceType, target_resource_id: target.targetResourceId,
    });
    expect(call.claims.target_tenant_id).toBe(target.targetTenantId);
    expect(call.claims.approval).toBeUndefined();

    const stored = await ledger.getByIdempotencyKey(`key-${routeId}`);
    expect(stored?.targetTenantId).toBe(target.targetTenantId);
    expect(stored?.targetResourceType).toBe(target.targetResourceType);
    expect(stored?.targetResourceId).toBe(target.targetResourceId);
  });

  it("is refused before any ledger row or owner call when the body is not what the contract allows", async () => {
    const { deps, owner, ledger } = await setup();
    await expect(
      executeAiCommand(deps, { ...operator(), routeId, pathParams: pathParamsFor(routeId), fields: { ...sampleFields(routeId), smuggledField: "x" }, reason: "r", idempotencyKey: `bad-${routeId}` }),
    ).rejects.toBeInstanceOf(InvalidAiRequestError);
    expect(owner.calls).toHaveLength(0);
    expect(await ledger.listOperations({ limit: 100 })).toHaveLength(0);
  });

  it("replays the durable result for the same key and payload without a second owner call", async () => {
    const { deps, owner } = await setup();
    const params = { ...operator(), routeId, pathParams: pathParamsFor(routeId), fields: sampleFields(routeId), reason: "same request", idempotencyKey: `replay-${routeId}` };
    const first = await executeAiCommand(deps, params);
    const second = await executeAiCommand(deps, params);
    expect(second.replay).toBe(true);
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(owner.mutations()).toHaveLength(1);
  });

  it("a different reason under the same key conflicts instead of replaying (the owner's request hash includes it)", async () => {
    const { deps } = await setup();
    const params = { ...operator(), routeId, pathParams: pathParamsFor(routeId), fields: sampleFields(routeId), idempotencyKey: `conflict-${routeId}` };
    await executeAiCommand(deps, { ...params, reason: "first reason" });
    await expect(executeAiCommand(deps, { ...params, reason: "another reason" })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe("routes whose method or body shape needs explicit proof", () => {
  it("quota removal is a DELETE that still carries the idempotency key and reason in its body", async () => {
    const { deps, owner } = await setup();
    await executeAiCommand(deps, { ...operator(), routeId: "tenant.quota.remove", pathParams: pathParamsFor("tenant.quota.remove"), reason: "retire the daily cap", idempotencyKey: "q-del" });
    const call = owner.mutations()[0]!;
    expect(call.method).toBe("DELETE");
    expect(call.path).toBe(`/management/v1/ai/tenants/${TENANT}/quotas/tenant%3A*%3A*%3Adaily%3Arequests%3A*`);
    expect(call.body).toEqual({ idempotencyKey: "q-del", reason: "retire the daily cap" });
    expect(call.claims).toMatchObject({ scopes: ["ai.quota.write"], target_resource_type: "ai_quota_policy", target_resource_id: "tenant:*:*:daily:requests:*" });
  });

  it("tenant model policy addresses its derived provider/model id", async () => {
    const { deps, owner } = await setup();
    await executeAiCommand(deps, { ...operator(), routeId: "tenant.model-policy.set", pathParams: { tenantId: TENANT }, fields: { providerKey: "nvidia_nim", decision: "deny" }, reason: "vendor concern", idempotencyKey: "mp-1" });
    expect(owner.mutations()[0]!.claims).toMatchObject({ target_resource_type: "ai_model_policy", target_resource_id: "nvidia_nim/*", scopes: ["ai.provider_policy.write"] });
    await executeAiCommand(deps, { ...operator(), routeId: "tenant.model-policy.set", pathParams: { tenantId: TENANT }, fields: { providerKey: "nvidia_nim", modelKey: "chat_default", decision: "allow" }, reason: "vendor concern", idempotencyKey: "mp-2" });
    expect(owner.mutations()[1]!.claims.target_resource_id).toBe("nvidia_nim/chat_default");
  });

  it("metering-exception and reconciliation resolves are global (no tenant claim) and use their contract scopes", async () => {
    const { deps, owner } = await setup();
    await executeAiCommand(deps, { ...operator(), routeId: "metering-exception.resolve", pathParams: pathParamsFor("metering-exception.resolve"), reason: "investigated", idempotencyKey: "m-1" });
    await executeAiCommand(deps, { ...operator(), routeId: "reconciliation.line.resolve", pathParams: pathParamsFor("reconciliation.line.resolve"), reason: "vendor confirmed", idempotencyKey: "r-1" });
    const [metering, reconciliation] = owner.mutations();
    expect(metering!.claims).toMatchObject({ scopes: ["ai.quota.write"], target_resource_type: "ai_metering_exception" });
    expect(metering!.claims.target_tenant_id).toBeUndefined();
    expect(reconciliation!.claims).toMatchObject({ scopes: ["finops.policy.write"], target_resource_type: "ai_reconciliation_line" });
  });

  it("commissioning mode: the dry-run preview is unledgered and the apply is refused without its diff hash", async () => {
    const { deps, owner, ledger } = await setup();
    const preview = await previewCommissioningMode(deps, { ...operator(), tenantId: TENANT, mode: "explicit" });
    expect(preview.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await ledger.listOperations({ limit: 10 })).toHaveLength(0);
    expect(owner.calls[0]).toMatchObject({ method: "POST", claims: { scopes: ["ai.entitlement.write"], requested_action: "ai.tenant.commissioning-mode.preview" } });

    await expect(
      executeAiCommand(deps, { ...operator(), routeId: "tenant.commissioning-mode.set", pathParams: { tenantId: TENANT }, fields: { mode: "explicit" }, reason: "go explicit", idempotencyKey: "cm-0" }),
    ).rejects.toMatchObject({ code: "AI_DIFF_REQUIRED" });
    const applied = await executeAiCommand(deps, { ...operator(), routeId: "tenant.commissioning-mode.set", pathParams: { tenantId: TENANT }, fields: { mode: "explicit", expectedDiffHash: preview.diffHash }, reason: "go explicit", idempotencyKey: "cm-1" });
    expect(applied.operation.status).toBe("completed");
    expect(owner.mutations().find((call) => call.method === "PUT")!.body).toMatchObject({ mode: "explicit", expectedDiffHash: preview.diffHash });
  });

  it("commissioning a capability while the tenant is in legacy_additive mode is verified against the owner receipt, not a state that cannot show it", async () => {
    const { deps, owner } = await setup();
    owner.state.rootPolicy.commissioningMode = "legacy_additive";
    const result = await executeAiCommand(deps, { ...operator(), routeId: "tenant.capability.commission", pathParams: pathParamsFor("tenant.capability.commission"), fields: { plane: "embedded_managed", state: "decommissioned" }, reason: "prepare explicit mode", idempotencyKey: "cap-1" });
    expect(result.operation.status).toBe("completed");
    expect((result.operation.result as { observation: { via: string; message: string } }).observation).toMatchObject({ status: "verified", via: "receipt" });
  });
});

describe("risk classes and the controls the contract declares", () => {
  it("suspend is R4, needs a recovery intent, and is a single-operator command (no approval evidence)", async () => {
    const { deps, owner } = await setup();
    await expect(
      executeAiCommand(deps, { ...operator(), routeId: "tenant.suspend", pathParams: { tenantId: TENANT }, fields: { recoveryIntent: "   " }, reason: "abuse", idempotencyKey: "s0" }),
    ).rejects.toMatchObject({ code: "AI_RECOVERY_INTENT_REQUIRED" });
    expect(owner.calls).toHaveLength(0);

    const result = await executeAiCommand(deps, { ...operator(), routeId: "tenant.suspend", pathParams: { tenantId: TENANT }, fields: { recoveryIntent: "restore after key rotation" }, reason: "leaked key suspected", idempotencyKey: "s1" });
    expect(result.operation.riskClass).toBe("R4");
    expect(result.operation.status).toBe("completed");
    expect(result.operation.approvalEvidence).toBeUndefined();
    expect(owner.mutations()[0]!.claims).toMatchObject({ scopes: ["ai.emergency_suspend"], requested_action: "ai.tenant.emergency.suspend", target_tenant_id: TENANT });
  });

  it("provider state: activating is R2; narrowing (disable/deprecate) is R4 and needs a recovery intent", async () => {
    const { deps } = await setup();
    const active = await executeAiCommand(deps, { ...operator(), routeId: "provider.state.set", pathParams: { providerKey: "nvidia_nim" }, fields: { status: "active" }, reason: "restore", idempotencyKey: "p1" });
    expect(active.operation.riskClass).toBe("R2");
    await expect(
      executeAiCommand(deps, { ...operator(), routeId: "provider.state.set", pathParams: { providerKey: "nvidia_nim" }, fields: { status: "disabled" }, reason: "outage", idempotencyKey: "p2" }),
    ).rejects.toMatchObject({ code: "AI_RECOVERY_INTENT_REQUIRED" });
    const disabled = await executeAiCommand(deps, { ...operator(), routeId: "provider.state.set", pathParams: { providerKey: "nvidia_nim" }, fields: { status: "disabled", recoveryIntent: "vendor incident VND-9 resolved" }, reason: "outage", idempotencyKey: "p3" });
    expect(disabled.operation.riskClass).toBe("R4");
    expect(disabled.operation.status).toBe("completed");
  });

  it.each(["tenant.resume", "model.lifecycle.set", "model.certification.set"])("%s is R3: executeAiCommand refuses to run it without maker-checker", async (routeId) => {
    const { deps, owner, ledger } = await setup();
    await expect(
      executeAiCommand(deps, { ...operator(), routeId, pathParams: pathParamsFor(routeId), fields: sampleFields(routeId), reason: "r", idempotencyKey: `r3-${routeId}` }),
    ).rejects.toMatchObject({ code: "AI_APPROVAL_REQUIRED" });
    expect(owner.calls).toHaveLength(0);
    expect(await ledger.listOperations({ limit: 10 })).toHaveLength(0);
  });

  it("the unreceipted preview route cannot be executed as a command", async () => {
    const { deps } = await setup();
    await expect(
      executeAiCommand(deps, { ...operator(), routeId: "tenant.commissioning-mode.preview", pathParams: { tenantId: TENANT }, fields: { mode: "explicit" }, reason: "r", idempotencyKey: "pv" }),
    ).rejects.toMatchObject({ code: "AI_ROUTE_NOT_EXECUTABLE" });
  });

  it("a read route cannot be executed as a command", async () => {
    const { deps } = await setup();
    await expect(
      executeAiCommand(deps, { ...operator(), routeId: "tenant.state.read", pathParams: { tenantId: TENANT }, reason: "r", idempotencyKey: "rd" }),
    ).rejects.toBeInstanceOf(AiOperationRefusedError);
  });

  it("free text that looks like a credential never reaches the ledger or the owner", async () => {
    const { deps, owner, ledger } = await setup();
    await expect(
      executeAiCommand(deps, { ...operator(), routeId: "tenant.planes.set", pathParams: { tenantId: TENANT }, fields: { planes: ["embedded_managed"] }, reason: "key is nvapi-abcdefghijklmnop", idempotencyKey: "sec-1" }),
    ).rejects.toMatchObject({ code: "AI_TEXT_LOOKS_LIKE_SECRET" });
    await expect(
      executeAiCommand(deps, { ...operator(), routeId: "tenant.suspend", pathParams: { tenantId: TENANT }, fields: { recoveryIntent: "-----BEGIN PRIVATE KEY-----" }, reason: "r", idempotencyKey: "sec-2" }),
    ).rejects.toMatchObject({ code: "AI_TEXT_LOOKS_LIKE_SECRET" });
    expect(owner.calls).toHaveLength(0);
    expect(await ledger.listOperations({ limit: 10 })).toHaveLength(0);
  });

  it("there is no way to reach a BYOAI submit/rotate/decrypt/test operation: the only credential mutation is revoke, and it takes no material", () => {
    const credentialRoutes = AI_CONTRACT.routes.filter((route) => /credential/.test(route.id + route.path));
    expect(credentialRoutes.map((route) => route.id).sort()).toEqual(["tenant.credential.revoke", "tenant.credentials.read"]);
    const revoke = aiRoute("tenant.credential.revoke");
    expect(Object.keys(revoke.requestSchema?.properties ?? {}).sort()).toEqual(["idempotencyKey", "reason"]);
    expect(revoke.requestSchema?.additionalProperties).toBe(false);
  });
});

describe("failure classification and independent observation", () => {
  it("a connection that never established is a plain failed operation (never dispatched)", async () => {
    const { deps } = await setup({ throwOnMutation: { "tenant.planes.set": Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }) } });
    const result = await executeAiCommand(deps, { ...operator(), routeId: "tenant.planes.set", pathParams: { tenantId: TENANT }, fields: { planes: ["embedded_managed"] }, reason: "r", idempotencyKey: "nd-1" });
    expect(result.operation.status).toBe("failed");
    expect(result.operation.partialFailureState).toMatchObject({ stage: "mutation-call-never-dispatched" });
  });

  it("a timeout or reset after dispatch is outcome-ambiguous: partially_completed, never a retryable failure", async () => {
    const { deps } = await setup({ throwOnMutation: { "tenant.planes.set": new Error("The operation was aborted due to timeout") } });
    const result = await executeAiCommand(deps, { ...operator(), routeId: "tenant.planes.set", pathParams: { tenantId: TENANT }, fields: { planes: ["embedded_managed"] }, reason: "r", idempotencyKey: "amb-1" });
    expect(result.operation.status).toBe("partially_completed");
    expect(result.operation.partialFailureState).toMatchObject({ stage: "mutation-call" });
  });

  it("an owner refusal is a failed operation whose owner error body is kept (redacted)", async () => {
    const { deps } = await setup({ failMutation: { "tenant.commissioning-mode.set": { status: 409, body: { error: "DIFF_STALE", message: "the diff changed", apiKey: "leak-me" } } } });
    const result = await executeAiCommand(deps, { ...operator(), routeId: "tenant.commissioning-mode.set", pathParams: { tenantId: TENANT }, fields: { mode: "explicit", expectedDiffHash: "a".repeat(64) }, reason: "r", idempotencyKey: "f-1" });
    expect(result.operation.status).toBe("failed");
    expect(result.operation.partialFailureState).toMatchObject({ stage: "mutation-response", status: 409, body: { error: "DIFF_STALE", apiKey: "[redacted]" } });
  });

  it("an owner that answers 200 but did not apply the change is partially_completed with the expected and observed facts", async () => {
    const { deps } = await setup({ applyEffects: false });
    const result = await executeAiCommand(deps, { ...operator(), routeId: "tenant.suspend", pathParams: { tenantId: TENANT }, fields: { recoveryIntent: "later" }, reason: "abuse", idempotencyKey: "mm-1" });
    expect(result.operation.status).toBe("partially_completed");
    expect(result.operation.partialFailureState).toEqual({ stage: "effective-mismatch", via: "tenant_state", expected: "suspended", observed: "none" });
  });

  it("a failing observation read is partially_completed (effective-observation), not a silent success", async () => {
    const { deps } = await setup({ stateStatus: 503 });
    const result = await executeAiCommand(deps, { ...operator(), routeId: "tenant.billing-anchor.set", pathParams: { tenantId: TENANT }, fields: { billingAnchorDay: 20 }, reason: "align to invoice", idempotencyKey: "ob-1" });
    expect(result.operation.status).toBe("partially_completed");
    expect(result.operation.partialFailureState).toMatchObject({ stage: "effective-observation" });
  });

  it("an operator who was not granted ai.read still completes; the effect is honestly labelled not observed", async () => {
    const { deps, owner } = await setup();
    const scopes = AI_SCOPES.filter((scope) => scope !== "ai.read");
    const result = await executeAiCommand(deps, { ...operator(OPERATOR, scopes), routeId: "tenant.billing-anchor.set", pathParams: { tenantId: TENANT }, fields: { billingAnchorDay: 20 }, reason: "align to invoice", idempotencyKey: "nr-1" });
    expect(result.operation.status).toBe("completed");
    expect((result.operation.result as { observation: { status: string } }).observation.status).toBe("not_observable");
    expect(owner.calls.filter((call) => call.method === "GET")).toHaveLength(0);
  });

  it("an operator without the command's own scope reserves no key, writes no ledger row and sends nothing", async () => {
    const { deps, owner, ledger } = await setup();
    await expect(
      executeAiCommand(deps, { ...operator(OPERATOR, ["ai.read"]), routeId: "tenant.suspend", pathParams: { tenantId: TENANT }, fields: { recoveryIntent: "x" }, reason: "r", idempotencyKey: "sc-1" }),
    ).rejects.toThrow(/not granted/);
    expect(owner.calls).toHaveLength(0);
    expect(await ledger.listOperations({ limit: 10 })).toHaveLength(0);
  });

  it("credential revoke is verified from the owner's safe metadata and the ledger keeps only safe fields", async () => {
    const { deps } = await setup();
    const result = await executeAiCommand(deps, { ...operator(), routeId: "tenant.credential.revoke", pathParams: pathParamsFor("tenant.credential.revoke"), reason: "employee left", idempotencyKey: "rv-1" });
    expect(result.operation.status).toBe("completed");
    const stored = JSON.stringify(result.operation);
    expect(stored).toContain("maskedHint");
    expect(stored).not.toMatch(/ciphertext|plaintext|apiKey|secret/i);
    expect((result.operation.result as { observation: { via: string } }).observation.via).toBe("credentials");
  });

  it("a secret-shaped field in an owner mutation response is never stored: the operation closes as partially_completed", async () => {
    const { deps, owner } = await setup();
    const original = owner.fetchImpl;
    owner.fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const response = await original(input, init);
      if ((init?.method ?? "GET") === "PUT") return { status: 200, json: async () => ({ ...((await response.json()) as Record<string, unknown>), apiKey: "sk-should-never-be-here" }) } as Response;
      return response;
    }) as typeof fetch;
    const leaky = { ...deps, fetchImpl: owner.fetchImpl };
    const result = await executeAiCommand(leaky, { ...operator(), routeId: "tenant.planes.set", pathParams: { tenantId: TENANT }, fields: { planes: ["embedded_managed"] }, reason: "r", idempotencyKey: "leak-1" });
    expect(result.operation.status).toBe("partially_completed");
    expect(result.operation.partialFailureState).toEqual({ stage: "owner-response-unsafe", fieldPath: "$.apiKey" });
    expect(JSON.stringify(result.operation)).not.toContain("sk-should-never-be-here");
  });
});
