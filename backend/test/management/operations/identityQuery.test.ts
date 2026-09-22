import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { listTenantIdentities, getIdentityDetail, getIdentityHistory, UnknownIdentityError } from "../../../src/management/operations/identityQuery.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { IdentityQueryDeps } from "../../../src/management/operations/identityQuery.js";

// 1A.12.1 — identity reads (R0, no ledger). Same fake-fetch harness as
// tenantRegistryQuery's own sibling tests.

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

async function baseDeps(responseByPath: Record<string, { status: number; body: unknown }>): Promise<IdentityQueryDeps & { calls: unknown[] }> {
  const signingKeys = await buildFixtureSigningKeys();
  const { fetchImpl, calls } = buildFakeInfrakinetic(responseByPath);
  return { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl, calls };
}

const CALLER = {
  operatorId: OPERATOR_ID,
  operatorSessionId: SESSION_ID,
  operatorRoles: ["identity_operator"],
  operatorGrantedScopes: ["identity.read"],
};

describe("listTenantIdentities", () => {
  it("returns the identity list envelope from Infrakinetic", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/identities`;
    const deps = await baseDeps({
      [path]: { status: 200, body: { tenantId: TENANT_ID, identities: [{ userId: USER_ID, email: "a@b.test", displayName: "A", appAccountStatus: "active", roleKey: "member", activity: { lastActiveAt: null } }], observedAt: "now", source: "infrakinetic-live", freshness: "live" } },
    });
    const result = await listTenantIdentities(deps, { ...CALLER, tenantId: TENANT_ID });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0].userId).toBe(USER_ID);
  });
});

describe("getIdentityDetail", () => {
  it("maps a 404 to UnknownIdentityError", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}`;
    const deps = await baseDeps({ [path]: { status: 404, body: { error: "IDENTITY_NOT_FOUND" } } });
    await expect(getIdentityDetail(deps, { ...CALLER, tenantId: TENANT_ID, userId: USER_ID })).rejects.toThrow(UnknownIdentityError);
  });

  it("returns the safe identity DTO, including drift, on success", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}`;
    const identity = {
      tenantId: TENANT_ID, userId: USER_ID, email: "a@b.test", displayName: "A", appAccountStatus: "active", roleKey: "member",
      provider: { exists: true, tenantBindingMismatch: false, enabled: true, userStatus: "CONFIRMED" },
      sessions: { activeApplicationSessionCount: 1, lastApplicationSessionSeenAt: null, lastApplicationSessionRevokedAt: null },
      activity: { lastActiveAt: null, source: "app_users/auth_sessions" },
      invitation: null,
      drift: [],
    };
    const deps = await baseDeps({ [path]: { status: 200, body: { identity, observedAt: "now", source: "infrakinetic-live", freshness: "live" } } });
    const result = await getIdentityDetail(deps, { ...CALLER, tenantId: TENANT_ID, userId: USER_ID });
    expect(result.identity).toEqual(identity);
  });
});

describe("getIdentityHistory", () => {
  it("returns the receipt history list", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/history`;
    const deps = await baseDeps({
      [path]: { status: 200, body: { history: [{ idempotencyKey: "k1", commandId: "c1", action: "identity.suspend", tenantId: TENANT_ID, userId: USER_ID, status: "completed", executionStage: "identity.suspend-completed", safeResult: {}, createdAt: "now", updatedAt: "now", completedAt: "now" }], observedAt: "now", source: "infrakinetic-live", freshness: "live" } },
    });
    const result = await getIdentityHistory(deps, { ...CALLER, tenantId: TENANT_ID, userId: USER_ID });
    expect(result.history).toHaveLength(1);
    expect(result.history[0].action).toBe("identity.suspend");
  });
});
