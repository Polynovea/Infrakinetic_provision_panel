import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import {
  ManagementApprovalStore,
  SelfApprovalNotAllowedError,
  ApprovalAlreadyExecutedError,
  ApprovalNotApprovedError,
} from "../../../src/management/operations/managementApprovalStore.js";
import {
  requestPaymentAdapterApproval,
  decidePaymentAdapterApproval,
  executePaymentAdapterApproval,
  submitPaymentAdapter,
  listPaymentAdapters,
  MissingPaymentAdapterFieldError,
} from "../../../src/management/operations/paymentAdapterOperation.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";

// 1A.14 §5 — Governance side of the payment adapter lifecycle. Rejected
// cases first-class (1A.13 lesson): self-approval, reuse, unapproved
// execution, missing recovery intent; and the two D1/D3 guarantees that
// only exist on this side — the assertion carries the CHECKER as signed
// approval evidence regardless of who executes, and revoke executes with
// the impact count the checker approved, not a fresh one.

const MAKER = "11111111-1111-4111-8111-111111111111";
const CHECKER = "22222222-2222-4222-8222-222222222222";
const EXECUTOR = "33333333-3333-4333-8333-333333333333";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RELEASE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ALL_SCOPES = ["payments.adapters.read", "payments.adapters.submit", "payments.adapters.approve", "payments.adapters.revoke"];

async function seedOperators(client: DbClient) {
  for (const [id, sub] of [[MAKER, "maker"], [CHECKER, "checker"], [EXECUTOR, "executor"]] as const) {
    await client.query(
      `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
       VALUES ($1, $2, $2 || '@example.invalid', 'Operator', 'active', true, now(), now())`,
      [id, sub],
    );
  }
}

async function signingKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "k"; jwk.alg = "RS256"; jwk.use = "sig";
  return { activeKid: "k", activePrivateKey: privateKey, publicJwks: [jwk] };
}

interface Call { method: string; path: string; body?: Record<string, unknown>; claims: Record<string, unknown> }

function fakeInfrakinetic(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, claims: decodeJwt(auth.replace(/^Bearer /, "")) as Record<string, unknown> });
    const body = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    return { status: body === undefined ? 404 : 200, json: async () => body ?? { error: "NO_FIXTURE" } } as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function setup(routes: Record<string, unknown>) {
  const { client } = buildMigratedPgMemClient();
  await seedOperators(client);
  const fake = fakeInfrakinetic(routes);
  const deps = {
    approvals: new ManagementApprovalStore(client),
    ledger: new ManagementOperationLedger(client),
    signingKeys: await signingKeys(),
    transportConfig: { issuer: "https://governance.test.invalid", audience: "infrakinetic-management-api-test" },
    infrakineticBaseUrl: "https://infrakinetic.test.invalid",
    fetchImpl: fake.fetchImpl,
  };
  return { deps, calls: fake.calls };
}

const op = (operatorId: string) => ({ operatorId, operatorSessionId: SESSION, operatorRoles: ["platform_admin"], operatorGrantedScopes: ALL_SCOPES });
const DETAIL = `GET /management/v1/payment-adapters/${RELEASE}`;
const IMPACT = `GET /management/v1/payment-adapters/${RELEASE}/revoke-impact`;
const REVOKE = `POST /management/v1/payment-adapters/${RELEASE}/revoke`;
const APPROVE = `POST /management/v1/payment-adapters/${RELEASE}/approve`;
const release = { release: { releaseKey: "fixturepay@1.0.0", manifestHash: "a".repeat(64), lifecycleStatus: "active", approvalStatus: "approved" } };

