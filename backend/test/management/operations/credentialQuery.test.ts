import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { listTenantCredentials, getCredentialDetail, getCredentialHistory, UnknownCredentialError } from "../../../src/management/operations/credentialQuery.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { CredentialQueryDeps } from "../../../src/management/operations/credentialQuery.js";

// 1A.13 — credential reads (R0, no ledger). Same fake-fetch harness as
// identityQuery.test.ts's own sibling tests.

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

async function baseDeps(responseByPath: Record<string, { status: number; body: unknown }>): Promise<CredentialQueryDeps & { calls: unknown[] }> {
  const signingKeys = await buildFixtureSigningKeys();
  const { fetchImpl, calls } = buildFakeInfrakinetic(responseByPath);
  return { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "https://infrakinetic.test.invalid", fetchImpl, calls };
}

const CALLER = {
  operatorId: OPERATOR_ID,
  operatorSessionId: SESSION_ID,
  operatorRoles: ["security_operator"],
  operatorGrantedScopes: ["credentials.metadata.read"],
};

describe("listTenantCredentials", () => {
  it("returns the credential list envelope from Infrakinetic", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/credentials`;
    const deps = await baseDeps({
      [path]: {
        status: 200,
        body: {
          tenantId: TENANT_ID,
          credentials: [{ tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, owningEngine: "payments", provider: "razorpay", adapterVersion: "1.0.0", environment: "test", displayName: "Test", status: "active", activatedAt: null, revokedAt: null, lastTestedAt: null, lastError: null, createdAt: "now", updatedAt: "now", secrets: [] }],
          observedAt: "now", source: "infrakinetic-live", freshness: "live",
        },
      },
    });
    const result = await listTenantCredentials(deps, { ...CALLER, tenantId: TENANT_ID });
    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].credentialId).toBe(CREDENTIAL_ID);
  });
});

describe("getCredentialDetail", () => {
  it("maps a 404 to UnknownCredentialError", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}`;
    const deps = await baseDeps({ [path]: { status: 404, body: { error: "CREDENTIAL_NOT_FOUND" } } });
    await expect(getCredentialDetail(deps, { ...CALLER, tenantId: TENANT_ID, credentialId: CREDENTIAL_ID })).rejects.toThrow(UnknownCredentialError);
  });

  it("returns the safe credential DTO, including its secrets array, on success", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}`;
    const credential = {
      tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, owningEngine: "payments", provider: "razorpay", adapterVersion: "1.0.0",
      environment: "test", displayName: "Test", status: "active", activatedAt: null, revokedAt: null, lastTestedAt: null,
      lastError: null, createdAt: "now", updatedAt: "now",
      secrets: [{ kind: "api_key_id", version: 1, status: "active", maskedHint: "****1234", validFrom: "now", validUntil: null }],
    };
    const deps = await baseDeps({ [path]: { status: 200, body: { credential, observedAt: "now", source: "infrakinetic-live", freshness: "live" } } });
    const result = await getCredentialDetail(deps, { ...CALLER, tenantId: TENANT_ID, credentialId: CREDENTIAL_ID });
    expect(result.credential).toEqual(credential);
    expect(JSON.stringify(result.credential)).not.toMatch(/ciphertext|authTag|keyVersion/i);
  });
});

describe("getCredentialHistory", () => {
  it("returns the receipt history list", async () => {
    const path = `/management/v1/tenants/${TENANT_ID}/credentials/${CREDENTIAL_ID}/history`;
    const deps = await baseDeps({
      [path]: {
        status: 200,
        body: {
          history: [{ idempotencyKey: "k1", commandId: "c1", action: "credential.rotate", owningEngine: "payments", tenantId: TENANT_ID, credentialId: CREDENTIAL_ID, secretKind: "webhook_secret", status: "completed", executionStage: "credential.rotate-completed", safeResult: {}, createdAt: "now", updatedAt: "now", completedAt: "now" }],
          observedAt: "now", source: "infrakinetic-live", freshness: "live",
        },
      },
    });
    const result = await getCredentialHistory(deps, { ...CALLER, tenantId: TENANT_ID, credentialId: CREDENTIAL_ID });
    expect(result.history).toHaveLength(1);
    expect(result.history[0].action).toBe("credential.rotate");
  });
});
