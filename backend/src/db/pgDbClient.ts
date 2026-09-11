import pg from "pg";

import { loadDbConfig } from "./dbConfig.js";
import type { DbClient } from "./dbClient.js";
import { DatabaseUnavailableError } from "./errors.js";

const { Pool } = pg;

// Real Postgres-backed DbClient. Never constructed at import time — only via
// fromEnv(), called lazily by LazyDbClient on first actual query, so server
// boot and /healthz never require GOVERNANCE_DB_* to be set (identical
// invariant to identity/providers/cognitoIdentityProvider.ts).
//
// UNVERIFIED AGAINST A REAL POSTGRES SERVER as of 1A.3 — this session has
// no reachable Postgres instance (local or RDS). Tested only against
// pg-mem's pg-compatible adapter (test/db/pgDbClient.test.ts), which
// exercises this exact class's query()/error-wrapping logic with a
// structurally-compatible in-memory Pool substituted for the real one. See
// docs/1A.3_status.md.
export class PgDbClient implements DbClient {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static fromEnv(): PgDbClient {
    const config = loadDbConfig();
    const pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
      max: config.poolMax,
      // Defense in depth alongside `ALTER ROLE governance_app SET
      // search_path = governance` in provisioning/001_create_role_database_and_schema.sql
      // (the authoritative, server-enforced layer — this applies even if a
      // future connection somehow authenticates as a different role).
      // Deliberately excludes `public`: an unqualified reference to a table
      // that only exists in `public` (any Infrakinetic table) must fail to
      // resolve, not silently succeed against the wrong table. Every query
      // in this codebase also schema-qualifies its own table references
      // explicitly (see identity/adapters/postgres*.ts), so this is a
      // second, independent layer, not the only one.
      options: "-c search_path=governance",
    });
    return new PgDbClient(pool);
  }

  async query<T extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    try {
      const result = await this.pool.query<T>(text, params as unknown[] | undefined);
      return { rows: result.rows };
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new DatabaseUnavailableError(`Governance database query failed: ${message}`);
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
