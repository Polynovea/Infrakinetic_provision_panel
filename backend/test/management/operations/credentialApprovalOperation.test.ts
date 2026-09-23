import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { ManagementApprovalStore, SelfApprovalNotAllowedError, ApprovalNotApprovedError, ApprovalAlreadyExecutedError } from "../../../src/management/operations/managementApprovalStore.js";
import {
  requestCredentialR3Approval,
  decideCredentialR3Approval,
  executeCredentialR3Approval,
  MissingCredentialApprovalTargetError,
} from "../../../src/management/operations/credentialApprovalOperation.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { CredentialApprovalOperationDeps } from "../../../src/management/operations/credentialApprovalOperation.js";

// 1A.13 — the R3 maker-checker substrate applied to credentials (rotate,
// revoke). Same shape as identityApprovalOperation.test.ts: maker cannot
// approve their own request, execution requires 'approved' status, an
// approval grants exactly one execution. The one real difference under
// test here: rotate's new secretValue is supplied only at execute() time
// (never at request time, never persisted in the approval record or the
// ledger payload) — see credentialApprovalOperation.ts's header.

const MAKER_ID = "11111111-1111-4111-8111-111111111111";
const CHECKER_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RAW_SECRET = "whsec_totally_secret_new_value_1a2b3c";

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

interface FakeCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as Response;
}

function buildFakeInfrakinetic(responseByPath: Record<string, { status: number; body: unknown }>) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });
    const match = responseByPath[url.pathname];
    if (!match) return jsonResponse(404, { error: "NO_FIXTURE_FOR_PATH" });
    return jsonResponse(match.status, match.body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function buildDeps(responseByPath: Record<string, { status: number; body: unknown }> = {}): Promise<{ deps: CredentialApprovalOperationDeps; calls: FakeCall[] }> {
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

describe("requestCredentialR3Approval", () => {
  it("creates a pending approval bound to the tenant/credential/action, with no secret material in it", async () => {
    const { deps } = await buildDeps();
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "scheduled webhook secret rotation", makerOperatorId: MAKER_ID,
    });
    expect(approval.status).toBe("pending");
    expect(approval.requestedAction).toBe("credential.rotate");
    expect(approval.makerOperatorId).toBe(MAKER_ID);
    expect(approval.riskClass).toBe("R3");
    expect(JSON.stringify(approval)).not.toContain(RAW_SECRET);
  });
});

describe("decideCredentialR3Approval — maker cannot approve their own request", () => {
  it("rejects when checkerOperatorId equals makerOperatorId", async () => {
    const { deps } = await buildDeps();
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "credential leaked in a public repo", makerOperatorId: MAKER_ID,
    });
    await expect(decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: MAKER_ID, decision: "approved" })).rejects.toThrow(SelfApprovalNotAllowedError);
  });

  it("succeeds when a different operator decides", async () => {
    const { deps } = await buildDeps();
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "credential leaked in a public repo", makerOperatorId: MAKER_ID,
    });
    const decided = await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    expect(decided.status).toBe("approved");
    expect(decided.checkerOperatorId).toBe(CHECKER_ID);
  });
});

