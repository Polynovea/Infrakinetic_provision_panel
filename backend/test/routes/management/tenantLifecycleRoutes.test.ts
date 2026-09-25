import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import { exportJWK } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import { buildTestApp } from "../../helpers/testApp.js";
import { buildTestIdentityProvider } from "../../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken, type TestKeyPair } from "../../helpers/testToken.js";
import { activeAdminOperator } from "../../helpers/operators.js";
import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import type { CognitoIdentityProvider } from "../../../src/identity/providers/cognitoIdentityProvider.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { Scope } from "../../../src/identity/roles.js";

async function buildFixtureSigningKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "tenant-route-test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "tenant-route-test-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

// Same boundary-only scope as engineStateRoute.test.ts's own header: this
// file exercises auth/scope/body-shape validation, which short-circuits
// before any network call to Infrakinetic — the full orchestration
// (real assertions, real HTTP calls against a fake Infrakinetic, replay/
// partial-failure/PII evidence) is fully covered in
// tenantLifecycleOperation.test.ts.

describe("POST /management/v1/tenants/commission and /tenants/:tenantId/{suspend,resume,decommission}", () => {
  let keyPair: TestKeyPair;
  let provider: CognitoIdentityProvider;
  let client: DbClient;
  let ledger: ManagementOperationLedger;
  let commissionedTenants: CommissionedTenantsRepository;
  let signingKeys: ManagementSigningKeySet;

  beforeEach(async () => {
    keyPair = await generateTestKeyPair();
    provider = buildTestIdentityProvider(keyPair);
    client = buildMigratedPgMemClient().client;
    ledger = new ManagementOperationLedger(client);
    commissionedTenants = new CommissionedTenantsRepository(client);
    signingKeys = await buildFixtureSigningKeys();
    // The auth layer's operator directory is in-memory (activeAdminOperator
    // fixture) and entirely separate from this pg-mem `client` — but
    // commissioned_tenants.responsible_operator_id has a real FK onto
    // governance.operators, so the same operator row must exist here too
    // for a commission call to insert its projection row.
    await client.query(
      `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
       VALUES ($1, 'fixture-sub-admin', 'admin@example.invalid', 'Test Admin', 'active', true, now(), now())`,
      [activeAdminOperator().operatorId],
    );
  });

  function appWithAdmin(overrides: { scopes?: Scope[] } = {}) {
    const op = activeAdminOperator({
      scopes: overrides.scopes ?? ["tenants.commission", "tenants.suspend", "tenants.resume", "tenants.decommission"],
    });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      commissionedTenants,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    return { server, op };
  }

  describe("POST /tenants/commission", () => {
    it("missing tenants.commission scope -> 403 before any orchestration runs", async () => {
      const op = activeAdminOperator({ scopes: ["tenants.read"] });
      const { app: server } = buildTestApp(provider, [op], {
        ledger, commissionedTenants,
        getManagementSigningKeys: () => Promise.resolve(signingKeys),
        loadTransportConfig: () => TRANSPORT_CONFIG,
        infrakineticBaseUrl: "http://127.0.0.1:0",
      });
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/commission")
        .set("authorization", `Bearer ${token}`)
        .send({ idempotencyKey: "k1", name: "Acme", plan: "pro", accountType: "demo", reason: "x", sendInvite: false });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("SCOPE_REQUIRED");
    });

    it("missing idempotencyKey -> 400", async () => {
      const { server, op } = appWithAdmin();
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/commission")
        .set("authorization", `Bearer ${token}`)
        .send({ name: "Acme", plan: "pro", accountType: "demo", reason: "x", sendInvite: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("missing reason -> 400", async () => {
      const { server, op } = appWithAdmin();
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/commission")
        .set("authorization", `Bearer ${token}`)
        .send({ idempotencyKey: "k1", name: "Acme", plan: "pro", accountType: "demo", sendInvite: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("REASON_REQUIRED");
    });

    it("missing name -> 400", async () => {
      const { server, op } = appWithAdmin();
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/commission")
        .set("authorization", `Bearer ${token}`)
        .send({ idempotencyKey: "k1", plan: "pro", accountType: "demo", reason: "x", sendInvite: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("NAME_REQUIRED");
    });

    it("invalid accountType -> 400", async () => {
      const { server, op } = appWithAdmin();
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/commission")
        .set("authorization", `Bearer ${token}`)
        .send({ idempotencyKey: "k1", name: "Acme", plan: "pro", accountType: "enterprise", reason: "x", sendInvite: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_ACCOUNT_TYPE");
    });

    it("sendInvite=true (default) with no initialAdmin -> 400 INITIAL_ADMIN_REQUIRED", async () => {
      const { server, op } = appWithAdmin();
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/commission")
        .set("authorization", `Bearer ${token}`)
        .send({ idempotencyKey: "k1", name: "Acme", plan: "pro", accountType: "demo", reason: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INITIAL_ADMIN_REQUIRED");
    });

    it("sendInvite=false with no initialAdmin -> passes route-level validation (the connection-refused failure that follows proves it got PAST validation, not a 400)", async () => {
      const { server, op } = appWithAdmin();
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/commission")
        .set("authorization", `Bearer ${token}`)
        .send({ idempotencyKey: "k1", name: "Acme", plan: "pro", accountType: "demo", reason: "x", sendInvite: false });
      // No real Infrakinetic reachable at 127.0.0.1:0 — a connection that
      // was never established is the unambiguous case (§8), so the
      // orchestration marks this `failed`, not `partially_completed`. The
      // 200 HTTP status (this route always returns the operation record,
      // whatever its status) plus a real operationId is the proof this
      // request reached the orchestration layer at all.
      expect(res.status).toBe(200);
      expect(res.body.operation.status).toBe("failed");
      expect(res.body.operation.partialFailureState.stage).toBe("mutation-call-never-dispatched");
    });
  });

  describe("POST /tenants/:tenantId/{suspend,resume,decommission}", () => {
    it("missing tenants.suspend scope -> 403", async () => {
      const op = activeAdminOperator({ scopes: ["tenants.read"] });
      const { app: server } = buildTestApp(provider, [op], {
        ledger, commissionedTenants,
        getManagementSigningKeys: () => Promise.resolve(signingKeys),
        loadTransportConfig: () => TRANSPORT_CONFIG,
        infrakineticBaseUrl: "http://127.0.0.1:0",
      });
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/33333333-3333-4333-8333-333333333333/suspend")
        .set("authorization", `Bearer ${token}`)
        .send({ idempotencyKey: "k1", reason: "abuse" });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("SCOPE_REQUIRED");
    });

    it("missing reason -> 400", async () => {
      const { server, op } = appWithAdmin();
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/33333333-3333-4333-8333-333333333333/resume")
        .set("authorization", `Bearer ${token}`)
        .send({ idempotencyKey: "k1" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("REASON_REQUIRED");
    });

    it("missing idempotencyKey -> 400", async () => {
      const { server, op } = appWithAdmin();
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/33333333-3333-4333-8333-333333333333/decommission")
        .set("authorization", `Bearer ${token}`)
        .send({ reason: "cleanup" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("a resume-scoped operator cannot call suspend (per-route scope, not a blanket tenant-lifecycle scope)", async () => {
      const op = activeAdminOperator({ scopes: ["tenants.resume"] });
      const { app: server } = buildTestApp(provider, [op], {
        ledger, commissionedTenants,
        getManagementSigningKeys: () => Promise.resolve(signingKeys),
        loadTransportConfig: () => TRANSPORT_CONFIG,
        infrakineticBaseUrl: "http://127.0.0.1:0",
      });
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .post("/management/v1/tenants/33333333-3333-4333-8333-333333333333/suspend")
        .set("authorization", `Bearer ${token}`)
        .send({ idempotencyKey: "k1", reason: "abuse" });
      expect(res.status).toBe(403);
    });
  });
  // Audit remediation H3 — the repair route that makes owner-side commission
  // repair reachable. Validation short-circuits before any Infrakinetic call.
  describe("POST /tenants/commission-requests/:commissionRequestId/repair", () => {
    const CRID = "eeeeeeee-0000-4eee-8eee-000000000001";
    const BODY = {
      idempotencyKey: "repair-1", reason: "identity stage failed", name: "Acme", slug: "acme", plan: "pro", accountType: "live",
      sendInvite: true, initialAdmin: { name: "Ada", email: "ada@example.invalid" },
    };

    async function projectionAt(state: "provisioning" | "active") {
      const created = await commissionedTenants.createForCommissionRequest({
        commissionRequestId: CRID, desiredName: "Acme", desiredSlug: "acme", desiredPlan: "pro", accountType: "live",
        responsibleOperatorId: activeAdminOperator().operatorId,
      });
      await commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "approved" });
      await commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "provisioning", tenantId: "ffffffff-0000-4fff-8fff-000000000001" });
      if (state === "active") await commissionedTenants.transitionLifecycleState(created.projectionId, { toState: "active" });
    }

    async function post(body: Record<string, unknown>, crid = CRID) {
      const { server, op } = appWithAdmin();
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      return request(server).post(`/management/v1/tenants/commission-requests/${crid}/repair`).set("authorization", `Bearer ${token}`).send(body);
    }

    it("404 for an unknown commission request", async () => {
      const res = await post(BODY);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("COMMISSION_REQUEST_NOT_FOUND");
    });

    it("409 when the commission is not in 'provisioning' (nothing to repair)", async () => {
      await projectionAt("active");
      const res = await post(BODY);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("COMMISSION_NOT_REPAIRABLE");
    });

    it("409 when the resubmitted commission differs from the approved one — a repair can finish a commission, never repurpose it", async () => {
      await projectionAt("provisioning");
      for (const changed of [{ name: "Other" }, { plan: "enterprise" }, { accountType: "demo" }, { slug: "other" }]) {
        const res = await post({ ...BODY, ...changed });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("COMMISSION_REPAIR_MISMATCH");
      }
    });

    it("a matching repair passes validation and reaches orchestration with the STORED commissionRequestId", async () => {
      await projectionAt("provisioning");
      const res = await post(BODY);
      // Unreachable fake Infrakinetic: the call is dispatched and fails
      // ambiguously, proving validation passed; the ledger op is addressed
      // by the stored commission request, not a fresh one.
      expect([200, 502]).toContain(res.status);
      const op = await ledger.getByIdempotencyKey("repair-1");
      expect(op?.targetResourceType).toBe("commission_request");
      expect(op?.targetResourceId).toBe(CRID);
    });

    it("requires tenants.commission", async () => {
      const { server, op } = appWithAdmin({ scopes: ["tenants.suspend"] });
      await projectionAt("provisioning");
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server).post(`/management/v1/tenants/commission-requests/${CRID}/repair`).set("authorization", `Bearer ${token}`).send(BODY);
      expect(res.status).toBe(403);
    });
  });

  // Audit remediation M5 — a same-key timeout retry of a commission must hash
  // identically (stable commissionRequestId), so it replays instead of 409-ing.
  it("POST /tenants/commission: a same-key retry reuses the first attempt's commissionRequestId", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const body = { idempotencyKey: "commission-retry", reason: "new customer", name: "Retry Co", plan: "pro", accountType: "live", sendInvite: false };
    const first = await request(server).post("/management/v1/tenants/commission").set("authorization", `Bearer ${token}`).send(body);
    const firstOp = await ledger.getByIdempotencyKey("commission-retry");
    const second = await request(server).post("/management/v1/tenants/commission").set("authorization", `Bearer ${token}`).send(body);

    expect(firstOp?.targetResourceId).toBeTruthy();
    expect(second.status).not.toBe(409);
    expect(second.body.replay).toBe(true);
    expect(second.body.operation.operationId).toBe(first.body.operation?.operationId ?? firstOp?.operationId);
  });
});
