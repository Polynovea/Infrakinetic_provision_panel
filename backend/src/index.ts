import express from "express";

import { LazyDbClient } from "./db/lazyDbClient.js";
import { PgDbClient } from "./db/pgDbClient.js";
import { ConsoleAuditSink } from "./identity/adapters/consoleAuditSink.js";
import { PostgresOperatorDirectory } from "./identity/adapters/postgresOperatorDirectory.js";
import { PostgresSessionStore } from "./identity/adapters/postgresSessionStore.js";
import { CognitoIdentityProvider } from "./identity/providers/cognitoIdentityProvider.js";
import { LazyIdentityProvider } from "./identity/providers/lazyIdentityProvider.js";
import { createManagementRouter } from "./routes/management/index.js";

// 1A.1 — infrastructure-only, still true: no database connection, no calls
// to Infrakinetic's api-server of any kind. /healthz must pass with zero
// dependency of any kind (master plan §7.1/§7.2 exit gate) — it is
// registered before anything below and never touches identity/Cognito.
const app = express();

const HOST = process.env.GOVERNANCE_API_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GOVERNANCE_API_PORT ?? 4100);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "polynovea.platform-governance", phase: "1A.3" });
});

// 1A.3 — the operator directory and session store are now Postgres-backed
// (migrations/0001_operator_identity_schema.sql + 0002_governance_db_foundation.sql),
// replacing 1A.2's in-memory/fixture-seeded interim adapters, exactly as
// docs/1A.2_status.md described ("the adapter seam is designed so 1A.3
// swaps in Postgres-backed implementations without touching the
// middleware, routes, or any test above the adapter layer") — neither
// requireManagementApiAuth, authorize.ts, nor createManagementRouter change
// here. The DB client is constructed lazily (LazyDbClient wrapping
// PgDbClient.fromEnv()), so server boot and /healthz never require
// GOVERNANCE_DB_* to be set — only an actual /management/v1/* request that
// reaches the directory or session store does, and it fails closed with a
// typed DatabaseUnavailableError (503) naming the missing configuration,
// the same fail-closed shape already proven for Cognito. The Cognito
// identity provider remains lazily constructed for the identical reason
// (GOVERNANCE_COGNITO_* provisioning is still pending — see
// docs/1A.2_status.md).
const dbClient = new LazyDbClient(() => PgDbClient.fromEnv());

const managementDeps = {
  identityProvider: new LazyIdentityProvider(() => CognitoIdentityProvider.fromEnv()),
  operatorDirectory: new PostgresOperatorDirectory(dbClient),
  sessionStore: new PostgresSessionStore(dbClient),
  auditSink: new ConsoleAuditSink(),
};

app.use("/management/v1", createManagementRouter(managementDeps));

// Every other route 404s — no other surface exists yet.
app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(PORT, HOST, () => {
  console.log(`PolyNovea Platform Governance backend listening on ${HOST}:${PORT}`);
});