describe("payment adapter R3/R4 approvals", () => {
  it("revoke binds the owner-reported impact; execution sends the APPROVED count and the signed checker, whoever executes", async () => {
    const { deps, calls } = await setup({ [DETAIL]: release, [IMPACT]: { impact: { affectedConnectionCount: 3, affectedTenantCount: 2, byEnvironment: { test: 1, live: 2 } } }, [REVOKE]: { commandStatus: "completed" } });
    const approval = await requestPaymentAdapterApproval(deps, { ...op(MAKER), actionKey: "revoke", releaseId: RELEASE, reason: "vendor compromise", recoveryIntent: "re-onboard 1.0.1 after audit" });
    expect(approval.riskClass).toBe("R4");
    expect(approval.targetTenantId).toBeUndefined();
    expect(approval.safeRequestSummary).toMatchObject({ expectedAffectedConnectionCount: 3, expectedAffectedTenantCount: 2, recoveryIntent: "re-onboard 1.0.1 after audit" });

    await decidePaymentAdapterApproval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER, decision: "approved" });
    const result = await executePaymentAdapterApproval(deps, { ...op(EXECUTOR), approvalId: approval.approvalId, idempotencyKey: "exec-1" });
    expect(result.operation.status).toBe("completed");

    const mutation = calls.find((c) => c.method === "POST")!;
    expect(mutation.body).toMatchObject({ expectedImpact: { affectedConnectionCount: 3 }, recoveryIntent: "re-onboard 1.0.1 after audit", reason: "vendor compromise" });
    expect(mutation.claims.operator_id).toBe(EXECUTOR);
    expect(mutation.claims.approval).toEqual({ approval_id: approval.approvalId, maker_operator_id: MAKER, checker_operator_id: CHECKER });
    expect(mutation.claims.target_tenant_id).toBeUndefined();
    expect(mutation.claims).toMatchObject({ target_resource_type: "payment_adapter_release", target_resource_id: RELEASE, requested_action: "payment.adapter.revoke", scopes: ["payments.adapters.revoke"] });
  });

  it("revoke without a recovery intent is refused before any approval exists", async () => {
    const { deps } = await setup({ [DETAIL]: release });
    await expect(requestPaymentAdapterApproval(deps, { ...op(MAKER), actionKey: "revoke", releaseId: RELEASE, reason: "r" })).rejects.toBeInstanceOf(MissingPaymentAdapterFieldError);
  });

  it("the maker cannot approve their own request", async () => {
    const { deps } = await setup({ [DETAIL]: release });
    const approval = await requestPaymentAdapterApproval(deps, { ...op(MAKER), actionKey: "approve", releaseId: RELEASE, reason: "onboard" });
    await expect(decidePaymentAdapterApproval(deps, { approvalId: approval.approvalId, checkerOperatorId: MAKER, decision: "approved" })).rejects.toBeInstanceOf(SelfApprovalNotAllowedError);
  });

  it("an undecided approval cannot execute, and an approval executes exactly once", async () => {
    const { deps, calls } = await setup({ [DETAIL]: release, [APPROVE]: { commandStatus: "completed" } });
    const approval = await requestPaymentAdapterApproval(deps, { ...op(MAKER), actionKey: "approve", releaseId: RELEASE, reason: "onboard", effectiveFrom: "2026-10-01T00:00:00.000Z" });
    await expect(executePaymentAdapterApproval(deps, { ...op(EXECUTOR), approvalId: approval.approvalId, idempotencyKey: "e0" })).rejects.toBeInstanceOf(ApprovalNotApprovedError);
    await decidePaymentAdapterApproval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER, decision: "approved" });
    await executePaymentAdapterApproval(deps, { ...op(EXECUTOR), approvalId: approval.approvalId, idempotencyKey: "e1" });
    expect(calls.filter((c) => c.method === "POST")[0].body).toMatchObject({ effectiveFrom: "2026-10-01T00:00:00.000Z" });
    const replay = await executePaymentAdapterApproval(deps, { ...op(EXECUTOR), approvalId: approval.approvalId, idempotencyKey: "e1" });
    expect(replay.replay).toBe(true);
    await expect(executePaymentAdapterApproval(deps, { ...op(EXECUTOR), approvalId: approval.approvalId, idempotencyKey: "e2" })).rejects.toBeInstanceOf(ApprovalAlreadyExecutedError);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("payment adapter R0/R2", () => {
  it("fleet reads carry no tenant claim and address the adapter fleet", async () => {
    const { deps, calls } = await setup({ "GET /management/v1/payment-adapters": { releases: [] } });
    await listPaymentAdapters(deps, op(MAKER));
    expect(calls[0].claims).toMatchObject({ target_resource_type: "payment_adapter_fleet", target_resource_id: "payment_adapter_fleet", requested_action: "payment.adapter.list" });
    expect(calls[0].claims.target_tenant_id).toBeUndefined();
  });

  it("submit forwards vendor test vectors to the owner but never records them in the ledger", async () => {
    const { deps, calls } = await setup({ "POST /management/v1/payment-adapters": { commandStatus: "completed", releaseId: RELEASE } });
    const vector = { raw_body: "one", signature: "abc", secret: "VENDOR-VECTOR-SECRET", event_id: "e", expected: true };
    const result = await submitPaymentAdapter(deps, {
      ...op(MAKER), idempotencyKey: "s1", reason: "onboard fixturepay",
      manifest: { provider_key: "fixturepay", adapter_version: "1.0.0" }, manifestSignature: "sig", vendorPublicKey: "pem", vendorName: "Vendor",
      fixtures: {}, signatureVectors: [vector],
    });
    expect(result.operation.status).toBe("completed");
    expect(result.operation.riskClass).toBe("R2");
    expect(calls[0].body?.signatureVectors).toEqual([vector]);
    expect(calls[0].claims).toMatchObject({ target_resource_type: "payment_adapter_release_key", target_resource_id: "fixturepay@1.0.0", scopes: ["payments.adapters.submit"] });
    expect(JSON.stringify(result.operation)).not.toContain("VENDOR-VECTOR-SECRET");
  });
});
