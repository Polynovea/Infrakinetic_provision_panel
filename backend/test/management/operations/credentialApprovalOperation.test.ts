import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import {
  ManagementApprovalStore,
  SelfApprovalNotAllowedError,
  ApprovalNotApprovedError,
  ApprovalAlreadyExecutedError,
  ApprovalPayloadMismatchError,
} from "../../../src/management/operations/managementApprovalStore.js";
import { IdempotencyConflictError } from "../../../src/management/operations/managementOperationErrors.js";
import {
  requestCredentialR3Approval,
  decideCredentialR3Approval,
  executeCredentialR3Approval,
  MissingCredentialApprovalTargetError,
  maskKeyId,
} from "../../../src/management/operations/credentialApprovalOperation.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { CredentialApprovalOperationDeps } from "../../../src/management/operations/credentialApprovalOperation.js";

// 1A.13 — the R3 maker-checker substrate applied to credentials (rotate,
// revoke). Same shape as identityApprovalOperation.test.ts: maker cannot
// approve their own request, execution requires 'approved' status, an
// approval grants exactly one execution. Audit remediation H1: rotate's
// material is submitted by the maker, bound into the approval as a salted
// digest only (never persisted), and the executor must resubmit identical
// material — substituted material, kind or window is rejected.

const MAKER_ID = "11111111-1111-4111-8111-111111111111";
const CHECKER_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RAW_SECRET = "whsec_totally_secret_new_value_1a2b3c";
const MERCHANT_KEY_ID = "rzp_live_MerchantKeyId01";
const MERCHANT_KEY_SECRET = "merchant_key_secret_value_9f8e7d";
const ROTATE_PATH = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/rotate`;
const REVOKE_PATH = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/revoke`;

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

const EXECUTOR = {
  operatorId: CHECKER_ID,
  operatorSessionId: SESSION_ID,
  operatorRoles: ["security_operator"],
  operatorGrantedScopes: ["credentials.rotate", "credentials.revoke"],
} as const;

const WEBHOOK_OK = { status: 200, body: { action: "rotate", secretKind: "webhook_secret", connectionStatus: "active", resultingSecrets: [{ version: 2, status: "active", maskedHint: "****3c" }], overlapHours: 24 } };
const PAIR_OK = {
  status: 200,
  body: {
    action: "rotate",
    secretKind: "api_key_pair",
    connectionStatus: "active",
    resultingSecrets: [
      { kind: "api_key_id", version: 2, status: "active", maskedHint: "****Id01" },
      { kind: "api_key_secret", version: 2, status: "active", maskedHint: "****7d" },
    ],
  },
};

async function approvedPairRotation(deps: CredentialApprovalOperationDeps) {
  const approval = await requestCredentialR3Approval(deps, {
    actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "leaked API key pair — cutting over", makerOperatorId: MAKER_ID,
    secretKind: "api_key_pair", apiKeyId: MERCHANT_KEY_ID, apiKeySecret: MERCHANT_KEY_SECRET,
  });
  await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
  return approval;
}

async function approvedWebhookRotation(deps: CredentialApprovalOperationDeps, overlapHours = 24) {
  const approval = await requestCredentialR3Approval(deps, {
    actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "scheduled rotation", makerOperatorId: MAKER_ID,
    secretKind: "webhook_secret", secretValue: RAW_SECRET, overlapHours,
  });
  await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
  return approval;
}

