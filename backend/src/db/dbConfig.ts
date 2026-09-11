import { DatabaseUnavailableError } from "./errors.js";

// 1A.3 — Governance database connection configuration. Every value comes
// from the environment; nothing is a hardcoded host, database name,
// username or password. CORRECTED 2026-09-11: Phase 1A Governance connects
// to the SAME existing production database Infrakinetic uses (so
// GOVERNANCE_DB_NAME/HOST/PORT are expected to match Infrakinetic's own —
// that is not a violation of README.md hard rule #2, which is about the
// *credential*, i.e. GOVERNANCE_DB_USER/PASSWORD, never being Infrakinetic's
// application role; isolation is the dedicated `governance_app` role/schema,
// not a distinct database). There is still no default value here for any
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

export function loadDbConfig(): DbConfig {
  const host = required("GOVERNANCE_DB_HOST");
  const port = optionalPositiveInt("GOVERNANCE_DB_PORT", 5432);
  const database = required("GOVERNANCE_DB_NAME");
  const user = required("GOVERNANCE_DB_USER");
  const password = required("GOVERNANCE_DB_PASSWORD");
  // Defaults to true (encrypted by default); explicit opt-out only for local
  // development against a Postgres instance with no TLS configured.
  const ssl = optionalBool("GOVERNANCE_DB_SSL", true);
  const poolMax = optionalPositiveInt("GOVERNANCE_DB_POOL_MAX", 10);

  return { host, port, database, user, password, ssl, poolMax };
}
