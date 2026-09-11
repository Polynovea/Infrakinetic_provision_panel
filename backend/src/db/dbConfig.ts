import { readFileSync } from "node:fs";

import { DatabaseUnavailableError } from "./errors.js";

// 1A.3 — Governance database connection configuration. Every value comes
// from the environment; nothing is a hardcoded host, database name,
// username or password (README.md hard rule #2: no shared database
// credentials with Infrakinetic's business database). Phase 1A Governance
// runs on the SAME RDS instance as Infrakinetic but a SEPARATE database
// (`polynovea_governance`, never `polynoveacrm`) and a separate role
// (`governance_app`) — see docs/1A.3_status.md "Architecture correction"
// for the full record (this was wrong in an earlier revision, which
// assumed sharing Infrakinetic's own database with only a schema for
// isolation; that was corrected). There is no default value here for any
// field, so nothing here could silently coincide with a real value by
// accident. This module is only ever called lazily, at first real database
// use (see lazyDbClient.ts) — never at import time — so `npm run
// build`/`typecheck` and the /healthz path never require these variables to
// be set, matching the identical invariant already established for Cognito
// (identity/cognitoConfig.ts) and the original 1A.1 zero-dependency health
// check.

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  // Trusted CA bundle contents (e.g. the Amazon RDS combined CA bundle),
  // read once at config-load time. Required for real certificate
  // verification when the client reaches the server through an SSH tunnel
  // (host is the local tunnel endpoint, e.g. 127.0.0.1) rather than the
  // real hostname the server's certificate was issued for.
  sslCa: string | undefined;
  // Overrides the hostname used for TLS certificate verification (SNI +
  // subjectAltName/CN matching). Needed whenever `host` is a tunnel/proxy
  // address rather than the server's own real DNS name — without this,
  // certificate verification would check the wrong hostname and either
  // fail or (worse) silently match nothing meaningful.
  sslServername: string | undefined;
  poolMax: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new DatabaseUnavailableError(
      `Missing required environment variable ${name}. Phase 1A.3 database ` +
        `access cannot start until the Governance database exists and its ` +
        `host/port/name/credentials are provided via environment ` +
        `configuration — see docs/1A.3_status.md and backend/provisioning/README.md.`,
    );
  }
  return value;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new DatabaseUnavailableError(`${name} must be "true" or "false" if set.`);
}

function optionalPositiveInt(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DatabaseUnavailableError(`${name} must be a positive integer if set.`);
  }
  return parsed;
}

function optionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

// Reads the trusted CA bundle from disk once, at config-load time (same
// lazy-on-first-use posture as every other value here). Fails closed: a
// configured path that cannot be read must never silently fall back to an
// unverified connection.
function optionalCaFile(name: string): string | undefined {
  const path = optionalString(name);
  if (path === undefined) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DatabaseUnavailableError(
      `${name} is set to "${path}" but the CA bundle could not be read: ${message}`,
    );
  }
}

export function loadDbConfig(): DbConfig {
  const host = required("GOVERNANCE_DB_HOST");
  const port = optionalPositiveInt("GOVERNANCE_DB_PORT", 5432);
  const database = required("GOVERNANCE_DB_NAME");
  const user = required("GOVERNANCE_DB_USER");
  const password = required("GOVERNANCE_DB_PASSWORD");
  // Defaults to true (encrypted by default); explicit opt-out only for local
  // development against a Postgres instance with no TLS configured.
  const ssl = optionalBool("GOVERNANCE_DB_SSL", true);
  // Trusted CA bundle for real certificate verification (e.g. the Amazon RDS
  // combined CA bundle) and an optional hostname override for verification
  // when `host` is a local SSH-tunnel endpoint rather than the server's own
  // DNS name. Both optional; rejectUnauthorized stays true regardless (see
  // pgDbClient.ts) — these only supply what strict verification needs.
  const sslCa = optionalCaFile("GOVERNANCE_DB_SSL_CA_FILE");
  const sslServername = optionalString("GOVERNANCE_DB_SSL_SERVERNAME");
  const poolMax = optionalPositiveInt("GOVERNANCE_DB_POOL_MAX", 10);

  return { host, port, database, user, password, ssl, sslCa, sslServername, poolMax };
}
