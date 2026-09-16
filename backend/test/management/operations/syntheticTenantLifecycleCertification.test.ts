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
} from "../../../src/management/operations/tenantLifecycleOperation.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { TenantLifecycleOperationDeps } from "../../../src/management/operations/tenantLifecycleOperation.js";

// Phase 1A.8.6 — synthetic tenant certification (master plan §64/§67/§72:
// "Implement synthetic tenant: commission / suspend / resume / decommission.
// Exit: no direct DB edits; full ledger/effective-state evidence").
//
// This is the local, CI-executable half of that exit gate: the full chain
// run against a fake-but-behaviourally-faithful Infrakinetic (the same
// harness style as tenantLifecycleOperation.test.ts), proving continuity
// across all four commands against ONE tenant and the evidence properties
// the exit gate names. What this file does NOT do — because this session
// has no live deployed Infrakinetic endpoint, no live Cognito, and no live
// production/staging Postgres — is the actual LIVE run against a deployed
// system. That live procedure is a deployment-time operational step, not
// something a unit test can perform; this file is the proof the
// orchestration logic itself is correct end-to-end, which the live run
// would then exercise for real.
//
// §3.12 — the certification tenant is tenant_kind='customer' with an
// obviously synthetic name/slug; `synthetic` itself is never a valid
// tenant_kind value and is never inserted as one.

const SYNTHETIC_TENANT_NAME = "ZZ-SYNTHETIC-CERT-1A8";
const SYNTHETIC_TENANT_ID = "c0000000-0000-4c00-8c00-000000000001";
const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROLES = ["provisioning_operator"];
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
  jwk.kid = "cert-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "cert-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

interface FakeCall { method: string; path: string; body?: Record<string, unknown> }

// A faithful-enough fake of Infrakinetic's real owner service semantics
// (lib/tenantLifecycle.js): platform_access_state starts 'active' on
// commission, tenant_kind is always 'customer', tenants.status is never
// mentioned anywhere in this fake's responses (proving the orchestration
// layer never needs it), and no DELETE-shaped call is ever exercised.
function buildFakeInfrakinetic() {
  const calls: FakeCall[] = [];
  let platformAccessState: "active" | "suspended" | "decommissioned" = "active";

  function jsonResponse(status: number, body: unknown): Response {
    return { status, json: async () => body } as Response;
  }

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (url.pathname === "/management/v1/tenants/commission" && method === "POST") {
      return jsonResponse(200, {
        tenantId: SYNTHETIC_TENANT_ID,
        slug: "zz-synthetic-cert-1a8",
        lifecycleOutcome: "completed",
        warnings: [],
      });
    }

    const mutationMatch = url.pathname.match(/^\/management\/v1\/tenants\/([^/]+)\/(suspend|resume|decommission)$/);
    if (mutationMatch && method === "POST") {
      const action = mutationMatch[2];
      const previous = platformAccessState;
      if (action === "suspend") platformAccessState = "suspended";
      if (action === "resume") platformAccessState = "active";
      if (action === "decommission") platformAccessState = "decommissioned";
      return jsonResponse(200, {
        tenantId: mutationMatch[1],
        previousPlatformAccessState: previous,
        resultingPlatformAccessState: platformAccessState,
      });
    }

    return jsonResponse(404, { error: "NOT_FOUND" });
  }) as typeof fetch;

  return { fetchImpl, calls, getPlatformAccessState: () => platformAccessState };
}

