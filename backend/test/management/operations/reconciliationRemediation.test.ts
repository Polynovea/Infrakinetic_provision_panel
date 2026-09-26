import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger, type CreateManagementOperationParams } from "../../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import {
  reconcileTenant,
  reconcileCommissionRequest,
  type ReconciliationOperationDeps,
} from "../../../src/management/operations/reconciliationOperation.js";
import { listDrift } from "../../../src/management/operations/reconciliationQuery.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";

// Audit remediation M3 / L4 / H3 (PlatformRectification/Phase1A.1-1A.13_
// Independent_Audit_2026-09-25.md) — the reconciliation cases the original
// 1A.10 suites never exercised: operations stranded outside
// 'partially_completed', commission operations (addressed by commission
// request, not tenant), identity/credential receipt families, a proxy 404,
// and desired-vs-observed lifecycle drift.

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_ID = "bbbbbbbb-0000-4bbb-8bbb-000000000001";
const COMMISSION_REQUEST_ID = "dddddddd-0000-4ddd-8ddd-000000000001";
const LONG_AGO = "2026-01-01T00:00:00.000Z";

const OPERATOR_PARAMS = {
  operatorId: OPERATOR_ID,
  operatorSessionId: SESSION_ID,
  operatorRoles: ["platform_operator"],
  operatorGrantedScopes: ["tenants.read", "identity.read", "credentials.metadata.read"],
};

type ReceiptStatus = "accepted" | "executing" | "partially_completed" | "completed" | "failed";
interface FakeReceipt { status: ReceiptStatus; tenantId?: string }

interface FakeOptions {
  platformAccessState?: "active" | "suspended" | "decommissioned";
  /** keyed by receipt path segment, then idempotency key */
  receipts?: Record<string, Record<string, FakeReceipt>>;
  /** receipt reads that hit a 404 WITHOUT the owner's UNKNOWN_* code (a proxy/misroute) */
  proxy404Keys?: string[];
  /** receipt reads the owner refuses with its L10 target-binding 409 */
  bindingMismatchKeys?: string[];
}

const UNKNOWN_CODES: Record<string, string> = {
  "tenant-lifecycle-commands": "UNKNOWN_LIFECYCLE_COMMAND",
  "tenant-engine-entitlement-commands": "UNKNOWN_ENTITLEMENT_COMMAND",
  "identity-admin-commands": "UNKNOWN_IDENTITY_ADMIN_COMMAND",
  "credential-admin-commands": "UNKNOWN_CREDENTIAL_ADMIN_COMMAND",
};

function decodeAssertionClaims(init?: RequestInit): Record<string, unknown> {
  const headers = new Headers(init?.headers);
  const token = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const payload = token.split(".")[1];
  return payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : {};
}

function buildFakeInfrakinetic(options: FakeOptions = {}) {
  const calls: string[] = [];
  /** L10 — the signed target claims each call carried, by path */
  const claims: Record<string, Record<string, unknown>> = {};
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    claims[url.pathname] = decodeAssertionClaims(init);
    if (url.pathname === `/management/v1/tenants/${TENANT_ID}`) {
      return {
        status: 200,
        json: async () => ({
          tenant: {
            id: TENANT_ID, name: "Acme", slug: "acme", tenant_kind: "customer", plan: "pro", status: "active",
            platform_access_state: options.platformAccessState ?? "active",
            trial_ends_at: null, industry: null, country: "IN", timezone: "Asia/Kolkata",
            seat_limit: null, storage_limit_mb: null,
            created_at: LONG_AGO, updated_at: LONG_AGO,
          },
          observedAt: "2026-09-25T00:00:00.000Z", source: "infrakinetic-live", freshness: "live",
        }),
      } as Response;
    }
    const receiptMatch = url.pathname.match(/^\/management\/v1\/([a-z-]+-commands)\/([^/]+)$/);
    if (receiptMatch) {
      const [, segment, rawKey] = receiptMatch;
      const key = decodeURIComponent(rawKey);
      if (options.proxy404Keys?.includes(key)) return { status: 404, json: async () => ({ error: "NOT_FOUND" }) } as Response;
      if (options.bindingMismatchKeys?.includes(key)) {
        return { status: 409, json: async () => ({ error: "MANAGEMENT_TARGET_RESOURCE_MISMATCH" }) } as Response;
      }
      const receipt = options.receipts?.[segment]?.[key];
      if (!receipt) return { status: 404, json: async () => ({ error: UNKNOWN_CODES[segment] }) } as Response;
      return { status: 200, json: async () => ({ command: { idempotencyKey: key, status: receipt.status, tenantId: receipt.tenantId ?? null } }) } as Response;
    }
    return { status: 404, json: async () => ({ error: "NOT_FOUND" }) } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls, claims };
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

