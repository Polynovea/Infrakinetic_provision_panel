import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import {
  requestTenantPlanChange,
  MissingTenantIdentifierForPlanChangeError,
  ProjectionMissingForPlanChangeError,
} from "../../../src/management/operations/tenantPlanChangeOperation.js";
import { UnknownTenantError } from "../../../src/management/operations/tenantRegistryQuery.js";
import { ManagementApiUnreachableError } from "../../../src/management/operations/engineStateOperation.js";
import { MissingReasonError, IdempotencyConflictError } from "../../../src/management/operations/managementOperationErrors.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { TenantPlanChangeOperationDeps } from "../../../src/management/operations/tenantPlanChangeOperation.js";

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

const KNOWN_TENANTS = new Set([TENANT_ID]);

interface FakeCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface FakeInfrakineticOptions {
  /** If set, the Nth verify-GET (1-indexed, counting only reads AFTER at least one PUT) returns this plan instead of the real store value. */
  forceVerifyEffectiveOnCall?: { call: number; plan: string };
  /** If set, the Nth verify-GET throws instead of responding. */
  failVerifyOnCall?: number;
  /** If set, the mutation PUT throws an outcome-ambiguous network error instead of responding. */
  failMutation?: boolean;
}

function buildFakeInfrakinetic(initialPlan = "starter", options: FakeInfrakineticOptions = {}) {
  let plan = initialPlan;
  const calls: FakeCall[] = [];
  let putCount = 0;
  let verifyGetCount = 0;

  function jsonResponse(status: number, body: unknown): Response {
    return { status, json: async () => body } as Response;
  }

  function tenantBody() {
    return { tenant: { id: TENANT_ID, name: "Acme", slug: "acme", tenant_kind: "customer", plan, status: "active" } };
  }

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });

    const planMatch = url.pathname.match(/^\/management\/v1\/tenants\/([^/]+)\/plan$/);
    if (planMatch && method === "PUT") {
      const tenantId = decodeURIComponent(planMatch[1]);
      if (!KNOWN_TENANTS.has(tenantId)) return jsonResponse(404, { error: "UNKNOWN_TENANT" });
      if (options.failMutation) throw new Error("simulated network failure on mutation call");
      const requestedPlan = body?.plan as string;
      putCount += 1;
      const previousPlan = plan;
      plan = requestedPlan;
      return jsonResponse(200, {
        tenantId,
        replay: false,
        previousPlan,
        requestedPlan,
        resultingPlan: plan,
        operatorId: OPERATOR_ID,
        correlationId: "fake-corr",
        executedAt: new Date().toISOString(),
      });
    }

    const detailMatch = url.pathname.match(/^\/management\/v1\/tenants\/([^/]+)$/);
    if (detailMatch && method === "GET") {
      const tenantId = decodeURIComponent(detailMatch[1]);
      if (!KNOWN_TENANTS.has(tenantId)) return jsonResponse(404, { error: "UNKNOWN_TENANT" });

      const isPostMutationRead = putCount > 0;
      if (isPostMutationRead) {
        verifyGetCount += 1;
        if (options.failVerifyOnCall === verifyGetCount) {
          throw new Error("simulated network failure on effective-state verification");
        }
        if (options.forceVerifyEffectiveOnCall?.call === verifyGetCount) {
          return jsonResponse(200, { tenant: { ...tenantBody().tenant, plan: options.forceVerifyEffectiveOnCall.plan } });
        }
      }
      return jsonResponse(200, tenantBody());
    }

    return jsonResponse(404, { error: "not_found" });
  }) as typeof fetch;

  return { fetchImpl, calls, putCountRef: () => putCount };
}

