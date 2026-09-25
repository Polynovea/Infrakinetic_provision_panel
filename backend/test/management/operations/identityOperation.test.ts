import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import {
  requestIdentityInvitation,
  requestIdentitySuspend,
  requestIdentityRecovery,
  MissingIdentityTargetError,
} from "../../../src/management/operations/identityOperation.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { IdentityOperationDeps } from "../../../src/management/operations/identityOperation.js";

// 1A.12.2 — the routine (R2) identity-administration mutations, same
// pg-mem + fake-fetch harness as tenantEngineEntitlementOperation.test.ts.
// Focus: target validation happens before any network call, a full
// success round trip records a redacted-safe after-state, and idempotent
// replay never re-dispatches the mutation.

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function seedOperator(client: DbClient) {
  await client.query(
    `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
     VALUES ($1, 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())`,
    [OPERATOR_ID],
  );
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

describe("identityOperation — target validation", () => {
  it("rejects a missing tenantId before any network call", async () => {
    const { client } = buildMigratedPgMemClient();
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl, calls } = buildFakeInfrakinetic({});
    const deps: IdentityOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };

    await expect(
      requestIdentitySuspend(deps, {
        idempotencyKey: "idem-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ["identity_operator"], operatorGrantedScopes: ["identity.disable"],
        tenantId: "", userId: USER_ID, reason: "test",
      }),
    ).rejects.toThrow(MissingIdentityTargetError);
    expect(calls).toHaveLength(0);
  });
});

describe("identityOperation — suspend full success round trip", () => {
  it("records a completed operation with a redacted-safe after-state snapshot", async () => {
    const { client } = buildMigratedPgMemClient();
    await seedOperator(client);
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const path = `/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/suspend`;
    const { fetchImpl, calls } = buildFakeInfrakinetic({
      [path]: { status: 200, body: { email: "person@tenant.example", appAccountStatus: "inactive", sessionsRevoked: 2 } },
    });
    const deps: IdentityOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };

    const result = await requestIdentitySuspend(deps, {
      idempotencyKey: "idem-suspend-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["identity_operator"], operatorGrantedScopes: ["identity.disable"],
      tenantId: TENANT_ID, userId: USER_ID, reason: "support ticket #42",
    });

    expect(result.replay).toBe(false);
    expect(result.operation.status).toBe("completed");
    // Audit remediation L3 — the 1A.8 PII boundary: the tenant user's email never lands in the ledger.
    expect(result.operation.result).toEqual({ email: "[redacted]", appAccountStatus: "inactive", sessionsRevoked: 2 });
    expect(JSON.stringify(result.operation)).not.toContain("person@tenant.example");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body?.reason).toBe("support ticket #42");
  });

  it("preserves an owner-reported partially_completed lifecycle outcome instead of upgrading it to completed", async () => {
    const { client } = buildMigratedPgMemClient();
    await seedOperator(client);
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const path = `/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/suspend`;
    const { fetchImpl } = buildFakeInfrakinetic({
      [path]: {
        status: 200,
        body: {
          commandStatus: "partially_completed",
          appAccountStatus: "inactive",
          providerEnabled: true,
          convergence: "partial",
          failureStages: ["provider-disable-or-global-signout"],
        },
      },
    });
    const deps: IdentityOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };

    const result = await requestIdentitySuspend(deps, {
      idempotencyKey: "idem-suspend-partial", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["identity_operator"], operatorGrantedScopes: ["identity.disable"],
      tenantId: TENANT_ID, userId: USER_ID, reason: "support ticket #partial",
    });

    expect(result.operation.status).toBe("partially_completed");
    expect(result.operation.result).toMatchObject({ commandStatus: "partially_completed", convergence: "partial" });
    expect(result.operation.partialFailureState).toMatchObject({ stage: "owner-reported-partial" });
  });

  it("same idempotencyKey replayed -> zero new Infrakinetic calls", async () => {
    const { client } = buildMigratedPgMemClient();
    await seedOperator(client);
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const path = `/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/suspend`;
    const { fetchImpl, calls } = buildFakeInfrakinetic({
      [path]: { status: 200, body: { email: "person@tenant.example", appAccountStatus: "inactive", sessionsRevoked: 2 } },
    });
    const deps: IdentityOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };
    const input = {
      idempotencyKey: "idem-suspend-2", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["identity_operator"], operatorGrantedScopes: ["identity.disable"],
      tenantId: TENANT_ID, userId: USER_ID, reason: "support ticket #43",
    };

    await requestIdentitySuspend(deps, input);
    expect(calls).toHaveLength(1);
    const replay = await requestIdentitySuspend(deps, input);
    expect(replay.replay).toBe(true);
    expect(calls).toHaveLength(1); // unchanged — no second dispatch
  });
});

describe("identityOperation — invitation issue", () => {
  it("issues an invitation and never carries an invite token in the recorded result", async () => {
    const { client } = buildMigratedPgMemClient();
    await seedOperator(client);
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const path = `/management/v1/tenants/${TENANT_ID}/identity-invitations`;
    const { fetchImpl } = buildFakeInfrakinetic({
      [path]: { status: 200, body: { invitationId: "invite-1", email: "new.hire@tenant.example", status: "pending", expiresAt: "2026-10-01T00:00:00Z" } },
    });
    const deps: IdentityOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };

    const result = await requestIdentityInvitation(deps, {
      idempotencyKey: "idem-invite-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["identity_operator"], operatorGrantedScopes: ["identity.recovery"],
      tenantId: TENANT_ID, invitationRequestId: "req-1", email: "new.hire@tenant.example", reason: "onboarding",
    });

    expect(result.operation.status).toBe("completed");
    expect(JSON.stringify(result.operation.result)).not.toMatch(/token/i);
  });
});

describe("identityOperation — recovery initiate never leaks a code", () => {
  it("records a completed operation whose result contains no reset code", async () => {
    const { client } = buildMigratedPgMemClient();
    await seedOperator(client);
    const ledger = new ManagementOperationLedger(client);
    const signingKeys = await buildFixtureSigningKeys();
    const path = `/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/recovery`;
    const { fetchImpl } = buildFakeInfrakinetic({
      [path]: { status: 200, body: { email: "person@tenant.example", initiatedAt: "2026-09-22T00:00:00Z" } },
    });
    const deps: IdentityOperationDeps = { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl };

    const result = await requestIdentityRecovery(deps, {
      idempotencyKey: "idem-recovery-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ["identity_operator"], operatorGrantedScopes: ["identity.recovery"],
      tenantId: TENANT_ID, userId: USER_ID, reason: "user locked out",
    });

    expect(result.operation.status).toBe("completed");
    expect(result.operation.result).toEqual({ email: "[redacted]", initiatedAt: "2026-09-22T00:00:00Z" });
  });
});
