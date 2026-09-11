import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import express from "express";

import { ConsoleAuditSink } from "./identity/adapters/consoleAuditSink.js";
import { InMemoryOperatorDirectory } from "./identity/adapters/inMemoryOperatorDirectory.js";
import { InMemorySessionStore } from "./identity/adapters/inMemorySessionStore.js";
import { CognitoIdentityProvider } from "./identity/providers/cognitoIdentityProvider.js";
import { LazyIdentityProvider } from "./identity/providers/lazyIdentityProvider.js";
import type { OperatorRecord } from "./identity/types.js";
import { createManagementRouter } from "./routes/management/index.js";

// 1A.1 — infrastructure-only, still true: no database connection, no calls
// to Infrakinetic's api-server of any kind. /healthz must pass with zero
// dependency of any kind (master plan §7.1/§7.2 exit gate) — it is
// registered before anything below and never touches identity/Cognito.
const app = express();

const HOST = process.env.GOVERNANCE_API_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GOVERNANCE_API_PORT ?? 4100);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "polynovea.platform-governance", phase: "1A.2" });
});

// 1A.2 — privileged operator identity boundary. The operator directory is
// fixture-seeded (no Governance DB yet — that is 1A.3, see
// docs/1A.2_status.md), and the Cognito identity provider is constructed
// lazily so server boot never requires GOVERNANCE_COGNITO_* to be set while
// real Cognito provisioning is pending authorization.
const operatorsFixturePath = fileURLToPath(new URL("../fixtures/operators.fixture.json", import.meta.url));
const seedOperators = JSON.parse(readFileSync(operatorsFixturePath, "utf8")) as OperatorRecord[];

const managementDeps = {
  identityProvider: new LazyIdentityProvider(() => CognitoIdentityProvider.fromEnv()),
  operatorDirectory: new InMemoryOperatorDirectory(seedOperators),
  sessionStore: new InMemorySessionStore(),
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
