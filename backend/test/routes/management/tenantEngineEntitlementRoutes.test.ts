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
  jwk.kid = "entitlement-route-test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "entitlement-route-test-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

const TENANT_ID = "33333333-3333-4333-8333-333333333333";

// Same boundary-only scope as engineStateRoute.test.ts/engineCatalogRoute.test.ts's
// own header: this file exercises auth/scope/body-shape validation, which
// short-circuits before any network call to Infrakinetic — the full
// orchestration (real assertions, real HTTP calls against a fake
// Infrakinetic, replay/conflict/effective-observation/PII evidence) is
// fully covered in tenantEngineEntitlementOperation.test.ts, which calls
// requestTenantEngineEntitlementChange() directly with an injectable
// fetchImpl — this route wiring has no such injection point.

describe("PUT /management/v1/tenants/:tenantId/engines/:engineKey/entitlement", () => {
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
    const op = activeAdminOperator({ scopes: overrides.scopes ?? ["tenants.read", "engines.entitlement.write"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    return { server, op };
  }

  it("valid operator missing engines.entitlement.write scope -> 403 before any orchestration runs", async () => {
    const op = activeAdminOperator({ scopes: ["tenants.read"] }); // missing engines.entitlement.write
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", enabled: true, reason: "x" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("missing idempotencyKey -> 400, before any orchestration runs", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`)
      .set("authorization", `Bearer ${token}`)
      .send({ enabled: true, reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("missing reason -> 400", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("REASON_REQUIRED");
  });

  it("non-boolean enabled -> 400 INVALID_ENABLED", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", enabled: "yes", reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_ENABLED");
  });

  it("a viewer-role operator (no engines.entitlement.write in their ceiling) is rejected", async () => {
    const op = activeViewerOperator({ scopes: ["tenants.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", enabled: true, reason: "x" });
    expect(res.status).toBe(403);
  });

  it("no assertion at all -> 401", async () => {
    const { server } = appWithAdmin();
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`)
      .send({ idempotencyKey: "k1", enabled: true, reason: "x" });
    expect(res.status).toBe(401);
  });

  it("valid request that passes route-level validation reaches orchestration (connection-refused during Step 1's resolve-read surfaces as a clean 502, no ledger entry — same pre-reservation-failure shape engineStateOperation.ts's own Step 1 has)", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`)
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", enabled: true, reason: "customer purchased AI add-on" });
    // Unlike tenant-lifecycle's suspend/resume/decommission (which reserve
    // the ledger operation BEFORE their only network call, so a connection
    // failure lands as a recorded `failed` operation), this flow — like
    // engineStateOperation.ts's own — resolves+validates via a GET BEFORE
    // ledger reservation, to capture real "before" evidence. A network
    // failure at that pre-reservation step has nothing to record it against,
    // so no operation row is created — but it is now caught as a
    // ManagementApiUnreachableError and mapped to a clean 502
    // (MANAGEMENT_API_UPSTREAM_ERROR), not an unhandled 500.
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("MANAGEMENT_API_UPSTREAM_ERROR");
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
  });
});

describe("GET /management/v1/tenants/:tenantId/engines/:engineKey/entitlement and /tenants/:tenantId/engines", () => {
  it("operator missing tenants.read -> 403, no orchestration attempted", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const signingKeys = await buildFixtureSigningKeys();
    const op = activeAdminOperator({ scopes: ["engines.read"] }); // missing tenants.read
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    const single = await request(server)
      .get(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`)
      .set("authorization", `Bearer ${token}`);
    expect(single.status).toBe(403);
    expect(single.body.error).toBe("SCOPE_REQUIRED");

    const list = await request(server)
      .get(`/management/v1/tenants/${TENANT_ID}/engines`)
      .set("authorization", `Bearer ${token}`);
    expect(list.status).toBe(403);
    expect(list.body.error).toBe("SCOPE_REQUIRED");
  });

  it("a viewer-role operator (tenants.read is in their ceiling) is not rejected on scope", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const signingKeys = await buildFixtureSigningKeys();
    const op = activeViewerOperator({ scopes: ["tenants.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      // Unreachable origin — proves the request got PAST the scope check and
      // failed downstream (upstream call), not on authz.
      infrakineticBaseUrl: "http://127.0.0.1:1",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .get(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`)
      .set("authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });

  it("no assertion at all -> 401", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const signingKeys = await buildFixtureSigningKeys();
    const op = activeAdminOperator({ scopes: ["tenants.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const single = await request(server).get(`/management/v1/tenants/${TENANT_ID}/engines/module_ai/entitlement`);
    expect(single.status).toBe(401);
    const list = await request(server).get(`/management/v1/tenants/${TENANT_ID}/engines`);
    expect(list.status).toBe(401);
  });
});
