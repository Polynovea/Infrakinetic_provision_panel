import express from "express";

import { LazyDbClient } from "./db/lazyDbClient.js";
import { PgDbClient } from "./db/pgDbClient.js";
import { ConsoleAuditSink } from "./identity/adapters/consoleAuditSink.js";
import { PostgresBrowserAuthStore } from "./identity/adapters/postgresBrowserAuthStore.js";
import { PostgresOperatorDirectory } from "./identity/adapters/postgresOperatorDirectory.js";
import { PostgresSessionStore } from "./identity/adapters/postgresSessionStore.js";
import { CognitoIdentityProvider } from "./identity/providers/cognitoIdentityProvider.js";
import { LazyIdentityProvider } from "./identity/providers/lazyIdentityProvider.js";
import { getManagementSigningKeysLazy } from "./management/lazyManagementKeys.js";
import { buildManagementJwks } from "./management/managementJwks.js";
import { loadManagementTransportConfig } from "./management/managementConfig.js";
import { ManagementOperationLedger } from "./management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "./management/operations/commissionedTenants.js";
import { ManagementApprovalStore } from "./management/operations/managementApprovalStore.js";
import { createBrowserAuthRouter } from "./routes/auth/index.js";
import { createManagementRouter } from "./routes/management/index.js";
import { DatabaseUnavailableError } from "./db/errors.js";

// 1A.1 — infrastructure-only, still true: no database connection, no calls
// to Infrakinetic's api-server of any kind. /healthz must pass with zero
// dependency of any kind (master plan §7.1/§7.2 exit gate) — it is
// registered before anything below and never touches identity/Cognito.
const app = express();

const HOST = process.env.GOVERNANCE_API_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GOVERNANCE_API_PORT ?? 4100);
const FRONTEND_ORIGIN =
  process.env.GOVERNANCE_FRONTEND_ORIGIN?.trim() ||
  (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : undefined);

app.set("trust proxy", 1);

app.use((req, res, next) => {
  const origin = req.header("origin");
  if (origin) {
    if (!FRONTEND_ORIGIN || origin !== FRONTEND_ORIGIN) {
      res.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
      return;
    }
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "content-type, x-governance-csrf, x-correlation-id, authorization");
    res.header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: "64kb" }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "polynovea.platform-governance" });
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
const identityProvider = new LazyIdentityProvider(() => CognitoIdentityProvider.fromEnv());
const operatorDirectory = new PostgresOperatorDirectory(dbClient);
const sessionStore = new PostgresSessionStore(dbClient);
const browserAuthStore = new PostgresBrowserAuthStore(dbClient);
const auditSink = new ConsoleAuditSink();

// 1A.6 — reuses the exact same lazy dbClient/signing-keys singletons this
// file already constructs for the identity adapters and the JWKS endpoint;
// no second database connection, no second key-loading path.
const managementDeps = {
  identityProvider,
  operatorDirectory,
  sessionStore,
  browserAuthStore,
  auditSink,
  ledger: new ManagementOperationLedger(dbClient),
  commissionedTenants: new CommissionedTenantsRepository(dbClient),
  approvals: new ManagementApprovalStore(dbClient),
  getManagementSigningKeys: getManagementSigningKeysLazy,
  loadTransportConfig: loadManagementTransportConfig,
  infrakineticBaseUrl: process.env.INFRAKINETIC_MANAGEMENT_BASE_URL ?? "http://127.0.0.1:4000",
};

app.use("/auth", createBrowserAuthRouter({ identityProvider, operatorDirectory, browserAuthStore, auditSink }));
app.use("/management/v1", createManagementRouter(managementDeps));

// 1A.4 — public verification material for the assertions Governance mints
// for Infrakinetic's `/management/v1/*`. Deliberately unauthenticated, same
// as any JWKS endpoint (Cognito's own included) — the security boundary is
// the signature check on the other end, not secrecy of the public key.
// Lazily loaded: GOVERNANCE_MANAGEMENT_SIGNING_* is not required for server
// boot or /healthz, only for a request that reaches this route.
app.get("/.well-known/management-jwks.json", async (_req, res, next) => {
  try {
    const keys = await getManagementSigningKeysLazy();
    res.status(200).json(buildManagementJwks(keys));
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      res.status(err.httpStatus).json({ error: err.code, message: err.message });
      return;
    }
    next(err);
  }
});

// Every other route 404s — no other surface exists yet.
app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(PORT, HOST, () => {
  console.log(`PolyNovea Platform Governance backend listening on ${HOST}:${PORT}`);
});
