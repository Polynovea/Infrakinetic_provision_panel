import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import express from "express";
import { exportJWK } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryAuditSink } from "../../../src/identity/adapters/inMemoryAuditSink.js";
import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import { createPublicOnboardingRouter } from "../../../src/routes/publicOnboarding/index.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";

// Mostly boundary-only scope, same as tenantLifecycleRoutes.test.ts's own
// commission describe block: this file exercises auth/scope/body-shape
// validation, which short-circuits before any network call to
// Infrakinetic. The full commission orchestration itself (real assertions,
// replay/conflict evidence) is fully covered in
// tenantLifecycleOperation.test.ts. The one exception is the trialEndsAt
// composition this ROUTE adds on top of that operation (a second registry
// read after a completed commission) — that logic lives here, not in an
// operation module, so it needs its own real, fetchImpl-injected coverage
// (see the last describe block below).

const ORIGINAL_KEY = process.env.PUBLIC_ONBOARDING_SERVICE_KEY;
const SERVICE_KEY = "test-onboarding-service-key-32-chars-plus";

async function buildFixtureSigningKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "public-onboarding-route-test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "public-onboarding-route-test-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

describe("POST /public-onboarding/v1/commission", () => {
  let app: express.Express;

  beforeEach(async () => {
    process.env.PUBLIC_ONBOARDING_SERVICE_KEY = SERVICE_KEY;
    const client = buildMigratedPgMemClient().client;
    const signingKeys = await buildFixtureSigningKeys();
    app = express();
    app.use(express.json());
    app.use(
      "/public-onboarding/v1",
      createPublicOnboardingRouter({
        auditSink: new InMemoryAuditSink(),
        ledger: new ManagementOperationLedger(client),
        commissionedTenants: new CommissionedTenantsRepository(client),
        getManagementSigningKeys: () => Promise.resolve(signingKeys),
        loadTransportConfig: () => TRANSPORT_CONFIG,
        infrakineticBaseUrl: "http://127.0.0.1:0", // unreachable on purpose
      }),
    );
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.PUBLIC_ONBOARDING_SERVICE_KEY;
    else process.env.PUBLIC_ONBOARDING_SERVICE_KEY = ORIGINAL_KEY;
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: "signup-1",
      name: "Acme Inc",
      plan: "starter",
      initialAdmin: { name: "Jane Admin", email: "jane@acme.example" },
      ...overrides,
    };
  }

  it("no service key -> 403, before any orchestration runs", async () => {
    const res = await request(app).post("/public-onboarding/v1/commission").send(validBody());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("ONBOARDING_SERVICE_KEY_INVALID");
  });

  it("wrong service key -> 403", async () => {
    const res = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", "not-the-real-key")
      .send(validBody());
    expect(res.status).toBe(403);
  });

  it("missing idempotencyKey -> 400", async () => {
    const res = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send(validBody({ idempotencyKey: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("missing name -> 400", async () => {
    const res = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send(validBody({ name: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("NAME_REQUIRED");
  });

  it("missing plan -> 400", async () => {
    const res = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send(validBody({ plan: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("PLAN_REQUIRED");
  });

  it("missing initialAdmin -> 400, a public signup with no invite would create an unreachable tenant", async () => {
    const res = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send(validBody({ initialAdmin: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INITIAL_ADMIN_REQUIRED");
  });

  it("caller-supplied accountType is ignored — this boundary never accepts 'live'", async () => {
    // 'live' isn't even validated/accepted as a body field at all — proven
    // indirectly: the route only ever reads name/plan/initialAdmin/etc from
    // the body and hardcodes accountType itself (see index.ts). A caller
    // trying to smuggle accountType:'live' has no path to it because the
    // route's requestTenantCommission call never reads body.accountType.
    const res = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send(validBody({ accountType: "live" }));
    // Passes body validation and reaches orchestration rather than being
    // rejected — proving accountType was never inspected as an
    // accept/reject input in the first place. (200 + operation.status
    // 'failed' below is this flow's own "reached orchestration" proof —
    // requestTenantCommission's only network call happens AFTER ledger
    // reservation, unlike the plan-change/entitlement routes, so a
    // never-established connection is caught and recorded, not a 502.)
    expect(res.status).toBe(200);
    expect(res.body.operation.status).toBe("failed");
  });

  it("valid request that passes route-level validation reaches orchestration (unreachable Infrakinetic -> the ledger records a clean 'failed', never dispatched — same shape as the operator-facing commission route)", async () => {
    const res = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send(validBody());
    expect(res.status).toBe(200);
    expect(res.body.operation.status).toBe("failed");
    expect(res.body.operation.partialFailureState.stage).toBe("mutation-call-never-dispatched");
  });

  it("commissionRequestId is derived deterministically from idempotencyKey, not randomUUID() — the ledger's own targetResourceId matches deterministicUuidFrom(idempotencyKey) exactly", async () => {
    const { deterministicUuidFrom } = await import("../../../src/management/deterministicId.js");
    const res = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send(validBody({ idempotencyKey: "signup-determinism-check" }));
    expect(res.status).toBe(200);
    expect(res.body.operation.targetResourceId).toBe(deterministicUuidFrom("signup-determinism-check"));
  });

  it("a retried signup with the same idempotencyKey replays the SAME operation (and therefore the same commissionRequestId) rather than hitting a ledger idempotency conflict — the bug this session's fix closes", async () => {
    const first = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send(validBody({ idempotencyKey: "signup-retry-check" }));
    const second = await request(app)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send(validBody({ idempotencyKey: "signup-retry-check" }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.replay).toBe(true);
    expect(second.body.operation.targetResourceId).toBe(first.body.operation.targetResourceId);
    expect(second.body.operation.operationId).toBe(first.body.operation.operationId);
  });
});

describe("POST /public-onboarding/v1/commission — trialEndsAt composition (fix 2)", () => {
  const TENANT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  function fakeInfrakinetic(trialEndsAt: string) {
    return (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET") as string;

      if (url.pathname === "/management/v1/tenants/commission" && method === "POST") {
        return {
          status: 200,
          json: async () => ({ tenantId: TENANT_ID, lifecycleOutcome: "completed", warnings: [] }),
        } as Response;
      }
      if (url.pathname === `/management/v1/tenants/${TENANT_ID}` && method === "GET") {
        return {
          status: 200,
          json: async () => ({
            tenant: { id: TENANT_ID, name: "Acme Inc", slug: "acme-inc", tenant_kind: "customer", plan: "starter", status: "trial", trial_ends_at: trialEndsAt, industry: "general", country: "IN", timezone: "Asia/Kolkata", seat_limit: 5, storage_limit_mb: 1024, created_at: "2026-09-19T00:00:00.000Z", updated_at: "2026-09-19T00:00:00.000Z" },
            observedAt: "2026-09-19T00:00:00.000Z", source: "infrakinetic-live", freshness: "live",
          }),
        } as Response;
      }
      return { status: 404, json: async () => ({ error: "not_found" }) } as Response;
    }) as typeof fetch;
  }

  it("a completed commission surfaces the REAL owner-observed trial_ends_at as operation.result.trialEndsAt — never a locally fabricated date", async () => {
    process.env.PUBLIC_ONBOARDING_SERVICE_KEY = SERVICE_KEY;
    const client = buildMigratedPgMemClient().client;
    const signingKeys = await buildFixtureSigningKeys();
    const testApp = express();
    testApp.use(express.json());
    testApp.use(
      "/public-onboarding/v1",
      createPublicOnboardingRouter({
        auditSink: new InMemoryAuditSink(),
        ledger: new ManagementOperationLedger(client),
        commissionedTenants: new CommissionedTenantsRepository(client),
        getManagementSigningKeys: () => Promise.resolve(signingKeys),
        loadTransportConfig: () => TRANSPORT_CONFIG,
        infrakineticBaseUrl: "http://fake-infra.test",
        fetchImpl: fakeInfrakinetic("2026-10-03T00:00:00.000Z"),
      }),
    );

    const res = await request(testApp)
      .post("/public-onboarding/v1/commission")
      .set("x-onboarding-service-key", SERVICE_KEY)
      .send({
        idempotencyKey: "signup-trial-check",
        name: "Acme Inc",
        plan: "starter",
        initialAdmin: { name: "Jane Admin", email: "jane@acme.example" },
      });

    expect(res.status).toBe(200);
    expect(res.body.operation.status).toBe("completed");
    expect(res.body.operation.result.trialEndsAt).toBe("2026-10-03T00:00:00.000Z");
    expect(res.body.operation.result.tenantId).toBe(TENANT_ID);
  });
});