describe("reconciliation — audit remediation (M3 / L4 / H3)", () => {
  let client: DbClient;
  let ledger: ManagementOperationLedger;
  let commissionedTenants: CommissionedTenantsRepository;
  let signingKeys: ManagementSigningKeySet;

  beforeEach(async () => {
    client = buildMigratedPgMemClient().client;
    ledger = new ManagementOperationLedger(client);
    commissionedTenants = new CommissionedTenantsRepository(client);
    await client.query(
      `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
       VALUES ($1, 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())`,
      [OPERATOR_ID],
    );
    signingKeys = await buildFixtureSigningKeys();
  });

  function deps(fetchImpl: typeof fetch): ReconciliationOperationDeps {
    return { ledger, commissionedTenants, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl: "http://fake-infra.test", fetchImpl };
  }

  function opParams(overrides: Partial<CreateManagementOperationParams>): CreateManagementOperationParams {
    return {
      idempotencyKey: `op-${Math.random()}`,
      operatorId: OPERATOR_ID,
      operatorSessionId: SESSION_ID,
      requestedAction: "tenant.suspend",
      targetTenantId: TENANT_ID,
      targetResourceType: "tenant",
      targetResourceId: TENANT_ID,
      reason: "fixture",
      riskClass: "R2",
      payload: {},
      contractVersion: "platform-management.operation.v1",
      correlationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ...overrides,
    };
  }

  async function seedAt(status: "accepted" | "running" | "partially_completed", overrides: Partial<CreateManagementOperationParams>, opts: { stranded?: boolean; stage?: string } = {}) {
    const { operation } = await ledger.createOrReplayOperation(opParams(overrides));
    await ledger.transitionOperation(operation.operationId, { toStatus: "accepted" });
    if (status !== "accepted") await ledger.transitionOperation(operation.operationId, { toStatus: "running" });
    if (status === "partially_completed") {
      await ledger.transitionOperation(operation.operationId, { toStatus: "partially_completed", partialFailureState: { stage: opts.stage ?? "mutation-call" } });
    }
    if (opts.stranded !== false) {
      await client.query(`UPDATE governance.management_operations SET updated_at = $2 WHERE operation_id = $1`, [operation.operationId, LONG_AGO]);
    }
    return ledger.getOperation(operation.operationId);
  }

  async function provisioningProjection(tenantId?: string) {
    const created = await commissionedTenants.createForCommissionRequest({
      commissionRequestId: COMMISSION_REQUEST_ID, desiredName: "Acme", desiredSlug: "acme", desiredPlan: "pro", accountType: "live", responsibleOperatorId: OPERATOR_ID,
    });
    await commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "approved" });
    return commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "provisioning", tenantId });
  }

  const COMMISSION_OP = {
    requestedAction: "tenant.commission",
    targetTenantId: null,
    targetResourceType: "commission_request",
    targetResourceId: COMMISSION_REQUEST_ID,
  } as const;

  it("an op stranded in 'accepted' provably never dispatched: resolved to failed WITHOUT any owner read", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: LONG_AGO, observedPlatformAccessState: "active" });
    const stuck = await seedAt("accepted", { idempotencyKey: "stranded-accepted" });
    const { fetchImpl, calls } = buildFakeInfrakinetic();

    const result = await reconcileTenant(deps(fetchImpl), { idempotencyKey: "recheck-a", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.resolvedOperations).toEqual([{ operationId: stuck.operationId, requestedAction: "tenant.suspend", from: "accepted", to: "failed", stage: "stranded-before-dispatch" }]);
    expect(calls.some((p) => p.includes("-commands/"))).toBe(false);
  });

  it("a RECENT running op is in flight, not stranded — neither surfaced nor touched", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: LONG_AGO, observedPlatformAccessState: "active" });
    const inFlight = await seedAt("running", { idempotencyKey: "in-flight" }, { stranded: false });
    const { fetchImpl } = buildFakeInfrakinetic({ receipts: { "tenant-lifecycle-commands": { "in-flight": { status: "completed" } } } });

    const result = await reconcileTenant(deps(fetchImpl), { idempotencyKey: "recheck-b", tenantId: TENANT_ID, ...OPERATOR_PARAMS });
    const drift = await listDrift(deps(fetchImpl), { tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.resolvedOperations).toEqual([]);
    expect(drift.stuckOperations).toEqual([]);
    expect((await ledger.getOperation(inFlight.operationId)).status).toBe("running");
  });

  it("a stranded 'running' op is surfaced as stranded_in_flight and resolved from its owner receipt", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: LONG_AGO, observedPlatformAccessState: "active" });
    const stuck = await seedAt("running", { idempotencyKey: "stranded-running" });
    const { fetchImpl, calls } = buildFakeInfrakinetic({ receipts: { "tenant-lifecycle-commands": { "stranded-running": { status: "completed" } } } });

    const drift = await listDrift(deps(fetchImpl), { tenantId: TENANT_ID, ...OPERATOR_PARAMS });
    expect(drift.stuckOperations).toEqual([expect.objectContaining({ operationId: stuck.operationId, class: "stranded_in_flight" })]);

    const result = await reconcileTenant(deps(fetchImpl), { idempotencyKey: "recheck-c", tenantId: TENANT_ID, ...OPERATOR_PARAMS });
    expect(result.resolvedOperations).toEqual([expect.objectContaining({ operationId: stuck.operationId, from: "running", to: "completed" })]);
    expect(calls.some((p) => p.endsWith("/suspend"))).toBe(false); // never resent
  });

  it("identity and credential ops are resolved from THEIR receipt families (1A.12/1A.13), not left for hand resolution", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: LONG_AGO, observedPlatformAccessState: "active" });
    const mfa = await seedAt("partially_completed", {
      idempotencyKey: "mfa-reset-key", requestedAction: "identity.mfa.reset", targetResourceType: "identity_user", targetResourceId: "user-1", riskClass: "R3",
    });
    const rotate = await seedAt("partially_completed", {
      idempotencyKey: "rotate-key", requestedAction: "credential.rotate", targetResourceType: "credential", targetResourceId: "cred-1", riskClass: "R3",
    });
    const { fetchImpl } = buildFakeInfrakinetic({
      receipts: {
        "identity-admin-commands": { "mfa-reset-key": { status: "completed" } },
        "credential-admin-commands": { "rotate-key": { status: "failed" } },
      },
    });

    const result = await reconcileTenant(deps(fetchImpl), { idempotencyKey: "recheck-d", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect((await ledger.getOperation(mfa.operationId)).status).toBe("completed");
    expect((await ledger.getOperation(rotate.operationId)).status).toBe("failed");
    expect(result.remainingDrift).toEqual([]);
  });

  it("an operator without the family's read scope gets an unknown outcome (surfaced), never a wrong resolution", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: LONG_AGO, observedPlatformAccessState: "active" });
    const rotate = await seedAt("partially_completed", {
      idempotencyKey: "rotate-noscope", requestedAction: "credential.rotate", targetResourceType: "credential", targetResourceId: "cred-1", riskClass: "R3",
    });
    const { fetchImpl } = buildFakeInfrakinetic();

    const result = await reconcileTenant(deps(fetchImpl), {
      idempotencyKey: "recheck-e", tenantId: TENANT_ID, ...OPERATOR_PARAMS, operatorGrantedScopes: ["tenants.read"],
    });

    expect(result.remainingDrift).toEqual([expect.objectContaining({ operationId: rotate.operationId, class: "transport_ambiguous" })]);
    expect((await ledger.getOperation(rotate.operationId)).status).toBe("partially_completed");
  });

  // L4 — a 404 is "confirmed never executed" only with the owner's own code.
  it("a proxy/mis-routed 404 without the owner's UNKNOWN_* code is NOT treated as never-executed", async () => {
    await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: LONG_AGO, observedPlatformAccessState: "active" });
    const stuck = await seedAt("partially_completed", { idempotencyKey: "proxied-key" });
    const { fetchImpl } = buildFakeInfrakinetic({ proxy404Keys: ["proxied-key"] });

    const result = await reconcileTenant(deps(fetchImpl), { idempotencyKey: "recheck-f", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.resolvedOperations).toEqual([]);
    expect(result.remainingDrift).toEqual([expect.objectContaining({ operationId: stuck.operationId, class: "transport_ambiguous" })]);
    expect((await ledger.getOperation(stuck.operationId)).status).toBe("partially_completed");
  });

  // M3 — commission ops carry targetTenantId null; the per-tenant sweep must still find them.
  it("the per-tenant sweep reaches this tenant's commission op and settles its projection from the receipt", async () => {
    const projection = await provisioningProjection(TENANT_ID);
    const stuck = await seedAt("partially_completed", { idempotencyKey: "commission-key", ...COMMISSION_OP });
    const { fetchImpl } = buildFakeInfrakinetic({ receipts: { "tenant-lifecycle-commands": { "commission-key": { status: "completed", tenantId: TENANT_ID } } } });

    const result = await reconcileTenant(deps(fetchImpl), { idempotencyKey: "recheck-g", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(result.resolvedOperations).toEqual([expect.objectContaining({ operationId: stuck.operationId, to: "completed" })]);
    expect((await commissionedTenants.getByProjectionId(projection.projectionId)).lifecycleState).toBe("active");
  });

  it("a commission ambiguous BEFORE any tenant id was known is reachable by commission request, and binds the tenant it learns", async () => {
    const projection = await provisioningProjection(undefined);
    const stuck = await seedAt("running", { idempotencyKey: "commission-unbound", ...COMMISSION_OP });
    const { fetchImpl } = buildFakeInfrakinetic({
      receipts: { "tenant-lifecycle-commands": { "commission-unbound": { status: "partially_completed", tenantId: TENANT_ID } } },
    });

    const result = await reconcileCommissionRequest(deps(fetchImpl), { idempotencyKey: "recheck-h", commissionRequestId: COMMISSION_REQUEST_ID, ...OPERATOR_PARAMS });

    expect(result.resolvedOperations).toEqual([expect.objectContaining({ operationId: stuck.operationId, from: "running", to: "partially_completed", stage: "commission-partial" })]);
    const after = await commissionedTenants.getByProjectionId(projection.projectionId);
    expect(after.tenantId).toBe(TENANT_ID);
    expect(after.lifecycleState).toBe("provisioning"); // partial: repair still required, never fabricated 'active'

    // A second pass now surfaces it for the H3 repair route instead of guessing.
    const again = await reconcileCommissionRequest(deps(fetchImpl), { idempotencyKey: "recheck-h2", commissionRequestId: COMMISSION_REQUEST_ID, ...OPERATOR_PARAMS });
    expect(again.remainingDrift).toEqual([expect.objectContaining({ class: "owner_partial_success", note: expect.stringContaining("/repair") })]);
  });

  it("an earlier attempt's tenant is never failed by a later attempt's not-found receipt", async () => {
    const projection = await provisioningProjection(TENANT_ID);
    await seedAt("partially_completed", { idempotencyKey: "repair-attempt", ...COMMISSION_OP });
    const { fetchImpl } = buildFakeInfrakinetic();

    await reconcileCommissionRequest(deps(fetchImpl), { idempotencyKey: "recheck-i", commissionRequestId: COMMISSION_REQUEST_ID, ...OPERATOR_PARAMS });

    expect((await commissionedTenants.getByProjectionId(projection.projectionId)).lifecycleState).toBe("provisioning");
  });

  // M3 — the master plan's first 1A.10 drift class, for the lifecycle itself.
  it("desired-vs-observed lifecycle drift is surfaced (the M4 case: projection 'provisioning', owner 'suspended')", async () => {
    await provisioningProjection(TENANT_ID);
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "suspended" });

    const drift = await listDrift(deps(fetchImpl), { tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(drift.lifecycleMismatch).toEqual([{ tenantId: TENANT_ID, projectionLifecycleState: "provisioning", observedPlatformAccessState: "suspended" }]);
  });

  it("a partially-commissioned tenant that is simply 'active' at the owner is NOT lifecycle drift", async () => {
    await provisioningProjection(TENANT_ID);
    const { fetchImpl } = buildFakeInfrakinetic({ platformAccessState: "active" });

    const drift = await listDrift(deps(fetchImpl), { tenantId: TENANT_ID, ...OPERATOR_PARAMS });

    expect(drift.lifecycleMismatch).toEqual([]);
  });

  // L10 — every owner read carries an explicit, bound target; nothing gets
  // fleet visibility through a tenant-oriented route.
  describe("L10 read targets", () => {
    it("identity/credential receipt reads are minted with the operation's own tenant + resource, not a fleet sentinel", async () => {
      await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: LONG_AGO, observedPlatformAccessState: "active" });
      await seedAt("partially_completed", {
        idempotencyKey: "mfa-bound", requestedAction: "identity.mfa.reset", targetResourceType: "identity_user", targetResourceId: "user-1", riskClass: "R3",
      });
      const { fetchImpl, claims } = buildFakeInfrakinetic({ receipts: { "identity-admin-commands": { "mfa-bound": { status: "completed" } } } });

      await reconcileTenant(deps(fetchImpl), { idempotencyKey: "recheck-l10a", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

      expect(claims["/management/v1/identity-admin-commands/mfa-bound"]).toMatchObject({
        target_tenant_id: TENANT_ID, target_resource_type: "identity_user", target_resource_id: "user-1",
      });
      expect(claims["/management/v1/identity-admin-commands/mfa-bound"]).not.toHaveProperty("target_engine");
    });

    it("an early commission receipt read is bound to the commission request, with no invented tenant target", async () => {
      await provisioningProjection(undefined);
      await seedAt("running", { idempotencyKey: "commission-l10", ...COMMISSION_OP });
      const { fetchImpl, claims } = buildFakeInfrakinetic({
        receipts: { "tenant-lifecycle-commands": { "commission-l10": { status: "accepted" } } },
      });

      await reconcileCommissionRequest(deps(fetchImpl), { idempotencyKey: "recheck-l10b", commissionRequestId: COMMISSION_REQUEST_ID, ...OPERATOR_PARAMS });

      const sent = claims["/management/v1/tenant-lifecycle-commands/commission-l10"];
      expect(sent).toMatchObject({ target_resource_type: "commission_request", target_resource_id: COMMISSION_REQUEST_ID });
      expect(sent).not.toHaveProperty("target_tenant_id");
    });

    it("an owner target-binding refusal (409) is surfaced as unknown — never resolved either way", async () => {
      await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: LONG_AGO, observedPlatformAccessState: "active" });
      const stuck = await seedAt("partially_completed", { idempotencyKey: "bound-409" });
      const { fetchImpl } = buildFakeInfrakinetic({ bindingMismatchKeys: ["bound-409"] });

      const result = await reconcileTenant(deps(fetchImpl), { idempotencyKey: "recheck-l10c", tenantId: TENANT_ID, ...OPERATOR_PARAMS });

      expect(result.resolvedOperations).toEqual([]);
      expect(result.remainingDrift).toEqual([expect.objectContaining({ operationId: stuck.operationId, class: "transport_ambiguous" })]);
      expect((await ledger.getOperation(stuck.operationId)).status).toBe("partially_completed");
    });

    it("the tenant detail read is addressed to that tenant; the fleet list is addressed to the fleet with no tenant binding", async () => {
      await commissionedTenants.createLegacyExisting({ tenantId: TENANT_ID, createdAt: LONG_AGO, observedPlatformAccessState: "active" });
      const { fetchImpl, claims } = buildFakeInfrakinetic();

      await listDrift(deps(fetchImpl), { tenantId: TENANT_ID, ...OPERATOR_PARAMS });
      await listDrift(deps(fetchImpl), { ...OPERATOR_PARAMS });

      expect(claims[`/management/v1/tenants/${TENANT_ID}`]).toMatchObject({ target_resource_type: "tenant", target_resource_id: TENANT_ID });
      expect(claims["/management/v1/tenants"]).toMatchObject({ target_resource_type: "tenant_fleet" });
      expect(claims["/management/v1/tenants"]).not.toHaveProperty("target_tenant_id");
    });
  });
});
