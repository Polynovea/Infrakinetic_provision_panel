import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import { reconcileTenant, type ReconciliationOperationDeps } from "../../../src/management/operations/reconciliationOperation.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { CreateManagementOperationParams } from "../../../src/management/operations/managementOperationLedger.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-0000-4bbb-8bbb-000000000001";

const OPERATOR_PARAMS = {
  operatorId: OPERATOR_ID,
  operatorSessionId: SESSION_ID,
  operatorRoles: ["platform_operator"],
  operatorGrantedScopes: ["tenants.read"],
};

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

interface FakeOptions {
  platformAccessState?: "active" | "suspended" | "decommissioned";
  lifecycleReceipts?: Record<string, "accepted" | "executing" | "partially_completed" | "completed" | "failed">;
  entitlementReceipts?: Record<string, "accepted" | "executing" | "partially_completed" | "completed" | "failed">;
  /** Idempotency keys whose receipt read returns a transient 500 instead of a real answer. */
  receiptServerErrorKeys?: string[];
}

function buildFakeInfrakinetic(options: FakeOptions = {}) {
  const calls: { path: string }[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname });

    if (url.pathname === `/management/v1/tenants/${TENANT_ID}`) {
      return {
        status: 200,
        json: async () => ({
          tenant: {
            id: TENANT_ID, name: "Acme", slug: "acme", tenant_kind: "customer", plan: "pro", status: "active",
            platform_access_state: options.platformAccessState ?? "active",
            trial_ends_at: null, industry: null, country: "IN", timezone: "Asia/Kolkata",
            seat_limit: null, storage_limit_mb: null,
            created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
          },
          observedAt: "2026-09-19T00:00:00.000Z", source: "infrakinetic-live", freshness: "live",
        }),
      } as Response;
    }

    const lifecycleMatch = url.pathname.match(/^\/management\/v1\/tenant-lifecycle-commands\/([^/]+)$/);
    if (lifecycleMatch) {
      const key = decodeURIComponent(lifecycleMatch[1]);
      if (options.receiptServerErrorKeys?.includes(key)) return { status: 500, json: async () => ({ error: "INTERNAL" }) } as Response;
      const status = options.lifecycleReceipts?.[key];
      if (!status) return { status: 404, json: async () => ({ error: "UNKNOWN_LIFECYCLE_COMMAND" }) } as Response;
      return { status: 200, json: async () => ({ command: { idempotencyKey: key, status } }) } as Response;
    }

    const entitlementMatch = url.pathname.match(/^\/management\/v1\/tenant-engine-entitlement-commands\/([^/]+)$/);
    if (entitlementMatch) {
      const key = decodeURIComponent(entitlementMatch[1]);
      const status = options.entitlementReceipts?.[key];
      if (!status) return { status: 404, json: async () => ({ error: "UNKNOWN_ENTITLEMENT_COMMAND" }) } as Response;
      return { status: 200, json: async () => ({ command: { idempotencyKey: key, status } }) } as Response;
    }

    return { status: 404, json: async () => ({ error: "NOT_FOUND" }) } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("management/operations/reconciliationOperation", () => {
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
  });

  function baseDeps(fetchImpl: typeof fetch): ReconciliationOperationDeps {
    return { ledger, commissionedTenants, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake-infra.test", fetchImpl };
  }

  function opParams(overrides: Partial<CreateManagementOperationParams> = {}): CreateManagementOperationParams {
    return {
      idempotencyKey: `op-${Math.random()}`,
      operatorId: OPERATOR_ID,
      operatorSessionId: SESSION_ID,
      requestedAction: "tenant.suspend",
      targetTenantId: TENANT_ID,
      targetResourceType: "tenant",
      targetResourceId: TENANT_ID,
      reason: "test fixture",
      riskClass: "R2",
      payload: {},
      contractVersion: "platform-management.operation.v1",
      correlationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ...overrides,
    };
  }

  async function seedStuckOperation(overrides: Partial<CreateManagementOperationParams>, partialFailureState: unknown) {
    const { operation } = await ledger.createOrReplayOperation(opParams(overrides));
    await ledger.transitionOperation(operation.operationId, { toStatus: "accepted" });
    await ledger.transitionOperation(operation.operationId, { toStatus: "running" });
    return ledger.transitionOperation(operation.operationId, { toStatus: "partially_completed", partialFailureState });
  }

  it("registry unreachable during repair -> reported as a partial outcome, never thrown (projection repair and stuck-op resolution are isolated)", async () => {
    const unreachableFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await reconcileTenant(baseDeps(unreachableFetch), { idempotencyKey: "recheck-unreachable", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.outcome).toBe("partial");
    expect(result.projection).toEqual({ created: false, observedRefreshed: false });
    expect(result.projectionError).toContain("Could not reach Infrakinetic's management API");
    expect(result.stuckOperationsError).toBeUndefined();
  });

  it("stuck-operation resolution still runs and succeeds even though projection repair fails on an unreachable registry", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const stuck = await seedStuckOperation({ idempotencyKey: "lifecycle-key-independent-1", requestedAction: "tenant.suspend" }, { stage: "mutation-call" });

    // Registry GET fails; the lifecycle-commands receipt read (a DIFFERENT
    // Infrakinetic endpoint, not the registry) succeeds normally.
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === `/management/v1/tenants/${TENANT_ID}`) {
        throw new TypeError("fetch failed");
      }
      if (url.pathname === "/management/v1/tenant-lifecycle-commands/lifecycle-key-independent-1") {
        return { status: 200, json: async () => ({ command: { idempotencyKey: "lifecycle-key-independent-1", status: "completed" } }) } as Response;
      }
      return { status: 404, json: async () => ({ error: "NOT_FOUND" }) } as Response;
    }) as unknown as typeof fetch;

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-independent-1", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.outcome).toBe("partial");
    expect(result.projectionError).toContain("Could not reach Infrakinetic's management API");
    expect(result.stuckOperationsError).toBeUndefined();
    expect(result.resolvedOperations).toEqual([{ operationId: stuck.operationId, requestedAction: "tenant.suspend", from: "partially_completed", to: "completed", stage: "mutation-call" }]);
    const final = await ledger.getOperation(stuck.operationId);
    expect(final.status).toBe("completed"); // real, committed side effect despite the other sub-task failing
  });

  it("projection repair still runs and succeeds even though the stuck-operation sweep fails (ledger unavailable)", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active" });
    vi.spyOn(ledger, "listOperations").mockRejectedValueOnce(new Error("governance db unavailable"));

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-independent-2", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.outcome).toBe("partial");
    expect(result.projectionError).toBeUndefined();
    expect(result.projection).toEqual({ created: true, observedRefreshed: false });
    expect(result.stuckOperationsError).toContain("governance db unavailable");
    expect(result.resolvedOperations).toEqual([]);
    expect(result.remainingDrift).toEqual([]);
    const projection = await commissionedTenants.getByTenantId(TENANT_ID);
    expect(projection?.provenance).toBe("legacy_existing"); // real, committed side effect despite the other sub-task failing
  });

  it("both sub-tasks fail -> outcome is 'failed', both errors visible, nothing falsely reported as succeeded", async () => {
    const unreachableFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    vi.spyOn(ledger, "listOperations").mockRejectedValueOnce(new Error("governance db unavailable"));

    const result = await reconcileTenant(baseDeps(unreachableFetch), { idempotencyKey: "recheck-both-fail", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.outcome).toBe("failed");
    expect(result.projectionError).toContain("Could not reach Infrakinetic's management API");
    expect(result.stuckOperationsError).toContain("governance db unavailable");
    expect(result.projection).toEqual({ created: false, observedRefreshed: false });
    expect(result.resolvedOperations).toEqual([]);
    expect(result.remainingDrift).toEqual([]);
  });

  it("both sub-tasks succeed -> outcome is 'complete', no error fields set", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active" });

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-both-succeed", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.outcome).toBe("complete");
    expect(result.projectionError).toBeUndefined();
    expect(result.stuckOperationsError).toBeUndefined();
  });

  it("no existing projection: creates one via getOrCreateLegacyExisting, recorded as a completed R1 ledger operation", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active" });
    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-1", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.projection).toEqual({ created: true, observedRefreshed: false });
    const projection = await commissionedTenants.getByTenantId(TENANT_ID);
    expect(projection?.provenance).toBe("legacy_existing");

    const ops = await client.query("SELECT * FROM governance.management_operations WHERE requested_action = 'tenant.projection.reconcile'");
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0].status).toBe("completed");
    expect(ops.rows[0].risk_class).toBe("R1");
  });

  it("existing projection, owner state changed: refreshes via refreshObservedState, no lifecycle transition, recorded as its own ledger operation", async () => {
    const created = await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "suspended" });

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-2", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.projection).toEqual({ created: false, observedRefreshed: true });
    const refreshed = await commissionedTenants.getByProjectionId(created.projectionId);
    expect(refreshed.lastObservedPlatformAccessState).toBe("suspended");
    expect(refreshed.lifecycleState).toBe("active"); // no lifecycle transition performed
  });

  it("idempotent no-op: unchanged projection writes no new ledger entry", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active" });

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-3", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.projection).toEqual({ created: false, observedRefreshed: false });
    expect(result.resolvedOperations).toEqual([]);
    expect(result.remainingDrift).toEqual([]);
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
  });

  it("resolves a transport-ambiguous tenant-lifecycle operation from the owner receipt, without ever calling the mutation route", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const stuck = await seedStuckOperation({ idempotencyKey: "lifecycle-key-1", requestedAction: "tenant.suspend" }, { stage: "mutation-call", message: "network blip" });
    const { fetchImpl, calls } = buildFakeInfrakinetic({ platformAccessState: "active", lifecycleReceipts: { "lifecycle-key-1": "completed" } });

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-4", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.resolvedOperations).toEqual([{ operationId: stuck.operationId, requestedAction: "tenant.suspend", from: "partially_completed", to: "completed", stage: "mutation-call" }]);
    const final = await ledger.getOperation(stuck.operationId);
    expect(final.status).toBe("completed");
    expect(calls.some((c) => c.path.includes("/suspend"))).toBe(false); // never resent the original mutation
  });

  it("resolves a transport-ambiguous entitlement operation from the owner receipt", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const stuck = await seedStuckOperation(
      { idempotencyKey: "entitlement-key-1", requestedAction: "tenant.engine.entitlement.set", targetEngine: "module_ai", targetResourceType: undefined, targetResourceId: undefined },
      { stage: "mutation-call", message: "network blip" },
    );
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active", entitlementReceipts: { "entitlement-key-1": "completed" } });

    await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-5", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    const final = await ledger.getOperation(stuck.operationId);
    expect(final.status).toBe("completed");
  });

  it("owner receipt confirms the command never completed -> resolves the stuck operation to failed", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const stuck = await seedStuckOperation({ idempotencyKey: "lifecycle-key-2", requestedAction: "tenant.suspend" }, { stage: "mutation-call" });
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active", lifecycleReceipts: { "lifecycle-key-2": "failed" } });

    await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-6", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    const final = await ledger.getOperation(stuck.operationId);
    expect(final.status).toBe("failed");
  });

  it("no receipt found at all -> resolves the stuck operation to failed (never actually dispatched)", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const stuck = await seedStuckOperation({ idempotencyKey: "lifecycle-key-missing", requestedAction: "tenant.suspend" }, { stage: "mutation-call" });
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active" });

    await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-7", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    const final = await ledger.getOperation(stuck.operationId);
    expect(final.status).toBe("failed");
  });

  // Regression test for a real bug caught during re-audit: a transient
  // failure reading the receipt (500, unparseable body) is NOT the same
  // signal as a confirmed 404, and must never be resolved to `failed` —
  // doing so would let an operator retry a mutation that may have actually
  // succeeded on the owner side.
  it("receipt read fails with a transient error (not 404) -> left unresolved, never falsely marked failed", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const stuck = await seedStuckOperation({ idempotencyKey: "lifecycle-key-error", requestedAction: "tenant.suspend" }, { stage: "mutation-call" });
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active", receiptServerErrorKeys: ["lifecycle-key-error"] });

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-error", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.resolvedOperations).toEqual([]);
    expect(result.remainingDrift).toEqual([{
      operationId: stuck.operationId,
      requestedAction: "tenant.suspend",
      class: "transport_ambiguous",
      note: expect.stringContaining("could not read the owner-side receipt"),
    }]);
    const final = await ledger.getOperation(stuck.operationId);
    expect(final.status).toBe("partially_completed"); // untouched — not falsely resolved
  });

  it("owner receipt still in flight -> surfaced as remaining drift, not resolved", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const stuck = await seedStuckOperation({ idempotencyKey: "lifecycle-key-3", requestedAction: "tenant.suspend" }, { stage: "mutation-call" });
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active", lifecycleReceipts: { "lifecycle-key-3": "executing" } });

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-8", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.resolvedOperations).toEqual([]);
    expect(result.remainingDrift).toHaveLength(1);
    expect(result.remainingDrift[0].operationId).toBe(stuck.operationId);
    const final = await ledger.getOperation(stuck.operationId);
    expect(final.status).toBe("partially_completed"); // untouched
  });

  // platform.engine-state.set is never itself tenant-scoped in production
  // (targetTenantId is always null — see engineStateOperation.ts), so it can
  // never actually surface through this per-tenant sweep; that command
  // family's lack of a receipt is instead visible via listDrift()'s
  // platform-wide read (see reconciliationQuery.test.ts). This test uses a
  // synthetic tenant-scoped requestedAction with no receipt reader purely
  // to exercise resolveStuckOperation()'s defensive fallback in isolation —
  // the same branch any future receipt-less tenant-scoped command would hit.
  it("a stuck operation whose command family has no durable receipt is surfaced, not resolved, no crash", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const stuck = await seedStuckOperation({ idempotencyKey: "no-receipt-key-1", requestedAction: "some.future.command", targetResourceType: undefined, targetResourceId: undefined, targetEngine: "module_ai" }, { stage: "mutation-call" });
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active" });

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-9", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.resolvedOperations).toEqual([]);
    expect(result.remainingDrift).toEqual([{
      operationId: stuck.operationId,
      requestedAction: "some.future.command",
      class: "transport_ambiguous",
      note: expect.stringContaining("no durable owner-side receipt"),
    }]);
  });

  it("an effective-mismatch stuck operation is surfaced only, never auto-repaired", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const stuck = await seedStuckOperation({ idempotencyKey: "mismatch-key-1", requestedAction: "tenant.engine.entitlement.set", targetEngine: "module_ai", targetResourceType: undefined, targetResourceId: undefined }, { stage: "effective-mismatch", expected: true, observed: false });
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active" });

    const result = await reconcileTenant(baseDeps(fetchImpl), { idempotencyKey: "recheck-10", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.remainingDrift).toEqual([{ operationId: stuck.operationId, requestedAction: "tenant.engine.entitlement.set", class: "effective-mismatch", note: expect.stringContaining("surfaced only") }]);
    const final = await ledger.getOperation(stuck.operationId);
    expect(final.status).toBe("partially_completed");
  });
});
