import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, exportJWK } from "jose";

import {
  findSecretShapedField,
  getAiCatalog,
  getFleetAiSummary,
  getTenantAiState,
  UnsafeAiOwnerResponseError,
} from "../../../src/management/operations/aiQuery.js";
import { UnknownTenantError } from "../../../src/management/operations/tenantRegistryQuery.js";
import { UnexpectedManagementApiResponseError } from "../../../src/management/operations/engineStateOperation.js";
import type { AiQueryDeps } from "../../../src/management/operations/aiQuery.js";

// 1A.15 Slice 1 — Governance AI reads (R0, no ledger). Proves what each
// assertion is addressed to (tenant vs fleet resource), that nothing is
// persisted, and that a secret-shaped owner response is refused (A2).

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const CALLER = { operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID, operatorRoles: ["platform_viewer"], operatorGrantedScopes: ["ai.read"] };

async function deps(responseByPath: Record<string, { status: number; body: unknown }>) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "test-kid", alg: "RS256", use: "sig" });
  const calls: Array<{ method: string; path: string; claims: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ method: init?.method ?? "GET", path: url.pathname, claims: decodeJwt(auth.replace(/^Bearer /, "")) as Record<string, unknown> });
    const match = responseByPath[url.pathname];
    return { status: match?.status ?? 404, json: async () => match?.body ?? { error: "NO_FIXTURE" } } as Response;
  }) as typeof fetch;
  const d: AiQueryDeps = {
    signingKeys: { activeKid: "test-kid", activePrivateKey: privateKey, publicJwks: [jwk] },
    transportConfig: { issuer: "https://governance.test.invalid", audience: "infrakinetic-management-api-test" },
    infrakineticBaseUrl: "https://infrakinetic.test.invalid",
    fetchImpl,
  };
  return { d, calls };
}

const STATE_PATH = `/management/v1/ai/tenants/${TENANT_ID}/state`;

describe("secret-shaped owner responses are refused (A2)", () => {
  it.each([
    [{ providers: [{ providerKey: "p", apiKey: "x" }] }, "$.providers[0].apiKey"],
    [{ deep: { nested: [{ ok: 1 }, { key_fingerprint: "abc" }] } }, "$.deep.nested[1].key_fingerprint"],
    [{ credential: { ciphertext: "..." } }, "$.credential.ciphertext"],
    [{ authorization: "Bearer x" }, "$.authorization"],
    [{ clientSecret: "x" }, "$.clientSecret"],
  ])("finds %j", (body, path) => {
    expect(findSecretShapedField(body)).toBe(path);
  });

  it("does not flag safe metadata names", () => {
    expect(findSecretShapedField({
      credentialSource: "env", maskedHint: "…1234", tenantFeatureKey: "feature_ai_x", providerModelIdentifier: "m",
      enforcement: { fingerprintSecretPosture: "dev_fallback" }, credentialRefs: { notModelled: true, slice: 5 },
    })).toBeNull();
  });

  it("the Slice 2 tenant DTO shape (root policy, emergency, quota v2) passes the guard", () => {
    expect(findSecretShapedField({
      rootPolicy: { source: "root_policy", policyVersion: 2, allowedPlanes: ["embedded_managed"], commissioningMode: "explicit", billingAnchorDay: 15 },
      emergency: { state: "suspended", reason: "r", recoveryIntent: "i", operationId: "o", since: "2026-09-28T00:00:00Z" },
      capabilities: [{ commissioning: { mode: "explicit", commissioned: true } }],
      quotas: [{ origin: "root", window: { start: "a", end: "b" }, warningPct: 0.8, softLimit: 9, overage: { mode: "grace", graceActiveForWindow: true, graceLimit: 1, graceExpiresAt: "x" }, recordedState: null }],
    })).toBeNull();
  });

  it("a tenant state carrying a secret-shaped field never reaches the caller", async () => {
    const { d } = await deps({ [STATE_PATH]: { status: 200, body: { tenantId: TENANT_ID, providersModels: [{ token: "leak" }] } } });
    await expect(getTenantAiState(d, { ...CALLER, tenantId: TENANT_ID })).rejects.toBeInstanceOf(UnsafeAiOwnerResponseError);
  });
});

describe("assertion addressing", () => {
  it("tenant state is bound to the tenant: target_tenant_id + tenant resource + ai.read + exact action", async () => {
    const { d, calls } = await deps({ [STATE_PATH]: { status: 200, body: { tenantId: TENANT_ID } } });
    await getTenantAiState(d, { ...CALLER, tenantId: TENANT_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: STATE_PATH });
    expect(calls[0].claims).toMatchObject({
      target_tenant_id: TENANT_ID, target_resource_type: "tenant", target_resource_id: TENANT_ID,
      requested_action: "ai.tenant.state.read", scopes: ["ai.read"],
    });
  });

  it("fleet and catalog assertions carry no tenant claim and name their own fleet resource", async () => {
    const { d, calls } = await deps({
      "/management/v1/ai/fleet/summary": { status: 200, body: { contractVersion: "ai-fleet/v1" } },
      "/management/v1/ai/catalog": { status: 200, body: { contractVersion: "ai-catalog/v1" } },
    });
    await getFleetAiSummary(d, CALLER);
    await getAiCatalog(d, CALLER);
    expect(calls[0].claims.target_tenant_id).toBeUndefined();
    expect(calls[0].claims).toMatchObject({ target_resource_type: "ai_fleet", target_resource_id: "ai_fleet", requested_action: "ai.fleet.read" });
    expect(calls[1].claims.target_tenant_id).toBeUndefined();
    expect(calls[1].claims).toMatchObject({ target_resource_type: "ai_catalog", target_resource_id: "ai_catalog", requested_action: "ai.catalog.read" });
  });

  it("an operator without ai.read cannot mint an AI read assertion at all", async () => {
    const { d, calls } = await deps({});
    await expect(getFleetAiSummary(d, { ...CALLER, operatorGrantedScopes: ["integrations.read"] })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("owner status mapping", () => {
  it("404 from the owner is an unknown tenant; other non-200s are upstream errors", async () => {
    const { d } = await deps({ [STATE_PATH]: { status: 404, body: { error: "UNKNOWN_TENANT" } } });
    await expect(getTenantAiState(d, { ...CALLER, tenantId: TENANT_ID })).rejects.toBeInstanceOf(UnknownTenantError);
    const { d: d409 } = await deps({ "/management/v1/ai/fleet/summary": { status: 409, body: {} } });
    await expect(getFleetAiSummary(d409, CALLER)).rejects.toBeInstanceOf(UnexpectedManagementApiResponseError);
  });
});
