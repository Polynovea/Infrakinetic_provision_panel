import express, { type Express } from "express";

import { InMemoryAuditSink } from "../../src/identity/adapters/inMemoryAuditSink.js";
import { InMemoryOperatorDirectory } from "../../src/identity/adapters/inMemoryOperatorDirectory.js";
import { InMemorySessionStore } from "../../src/identity/adapters/inMemorySessionStore.js";
import type { IdentityProvider } from "../../src/identity/identityProvider.js";
import type { OperatorRecord } from "../../src/identity/types.js";
import { createManagementRouter, type ManagementRouterDeps } from "../../src/routes/management/index.js";
import { ManagementOperationLedger } from "../../src/management/operations/managementOperationLedger.js";
import { buildMigratedPgMemClient } from "./pgMemDb.js";

export interface TestAppHandle {
  app: Express;
  auditSink: InMemoryAuditSink;
  sessionStore: InMemorySessionStore;
}

// 1A.6 deps default to a fresh pg-mem-backed ledger and fixture transport
// config — sufficient for every existing identity/session/authz test in
// this file's other consumers, none of which exercise the engine-state
// routes. Tests that DO need to exercise those routes for real pass their
// own overrides (see test/management/operations/engineStateRoute.test.ts).
export function buildTestApp(
  identityProvider: IdentityProvider,
  operators: readonly OperatorRecord[],
  overrides: Partial<Pick<ManagementRouterDeps, "ledger" | "getManagementSigningKeys" | "loadTransportConfig" | "infrakineticBaseUrl">> = {},
): TestAppHandle {
  const app = express();
  app.use(express.json());
  const auditSink = new InMemoryAuditSink();
  const sessionStore = new InMemorySessionStore();
  const operatorDirectory = new InMemoryOperatorDirectory(operators);
  const ledger = overrides.ledger ?? new ManagementOperationLedger(buildMigratedPgMemClient().client);

  app.use(
    "/management/v1",
    createManagementRouter({
      identityProvider,
      operatorDirectory,
      sessionStore,
      auditSink,
      ledger,
      getManagementSigningKeys: overrides.getManagementSigningKeys ?? (() => Promise.reject(new Error("management signing keys not configured in this test"))),
      loadTransportConfig: overrides.loadTransportConfig ?? (() => { throw new Error("management transport config not configured in this test"); }),
      infrakineticBaseUrl: overrides.infrakineticBaseUrl ?? "http://127.0.0.1:0",
    }),
  );

  return { app, auditSink, sessionStore };
}
