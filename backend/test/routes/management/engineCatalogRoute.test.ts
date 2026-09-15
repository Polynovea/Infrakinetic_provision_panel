import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import { exportJWK } from "jose";
import { describe, expect, it } from "vitest";

import { buildTestApp } from "../../helpers/testApp.js";
import { buildTestIdentityProvider } from "../../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken } from "../../helpers/testToken.js";
import { activeAdminOperator, activeViewerOperator } from "../../helpers/operators.js";
import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";

async function buildFixtureSigningKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "route-test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "route-test-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

// Mirrors tenantRegistryRoute.test.ts's own framing: this file only
// exercises the boundary this route owns (auth/scope). Real orchestration
// (assertion minting, HTTP calls, per-engine failure isolation) is fully
// covered in engineCatalogQuery.test.ts against a fake Infrakinetic.

describe("GET /management/v1/engines — Governance's own operator-facing route", () => {
  it("operator missing engines.read -> 403, no orchestration attempted", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const signingKeys = await buildFixtureSigningKeys();
    const op = activeAdminOperator({ scopes: ["tenants.read"] }); // missing engines.read
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    const res = await request(server).get("/management/v1/engines").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("a viewer-role operator (engines.read is in their ceiling) is not rejected on scope", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const signingKeys = await buildFixtureSigningKeys();
    const op = activeViewerOperator({ scopes: ["engines.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      // Unreachable origin — proves the request got PAST the scope check and
      // failed downstream (upstream call), not on authz.
      infrakineticBaseUrl: "http://127.0.0.1:1",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/engines").set("authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });

  it("no assertion at all -> 401", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const signingKeys = await buildFixtureSigningKeys();
    const op = activeAdminOperator({ scopes: ["engines.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const res = await request(server).get("/management/v1/engines");
    expect(res.status).toBe(401);
  });
});

describe("GET /management/v1/operations — Governance's own operator-facing route", () => {
  it("operator missing engines.read -> 403", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const op = activeAdminOperator({ scopes: ["tenants.read"] }); // missing engines.read
    const { app: server } = buildTestApp(provider, [op], { ledger });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    const res = await request(server).get("/management/v1/operations").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("a viewer-role operator lists the (empty) ledger with no query params — pure DB read, no Infrakinetic call needed", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const op = activeViewerOperator({ scopes: ["engines.read"] });
    const { app: server } = buildTestApp(provider, [op], { ledger });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    const res = await request(server).get("/management/v1/operations").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.operations).toEqual([]);
  });

  it("rejects an out-of-range limit and an invalid status before touching the ledger", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const op = activeViewerOperator({ scopes: ["engines.read"] });
    const { app: server } = buildTestApp(provider, [op], { ledger });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    const badLimit = await request(server)
      .get("/management/v1/operations?limit=0")
      .set("authorization", `Bearer ${token}`);
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.error).toBe("INVALID_LIMIT");

    const badStatus = await request(server)
      .get("/management/v1/operations?status=not-a-real-status")
      .set("authorization", `Bearer ${token}`);
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error).toBe("INVALID_STATUS");
  });

  it("no assertion at all -> 401", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const ledger = new ManagementOperationLedger(buildMigratedPgMemClient().client);
    const { app: server } = buildTestApp(provider, [], { ledger });
    const res = await request(server).get("/management/v1/operations");
    expect(res.status).toBe(401);
  });
});