describe("management/operations/tenantPlanChangeOperation", () => {
  let client: DbClient;
  let ledger: ManagementOperationLedger;
  let commissionedTenants: CommissionedTenantsRepository;
  let signingKeys: ManagementSigningKeySet;

  beforeEach(async () => {
    const built = buildMigratedPgMemClient();
    client = built.client;
    ledger = new ManagementOperationLedger(client);
    commissionedTenants = new CommissionedTenantsRepository(client);
    await seedOperator(client);
    signingKeys = await buildFixtureSigningKeys();
    // Real projection row for TENANT_ID — most tests need Step 1b's
    // projection_missing gate to pass so they can exercise what comes
    // after it. The dedicated "no projection exists" test below removes
    // this precondition on purpose.
    await commissionedTenants.createLegacyExisting({
      tenantId: TENANT_ID,
      createdAt: new Date().toISOString(),
      observedPlatformAccessState: "active",
    });
  });

  function baseDeps(fetchImpl: typeof fetch, infrakineticBaseUrl = "http://fake-infra.test"): TenantPlanChangeOperationDeps {
    return { ledger, commissionedTenants, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl, fetchImpl };
  }

  function baseParams(overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: "plan-op-1",
      operatorId: OPERATOR_ID,
      operatorSessionId: SESSION_ID,
      operatorRoles: ["provisioning_operator"],
      operatorGrantedScopes: ["tenants.read", "tenants.plan.write"],
      tenantId: TENANT_ID,
      plan: "growth",
      reason: "customer upgraded",
      ...overrides,
    };
  }

  it("missing tenantId is rejected before any network call", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    await expect(
      requestTenantPlanChange(baseDeps(fetchImpl), baseParams({ tenantId: "" })),
    ).rejects.toBeInstanceOf(MissingTenantIdentifierForPlanChangeError);
    expect(calls).toHaveLength(0);
  });

  it("no commissioned-tenant projection exists for this tenant -> rejects before any ledger reservation, no owner mutation attempted", async () => {
    const noProjectionTenant = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const { fetchImpl, calls } = buildFakeInfrakinetic("starter");
    // Registers this tenant as KNOWN to Infrakinetic's registry (via the
    // fake) but Governance has no commissioned_tenants row for it at all —
    // the exact projection_missing shape.
    KNOWN_TENANTS.add(noProjectionTenant);
    await expect(
      requestTenantPlanChange(baseDeps(fetchImpl), baseParams({ tenantId: noProjectionTenant })),
    ).rejects.toBeInstanceOf(ProjectionMissingForPlanChangeError);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
    KNOWN_TENANTS.delete(noProjectionTenant);
  });

  it("a successful plan change converges Governance's own desired_plan to the requested plan — closing the exact gap that would otherwise leave desiredProvisionedMismatch behind", async () => {
    const { fetchImpl } = buildFakeInfrakinetic("starter");
    const { operation } = await requestTenantPlanChange(baseDeps(fetchImpl), baseParams({ plan: "growth" }));
    expect(operation.status).toBe("completed");
    const projection = await commissionedTenants.getByTenantId(TENANT_ID);
    expect(projection?.desiredPlan).toBe("growth");
  });

  it("desired_plan is updated even when the owner apply later fails — deliberate, documented drift for 1A.10 to surface, not silently reverted", async () => {
    const { fetchImpl } = buildFakeInfrakinetic("starter", { failMutation: true });
    const { operation } = await requestTenantPlanChange(baseDeps(fetchImpl), baseParams({ plan: "growth" }));
    expect(operation.status).toBe("partially_completed");
    const projection = await commissionedTenants.getByTenantId(TENANT_ID);
    // Intent was declared before the owner attempt; it is not rolled back
    // just because Infrakinetic never received/applied it.
    expect(projection?.desiredPlan).toBe("growth");
  });

  it("unknown tenant is rejected before any ledger operation is created", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    await expect(
      requestTenantPlanChange(baseDeps(fetchImpl), baseParams({ tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })),
    ).rejects.toBeInstanceOf(UnknownTenantError);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
  });

  it("a network failure on Step 1's resolve-read (before any ledger reservation) is a clean ManagementApiUnreachableError-ish rejection and creates no ledger row", async () => {
    const unreachableFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(requestTenantPlanChange(baseDeps(unreachableFetch), baseParams())).rejects.toThrow();
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
  });

  it("outcome-ambiguous network failure on the mutation call -> partially_completed, not failed (1A.10.1 discipline)", async () => {
    const { fetchImpl } = buildFakeInfrakinetic("starter", { failMutation: true });
    const { operation } = await requestTenantPlanChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("partially_completed");
    expect((operation.partialFailureState as { stage?: string })?.stage).toBe("mutation-call");
  });

  it("connection never established on the mutation call -> unambiguous failed", async () => {
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

    const { operation } = await requestTenantPlanChange(baseDeps(neverConnectsOnMutation), baseParams());
    expect(mutationAttempted).toBe(true);
    expect(operation.status).toBe("failed");
    expect((operation.partialFailureState as { stage?: string })?.stage).toBe("mutation-call-never-dispatched");
  });

  it("missing reason is rejected by the 1A.5 ledger (R2 requires a reason)", async () => {
    const { fetchImpl } = buildFakeInfrakinetic();
    await expect(
      requestTenantPlanChange(baseDeps(fetchImpl), baseParams({ reason: "" })),
    ).rejects.toBeInstanceOf(MissingReasonError);
  });

  it("captures the real before-plan, independently observed, not merely asserted", async () => {
    const { fetchImpl } = buildFakeInfrakinetic("starter");
    const { operation } = await requestTenantPlanChange(baseDeps(fetchImpl), baseParams());
    const before = operation.beforeStateSafeSnapshot as { data: { plan: string } };
    expect(before.data.plan).toBe("starter");
  });

  it("completes only after independent effective confirmation, mutating exactly once", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic("starter");
    const { operation, replay } = await requestTenantPlanChange(baseDeps(fetchImpl), baseParams());

    expect(replay).toBe(false);
    expect(operation.status).toBe("completed");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    // resolve-GET, PUT, verify-GET — independent effective read-back is a
    // distinct call from the PUT's own response.
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
    expect(operation.result).toMatchObject({ previousPlan: "starter", requestedPlan: "growth", resultingPlan: "growth" });
  });

  it("same idempotency key + same request replays safely — no second call to Infrakinetic's mutation route", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic("starter");
    const deps = baseDeps(fetchImpl);
    const first = await requestTenantPlanChange(deps, baseParams());
    const callsAfterFirst = calls.length;
    const second = await requestTenantPlanChange(deps, baseParams());

    expect(second.replay).toBe(true);
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(calls.length).toBeLessThanOrEqual(callsAfterFirst + 1); // at most a harmless resolve-GET
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("same key + different plan conflicts, without ever calling the mutation route again", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic("starter");
    const deps = baseDeps(fetchImpl);
    await requestTenantPlanChange(deps, baseParams());
    await expect(
      requestTenantPlanChange(deps, baseParams({ plan: "enterprise" })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("concurrent duplicate requests collapse to exactly one real mutation call", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic("starter");
    const deps = baseDeps(fetchImpl);
    const [a, b] = await Promise.all([
      requestTenantPlanChange(deps, baseParams()),
      requestTenantPlanChange(deps, baseParams()),
    ]);
    expect(a.operation.operationId).toBe(b.operation.operationId);
    expect([a.replay, b.replay].sort()).toEqual([false, true]);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("represents an effective-state mismatch as partially_completed, not a false 'completed' — this is exactly the shape that must never silently produce desiredProvisionedMismatch", async () => {
    const { fetchImpl } = buildFakeInfrakinetic("starter", { forceVerifyEffectiveOnCall: { call: 1, plan: "starter" } });
    const { operation } = await requestTenantPlanChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("partially_completed");
    expect(operation.partialFailureState).toMatchObject({ stage: "effective-mismatch", expected: "growth", observed: "starter" });
  });

  it("represents a partial failure when the independent effective read itself fails", async () => {
    const { fetchImpl } = buildFakeInfrakinetic("starter", { failVerifyOnCall: 1 });
    const { operation } = await requestTenantPlanChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("partially_completed");
    expect((operation.partialFailureState as { stage: string }).stage).toBe("effective-observation");
  });

  it("carries correlation id through to the final operation, and a caller-supplied causation id", async () => {
    const { fetchImpl } = buildFakeInfrakinetic("starter");
    const correlationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const causationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const { operation } = await requestTenantPlanChange(baseDeps(fetchImpl), baseParams({ correlationId, causationId }));
    expect(operation.correlationId).toBe(correlationId);
    expect(operation.causationId).toBe(causationId);
  });
});
