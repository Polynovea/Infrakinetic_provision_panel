import pg from "pg";

import { loadDbConfig } from "./dbConfig.js";
import type { DbClient, DbExecutor } from "./dbClient.js";
import { DatabaseUnavailableError } from "./errors.js";

const { Pool } = pg;

function wrapDbError(err: unknown): DatabaseUnavailableError {
  if (err instanceof DatabaseUnavailableError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DatabaseUnavailableError(`Governance database query failed: ${message}`);
}

// Real Postgres-backed DbClient. Never constructed at import time — only via
// fromEnv(), called lazily by LazyDbClient on first actual query, so server
// boot and /healthz never require GOVERNANCE_DB_* to be set.
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
      // Defense in depth alongside ALTER ROLE governance_app SET
      // search_path=governance. Every application query remains schema-
      // qualified as well.
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
      throw wrapDbError(err);
    }
  }

  async transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw wrapDbError(err);
    }

    const tx: DbExecutor = {
      query: async <R extends object = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<{ rows: R[] }> => {
        try {
          const result = await client.query<R>(text, params as unknown[] | undefined);
          return { rows: result.rows };
        } catch (err) {
          throw wrapDbError(err);
        }
      },
    };

    try {
      await client.query("BEGIN");
      const result = await work(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure. A broken rollback means the
        // connection is discarded/released below; callers still receive the
        // operation failure that caused the rollback attempt.
      }
      throw wrapDbError(err);
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
