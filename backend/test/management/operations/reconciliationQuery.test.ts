import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import { listDrift, type DriftQueryDeps } from "../../../src/management/operations/reconciliationQuery.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { CreateManagementOperationParams } from "../../../src/management/operations/managementOperationLedger.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATOR_PARAMS = {
  operatorId: OPERATOR_ID,
  operatorSessionId: SESSION_ID,
  operatorRoles: ["platform_operator"],
  operatorGrantedScopes: ["tenants.read"],
};

const CUSTOMER_TENANT_A = "aaaaaaaa-0000-4aaa-8aaa-000000000001"; // has a commissioned_tenants row
const CUSTOMER_TENANT_B = "bbbbbbbb-0000-4bbb-8bbb-000000000002"; // registry-only, no projection
const PLATFORM_TENANT = "cccccccc-0000-4ccc-8ccc-000000000003"; // tenant_kind = platform, also no projection

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

interface FakeRegistryEntry {
  id: string;
  name: string;
  slug: string;
  tenant_kind: "customer" | "platform";
  plan: string;
}

const REGISTRY: FakeRegistryEntry[] = [
  { id: CUSTOMER_TENANT_A, name: "Acme", slug: "acme", tenant_kind: "customer", plan: "starter" },
  { id: CUSTOMER_TENANT_B, name: "Beta Co", slug: "beta-co", tenant_kind: "customer", plan: "pro" },
  { id: PLATFORM_TENANT, name: "Polynovea Internal", slug: "polynovea-internal", tenant_kind: "platform", plan: "internal" },
];