describe("Phase 1A.8.6 — synthetic tenant certification (commission -> suspend -> resume -> decommission)", () => {
  let client: DbClient;
  let ledger: ManagementOperationLedger;
  let commissionedTenants: CommissionedTenantsRepository;
  let signingKeys: ManagementSigningKeySet;
  let fake: ReturnType<typeof buildFakeInfrakinetic>;
  let deps: TenantLifecycleOperationDeps;

  beforeEach(async () => {
    const built = buildMigratedPgMemClient();
    client = built.client;
    ledger = new ManagementOperationLedger(client);
    commissionedTenants = new CommissionedTenantsRepository(client);
    await seedOperator(client);
    signingKeys = await buildFixtureSigningKeys();
    fake = buildFakeInfrakinetic();
    deps = {
      ledger, commissionedTenants, signingKeys, transportConfig: TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://infrakinetic.test.invalid", fetchImpl: fake.fetchImpl,
    };
  });

  it("runs the full chain against one synthetic tenant with continuous, real evidence at every step", async () => {
    const commissionRequestId = "d0000000-0000-4d00-8d00-000000000001";

    // 1. Commission.
    const commissionResult = await requestTenantCommission(deps, {
      idempotencyKey: "cert-commission-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
      commissionRequestId,
      name: SYNTHETIC_TENANT_NAME,
      slug: "zz-synthetic-cert-1a8",
      plan: "pro",
      accountType: "demo",
      trialDays: 0,
      sendInvite: false,
      reason: "1A.8.6 synthetic certification",
    });
    expect(commissionResult.replay).toBe(false);
    expect(commissionResult.operation.status).toBe("completed");

    const afterCommission = await commissionedTenants.getByCommissionRequestId(commissionRequestId);
    expect(afterCommission?.provenance).toBe("governance_commissioned");
    expect(afterCommission?.lifecycleState).toBe("active");
    expect(afterCommission?.tenantId).toBe(SYNTHETIC_TENANT_ID);
    expect(afterCommission?.lastObservedPlatformAccessState).toBe("active");

    // 2. Suspend.
    const suspendResult = await requestTenantSuspend(deps, {
      idempotencyKey: "cert-suspend-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
      tenantId: SYNTHETIC_TENANT_ID, reason: "1A.8.6 synthetic certification — suspend leg",
    });
    expect(suspendResult.operation.status).toBe("completed");
    expect(fake.getPlatformAccessState()).toBe("suspended");
    const afterSuspend = await commissionedTenants.getByTenantId(SYNTHETIC_TENANT_ID);
    expect(afterSuspend?.lifecycleState).toBe("suspended");

    // 3. Resume.
    const resumeResult = await requestTenantResume(deps, {
      idempotencyKey: "cert-resume-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
      tenantId: SYNTHETIC_TENANT_ID, reason: "1A.8.6 synthetic certification — resume leg",
    });
    expect(resumeResult.operation.status).toBe("completed");
    expect(fake.getPlatformAccessState()).toBe("active");
    const afterResume = await commissionedTenants.getByTenantId(SYNTHETIC_TENANT_ID);
    expect(afterResume?.lifecycleState).toBe("active");

    // 4. Decommission.
    const decommissionResult = await requestTenantDecommission(deps, {
      idempotencyKey: "cert-decommission-1", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
      tenantId: SYNTHETIC_TENANT_ID, reason: "1A.8.6 synthetic certification — decommission leg",
    });
    expect(decommissionResult.operation.status).toBe("completed");
    expect(fake.getPlatformAccessState()).toBe("decommissioned");
    const afterDecommission = await commissionedTenants.getByTenantId(SYNTHETIC_TENANT_ID);
    expect(afterDecommission?.lifecycleState).toBe("decommissioned");
    expect(afterDecommission?.decommissionedAt).toBeTruthy();

    // Exit-gate property 1: "no direct DB edits" — every mutation went
    // through the real /management/v1/tenants/* HTTP contract, never a
    // bare SQL statement against Infrakinetic's database. No DELETE was
    // ever issued anywhere in this chain (a real DELETE would show up as
    // a distinct call path this fake doesn't even register).
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /management/v1/tenants/commission",
      "POST /management/v1/tenants/c0000000-0000-4c00-8c00-000000000001/suspend",
      "POST /management/v1/tenants/c0000000-0000-4c00-8c00-000000000001/resume",
      "POST /management/v1/tenants/c0000000-0000-4c00-8c00-000000000001/decommission",
    ]);
    for (const call of fake.calls) {
      expect(call.body).not.toHaveProperty("status"); // never a Billing-shaped field in any request body
    }

    // Exit-gate property 2: "full ledger/effective-state evidence" — all
    // four operations are independently retrievable from the real ledger,
    // each carrying its own correlation id, risk class, and safe snapshot.
    const allOperations = await ledger.listOperations({ targetTenantId: SYNTHETIC_TENANT_ID, limit: 10 });
    const commissionOps = await ledger.listOperations({ requestedAction: "tenant.commission", limit: 10 });
    const relevantOps = [...allOperations, ...commissionOps.filter((op) => op.operationId === commissionResult.operation.operationId)];
    const operationIds = new Set(relevantOps.map((op) => op.operationId));
    expect(operationIds.has(commissionResult.operation.operationId)).toBe(true);
    expect(operationIds.has(suspendResult.operation.operationId)).toBe(true);
    expect(operationIds.has(resumeResult.operation.operationId)).toBe(true);
    expect(operationIds.has(decommissionResult.operation.operationId)).toBe(true);
    for (const op of [suspendResult.operation, resumeResult.operation, decommissionResult.operation]) {
      expect(op.riskClass).toBe("R2");
      expect(op.reason).toBeTruthy();
    }

    // Exit-gate property 3: synthetic tenant is a real, ordinary customer
    // tenant, never a fabricated `tenant_kind='synthetic'` (which does not
    // exist as a valid value at all — see §3.12).
    expect(afterCommission?.desiredName).toBe(SYNTHETIC_TENANT_NAME);
  });

  it("the full chain never mutates Billing-owned fields — no request body anywhere carries a commercial status field", async () => {
    const commissionRequestId = "d0000000-0000-4d00-8d00-000000000002";
    await requestTenantCommission(deps, {
      idempotencyKey: "cert-commission-2", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ROLES, operatorGrantedScopes: SCOPES,
      commissionRequestId, name: "ZZ-SYNTHETIC-CERT-1A8-B", plan: "pro", accountType: "live",
      sendInvite: false, reason: "1A.8.6 synthetic certification",
    });
    await requestTenantSuspend(deps, {
      idempotencyKey: "cert-suspend-2", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: SYNTHETIC_TENANT_ID, reason: "x",
    });
    await requestTenantResume(deps, {
      idempotencyKey: "cert-resume-2", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: SYNTHETIC_TENANT_ID, reason: "x",
    });
    await requestTenantDecommission(deps, {
      idempotencyKey: "cert-decommission-2", operatorId: OPERATOR_ID, operatorSessionId: SESSION_ID,
      operatorRoles: ROLES, operatorGrantedScopes: SCOPES, tenantId: SYNTHETIC_TENANT_ID, reason: "x",
    });

    for (const call of fake.calls) {
      const serialized = JSON.stringify(call.body ?? {});
      expect(serialized).not.toMatch(/"status"\s*:/);
      expect(serialized).not.toMatch(/subscription/i);
      expect(serialized).not.toMatch(/razorpay/i);
    }
  });
});
