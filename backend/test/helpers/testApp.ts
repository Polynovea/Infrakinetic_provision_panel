import express, { type Express } from "express";

import { InMemoryAuditSink } from "../../src/identity/adapters/inMemoryAuditSink.js";
import { InMemoryBrowserAuthStore } from "../../src/identity/adapters/inMemoryBrowserAuthStore.js";
import { InMemoryOperatorDirectory } from "../../src/identity/adapters/inMemoryOperatorDirectory.js";
import { InMemorySessionStore } from "../../src/identity/adapters/inMemorySessionStore.js";
import type { IdentityProvider } from "../../src/identity/identityProvider.js";
import type { OperatorRecord } from "../../src/identity/types.js";
import { createManagementRouter, type ManagementRouterDeps } from "../../src/routes/management/index.js";
import { ManagementOperationLedger } from "../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../src/management/operations/commissionedTenants.js";
import { ManagementApprovalStore } from "../../src/management/operations/managementApprovalStore.js";
import { buildMigratedPgMemClient } from "./pgMemDb.js";

export interface TestAppHandle {
  app: Express;
  auditSink: InMemoryAuditSink;
  sessionStore: InMemorySessionStore;
  browserAuthStore: InMemoryBrowserAuthStore;
}

// 1A.6 deps default to a fresh pg-mem-backed ledger and fixture transport
// config — sufficient for every existing identity/session/authz test in
// this file's other consumers, none of which exercise the engine-state
// routes. Tests that DO need to exercise those routes for real pass their
// own overrides (see test/management/operations/engineStateRoute.test.ts).
export function buildTestApp(
  identityProvider: IdentityProvider,
  operators: readonly OperatorRecord[],
  overrides: Partial<
    Pick<
      ManagementRouterDeps,
      "ledger" | "commissionedTenants" | "approvals" | "getManagementSigningKeys" | "loadTransportConfig" | "infrakineticBaseUrl" | "loadBrowserAuthConfig" | "fetchImpl"
    >
  > = {},
): TestAppHandle {
  const app = express();
  app.use(express.json());
  const auditSink = new InMemoryAuditSink();
  const sessionStore = new InMemorySessionStore();
  const browserAuthStore = new InMemoryBrowserAuthStore();
  const operatorDirectory = new InMemoryOperatorDirectory(operators);
  // A test that needs `ledger`, `commissionedTenants` and `approvals` to
  // share state (e.g. a route test asserting the ledger after a real R3
  // execution) must pass all three overrides together, backed by the same
  // client — see test/routes/management/tenantLifecycleRoutes.test.ts.
  // None overridden: one fresh shared pg-mem client covers all three by
  // default, matching every existing consumer of this helper.
  const defaultClient = overrides.ledger && overrides.commissionedTenants && overrides.approvals ? undefined : buildMigratedPgMemClient().client;
  const ledger = overrides.ledger ?? new ManagementOperationLedger(defaultClient!);
  const commissionedTenants = overrides.commissionedTenants ?? new CommissionedTenantsRepository(defaultClient!);
  const approvals = overrides.approvals ?? new ManagementApprovalStore(defaultClient!);

  app.use(
    "/management/v1",
    createManagementRouter({
      identityProvider,
      operatorDirectory,
      sessionStore,
      auditSink,
      browserAuthStore,
      ledger,
      commissionedTenants,
      approvals,
      getManagementSigningKeys: overrides.getManagementSigningKeys ?? (() => Promise.reject(new Error("management signing keys not configured in this test"))),
      loadTransportConfig: overrides.loadTransportConfig ?? (() => { throw new Error("management transport config not configured in this test"); }),
      infrakineticBaseUrl: overrides.infrakineticBaseUrl ?? "http://127.0.0.1:0",
      loadBrowserAuthConfig: overrides.loadBrowserAuthConfig,
      fetchImpl: overrides.fetchImpl,
    }),
  );

  return { app, auditSink, sessionStore, browserAuthStore };
}
