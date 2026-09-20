import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import { exportJWK } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import { buildTestApp } from "../../helpers/testApp.js";
import { buildTestIdentityProvider } from "../../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken, type TestKeyPair } from "../../helpers/testToken.js";
import { activeAdminOperator, activeViewerOperator } from "../../helpers/operators.js";
import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import type { CognitoIdentityProvider } from "../../../src/identity/providers/cognitoIdentityProvider.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { Scope } from "../../../src/identity/roles.js";

async function buildFixtureSigningKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "plan-route-test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "plan-route-test-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

const TENANT_ID = "44444444-4444-4444-8444-444444444444";

// Same boundary-only scope as tenantEngineEntitlementRoutes.test.ts's own
// header: this file exercises auth/scope/body-shape validation, which
// short-circuits before any network call to Infrakinetic — the full
// orchestration is covered in tenantPlanChangeOperation.test.ts, which
// calls requestTenantPlanChange() directly with an injectable fetchImpl.

describe("PUT /management/v1/tenants/:tenantId/plan", () => {
  let keyPair: TestKeyPair;
  let provider: CognitoIdentityProvider;
  let client: DbClient;
  let ledger: ManagementOperationLedger;
  let signingKeys: ManagementSigningKeySet;

  beforeEach(async () => {
    keyPair = await generateTestKeyPair();
    provider = buildTestIdentityProvider(keyPair);
    client = buildMigratedPgMemClient().client;
    ledger = new ManagementOperationLedger(client);
    signingKeys = await buildFixtureSigningKeys();
  });

  function appWithAdmin(overrides: { scopes?: Scope[] } = {}) {
    const op = activeAdminOperator({ scopes: overrides.scopes ?? ["tenants.read", "tenants.plan.write"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    return { server, op };
  }

  it("valid operator missing tenants.plan.write scope -> 403 before any orchestration runs", async () => {
    const op = activeAdminOperator({ scopes: ["tenants.read"] }); // missing tenants.plan.write
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/plan`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", plan: "growth", reason: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("missing idempotencyKey -> 400, before any orchestration runs", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/plan`)
      .set("authorization", `Bearer ${token}`)
      .send({ plan: "growth", reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("missing reason -> 400", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/plan`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", plan: "growth" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("REASON_REQUIRED");
  });

  it("missing plan -> 400 PLAN_REQUIRED", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/plan`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("PLAN_REQUIRED");
  });

  it("a viewer-role operator (no tenants.plan.write in their ceiling) is rejected", async () => {
    const op = activeViewerOperator({ scopes: ["tenants.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/plan`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", plan: "growth", reason: "x" });
    expect(res.status).toBe(403);
  });

  it("no assertion at all -> 401", async () => {
    const { server } = appWithAdmin();
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/plan`)
      .send({ idempotencyKey: "k1", plan: "growth", reason: "x" });
    expect(res.status).toBe(401);
  });

  it("valid request that passes route-level validation reaches orchestration (connection-refused during Step 1's resolve-read surfaces as a clean 502, no ledger entry)", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/plan`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", plan: "growth", reason: "customer upgraded" });
    // Same pre-reservation-failure shape as engineStateOperation.ts and
    // tenantEngineEntitlementOperation.ts's own Step 1 resolve-read: a
    // network failure before ledger reservation has nothing to record it
    // against, so no operation row is created — mapped to a clean 502.
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("MANAGEMENT_API_UPSTREAM_ERROR");
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
  });
});