function fullRegistryEntry(entry: FakeRegistryEntry) {
  return {
    ...entry,
    status: "active",
    trial_ends_at: null,
    industry: null,
    country: "IN",
    timezone: "Asia/Kolkata",
    seat_limit: null,
    storage_limit_mb: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function buildFakeInfrakinetic(options: { fail?: boolean } = {}) {
  const fetchImpl = (async (input: string | URL) => {
    if (options.fail) throw new Error("simulated registry failure");
    const url = new URL(String(input));
    if (url.pathname === "/management/v1/tenants") {
      return {
        status: 200,
        json: async () => ({ tenants: REGISTRY.map(fullRegistryEntry), observedAt: "2026-09-19T00:00:00.000Z", source: "infrakinetic-live", freshness: "live" }),
      } as Response;
    }
    const detailMatch = url.pathname.match(/^\/management\/v1\/tenants\/([^/]+)$/);
    if (detailMatch) {
      const identifier = decodeURIComponent(detailMatch[1]);
      const found = REGISTRY.find((e) => e.id === identifier || e.slug === identifier);
      if (!found) return { status: 404, json: async () => ({ error: "UNKNOWN_TENANT" }) } as Response;
      return {
        status: 200,
        json: async () => ({ tenant: fullRegistryEntry(found), observedAt: "2026-09-19T00:00:00.000Z", source: "infrakinetic-live", freshness: "live" }),
      } as Response;
    }
    return { status: 404, json: async () => ({ error: "NOT_FOUND" }) } as Response;
  }) as typeof fetch;
  return fetchImpl;
}

describe("management/operations/reconciliationQuery", () => {
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

  function baseDeps(fetchImpl: typeof fetch): DriftQueryDeps {
    return { ledger, commissionedTenants, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake-infra.test", fetchImpl };
  }

  function opParams(overrides: Partial<CreateManagementOperationParams> = {}): CreateManagementOperationParams {
    return {
      idempotencyKey: `op-${Math.random()}`,
      operatorId: OPERATOR_ID,
      operatorSessionId: SESSION_ID,
      requestedAction: "platform.engine-state.set",
      targetTenantId: null,
      targetEngine: "module_ai",
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

  it("projectionMissing: flags a registry customer tenant with no commissioned_tenants row, excludes the platform-kind tenant", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: CUSTOMER_TENANT_A, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });

    const result = await listDrift(baseDeps(buildFakeInfrakinetic()), OPERATOR_PARAMS);

    expect(result.projectionMissing).toEqual([{ tenantId: CUSTOMER_TENANT_B, name: "Beta Co", platformAccessState: undefined }]);
  });

  it("classifies a stuck mutation-call operation as transport_ambiguous", async () => {
    await seedStuckOperation({ idempotencyKey: "stuck-1" }, { stage: "mutation-call", message: "boom" });

    const result = await listDrift(baseDeps(buildFakeInfrakinetic()), OPERATOR_PARAMS);

    expect(result.stuckOperations).toHaveLength(1);
    expect(result.stuckOperations[0]).toMatchObject({ class: "transport_ambiguous", stage: "mutation-call" });
  });

  it("classifies a stuck effective-mismatch operation as effective_mismatch, carrying expected/observed", async () => {
    await seedStuckOperation({ idempotencyKey: "stuck-2" }, { stage: "effective-mismatch", expected: "disabled", observed: "operational" });

    const result = await listDrift(baseDeps(buildFakeInfrakinetic()), OPERATOR_PARAMS);

    expect(result.stuckOperations[0]).toMatchObject({ class: "effective_mismatch", expected: "disabled", observed: "operational" });
  });

  it("classifies effective-observation and commission-partial stages distinctly", async () => {
    await seedStuckOperation({ idempotencyKey: "stuck-3" }, { stage: "effective-observation", message: "boom" });
    await seedStuckOperation({ idempotencyKey: "stuck-4", requestedAction: "tenant.commission", targetResourceType: "commission_request", targetResourceId: "req-1", targetEngine: undefined }, { stage: "commission-partial", warnings: [] });

    const result = await listDrift(baseDeps(buildFakeInfrakinetic()), OPERATOR_PARAMS);

    const classes = result.stuckOperations.map((o) => o.class).sort();
    expect(classes).toEqual(["effective_observation_failed", "owner_partial_success"]);
  });

  it("stuckOperations narrows to one tenant when tenantId is given", async () => {
    await seedStuckOperation({ idempotencyKey: "stuck-a", targetTenantId: CUSTOMER_TENANT_A }, { stage: "mutation-call" });
    await seedStuckOperation({ idempotencyKey: "stuck-b", targetTenantId: CUSTOMER_TENANT_B }, { stage: "mutation-call" });

    const result = await listDrift(baseDeps(buildFakeInfrakinetic()), { ...OPERATOR_PARAMS, tenantId: CUSTOMER_TENANT_A });

    expect(result.stuckOperations).toHaveLength(1);
    expect(result.stuckOperations[0].targetTenantId).toBe(CUSTOMER_TENANT_A);
  });

  it("desiredProvisionedMismatch: flags a desired field that differs from the fresh registry read", async () => {
    const created = await commissionedTenants.createForCommissionRequest({
      commissionRequestId: "dddddddd-0000-4ddd-8ddd-000000000001", desiredName: "Acme", desiredPlan: "pro", accountType: "live", responsibleOperatorId: OPERATOR_ID,
    });
    await commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "approved" });
    await commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "provisioning", tenantId: CUSTOMER_TENANT_A });

    const result = await listDrift(baseDeps(buildFakeInfrakinetic()), OPERATOR_PARAMS);

    expect(result.desiredProvisionedMismatch).toEqual([{ tenantId: CUSTOMER_TENANT_A, field: "plan", desired: "pro", provisioned: "starter" }]);
  });

  it("staleObservations: flags a projection whose last_observed_at exceeds the threshold", async () => {
    const created = await commissionedTenants.createLegacyExisting({ tenantId: CUSTOMER_TENANT_A, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    const oldObservedAt = new Date(Date.now() - 999_999_000).toISOString();
    await commissionedTenants.refreshObservedState(created.projectionId, "active", oldObservedAt);

    const result = await listDrift(baseDeps(buildFakeInfrakinetic()), { ...OPERATOR_PARAMS, staleAfterSeconds: 60 });

    expect(result.staleObservations).toHaveLength(1);
    expect(result.staleObservations[0].tenantId).toBe(CUSTOMER_TENANT_A);
    expect(result.staleObservations[0].ageSeconds).toBeGreaterThanOrEqual(999_000);
  });

  it("registry unreachable: ledger-derived drift is still returned, registryUnavailable is set, projection classes are empty", async () => {
    await seedStuckOperation({ idempotencyKey: "stuck-5" }, { stage: "mutation-call" });

    const result = await listDrift(baseDeps(buildFakeInfrakinetic({ fail: true })), OPERATOR_PARAMS);

    expect(result.stuckOperations).toHaveLength(1);
    expect(result.projectionMissing).toEqual([]);
    expect(result.desiredProvisionedMismatch).toEqual([]);
    expect(result.registryUnavailable?.message).toBeTruthy();
  });
});
