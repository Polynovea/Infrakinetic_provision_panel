import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { DatabaseUnavailableError } from "../../src/db/errors.js";
import { InMemoryAuditSink } from "../../src/identity/adapters/inMemoryAuditSink.js";
import { InMemoryOperatorDirectory } from "../../src/identity/adapters/inMemoryOperatorDirectory.js";
import { InMemorySessionStore } from "../../src/identity/adapters/inMemorySessionStore.js";
import type { CognitoIdentityProvider } from "../../src/identity/providers/cognitoIdentityProvider.js";
import type { OperatorSessionStore } from "../../src/identity/sessionStore.js";
import { createManagementRouter } from "../../src/routes/management/index.js";
import { ManagementOperationLedger } from "../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../src/management/operations/commissionedTenants.js";
import { ManagementApprovalStore } from "../../src/management/operations/managementApprovalStore.js";
import { activeAdminOperator } from "../helpers/operators.js";
import { buildTestIdentityProvider } from "../helpers/testProvider.js";
import { buildMigratedPgMemClient } from "../helpers/pgMemDb.js";
import { generateTestKeyPair, signTestToken, type TestKeyPair } from "../helpers/testToken.js";

// Neither test in this file exercises the 1A.6 engine-state routes — these
// stand in only to satisfy ManagementRouterDeps.
const unusedEngineStateDeps = {
  ledger: new ManagementOperationLedger(buildMigratedPgMemClient().client),
  commissionedTenants: new CommissionedTenantsRepository(buildMigratedPgMemClient().client),
  approvals: new ManagementApprovalStore(buildMigratedPgMemClient().client),
  getManagementSigningKeys: () => Promise.reject(new Error("not used in this test")),
  loadTransportConfig: () => {
    throw new Error("not used in this test");
  },
  infrakineticBaseUrl: "http://127.0.0.1:0",
};

// Proves the 1A.3 fail-closed contract end-to-end through a real Express
// router: a valid, correctly-issued operator token still gets a clean,
// typed 503 (not an unhandled 500, not a silent allow) when the operator
// directory cannot reach the Governance database — exactly the same shape
// already proven for a misconfigured Cognito provider in 1A.2
// (IDENTITY_PROVIDER_MISCONFIGURED). This exercises the real
// requireManagementApiAuth catch path with an operatorDirectory that throws
// DatabaseUnavailableError, standing in for GOVERNANCE_DB_* being unset or
// the database being unreachable — this session cannot reach a real
// Postgres server to reproduce this any other way (see docs/1A.3_status.md).
describe("requireManagementApiAuth — Governance DB unavailable (fail-closed)", () => {
  let keyPair: TestKeyPair;
  let provider: CognitoIdentityProvider;

  beforeEach(async () => {
    keyPair = await generateTestKeyPair();
    provider = buildTestIdentityProvider(keyPair);
  });

  it("returns 503 GOVERNANCE_DB_UNAVAILABLE for a structurally valid token when the operator directory cannot reach the database", async () => {
    const app = express();
    const alwaysUnavailable = {
      findByCognitoSub: async () => {
        throw new DatabaseUnavailableError("Missing required environment variable GOVERNANCE_DB_HOST.");
      },
      activatePendingOperator: async () => {
        throw new DatabaseUnavailableError("Missing required environment variable GOVERNANCE_DB_HOST.");
      },
    };
    app.use(
      "/management/v1",
      createManagementRouter({
        identityProvider: provider,
        operatorDirectory: alwaysUnavailable,
        sessionStore: new InMemorySessionStore(),
        auditSink: new InMemoryAuditSink(),
        ...unusedEngineStateDeps,
      }),
    );

    const token = await signTestToken(keyPair, { subject: "any-sub" });
    const res = await request(app).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("GOVERNANCE_DB_UNAVAILABLE");
    // No operator context leaked, no default-allow.
    expect(res.body).not.toHaveProperty("operator");
  });

  it("returns typed 503 when the DB fails after authentication during logout", async () => {
    const app = express();
    const op = activeAdminOperator();
    const sessionStore: OperatorSessionStore = {
      isRevoked: async () => false,
      revoke: async () => {
        throw new DatabaseUnavailableError("database connection dropped during logout");
      },
      recordStepUp: async () => undefined,
      getStepUp: async () => undefined,
    };
    const auditSink = new InMemoryAuditSink();

    app.use(
      "/management/v1",
      createManagementRouter({
        identityProvider: provider,
        operatorDirectory: new InMemoryOperatorDirectory([op]),
        sessionStore,
        auditSink,
        ...unusedEngineStateDeps,
      }),
    );

    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(app)
      .post("/management/v1/session/logout")
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("GOVERNANCE_DB_UNAVAILABLE");
    expect(
      auditSink.events.some(
        (event) => event.eventType === "authz.denied" && event.reasonCode === "GOVERNANCE_DB_UNAVAILABLE",
      ),
    ).toBe(true);
  });
});
