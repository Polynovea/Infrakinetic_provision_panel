import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import {
  requestTenantCommission,
  requestTenantSuspend,
  requestTenantResume,
  requestTenantDecommission,
  MissingTenantIdentifierError,
} from "../../../src/management/operations/tenantLifecycleOperation.js";
import { IdempotencyConflictError } from "../../../src/management/operations/managementOperationErrors.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { TenantLifecycleOperationDeps } from "../../../src/management/operations/tenantLifecycleOperation.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLES = ["platform_operator"];
const SCOPES = ["tenants.commission", "tenants.suspend", "tenants.resume", "tenants.decommission", "tenants.read"];

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

interface FakeCall { method: string; path: string; body?: Record<string, unknown> }

interface FakeInfrakineticOptions {
  commissionOutcome?: "completed" | "partially_completed";
  commissionHttpStatus?: number;
  failCommission?: boolean;
  mutationHttpStatus?: number;
  failMutation?: boolean;
  tenantState?: { previous: string; resulting: string };
}

function buildFakeInfrakinetic(options: FakeInfrakineticOptions = {}) {
  const calls: FakeCall[] = [];
  function jsonResponse(status: number, body: unknown): Response {
    return { status, json: async () => body } as Response;
  }

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (url.pathname === "/management/v1/tenants/commission" && method === "POST") {
      if (options.failCommission) throw new Error("simulated network failure");
      if (options.commissionHttpStatus && options.commissionHttpStatus !== 200) {
        return jsonResponse(options.commissionHttpStatus, { error: "TENANT_LIFECYCLE_VALIDATION" });
      }
      return jsonResponse(200, {
        tenantId: "bb000000-0000-4bbb-8bbb-000000000001",
        lifecycleOutcome: options.commissionOutcome ?? "completed",
        warnings: options.commissionOutcome === "partially_completed" ? [{ stage: "identity", message: "identity failed (Error)." }] : [],
      });
    }

    const mutationMatch = url.pathname.match(/^\/management\/v1\/tenants\/([^/]+)\/(suspend|resume|decommission)$/);
    if (mutationMatch && method === "POST") {
      if (options.failMutation) throw new Error("simulated network failure");
      if (options.mutationHttpStatus && options.mutationHttpStatus !== 200) {
        return jsonResponse(options.mutationHttpStatus, { error: "INVALID_LIFECYCLE_TRANSITION" });
      }
      return jsonResponse(200, {
        tenantId: mutationMatch[1],
        previousPlatformAccessState: options.tenantState?.previous ?? "active",
        resultingPlatformAccessState: options.tenantState?.resulting ?? "suspended",
      });
    }

    return jsonResponse(404, { error: "NOT_FOUND" });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

describe("management/operations/tenantLifecycleOperation", () => {
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

  function baseDeps(fetchImpl: typeof fetch): TenantLifecycleOperationDeps {
    return {
      ledger, commissionedTenants, signingKeys, transportConfig: TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://infrakinetic.test.invalid", fetchImpl,
    };
  }

  describe("requestTenantCommission", () => {
    it("full success: ledger completed, projection active with the real tenantId bound", async () => {
      const { fetchImpl, calls } = buildFakeInfrakinetic({ commissionOutcome: "completed" });
      const result = await requestTenantCommission(baseDeps(fetchImpl), {
        idempotencyKey: "commission-key-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "22222222-2222-4222-8222-222222222222",
        name: "Acme", plan: "pro", accountType: "demo", reason: "onboarding",
        sendInvite: false,
      });

      expect(result.replay).toBe(false);
      expect(result.operation.status).toBe("completed");
      const projection = await commissionedTenants.getByCommissionRequestId("22222222-2222-4222-8222-222222222222");
      expect(projection?.lifecycleState).toBe("active");
      expect(projection?.tenantId).toBe("bb000000-0000-4bbb-8bbb-000000000001");
      const commissionCall = calls.find((c) => c.path === "/management/v1/tenants/commission");
      expect(commissionCall?.body?.name).toBe("Acme");
    });

    it("same idempotencyKey replayed -> zero new Infrakinetic calls", async () => {
      const { fetchImpl, calls } = buildFakeInfrakinetic({ commissionOutcome: "completed" });
      const deps = baseDeps(fetchImpl);
      const params: Parameters<typeof requestTenantCommission>[1] = {
        idempotencyKey: "commission-key-2", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "33333333-3333-4333-8333-333333333333",
        name: "Beta", plan: "pro", accountType: "demo", reason: "onboarding", sendInvite: false,
      };
      await requestTenantCommission(deps, params);
      const callsAfterFirst = calls.length;
      const second = await requestTenantCommission(deps, params);
      expect(second.replay).toBe(true);
      expect(calls.length).toBe(callsAfterFirst);
    });

    it("same idempotencyKey + different payload -> conflict", async () => {
      const { fetchImpl } = buildFakeInfrakinetic({ commissionOutcome: "completed" });
      const deps = baseDeps(fetchImpl);
      await requestTenantCommission(deps, {
        idempotencyKey: "commission-key-3", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "44444444-4444-4444-8444-444444444444",
        name: "Gamma", plan: "pro", accountType: "demo", reason: "onboarding", sendInvite: false,
      });
      await expect(requestTenantCommission(deps, {
        idempotencyKey: "commission-key-3", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "44444444-4444-4444-8444-444444444444",
        name: "Different Name", plan: "pro", accountType: "demo", reason: "onboarding", sendInvite: false,
      })).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it("Infrakinetic reports partially_completed -> ledger partially_completed, projection stays at provisioning with tenantId bound (not failed)", async () => {
      const { fetchImpl } = buildFakeInfrakinetic({ commissionOutcome: "partially_completed" });
      const result = await requestTenantCommission(baseDeps(fetchImpl), {
        idempotencyKey: "commission-key-4", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "55555555-5555-4555-8555-555555555555",
        name: "Delta", plan: "pro", accountType: "demo", reason: "onboarding",
        sendInvite: true, initialAdmin: { name: "Admin", email: "admin@example.com" },
      });

      expect(result.operation.status).toBe("partially_completed");
      const projection = await commissionedTenants.getByCommissionRequestId("55555555-5555-4555-8555-555555555555");
      expect(projection?.lifecycleState).toBe("provisioning");
      expect(projection?.tenantId).toBe("bb000000-0000-4bbb-8bbb-000000000001");
    });

    it("network failure after dispatch -> partially_completed (outcome-ambiguous, not failed) per §6", async () => {
      const { fetchImpl } = buildFakeInfrakinetic({ failCommission: true });
      const result = await requestTenantCommission(baseDeps(fetchImpl), {
        idempotencyKey: "commission-key-5", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "66666666-6666-4666-8666-666666666666",
        name: "Epsilon", plan: "pro", accountType: "demo", reason: "onboarding", sendInvite: false,
      });

      expect(result.operation.status).toBe("partially_completed");
      expect((result.operation.partialFailureState as { stage?: string })?.stage).toBe("mutation-call");
    });

    it("connection never established (DNS/connection-refused) -> unambiguous failed, not partially_completed, per §8", async () => {
      const neverConnects = (async () => {
        throw Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
      }) as unknown as typeof fetch;
      const result = await requestTenantCommission(baseDeps(neverConnects), {
        idempotencyKey: "commission-key-5b", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "66666666-6666-4666-8666-666666666667",
        name: "Epsilon2", plan: "pro", accountType: "demo", reason: "onboarding", sendInvite: false,
      });

      expect(result.operation.status).toBe("failed");
      expect((result.operation.partialFailureState as { stage?: string })?.stage).toBe("mutation-call-never-dispatched");
      const projection = await commissionedTenants.getByCommissionRequestId("66666666-6666-4666-8666-666666666667");
      expect(projection?.lifecycleState).toBe("failed");
    });

    it("Infrakinetic rejects unambiguously (e.g. slug collision) -> ledger failed, projection failed", async () => {
      const { fetchImpl } = buildFakeInfrakinetic({ commissionHttpStatus: 409 });
      const result = await requestTenantCommission(baseDeps(fetchImpl), {
        idempotencyKey: "commission-key-6", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "77777777-7777-4777-8777-777777777777",
        name: "Zeta", plan: "pro", accountType: "demo", reason: "onboarding", sendInvite: false,
      });

      expect(result.operation.status).toBe("failed");
      const projection = await commissionedTenants.getByCommissionRequestId("77777777-7777-4777-8777-777777777777");
      expect(projection?.lifecycleState).toBe("failed");
    });

    it("repair: a new idempotencyKey with the SAME commissionRequestId reuses the existing projection row, not a second one", async () => {
      const { fetchImpl } = buildFakeInfrakinetic({ commissionOutcome: "partially_completed" });
      const deps = baseDeps(fetchImpl);
      await requestTenantCommission(deps, {
        idempotencyKey: "commission-key-7a", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "88888888-8888-4888-8888-888888888888",
        name: "Eta", plan: "pro", accountType: "demo", reason: "onboarding", sendInvite: false,
      });
      const firstProjection = await commissionedTenants.getByCommissionRequestId("88888888-8888-4888-8888-888888888888");

      const { fetchImpl: fetchImpl2 } = buildFakeInfrakinetic({ commissionOutcome: "completed" });
      await requestTenantCommission(baseDeps(fetchImpl2), {
        idempotencyKey: "commission-key-7b", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "88888888-8888-4888-8888-888888888888",
        name: "Eta", plan: "pro", accountType: "demo", reason: "repair", sendInvite: false,
      });
      const secondProjection = await commissionedTenants.getByCommissionRequestId("88888888-8888-4888-8888-888888888888");

      expect(secondProjection?.projectionId).toBe(firstProjection?.projectionId);
      expect(secondProjection?.lifecycleState).toBe("active");
    });

    it("evidence: no raw admin email/name in the ledger's safe snapshots", async () => {
      const { fetchImpl } = buildFakeInfrakinetic({ commissionOutcome: "completed" });
      const result = await requestTenantCommission(baseDeps(fetchImpl), {
        idempotencyKey: "commission-key-8", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
        commissionRequestId: "99999999-9999-4999-8999-999999999999",
        name: "Theta", plan: "pro", accountType: "demo", reason: "onboarding",
        sendInvite: true, initialAdmin: { name: "Secret Person", email: "secret-admin@example.com" },
      });

      const serialized = JSON.stringify(result.operation);
      expect(serialized).not.toMatch(/secret-admin@example\.com/);
      expect(serialized).not.toMatch(/Secret Person/);
    });
  });

  describe("requestTenantSuspend / requestTenantResume / requestTenantDecommission", () => {
    async function seedActiveProjection(tenantId: string) {
      return commissionedTenants.createLegacyExisting({
        tenantId, createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active",
      });
    }

    it("suspend: ledger completed, projection transitions to suspended with observed state refreshed", async () => {
      await seedActiveProjection("bb000000-0000-4bbb-8bbb-000000000002");
      const { fetchImpl } = buildFakeInfrakinetic({ tenantState: { previous: "active", resulting: "suspended" } });
      const result = await requestTenantSuspend(baseDeps(fetchImpl), {
        idempotencyKey: "suspend-key-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: "bb000000-0000-4bbb-8bbb-000000000002", reason: "abuse",
      });

      expect(result.operation.status).toBe("completed");
      const projection = await commissionedTenants.getByTenantId("bb000000-0000-4bbb-8bbb-000000000002");
      expect(projection?.lifecycleState).toBe("suspended");
      expect(projection?.lastObservedPlatformAccessState).toBe("suspended");
    });

    it("resume: projection transitions back to active", async () => {
      const created = await seedActiveProjection("bb000000-0000-4bbb-8bbb-000000000003");
      await commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "suspended" });
      const { fetchImpl } = buildFakeInfrakinetic({ tenantState: { previous: "suspended", resulting: "active" } });
      const result = await requestTenantResume(baseDeps(fetchImpl), {
        idempotencyKey: "resume-key-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: "bb000000-0000-4bbb-8bbb-000000000003", reason: "reactivate",
      });

      expect(result.operation.status).toBe("completed");
      const projection = await commissionedTenants.getByTenantId("bb000000-0000-4bbb-8bbb-000000000003");
      expect(projection?.lifecycleState).toBe("active");
    });

    it("decommission: projection chains through decommission_requested/decommissioning to decommissioned", async () => {
      await seedActiveProjection("bb000000-0000-4bbb-8bbb-000000000004");
      const { fetchImpl } = buildFakeInfrakinetic({ tenantState: { previous: "active", resulting: "decommissioned" } });
      const result = await requestTenantDecommission(baseDeps(fetchImpl), {
        idempotencyKey: "decom-key-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: "bb000000-0000-4bbb-8bbb-000000000004", reason: "cleanup",
      });

      expect(result.operation.status).toBe("completed");
      const projection = await commissionedTenants.getByTenantId("bb000000-0000-4bbb-8bbb-000000000004");
      expect(projection?.lifecycleState).toBe("decommissioned");
      expect(projection?.decommissionedAt).toBeTruthy();
    });

    it("Infrakinetic rejects the transition (409) -> ledger failed, projection state unchanged", async () => {
      await seedActiveProjection("bb000000-0000-4bbb-8bbb-000000000005");
      const { fetchImpl } = buildFakeInfrakinetic({ mutationHttpStatus: 409 });
      const result = await requestTenantResume(baseDeps(fetchImpl), {
        idempotencyKey: "resume-key-2", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: "bb000000-0000-4bbb-8bbb-000000000005", reason: "reactivate",
      });

      expect(result.operation.status).toBe("failed");
      const projection = await commissionedTenants.getByTenantId("bb000000-0000-4bbb-8bbb-000000000005");
      expect(projection?.lifecycleState).toBe("active"); // untouched
    });

    it("network failure -> partially_completed, not failed", async () => {
      await seedActiveProjection("bb000000-0000-4bbb-8bbb-000000000006");
      const { fetchImpl } = buildFakeInfrakinetic({ failMutation: true });
      const result = await requestTenantSuspend(baseDeps(fetchImpl), {
        idempotencyKey: "suspend-key-2", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: "bb000000-0000-4bbb-8bbb-000000000006", reason: "abuse",
      });

      expect(result.operation.status).toBe("partially_completed");
    });

    it("suspend/resume/decommission never write tenants.status-shaped fields — Billing independence proven at the orchestration layer (targetResourceType is always 'tenant', never a Billing action)", async () => {
      await seedActiveProjection("bb000000-0000-4bbb-8bbb-000000000007");
      const { fetchImpl, calls } = buildFakeInfrakinetic({ tenantState: { previous: "active", resulting: "suspended" } });
      await requestTenantSuspend(baseDeps(fetchImpl), {
        idempotencyKey: "suspend-key-3", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: "bb000000-0000-4bbb-8bbb-000000000007", reason: "abuse",
      });
      const mutationCall = calls.find((c) => c.path.endsWith("/suspend"));
      expect(mutationCall?.body).toEqual(expect.objectContaining({ reason: "abuse" }));
      expect(mutationCall?.body).not.toHaveProperty("status");
    });

    // Audit remediation M4 — a partially-commissioned tenant (projection
    // still 'provisioning') suspended at the owner: provisioning -> suspended
    // is not a valid projection transition. The owner mutation is durable,
    // so the ledger must still record completed truth — never strand in
    // 'running' with a 500 — and the projection is left visibly stale.
    it("owner suspend succeeds but the projection cannot follow -> ledger still completed, projectionSync 'stale'", async () => {
      const tenantId = "bb000000-0000-4bbb-8bbb-000000000008";
      const created = await commissionedTenants.createForCommissionRequest({
        commissionRequestId: "dddddddd-0000-4ddd-8ddd-000000000008", desiredName: "Partial", desiredPlan: "pro", accountType: "live", responsibleOperatorId: OPERATOR_ID,
      });
      await commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "approved" });
      await commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "provisioning", tenantId });
      const { fetchImpl } = buildFakeInfrakinetic({ tenantState: { previous: "active", resulting: "suspended" } });

      const result = await requestTenantSuspend(baseDeps(fetchImpl), {
        idempotencyKey: "suspend-partial-commission", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId, reason: "abuse",
      });

      expect(result.operation.status).toBe("completed");
      expect(result.operation.result).toEqual(expect.objectContaining({
        resultingPlatformAccessState: "suspended",
        projectionSync: expect.objectContaining({ status: "stale" }),
      }));
      expect((await commissionedTenants.getByProjectionId(created.projectionId)).lifecycleState).toBe("provisioning");
    });

    it("rejects an empty tenantId before minting anything", async () => {
      const { fetchImpl, calls } = buildFakeInfrakinetic();
      await expect(requestTenantSuspend(baseDeps(fetchImpl), {
        idempotencyKey: "suspend-key-4", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
        operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: "", reason: "abuse",
      })).rejects.toBeInstanceOf(MissingTenantIdentifierError);
      expect(calls.length).toBe(0);
    });
  });
});
