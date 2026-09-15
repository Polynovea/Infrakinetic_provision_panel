import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { listEngineCatalog } from "../../../src/management/operations/engineCatalogQuery.js";
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
  operatorGrantedScopes: ["engines.read"],
};

const CATALOG = [
  { engineKey: "module_migration", label: "Migration", aliases: [] },
  { engineKey: "module_billing", label: "Billing & Invoicing", aliases: ["module_payments"] },
];

interface FakeCall {
  method: string;
  path: string;
}

function buildFakeInfrakinetic(stateByEngine: Record<string, { state: string; reason: string | null } | "500" | "404">) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    calls.push({ method, path: url.pathname });

    if (url.pathname === "/management/v1/engines/catalog") {
      return { status: 200, json: async () => ({ engines: CATALOG }) } as Response;
    }
    const stateMatch = url.pathname.match(/^\/management\/v1\/engines\/([^/]+)\/state$/);
    if (stateMatch) {
      const engineKey = decodeURIComponent(stateMatch[1]);
      const fixture = stateByEngine[engineKey];
      if (fixture === "500") return { status: 500, json: async () => ({ error: "BOOM" }) } as Response;
      if (fixture === "404" || !fixture) return { status: 404, json: async () => ({ error: "UNKNOWN_ENGINE_KEY" }) } as Response;
      return { status: 200, json: async () => ({ engineKey, ...fixture }) } as Response;
    }
    return { status: 404, json: async () => ({ error: "NOT_FOUND" }) } as Response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

describe("listEngineCatalog — real assertion, real HTTP shape, fake Infrakinetic", () => {
  it("returns every catalog engine with its live state, one catalog call + one state call per engine", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl, calls } = buildFakeInfrakinetic({
      module_migration: { state: "operational", reason: null },
      module_billing: { state: "degraded", reason: "provider outage" },
    });

    const result = await listEngineCatalog(
      { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
      OPERATOR_PARAMS,
    );

    // The catalog call is awaited before the per-engine state calls ever
    // start, so it's deterministically first. The two per-engine state
    // calls then run concurrently (Promise.all over the mapped catalog
    // entries) — real async work (assertion signing) sits between each
    // call's "start" and its actual fetch, so which one's fetch actually
    // fires first is not guaranteed, and must not be asserted as if it
    // were. Promise.all's own result-ordering guarantee (asserted below,
    // against result.engines) is what actually matters here, not fetch
    // arrival order.
    expect(calls[0]).toEqual({ method: "GET", path: "/management/v1/engines/catalog" });
    expect(calls.slice(1)).toHaveLength(2);
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/management/v1/engines/module_migration/state" },
        { method: "GET", path: "/management/v1/engines/module_billing/state" },
      ]),
    );
    expect(result.engines).toEqual([
      { engineKey: "module_migration", label: "Migration", aliases: [], state: "operational", reason: null },
      { engineKey: "module_billing", label: "Billing & Invoicing", aliases: ["module_payments"], state: "degraded", reason: "provider outage" },
    ]);
    expect(result.source).toBe("infrakinetic-live");
    expect(result.freshness).toBe("live");
  });

  it("a single engine's failed state read surfaces as state 'unknown', never fails the whole catalog", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl } = buildFakeInfrakinetic({
      module_migration: { state: "operational", reason: null },
      module_billing: "500",
    });

    const result = await listEngineCatalog(
      { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
      OPERATOR_PARAMS,
    );

    const billing = result.engines.find((e) => e.engineKey === "module_billing");
    expect(billing?.state).toBe("unknown");
    expect(billing?.reason).toMatch(/500/);
    const migration = result.engines.find((e) => e.engineKey === "module_migration");
    expect(migration?.state).toBe("operational");
  });

  it("operator missing engines.read in their granted scopes -> throws before any HTTP call", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const { fetchImpl, calls } = buildFakeInfrakinetic({});

    await expect(
      listEngineCatalog(
        { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
        { ...OPERATOR_PARAMS, operatorGrantedScopes: ["tenants.read"] },
      ),
    ).rejects.toThrow(/engines.read/);
    expect(calls).toEqual([]);
  });

  it("catalog call itself failing -> UnexpectedManagementApiResponseError", async () => {
    const signingKeys = await buildFixtureSigningKeys();
    const fetchImpl = (async () => ({ status: 500, json: async () => ({ error: "BOOM" }) }) as Response) as typeof fetch;

    await expect(
      listEngineCatalog(
        { signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake.invalid", fetchImpl },
        OPERATOR_PARAMS,
      ),
    ).rejects.toBeInstanceOf(UnexpectedManagementApiResponseError);
  });
});
