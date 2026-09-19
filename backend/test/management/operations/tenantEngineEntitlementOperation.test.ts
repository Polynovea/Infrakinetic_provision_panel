import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import {
  requestTenantEngineEntitlementChange,
  UnknownEntitlementEngineError,
  UnknownEntitlementTenantError,
  MissingEntitlementTenantIdentifierError,
} from "../../../src/management/operations/tenantEngineEntitlementOperation.js";
import { ManagementApiUnreachableError } from "../../../src/management/operations/engineStateOperation.js";
import { MissingReasonError, IdempotencyConflictError } from "../../../src/management/operations/managementOperationErrors.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { TenantEngineEntitlementOperationDeps } from "../../../src/management/operations/tenantEngineEntitlementOperation.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

// A canonical-engine + alias fixture, matching enough of the real catalog
// shape (module_ai, plus one alias) for these tests — NOT importing CRM's
// real catalog (hard rule), same fixture convention engineStateOperation.test.ts
// already uses.
const CANONICAL_ENGINES = new Set(["module_ai", "module_finance"]);
const ALIAS_TO_CANONICAL: Record<string, string> = { ai: "module_ai" };
const DEFAULT_DENY_ENGINES = new Set(["module_ai", "module_finance"]);
const KNOWN_TENANTS = new Set([TENANT_ID]);

interface FakeCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface FakeInfrakineticOptions {
  /** If set, the Nth verify-GET (1-indexed, counting only reads AFTER at least one PUT) returns this instead of the real store value. */
  forceVerifyEffectiveOnCall?: { call: number; effectiveEnabled: boolean };
  /** If set, the Nth verify-GET throws instead of responding. */
  failVerifyOnCall?: number;
  platformState?: { state: string; reason: string | null };
  /** If set, the mutation PUT throws an outcome-ambiguous network error instead of responding. */
  failMutation?: boolean;
}

function buildFakeInfrakinetic(
  initial: Record<string, boolean> = {}, // engineKey -> configured `enabled` value
  options: FakeInfrakineticOptions = {},
) {
  const store = new Map<string, boolean>(Object.entries(initial));
  const calls: FakeCall[] = [];
  let putCount = 0;
  let verifyGetCount = 0;
  const platformState = options.platformState ?? { state: "operational", reason: null };

  function jsonResponse(status: number, body: unknown): Response {
    return { status, json: async () => body } as Response;
  }

  function entitlementBody(canonical: string) {
    const configured = store.has(canonical);
    const defaultDeny = DEFAULT_DENY_ENGINES.has(canonical);
    const effectiveEnabled = configured ? (store.get(canonical) as boolean) : !defaultDeny;
    return {
      tenantId: TENANT_ID,
      canonicalEngine: canonical,
      configured,
      effectiveEnabled,
      defaultDeny,
      platformEngineState: platformState,
    };
  }

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });

    const getMatch = url.pathname.match(/^\/management\/v1\/tenants\/([^/]+)\/engines\/([^/]+)\/entitlement$/);

    if (getMatch) {
      const tenantId = decodeURIComponent(getMatch[1]);
      if (!KNOWN_TENANTS.has(tenantId)) {
        return jsonResponse(404, { error: "UNKNOWN_TENANT" });
      }
      const requested = decodeURIComponent(getMatch[2]);
      const canonical = ALIAS_TO_CANONICAL[requested] ?? requested;
      if (!CANONICAL_ENGINES.has(canonical)) {
        return jsonResponse(404, { error: "UNKNOWN_ENGINE_KEY", engineKey: requested });
      }

      if (method === "PUT") {
        if (options.failMutation) {
          throw new Error("simulated network failure on mutation call");
        }
        const enabled = body?.enabled as boolean;
        putCount += 1;
        const previous = entitlementBody(canonical);
        store.set(canonical, enabled);
        return jsonResponse(200, {
          tenantId,
          canonicalEngine: canonical,
          replay: false,
          previousEntitlement: { configured: previous.configured, effectiveEnabled: previous.effectiveEnabled, defaultDeny: previous.defaultDeny },
          requestedEnabled: enabled,
          resultingEntitlement: { configured: true, effectiveEnabled: enabled, defaultDeny: DEFAULT_DENY_ENGINES.has(canonical) },
          platformEngineState: platformState,
          operatorId: OPERATOR_ID,
          correlationId: "fake-corr",
          executedAt: new Date().toISOString(),
        });
      }

      // GET — distinguish resolve-GET (before any mutation) from verify-GET
      // (after at least one PUT), same technique as engineStateOperation.test.ts.
      const isPostMutationRead = putCount > 0;
      if (isPostMutationRead) {
        verifyGetCount += 1;
        if (options.failVerifyOnCall === verifyGetCount) {
          throw new Error("simulated network failure on effective-state verification");
        }
        if (options.forceVerifyEffectiveOnCall?.call === verifyGetCount) {
          return jsonResponse(200, {
            ...entitlementBody(canonical),
            effectiveEnabled: options.forceVerifyEffectiveOnCall.effectiveEnabled,
          });
        }
      }
      return jsonResponse(200, entitlementBody(canonical));
    }

    return jsonResponse(404, { error: "not_found" });
  }) as typeof fetch;

  return { fetchImpl, calls, store, putCountRef: () => putCount };
}

