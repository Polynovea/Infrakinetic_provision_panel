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
  overrides: Partial<Pick<ManagementRouterDeps, "ledger" | "commissionedTenants" | "getManagementSigningKeys" | "loadTransportConfig" | "infrakineticBaseUrl">> = {},
): TestAppHandle {
  const app = express();
  app.use(express.json());
  const auditSink = new InMemoryAuditSink();
  const sessionStore = new InMemorySessionStore();
  const browserAuthStore = new InMemoryBrowserAuthStore();
  const operatorDirectory = new InMemoryOperatorDirectory(operators);
  // A test that needs `ledger` and `commissionedTenants` to share state
  // (e.g. a route test asserting the projection after a real mutation)
  // must pass both overrides together, backed by the same client — see
  // test/routes/management/tenantLifecycleRoutes.test.ts. Neither
  // overridden: one fresh shared pg-mem client covers both by default,
  // matching every existing consumer of this helper (none of which
  // exercise the tenant-lifecycle routes).
  const defaultClient = overrides.ledger && overrides.commissionedTenants ? undefined : buildMigratedPgMemClient().client;
  const ledger = overrides.ledger ?? new ManagementOperationLedger(defaultClient!);
  const commissionedTenants = overrides.commissionedTenants ?? new CommissionedTenantsRepository(defaultClient!);

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
      getManagementSigningKeys: overrides.getManagementSigningKeys ?? (() => Promise.reject(new Error("management signing keys not configured in this test"))),
      loadTransportConfig: overrides.loadTransportConfig ?? (() => { throw new Error("management transport config not configured in this test"); }),
      infrakineticBaseUrl: overrides.infrakineticBaseUrl ?? "http://127.0.0.1:0",
    }),
  );

  return { app, auditSink, sessionStore, browserAuthStore };
}
