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

// Same fixture-JWK approach as engineStateOperation.test.ts, kept local to
// this file since it exercises a different layer (the real Express router
// + requireScope, not the orchestration function directly).
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

// This file deliberately only exercises the boundary conditions the route
// itself owns (auth/scope/body-shape validation) — every one of them
// short-circuits before any network call to Infrakinetic. The real
// end-to-end orchestration (real assertions, real HTTP calls against a
// fake Infrakinetic, replay/conflict/effective-observation) is fully
// covered in engineStateOperation.test.ts, which calls
// requestEngineStateChange() directly with an injectable fetchImpl — this
// route wiring has no such injection point (matching production, which
// always uses the real network), so a success-path HTTP test here would
// need a real reachable Infrakinetic and belongs at live certification
// instead.

describe("PUT /management/v1/engine-state/:engineKey — Governance's own operator-facing route", () => {
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
    const op = activeAdminOperator({ scopes: overrides.scopes ?? ["engines.read", "engines.platform_state.write"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    return { server, op };
  }

  it("valid operator missing engines.platform_state.write scope -> 403 before any orchestration runs", async () => {
    const op = activeAdminOperator({ scopes: ["engines.read"] }); // missing engines.platform_state.write
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put("/management/v1/engine-state/module_ai")
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", desiredState: "disabled", reason: "x", recoveryIntent: "y" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });

  it("missing idempotencyKey -> 400, before any orchestration runs", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put("/management/v1/engine-state/module_ai")
      .set("authorization", `Bearer ${token}`)
      .send({ desiredState: "disabled", reason: "x", recoveryIntent: "y" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("missing reason -> 400", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put("/management/v1/engine-state/module_ai")
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", desiredState: "disabled", recoveryIntent: "y" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("REASON_REQUIRED");
  });

  it("invalid desired state -> 400", async () => {
    const { server, op } = appWithAdmin();
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put("/management/v1/engine-state/module_ai")
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", desiredState: "on_fire", reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_DESIRED_STATE");
  });

  it("a viewer-role operator (no engines.platform_state.write in their ceiling) is rejected", async () => {
    const op = activeViewerOperator({ scopes: ["tenants.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.resolve(signingKeys),
      loadTransportConfig: () => TRANSPORT_CONFIG,
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .put("/management/v1/engine-state/module_ai")
      .set("authorization", `Bearer ${token}`)
      .send({ idempotencyKey: "k1", desiredState: "disabled", reason: "x", recoveryIntent: "y" });
    expect(res.status).toBe(403);
  });

  it("no assertion at all -> 401", async () => {
    const { server } = appWithAdmin();
    const res = await request(server)
      .put("/management/v1/engine-state/module_ai")
      .send({ idempotencyKey: "k1", desiredState: "disabled", reason: "x", recoveryIntent: "y" });
    expect(res.status).toBe(401);
  });
});

describe("GET /management/v1/operations/:operationId", () => {
  it("returns 404 for an unknown operation id", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const client = buildMigratedPgMemClient().client;
    const ledger = new ManagementOperationLedger(client);
    const op = activeAdminOperator({ scopes: ["engines.read"] });
    const { app: server } = buildTestApp(provider, [op], {
      ledger,
      getManagementSigningKeys: () => Promise.reject(new Error("not used")),
      loadTransportConfig: () => {
        throw new Error("not used");
      },
      infrakineticBaseUrl: "http://127.0.0.1:0",
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server)
      .get("/management/v1/operations/00000000-0000-4000-8000-000000000000")
      .set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
