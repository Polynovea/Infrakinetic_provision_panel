import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import {
  listTenantRegistry,
  getTenantRegistryEntry,
  UnknownTenantError,
} from "../../../src/management/operations/tenantRegistryQuery.js";
import { UnexpectedManagementApiResponseError } from "../../../src/management/operations/engineStateOperation.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";

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

const OPERATOR_PARAMS = {
  operatorId: "11111111-1111-4111-8111-111111111111",
  operatorSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  operatorRoles: ["platform_viewer"],
  operatorGrantedScopes: ["tenants.read"],
};

const SANITIZED_ENTRY = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Beta Co",
  slug: "beta-co",
  tenant_kind: "customer" as const,
  plan: "starter",
  status: "active",
  trial_ends_at: null,
  industry: "retail",
  country: "IN",
  timezone: "Asia/Kolkata",
  seat_limit: 5,
  storage_limit_mb: 2048,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

interface FakeCall {
  method: string;
  path: string;
}

function buildFakeInfrakinetic() {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    calls.push({ method, path: url.pathname });

    if (url.pathname === "/management/v1/tenants") {
      return {
        status: 200,
        json: async () => ({
          tenants: [SANITIZED_ENTRY],
          observedAt: "2026-09-14T00:00:00.000Z",
          source: "infrakinetic-live",
          freshness: "live",
        }),
      } as Response;
    }
    const detailMatch = url.pathname.match(/^\/management\/v1\/tenants\/([^/]+)$/);
    if (detailMatch) {
      const identifier = decodeURIComponent(detailMatch[1]);
      if (identifier !== SANITIZED_ENTRY.id && identifier !== SANITIZED_ENTRY.slug) {
        return { status: 404, json: async () => ({ error: "UNKNOWN_TENANT" }) } as Response;
      }
      return {
        status: 200,
        json: async () => ({
          tenant: SANITIZED_ENTRY,
          observedAt: "2026-09-14T00:00:00.000Z",
          source: "infrakinetic-live",
          freshness: "live",
        }),
      } as Response;
    }
    return { status: 404, json: async () => ({ error: "NOT_FOUND" }) } as Response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

describe("listTenantRegistry — real assertion, real HTTP shape, fake Infrakinetic", () => {
  it("mints exactly one assertion and returns the sanitized list untouched, with the freshness envelope", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl, calls } = buildFakeInfrakinetic();

    const result = await listTenantRegistry(
      { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
      OPERATOR_PARAMS,
    );

    expect(calls).toEqual([{ method: "GET", path: "/management/v1/tenants" }]);
    expect(result.tenants).toEqual([SANITIZED_ENTRY]);
    expect(result.source).toBe("infrakinetic-live");
    expect(result.freshness).toBe("live");
  });

  it("operator missing tenants.read in their granted scopes -> throws before any HTTP call", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl, calls } = buildFakeInfrakinetic();

    await expect(
      listTenantRegistry(
        { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
        { ...OPERATOR_PARAMS, operatorGrantedScopes: ["engines.read"] },
      ),
    ).rejects.toThrow(/tenants.read/);
    expect(calls).toEqual([]);
  });

  it("unexpected upstream status -> UnexpectedManagementApiResponseError", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const fetchImpl = (async () => ({ status: 500, json: async () => ({ error: "BOOM" }) }) as Response) as typeof fetch;

    await expect(
      listTenantRegistry(
        { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
        OPERATOR_PARAMS,
      ),
    ).rejects.toBeInstanceOf(UnexpectedManagementApiResponseError);
  });
});

describe("getTenantRegistryEntry — lookup by id or slug, 404 mapping", () => {
  it("resolves by id", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl } = buildFakeInfrakinetic();
    const result = await getTenantRegistryEntry(
      { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
      { ...OPERATOR_PARAMS, identifier: SANITIZED_ENTRY.id },
    );
    expect(result.tenant).toEqual(SANITIZED_ENTRY);
  });

  it("resolves by slug", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl } = buildFakeInfrakinetic();
    const result = await getTenantRegistryEntry(
      { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
      { ...OPERATOR_PARAMS, identifier: SANITIZED_ENTRY.slug },
    );
    expect(result.tenant.id).toBe(SANITIZED_ENTRY.id);
  });

  it("unknown identifier -> UnknownTenantError", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl } = buildFakeInfrakinetic();
    await expect(
      getTenantRegistryEntry(
        { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
        { ...OPERATOR_PARAMS, identifier: "not-a-real-tenant" },
      ),
    ).rejects.toBeInstanceOf(UnknownTenantError);
  });
});
