import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeJwt, exportJWK } from "jose";

import { getPlatformInfrastructure, PLATFORM_INFRASTRUCTURE_RESOURCE, type PlatformInfrastructureQueryDeps } from "../../../src/management/operations/platformInfrastructureQuery.js";
import { getPlatformFinOps, PLATFORM_FINOPS_RESOURCE, type PlatformFinOpsQueryDeps } from "../../../src/management/operations/platformFinOpsQuery.js";
import { UnsafeAiOwnerResponseError } from "../../../src/management/operations/aiQuery.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  const common = {
    signingKeys: { activeKid: "test-kid", activePrivateKey: privateKey, publicJwks: [jwk] },
    transportConfig: { issuer: "https://governance.test.invalid", audience: "infrakinetic-management-api-test" },
    infrakineticBaseUrl: "https://infrakinetic.test.invalid",
    fetchImpl,
  };
  return { d: common as PlatformInfrastructureQueryDeps & PlatformFinOpsQueryDeps, calls };
}

const CALLER = {
  operatorId: OPERATOR_ID,
  operatorSessionId: SESSION_ID,
  operatorRoles: ["platform_admin"],
  operatorGrantedScopes: ["runtime.read", "finops.read"],
};

describe("Phase 1A.16/1A.17 Governance owner-query boundary", () => {
  it("addresses infrastructure with runtime.read and its exact platform-global resource", async () => {
    const path = "/management/v1/infrastructure";
    const { d, calls } = await deps({ [path]: { status: 200, body: { contractVersion: "platform-infrastructure/v1", freshness: "live" } } });
    await getPlatformInfrastructure(d, CALLER);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path });
    expect(calls[0].claims.target_tenant_id).toBeUndefined();
    expect(calls[0].claims).toMatchObject({
      target_resource_type: PLATFORM_INFRASTRUCTURE_RESOURCE,
      target_resource_id: PLATFORM_INFRASTRUCTURE_RESOURCE,
      requested_action: "platform.infrastructure.read",
      scopes: ["runtime.read"],
    });
  });

  it("addresses FinOps with finops.read and its own platform-global resource", async () => {
    const path = "/management/v1/finops";
    const { d, calls } = await deps({ [path]: { status: 200, body: { contractVersion: "platform-finops/v1", sources: { azure: { status: "not_connected" } } } } });
    await getPlatformFinOps(d, CALLER);
    expect(calls).toHaveLength(1);
    expect(calls[0].claims.target_tenant_id).toBeUndefined();
    expect(calls[0].claims).toMatchObject({
      target_resource_type: PLATFORM_FINOPS_RESOURCE,
      target_resource_id: PLATFORM_FINOPS_RESOURCE,
      requested_action: "platform.finops.read",
      scopes: ["finops.read"],
    });
  });

  it("refuses a secret-shaped infrastructure response before it can reach the browser", async () => {
    const { d } = await deps({
      "/management/v1/infrastructure": { status: 200, body: { azure: { serviceBus: { connectionString: "Endpoint=secret" } } } },
    });
    await expect(getPlatformInfrastructure(d, CALLER)).rejects.toBeInstanceOf(UnsafeAiOwnerResponseError);
  });

  it("fails locally when an operator lacks the scope instead of sending an over-privileged assertion", async () => {
    const { d, calls } = await deps({});
    await expect(getPlatformInfrastructure(d, { ...CALLER, operatorGrantedScopes: ["finops.read"] })).rejects.toThrow();
    await expect(getPlatformFinOps(d, { ...CALLER, operatorGrantedScopes: ["runtime.read"] })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