describe("requestCredentialR3Approval", () => {
  it("rotate binds kind/window/fingerprint into a checker-visible safe diff with no secret material in it", async () => {
    const { deps } = await buildDeps();
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "scheduled webhook secret rotation", makerOperatorId: MAKER_ID,
      secretKind: "webhook_secret", secretValue: RAW_SECRET, overlapHours: 500,
    });
    expect(approval.status).toBe("pending");
    expect(approval.requestedAction).toBe("credential.rotate");
    expect(approval.makerOperatorId).toBe(MAKER_ID);
    expect(approval.riskClass).toBe("R3");
    expect(approval.safeRequestSummary).toMatchObject({ secretKind: "webhook_secret", overlapHours: 72, webhookEndpointId: null, apiKeyIdHint: null });
    expect(approval.safeRequestSummary?.materialFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(approval)).not.toContain(RAW_SECRET);
  });

  it("api_key_pair shows the checker a masked key id, never the secret half", async () => {
    const { deps } = await buildDeps();
    const approval = await approvedPairRotation(deps);
    const stored = await deps.approvals.getApproval(approval.approvalId);
    expect(stored.safeRequestSummary?.apiKeyIdHint).toBe(maskKeyId(MERCHANT_KEY_ID));
    expect(stored.safeRequestSummary?.apiKeyIdHint).not.toBe(MERCHANT_KEY_ID);
    expect(JSON.stringify(stored)).not.toContain(MERCHANT_KEY_SECRET);
    expect(JSON.stringify(stored)).not.toContain(MERCHANT_KEY_ID);
  });

  it("rotate refuses a request with no secretKind or no material — the maker must commit to the exact change", async () => {
    const { deps } = await buildDeps();
    await expect(requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "r", makerOperatorId: MAKER_ID,
    })).rejects.toThrow(MissingCredentialApprovalTargetError);
    await expect(requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "r", makerOperatorId: MAKER_ID, secretKind: "webhook_secret",
    })).rejects.toThrow(MissingCredentialApprovalTargetError);
    await expect(requestCredentialR3Approval(deps, {
      actionKey: "rotate", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "r", makerOperatorId: MAKER_ID, secretKind: "api_key_pair", apiKeyId: "only_id",
    })).rejects.toThrow(MissingCredentialApprovalTargetError);
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
      executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-1" }),
    ).rejects.toThrow(ApprovalNotApprovedError);
  });

  it("rotate: refuses to execute without resubmitted material even once approved", async () => {
    const { deps, calls } = await buildDeps({ [ROTATE_PATH]: WEBHOOK_OK });
    const approval = await approvedWebhookRotation(deps);
    await expect(
      executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-no-secret" }),
    ).rejects.toThrow(MissingCredentialApprovalTargetError);
    expect(calls).toHaveLength(0);
  });

  // H1 — the payment-diversion vector: an executor (here, the checker)
  // substituting keys for an account they control.
  it("rotate: REJECTS an executor who substitutes different api_key_pair material, and does not consume the approval", async () => {
    const { deps, calls } = await buildDeps({ [ROTATE_PATH]: PAIR_OK });
    const approval = await approvedPairRotation(deps);

    await expect(
      executeCredentialR3Approval(deps, {
        ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-diverted",
        apiKeyId: "rzp_live_AttackerKeyId9", apiKeySecret: "attacker_controlled_secret",
      }),
    ).rejects.toThrow(ApprovalPayloadMismatchError);
    // Swapping only one half is equally rejected.
    await expect(
      executeCredentialR3Approval(deps, {
        ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-diverted-2",
        apiKeyId: MERCHANT_KEY_ID, apiKeySecret: "attacker_controlled_secret",
      }),
    ).rejects.toThrow(ApprovalPayloadMismatchError);
    expect(calls).toHaveLength(0);

    const stillUsable = await deps.approvals.getApproval(approval.approvalId);
    expect(stillUsable.executedAt).toBeUndefined();
  });

  it("rotate: REJECTS a substituted webhook secret", async () => {
    const { deps, calls } = await buildDeps({ [ROTATE_PATH]: WEBHOOK_OK });
    const approval = await approvedWebhookRotation(deps);
    await expect(
      executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-wh-sub", secretValue: "whsec_someone_elses_value" }),
    ).rejects.toThrow(ApprovalPayloadMismatchError);
    expect(calls).toHaveLength(0);
  });

  it("rotate: the executor cannot change the approved kind or overlap window — Infrakinetic receives the approved values", async () => {
    const { deps, calls } = await buildDeps({ [ROTATE_PATH]: WEBHOOK_OK });
    const approval = await approvedWebhookRotation(deps, 6);
    await executeCredentialR3Approval(deps, {
      ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-wh-window",
      secretValue: RAW_SECRET,
      // Not part of the execute contract any more; extra fields are ignored.
      ...({ secretKind: "api_key_pair", overlapHours: 72 } as Record<string, unknown>),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.secretKind).toBe("webhook_secret");
    expect(calls[0].body?.overlapHours).toBe(6);
  });

  it("rotate: a pre-0013 rotate approval with no bound parameters fails closed", async () => {
    const { deps, calls } = await buildDeps({ [ROTATE_PATH]: WEBHOOK_OK });
    const legacy = await deps.approvals.createApproval({
      approvalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", requestedAction: "credential.rotate", targetTenantId: TENANT_ID,
      targetResourceType: "credential", targetResourceId: CREDENTIAL_ID, safePayloadHash: "legacy-hash", riskClass: "R3",
      reason: "legacy", makerOperatorId: MAKER_ID, correlationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ttlSeconds: 3600,
    });
    await decideCredentialR3Approval(deps, { approvalId: legacy.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    await expect(
      executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: legacy.approvalId, idempotencyKey: "idem-legacy", secretValue: RAW_SECRET }),
    ).rejects.toThrow(MissingCredentialApprovalTargetError);
    expect(calls).toHaveLength(0);
  });

  it("rotate: webhook_secret full round trip sends the approved secretValue and completes the ledger operation without persisting it", async () => {
    const { deps, calls } = await buildDeps({ [ROTATE_PATH]: WEBHOOK_OK });
    const approval = await approvedWebhookRotation(deps);

    const result = await executeCredentialR3Approval(deps, {
      ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-exec-1", secretValue: RAW_SECRET,
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

  it("rotate: api_key_pair full round trip sends both approved halves atomically and completes the ledger operation without persisting either", async () => {
    const { deps, calls } = await buildDeps({ [ROTATE_PATH]: PAIR_OK });
    const approval = await approvedPairRotation(deps);

    const result = await executeCredentialR3Approval(deps, {
      ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-exec-pair-1",
      apiKeyId: MERCHANT_KEY_ID, apiKeySecret: MERCHANT_KEY_SECRET,
    });

    expect(result.replay).toBe(false);
    expect(result.operation.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.apiKeyId).toBe(MERCHANT_KEY_ID);
    expect(calls[0].body?.apiKeySecret).toBe(MERCHANT_KEY_SECRET);
    expect(calls[0].body?.secretValue).toBeUndefined();
    expect(JSON.stringify(result.operation)).not.toMatch(new RegExp(`${MERCHANT_KEY_ID}|${MERCHANT_KEY_SECRET}`));
    expect(JSON.stringify(result.approval)).not.toMatch(new RegExp(`${MERCHANT_KEY_ID}|${MERCHANT_KEY_SECRET}`));
  });

  it("revoke: full round trip needs no secretValue at all", async () => {
    const { deps, calls } = await buildDeps({
      [REVOKE_PATH]: { status: 200, body: { action: "revoke", secretKind: null, connectionStatus: "revoked", resultingSecret: null } },
    });
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "credential leaked", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });

    const result = await executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-exec-revoke" });

    expect(result.operation.status).toBe("completed");
    expect(calls[0].body?.secretValue).toBeUndefined();
  });

  it("an approval grants exactly one execution — a second attempt under a NEW key fails even though the first succeeded", async () => {
    const { deps } = await buildDeps({
      [REVOKE_PATH]: { status: 200, body: { action: "revoke", secretKind: null, connectionStatus: "revoked", resultingSecret: null } },
    });
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "credential leaked", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    await executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-exec-a" });

    await expect(
      executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-exec-b" }),
    ).rejects.toThrow(ApprovalAlreadyExecutedError);
  });

  // M5 — §59 "same key + same payload -> safe replay".
  it("a retry under the SAME idempotency key replays the recorded operation without re-sending", async () => {
    const { deps, calls } = await buildDeps({
      [REVOKE_PATH]: { status: 200, body: { action: "revoke", secretKind: null, connectionStatus: "revoked", resultingSecret: null } },
    });
    const approval = await requestCredentialR3Approval(deps, {
      actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "credential leaked", makerOperatorId: MAKER_ID,
    });
    await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    const first = await executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-retry" });
    const second = await executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: approval.approvalId, idempotencyKey: "idem-retry" });

    expect(second.replay).toBe(true);
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(calls).toHaveLength(1);
  });

  it("reusing an idempotency key from a DIFFERENT approval is a conflict, not a replay", async () => {
    const { deps } = await buildDeps({
      [REVOKE_PATH]: { status: 200, body: { action: "revoke", secretKind: null, connectionStatus: "revoked", resultingSecret: null } },
    });
    const a = await requestCredentialR3Approval(deps, { actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "a", makerOperatorId: MAKER_ID });
    const b = await requestCredentialR3Approval(deps, { actionKey: "revoke", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, reason: "b", makerOperatorId: MAKER_ID });
    for (const approval of [a, b]) {
      await decideCredentialR3Approval(deps, { approvalId: approval.approvalId, checkerOperatorId: CHECKER_ID, decision: "approved" });
    }
    await executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: a.approvalId, idempotencyKey: "idem-shared" });
    await expect(
      executeCredentialR3Approval(deps, { ...EXECUTOR, approvalId: b.approvalId, idempotencyKey: "idem-shared" }),
    ).rejects.toThrow(IdempotencyConflictError);
  });
});
