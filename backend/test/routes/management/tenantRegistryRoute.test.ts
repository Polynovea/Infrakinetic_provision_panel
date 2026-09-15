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

// Mirrors engineStateRoute.test.ts's own framing: this file only exercises
// the boundary this route owns (auth/scope), matching production's lack of
// a fetch-injection point at the route layer. The real orchestration
// (assertion minting, HTTP call, 404 mapping) is fully covered in
// tenantRegistryQuery.test.ts against a fake Infrakinetic.

describe("GET /management/v1/tenants and /tenants/:identifier — Governance's own operator-facing route", () => {
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

    const list = await request(server).get("/management/v1/tenants").set("authorization", `Bearer ${token}`);
    expect(list.status).toBe(403);
    expect(list.body.error).toBe("SCOPE_REQUIRED");

    const detail = await request(server).get("/management/v1/tenants/beta-co").set("authorization", `Bearer ${token}`);
    expect(detail.status).toBe(403);

    const users = await request(server).get("/management/v1/tenants/beta-co/users").set("authorization", `Bearer ${token}`);
    expect(users.status).toBe(403);
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
    const res = await request(server).get("/management/v1/tenants").set("authorization", `Bearer ${token}`);
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
    const res = await request(server).get("/management/v1/tenants");
    expect(res.status).toBe(401);
  });
});