describe("executeCredentialR3Approval", () => {
  it("refuses to execute a pending (not-yet-approved) approval", async () => {
    const { deps } = await buildDeps();
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "compromise suspected", makerOperatorId: MAKER_ID,
    });
    await expect(
      executeCredentialR3Approval(deps, {
        approvalId: approval.approvalId, idempotencyKey: "idem-1", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.revoke"],
      }),
    ).rejects.toThrow(ApprovalNotApprovedError);
  });

  it("rotate: refuses to execute without a secretKind even once approved", async () => {
    const { deps } = await buildDeps();
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "scheduled rotation", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    await expect(
      executeCredentialR3Approval(deps, {
        approvalId: approval.approvalId, idempotencyKey: "idem-no-kind", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.rotate"],
      }),
    ).rejects.toThrow(MissingCredentialApprovalTargetError);
  });

  it("rotate: secretKind webhook_secret refuses to execute without a secretValue even once approved", async () => {
    const { deps } = await buildDeps();
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "scheduled rotation", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    await expect(
      executeCredentialR3Approval(deps, {
        approvalId: approval.approvalId, idempotencyKey: "idem-no-secret", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.rotate"],
        secretKind: "webhook_secret",
      }),
    ).rejects.toThrow(MissingCredentialApprovalTargetError);
  });

  it("rotate: secretKind api_key_pair refuses to execute without both apiKeyId and apiKeySecret even once approved", async () => {
    const { deps } = await buildDeps();
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "scheduled key rotation", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    await expect(
      executeCredentialR3Approval(deps, {
        approvalId: approval.approvalId, idempotencyKey: "idem-no-pair", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.rotate"],
        secretKind: "api_key_pair", apiKeyId: "only_id",
      }),
    ).rejects.toThrow(MissingCredentialApprovalTargetError);
  });

  it("rotate: webhook_secret full round trip sends the executor-supplied secretValue to Infrakinetic's rotate route and completes the ledger operation without persisting it", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/rotate`;
    const { deps, calls } = await buildDeps({
      [path]: { status: 200, body: { action: "rotate", secretKind: "webhook_secret", connectionStatus: "active", resultingSecrets: [{ version: 2, status: "active", maskedHint: "****3c" }], overlapHours: 24 } },
    });
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "scheduled rotation", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });

    const result = await executeCredentialR3Approval(deps, {
      approvalId: approval.approvalId, idempotencyKey: "idem-exec-1", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.rotate"],
      secretKind: "webhook_secret", secretValue: RAW_SECRET, overlapHours: 24,
    });

    expect(result.replay).toBe(false);
    expect(result.operation.status).toBe("completed");
    expect(result.operation.riskClass).toBe("R3");
    expect(result.approval.executedAt).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.secretValue).toBe(RAW_SECRET); // sent to Infrakinetic, as expected
    expect(JSON.stringify(result.operation)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(result.approval)).not.toContain(RAW_SECRET);
  });

  it("rotate: api_key_pair full round trip sends both executor-supplied halves atomically and completes the ledger operation without persisting either", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/rotate`;
    const rawApiKeyId = "rzp_live_new_key_id";
    const rawApiKeySecret = "rzp_live_new_key_secret";
    const { deps, calls } = await buildDeps({
      [path]: {
        status: 200,
        body: {
          action: "rotate",
          secretKind: "api_key_pair",
          connectionStatus: "active",
          resultingSecrets: [
            { kind: "api_key_id", version: 2, status: "active", maskedHint: "****d_id" },
            { kind: "api_key_secret", version: 2, status: "active", maskedHint: "****cret" },
          ],
        },
      },
    });
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "leaked API key pair — cutting over", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });

    const result = await executeCredentialR3Approval(deps, {
      approvalId: approval.approvalId, idempotencyKey: "idem-exec-pair-1", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.rotate"],
      secretKind: "api_key_pair", apiKeyId: rawApiKeyId, apiKeySecret: rawApiKeySecret,
    });

    expect(result.replay).toBe(false);
    expect(result.operation.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.apiKeyId).toBe(rawApiKeyId);
    expect(calls[0].body?.apiKeySecret).toBe(rawApiKeySecret);
    expect(calls[0].body?.secretValue).toBeUndefined();
    expect(JSON.stringify(result.operation)).not.toMatch(new RegExp(`${rawApiKeyId}|${rawApiKeySecret}`));
    expect(JSON.stringify(result.approval)).not.toMatch(new RegExp(`${rawApiKeyId}|${rawApiKeySecret}`));
  });

  it("revoke: full round trip needs no secretValue at all", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/revoke`;
    const { deps, calls } = await buildDeps({
      [path]: { status: 200, body: { action: "revoke", secretKind: null, connectionStatus: "revoked", resultingSecret: null } },
    });
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "credential leaked", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });

    const result = await executeCredentialR3Approval(deps, {
      approvalId: approval.approvalId, idempotencyKey: "idem-exec-revoke", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.revoke"],
    });

    expect(result.operation.status).toBe("completed");
    expect(calls[0].body?.secretValue).toBeUndefined();
  });

  it("an approval grants exactly one execution — the second attempt fails even though the first succeeded", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/revoke`;
    const { deps } = await buildDeps({
      [path]: { status: 200, body: { action: "revoke", secretKind: null, connectionStatus: "revoked", resultingSecret: null } },
    });
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "credential leaked", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    await executeCredentialR3Approval(deps, {
      approvalId: approval.approvalId, idempotencyKey: "idem-exec-a", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.revoke"],
    });

    await expect(
      executeCredentialR3Approval(deps, {
        approvalId: approval.approvalId, idempotencyKey: "idem-exec-b", operatorId: CHECKER_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ["security_operator"], operatorGrantedScopes: ["credentials.revoke"],
      }),
    ).rejects.toThrow(ApprovalAlreadyExecutedError);
  });
});
