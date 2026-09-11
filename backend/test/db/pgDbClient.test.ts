import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { PgDbClient } from "../../src/db/pgDbClient.js";
import { DatabaseUnavailableError } from "../../src/db/errors.js";

const DB_ENV_VARS = ["GOVERNANCE_DB_HOST", "GOVERNANCE_DB_NAME", "GOVERNANCE_DB_USER", "GOVERNANCE_DB_PASSWORD"] as const;
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

  it("end() delegates to the underlying pool", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const fakePool = { query: vi.fn(), end } as unknown as pg.Pool;
    const client = new PgDbClient(fakePool);

    await client.end();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