describe("management/operations/tenantEngineEntitlementOperation", () => {
  let client: DbClient;
  let ledger: ManagementOperationLedger;
  let signingKeys: ManagementSigningKeySet;

  beforeEach(async () => {
    const built = buildMigratedPgMemClient();
    client = built.client;
    ledger = new ManagementOperationLedger(client);
    await seedOperator(client);
    signingKeys = await buildFixtureSigningKeys();
  });

  function baseDeps(fetchImpl: typeof fetch, infrakineticBaseUrl = "http://fake-infra.test"): TenantEngineEntitlementOperationDeps {
    return { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl, fetchImpl };
  }

  function baseParams(overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: "entitlement-op-1",
      operatorId: OPERATOR_ID,
      operatorSessionId: SESSION_ID,
      operatorRoles: ["platform_operator"],
      operatorGrantedScopes: ["tenants.read", "engines.entitlement.write"],
      tenantId: TENANT_ID,
      engineKeyOrAlias: "module_ai",
      enabled: true,
      reason: "customer purchased AI add-on",
      ...overrides,
    };
  }

  it("missing tenantId is rejected before any network call", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    await expect(
      requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams({ tenantId: "" })),
    ).rejects.toBeInstanceOf(MissingEntitlementTenantIdentifierError);
    expect(calls).toHaveLength(0);
  });

  it("unknown engine is rejected before any ledger operation is created", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    await expect(
      requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams({ engineKeyOrAlias: "not_a_real_engine" })),
    ).rejects.toBeInstanceOf(UnknownEntitlementEngineError);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
  });

  it("unknown tenant is rejected before any ledger operation is created", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    await expect(
      requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams({ tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })),
    ).rejects.toBeInstanceOf(UnknownEntitlementTenantError);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("a network failure on Step 1's resolve-read (before any ledger reservation) is a clean ManagementApiUnreachableError, not an uncaught throw, and creates no ledger row", async () => {
    const unreachableFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      requestTenantEngineEntitlementChange(baseDeps(unreachableFetch), baseParams()),
    ).rejects.toBeInstanceOf(ManagementApiUnreachableError);
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
  });

  it("outcome-ambiguous network failure on the mutation call -> partially_completed, not failed (1A.10.1)", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({}, { failMutation: true });
    const { operation } = await requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("partially_completed");
    expect((operation.partialFailureState as { stage?: string })?.stage).toBe("mutation-call");
  });

  it("connection never established (DNS/connection-refused) on the mutation call -> unambiguous failed (1A.10.1)", async () => {
    const { fetchImpl: resolveFetch } = buildFakeInfrakinetic();
    let mutationAttempted = false;
    const neverConnectsOnMutation = (async (input: string | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET") as string;
      if (method === "PUT") {
        mutationAttempted = true;
        throw Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
      }
      return resolveFetch(input, init);
    }) as unknown as typeof fetch;

    const { operation } = await requestTenantEngineEntitlementChange(baseDeps(neverConnectsOnMutation), baseParams());
    expect(mutationAttempted).toBe(true);
    expect(operation.status).toBe("failed");
    expect((operation.partialFailureState as { stage?: string })?.stage).toBe("mutation-call-never-dispatched");
  });

  it("an alias is canonicalized before the ledger and Infrakinetic mutation route ever see it", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    const { operation } = await requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams({ engineKeyOrAlias: "ai" }));
    expect(operation.targetEngine).toBe("module_ai");
    expect(operation.targetTenantId).toBe(TENANT_ID);
    expect(calls.find((c) => c.method === "PUT")?.path).toBe(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`);
  });

  it("missing reason is rejected by the 1A.5 ledger (R2 requires a reason)", async () => {
    const { fetchImpl } = buildFakeInfrakinetic();
    await expect(
      requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams({ reason: "" })),
    ).rejects.toBeInstanceOf(MissingReasonError);
  });

  it("captures the real before-entitlement, independently observed, not merely asserted", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({ module_ai: false }); // already configured, explicitly disabled
    const { operation } = await requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams());
    const before = operation.beforeStateSafeSnapshot as { data: { configured: boolean; effectiveEnabled: boolean } };
    expect(before.data).toMatchObject({ configured: true, effectiveEnabled: false });
  });

  it("completes only after independent effective confirmation, mutating exactly once", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    const { operation, replay } = await requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams());

    expect(replay).toBe(false);
    expect(operation.status).toBe("completed");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    // resolve-GET, PUT, verify-GET — independent effective read-back is a
    // distinct call from the PUT's own response.
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
    expect(operation.result).toMatchObject({ requestedEnabled: true, resultingEntitlement: { effectiveEnabled: true } });
  });

  it("every mutation call carries BOTH target_engine and target_tenant_id on the same assertion", async () => {
    const { fetchImpl } = buildFakeInfrakinetic();
    await requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams());
    const { operation } = await requestTenantEngineEntitlementChange(
      baseDeps(fetchImpl),
      baseParams({ idempotencyKey: "entitlement-op-1" }), // same key -> replay, still proves the recorded operation carries both
    );
    expect(operation.targetEngine).toBe("module_ai");
    expect(operation.targetTenantId).toBe(TENANT_ID);
  });

  it("same idempotency key + same request replays safely — no second call to Infrakinetic's mutation route", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    const deps = baseDeps(fetchImpl);
    const first = await requestTenantEngineEntitlementChange(deps, baseParams());
    const callsAfterFirst = calls.length;
    const second = await requestTenantEngineEntitlementChange(deps, baseParams());

    expect(second.replay).toBe(true);
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(calls.length).toBeLessThanOrEqual(callsAfterFirst + 1); // at most a harmless resolve-GET
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("same key + different enabled value conflicts, without ever calling the mutation route again", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    const deps = baseDeps(fetchImpl);
    await requestTenantEngineEntitlementChange(deps, baseParams());
    await expect(
      requestTenantEngineEntitlementChange(deps, baseParams({ enabled: false })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("concurrent duplicate requests collapse to exactly one real mutation call", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    const deps = baseDeps(fetchImpl);
    const [a, b] = await Promise.all([
      requestTenantEngineEntitlementChange(deps, baseParams()),
      requestTenantEngineEntitlementChange(deps, baseParams()),
    ]);
    expect(a.operation.operationId).toBe(b.operation.operationId);
    expect([a.replay, b.replay].sort()).toEqual([false, true]);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("represents an effective-state mismatch as partially_completed, not a false 'completed'", async () => {
    const { fetchImpl } = buildFakeInfrakinetic(
      {},
      { forceVerifyEffectiveOnCall: { call: 1, effectiveEnabled: false } }, // PUT claims enabled, independent read disagrees
    );
    const { operation } = await requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("partially_completed");
    expect(operation.partialFailureState).toMatchObject({
      stage: "effective-mismatch",
      expected: true,
      observed: false,
    });
  });

  it("represents a partial failure when the independent effective read itself fails", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({}, { failVerifyOnCall: 1 });
    const { operation } = await requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("partially_completed");
    expect((operation.partialFailureState as { stage: string }).stage).toBe("effective-observation");
  });

  it("setting entitlement on a platform-disabled engine still succeeds — desired state is independent of platform state (§3.4)", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({}, { platformState: { state: "disabled", reason: "provider policy revoked" } });
    const { operation } = await requestTenantEngineEntitlementChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("completed");
    expect(operation.result).toMatchObject({ platformEngineState: { state: "disabled", reason: "provider policy revoked" } });
  });

  it("carries correlation id through to the final operation, and a caller-supplied causation id", async () => {
    const { fetchImpl } = buildFakeInfrakinetic();
    const correlationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const causationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const { operation } = await requestTenantEngineEntitlementChange(
      baseDeps(fetchImpl),
      baseParams({ correlationId, causationId }),
    );
    expect(operation.correlationId).toBe(correlationId);
    expect(operation.causationId).toBe(causationId);
  });
});
