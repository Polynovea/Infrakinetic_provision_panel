import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { ManagementApprovalStore, SelfApprovalNotAllowedError, ApprovalNotApprovedError, ApprovalAlreadyExecutedError } from "../../../src/management/operations/managementApprovalStore.js";
import {
  requestIdentityR3Approval,
  decideIdentityR3Approval,
  executeIdentityR3Approval,
} from "../../../src/management/operations/identityApprovalOperation.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { IdentityApprovalOperationDeps } from "../../../src/management/operations/identityApprovalOperation.js";

// 1A.12.5 — the R3 maker-checker substrate. Focus: maker cannot approve
// their own request, execution requires 'approved' status, an approval
// grants exactly one execution, and a full request -> approve -> execute
// round trip actually calls Infrakinetic's force-reset route.

const MAKER_ID = "11111111-1111-4111-8111-111111111111";
const CHECKER_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function seedOperators(client: DbClient) {
  for (const [id, sub] of [[MAKER_ID, "maker-sub"], [CHECKER_ID, "checker-sub"]] as const) {
    await client.query(
      `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
       VALUES ($1, $2, $2 || '@example.invalid', 'Operator', 'active', true, now(), now())`,
      [id, sub],
    );
  }
}

async function buildFixtureSigningKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "test-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as Response;
}

function buildFakeInfrakinetic(responseByPath: Record<string, { status: number; body: unknown }>) {
  const calls: { method: string; path: string }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: (init?.method ?? "GET") as string, path: url.pathname });
    const match = responseByPath[url.pathname];
    if (!match) return jsonResponse(404, { error: "NO_FIXTURE_FOR_PATH" });
    return jsonResponse(match.status, match.body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function buildDeps(responseByPath: Record<string, { status: number; body: unknown }> = {}): Promise<{ deps: IdentityApprovalOperationDeps; calls: unknown[] }> {
  const { client } = buildMigratedPgMemClient();
  await seedOperators(client);
  const ledger = new ManagementOperationLedger(client);
  const approvals = new ManagementApprovalStore(client);
  const signingKeys = await buildFixtureSigningKeys();
  const { fetchImpl, calls } = buildFakeInfrakinetic(responseByPath);
  return {
    deps: { approvals, ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl },
    calls,
  };
}

describe("requestIdentityR3Approval", () => {
  it("creates a pending approval bound to the tenant/user/action", async () => {
    const { deps } = await buildDeps();
    const approval = await requestIdentityR3Approval(deps, {
      actionKey: "force-reset", tenantId: TENANT_ID, userId: USER_ID, reason: "user reports account takeover", makerOperatorId: MAKER_ID,
    });
    expect(approval.status).toBe("pending");
    expect(approval.requestedAction).toBe("identity.force-reset");
    expect(approval.makerOperatorId).toBe(MAKER_ID);
    expect(approval.riskClass).toBe("R3");
  });
});

describe("decideIdentityR3Approval — maker cannot approve their own request", () => {
  it("rejects when checkerOperatorId equals makerOperatorId", async () => {
    const { deps } = await buildDeps();
    const approval = await requestIdentityR3Approval(deps, {
      actionKey: "mfa-reset", tenantId: TENANT_ID, userId: USER_ID, reason: "lost device", makerOperatorId: MAKER_ID,
    });
    await expect(decideIdentityR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: MAKER_ID, decision: "approved" })).rejects.toThrow(SelfApprovalNotAllowedError);
  });

  it("succeeds when a different operator decides", async () => {
    const { deps } = await buildDeps();
    const approval = await requestIdentityR3Approval(deps, {
      actionKey: "mfa-reset", tenantId: TENANT_ID, userId: USER_ID, reason: "lost device", makerOperatorId: MAKER_ID,
    });
    const decided = await decideIdentityR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    expect(decided.status).toBe("approved");
    expect(decided.checkerOperatorId).toBe(CHECKER_ID);
  });
});

describe("executeIdentityR3Approval", () => {
  it("refuses to execute a pending (not-yet-approved) approval", async () => {
    const { deps } = await buildDeps();
    const approval = await requestIdentityR3Approval(deps, {
      actionKey: "force-reset", tenantId: TENANT_ID, userId: USER_ID, reason: "compromise suspected", makerOperatorId: MAKER_ID,
    });
    await expect(
      executeIdentityR3Approval(deps, {
        approvalId: approval.approvalId, idempotencyKey: "idem-1", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ["security_operator"], operatorGrantedScopes: ["identity.recovery"],
      }),
    ).rejects.toThrow(ApprovalNotApprovedError);
  });

  it("full round trip: request -> approve -> execute calls Infrakinetic's force-reset route and completes the ledger operation", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/force-reset`;
    const { deps, calls } = await buildDeps({
      [path]: { status: 200, body: { email: "person@tenant.example", providerUserStatus: "RESET_REQUIRED" } },
    });
    const approval = await requestIdentityR3Approval(deps, {
      actionKey: "force-reset", tenantId: TENANT_ID, userId: USER_ID, reason: "compromise suspected", makerOperatorId: MAKER_ID,
    });
    await decideIdentityR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });

    const result = await executeIdentityR3Approval(deps, {
      approvalId: approval.approvalId, idempotencyKey: "idem-exec-1", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["security_operator"], operatorGrantedScopes: ["identity.recovery"],
    });

    expect(result.replay).toBe(false);
    expect(result.operation.status).toBe("completed");
    expect(result.operation.riskClass).toBe("R3");
    expect(result.approval.executedAt).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it("an approval grants exactly one execution — the second attempt fails even though the first succeeded", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/force-reset`;
    const { deps } = await buildDeps({
      [path]: { status: 200, body: { email: "person@tenant.example", providerUserStatus: "RESET_REQUIRED" } },
    });
    const approval = await requestIdentityR3Approval(deps, {
      actionKey: "force-reset", tenantId: TENANT_ID, userId: USER_ID, reason: "compromise suspected", makerOperatorId: MAKER_ID,
    });
    await decideIdentityR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    await executeIdentityR3Approval(deps, {
      approvalId: approval.approvalId, idempotencyKey: "idem-exec-a", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["security_operator"], operatorGrantedScopes: ["identity.recovery"],
    });

    await expect(
      executeIdentityR3Approval(deps, {
        approvalId: approval.approvalId, idempotencyKey: "idem-exec-b", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ["security_operator"], operatorGrantedScopes: ["identity.recovery"],
      }),
    ).rejects.toThrow(ApprovalAlreadyExecutedError);
  });
});
