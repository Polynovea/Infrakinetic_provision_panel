import express, { type Express } from "express";

import { InMemoryAuditSink } from "../../src/identity/adapters/inMemoryAuditSink.js";
import { InMemoryOperatorDirectory } from "../../src/identity/adapters/inMemoryOperatorDirectory.js";
import { InMemorySessionStore } from "../../src/identity/adapters/inMemorySessionStore.js";
import type { IdentityProvider } from "../../src/identity/identityProvider.js";
import type { OperatorRecord } from "../../src/identity/types.js";
import { createManagementRouter } from "../../src/routes/management/index.js";

export interface TestAppHandle {
  app: Express;
  auditSink: InMemoryAuditSink;
  sessionStore: InMemorySessionStore;
}

export function buildTestApp(identityProvider: IdentityProvider, operators: readonly OperatorRecord[]): TestAppHandle {
  const app = express();
  const auditSink = new InMemoryAuditSink();
  const sessionStore = new InMemorySessionStore();
  const operatorDirectory = new InMemoryOperatorDirectory(operators);

  app.use(
    "/management/v1",
    createManagementRouter({ identityProvider, operatorDirectory, sessionStore, auditSink }),
  );

  return { app, auditSink, sessionStore };
}
