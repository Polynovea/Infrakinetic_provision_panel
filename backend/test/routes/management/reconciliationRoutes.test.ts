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
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import type { CognitoIdentityProvider } from "../../../src/identity/providers/cognitoIdentityProvider.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { DbClient } from "../../../src/db/dbClient.js";

async function buildFixtureSigningKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "reconciliation-route-test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "reconciliation-route-test-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

const TENANT_ID = "33333333-3333-4333-8333-333333333333";

// Same boundary-only scope as tenantEngineEntitlementRoutes.test.ts's own
// header: auth/scope/body-shape validation only. Full drift-classification
// and repair-orchestration behavior is covered directly in
// reconciliationQuery.test.ts/reconciliationOperation.test.ts.

describe("GET /management/v1/reconciliation/drift", () => {
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
  });

  it("operator missing runtime.read -> 403, no orchestration attempted", async () => {
    const op = activeAdminOperator({ scopes: ["tenants.read"] }); // missing runtime.read
    const { app: server } = buildTestApp(provider, [op], {
      ledger, commissionedTenants,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/reconciliation/drift").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("no assertion at all -> 401", async () => {
    const op = activeAdminOperator({ scopes: ["runtime.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger, commissionedTenants,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const res = await request(server).get("/management/v1/reconciliation/drift");
    expect(res.status).toBe(401);
  });

  it("a viewer-role operator (runtime.read is in their ceiling) is not rejected on scope", async () => {
    const op = activeViewerOperator({ scopes: ["runtime.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger, commissionedTenants,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      // Unreachable origin — proves the request got PAST the scope check.
      infrakineticBaseUrl: "http://127.0.0.1:1",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/reconciliation/drift").set("authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });

  it("valid request with a granted scope reaches orchestration and returns ledger-derived drift even when the registry is unreachable", async () => {
    const op = activeAdminOperator({ scopes: ["runtime.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger, commissionedTenants,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:1", // unreachable — registry read fails, ledger-only classes still returned
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/reconciliation/drift").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.stuckOperations).toEqual([]);
    expect(res.body.registryUnavailable).toBeTruthy();
  });
});

describe("POST /management/v1/reconciliation/tenants/:tenantId/recheck", () => {
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
  });

  function appWithAdmin(overrides: { scopes?: string[]; infrakineticBaseUrl?: string } = {}) {
    const op = activeAdminOperator({ scopes: (overrides.scopes as never) ?? ["runtime.repair.request"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger, commissionedTenants,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: overrides.infrakineticBaseUrl ?? "http://127.0.0.1:0",
    });
    return { server, op };
  }

  it("operator missing runtime.repair.request -> 403, before any orchestration runs", async () => {
    const { server, op } = appWithAdmin({ scopes: ["tenants.read"] });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .post(`/management/v1/reconciliation/tenants/${TENANT_ID}/recheck`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "recheck-key-1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("missing idempotencyKey -> 400, before any orchestration runs", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .post(`/management/v1/reconciliation/tenants/${TENANT_ID}/recheck`)
      .set("authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("no assertion at all -> 401", async () => {
    const { server } = appWithAdmin();
    const res = await request(server)
      .post(`/management/v1/reconciliation/tenants/${TENANT_ID}/recheck`)
      .send({ idempotencyKey: "recheck-key-1" });
    expect(res.status).toBe(401);
  });

  it("valid request against an unreachable registry surfaces a 200 with a partial outcome, not a thrown error (projection repair and stuck-op resolution are isolated)", async () => {
    const { server, op } = appWithAdmin({ infrakineticBaseUrl: "http://127.0.0.1:1" });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .post(`/management/v1/reconciliation/tenants/${TENANT_ID}/recheck`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "recheck-key-2" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("partial");
    expect(res.body.projectionError).toBeTruthy();
    expect(res.body.stuckOperationsError).toBeUndefined();
  });
});
