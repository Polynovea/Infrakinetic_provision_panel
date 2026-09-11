import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

const PoolMock = vi.fn().mockImplementation(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
}));
vi.mock("pg", () => ({ default: { Pool: PoolMock } }));

const { PgDbClient } = await import("../../src/db/pgDbClient.js");
const { DatabaseUnavailableError } = await import("../../src/db/errors.js");

const DB_ENV_VARS = [
  "GOVERNANCE_DB_HOST",
  "GOVERNANCE_DB_NAME",
  "GOVERNANCE_DB_USER",
  "GOVERNANCE_DB_PASSWORD",
  "GOVERNANCE_DB_SSL",
  "GOVERNANCE_DB_SSL_CA_FILE",
  "GOVERNANCE_DB_SSL_SERVERNAME",
] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("db/pgDbClient", () => {
  beforeEach(() => {
    for (const key of DB_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of DB_ENV_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("fromEnv() throws DatabaseUnavailableError (not a raw pg connection attempt) when config is missing", () => {
    expect(() => PgDbClient.fromEnv()).toThrow(DatabaseUnavailableError);
  });

  describe("fromEnv() TLS configuration passed to pg.Pool", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "pgdbclient-tls-test-"));
      PoolMock.mockClear();
      process.env.GOVERNANCE_DB_HOST = "127.0.0.1";
      process.env.GOVERNANCE_DB_NAME = "db";
      process.env.GOVERNANCE_DB_USER = "u";
      process.env.GOVERNANCE_DB_PASSWORD = "p";
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("SSL disabled: passes ssl: undefined to pg.Pool", () => {
      process.env.GOVERNANCE_DB_SSL = "false";

      PgDbClient.fromEnv();

      expect(PoolMock).toHaveBeenCalledTimes(1);
      expect(PoolMock.mock.calls[0][0].ssl).toBeUndefined();
    });

    it("SSL enabled with a CA bundle and servername: rejectUnauthorized stays true, ca and servername are passed through", () => {
      const caPath = join(tmpDir, "ca.pem");
      writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
      process.env.GOVERNANCE_DB_SSL = "true";
      process.env.GOVERNANCE_DB_SSL_CA_FILE = caPath;
      process.env.GOVERNANCE_DB_SSL_SERVERNAME = "real-rds-host.example.com";

      PgDbClient.fromEnv();

      expect(PoolMock).toHaveBeenCalledTimes(1);
      const ssl = PoolMock.mock.calls[0][0].ssl;
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.ca).toContain("BEGIN CERTIFICATE");
      expect(ssl.servername).toBe("real-rds-host.example.com");
    });

    it("SSL enabled with neither CA nor servername set: rejectUnauthorized stays true with no extra fields", () => {
      process.env.GOVERNANCE_DB_SSL = "true";

      PgDbClient.fromEnv();

      const ssl = PoolMock.mock.calls[0][0].ssl;
      expect(ssl).toEqual({ rejectUnauthorized: true });
    });
  });

  it("query() passes through rows on success", async () => {
    const fakePool = {
      query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
    } as unknown as pg.Pool;
    const client = new PgDbClient(fakePool);

    const result = await client.query("SELECT 1 as ok");
    expect(result.rows).toEqual([{ ok: 1 }]);
  });

  it("query() wraps a driver-level failure as a typed DatabaseUnavailableError (fail-closed, not a raw 500)", async () => {
    const fakePool = {
      query: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as pg.Pool;
    const client = new PgDbClient(fakePool);

    await expect(client.query("SELECT 1")).rejects.toThrow(DatabaseUnavailableError);
    await expect(client.query("SELECT 1")).rejects.toThrow(/connection refused/);
  });

  it("transaction() pins one pool client and commits on success", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    const fakePool = { connect, query: vi.fn(), end: vi.fn() } as unknown as pg.Pool;
    const client = new PgDbClient(fakePool);

    const result = await client.transaction(async (tx) => {
      await tx.query("SELECT 42");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "SELECT 42", "COMMIT"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("transaction() rolls back and releases the pinned client when work fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "SELECT explode") throw new Error("boom");
      return { rows: [] };
    });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    const fakePool = { connect, query: vi.fn(), end: vi.fn() } as unknown as pg.Pool;
    const client = new PgDbClient(fakePool);

    await expect(
      client.transaction(async (tx) => {
        await tx.query("SELECT explode");
      }),
    ).rejects.toThrow(DatabaseUnavailableError);

    expect(query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "SELECT explode", "ROLLBACK"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("transaction() destroys the pinned client when rollback itself fails", async () => {
    const rollbackError = new Error("socket closed during rollback");
    const query = vi.fn(async (sql: string) => {
      if (sql === "SELECT explode") throw new Error("original operation failure");
      if (sql === "ROLLBACK") throw rollbackError;
      return { rows: [] };
    });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    const fakePool = { connect, query: vi.fn(), end: vi.fn() } as unknown as pg.Pool;
    const client = new PgDbClient(fakePool);

    await expect(
      client.transaction(async (tx) => {
        await tx.query("SELECT explode");
      }),
    ).rejects.toThrow(/original operation failure/);

    expect(query.mock.calls.map((call) => call[0])).toEqual(["BEGIN", "SELECT explode", "ROLLBACK"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(rollbackError);
  });

  it("end() delegates to the underlying pool", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const fakePool = { query: vi.fn(), end } as unknown as pg.Pool;
    const client = new PgDbClient(fakePool);

    await client.end();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
