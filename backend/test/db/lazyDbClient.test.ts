import { describe, expect, it, vi } from "vitest";

import { LazyDbClient } from "../../src/db/lazyDbClient.js";
import type { DbClient } from "../../src/db/dbClient.js";

function fakeClient(): DbClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    transaction: vi.fn(async (work) => work({ query: vi.fn().mockResolvedValue({ rows: [] }) })),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("db/lazyDbClient", () => {
  it("does not call the factory until the first query", () => {
    const factory = vi.fn(fakeClient);
    // eslint-disable-next-line no-new
    new LazyDbClient(factory);
    expect(factory).not.toHaveBeenCalled();
  });

  it("constructs the wrapped client exactly once, on first use, and reuses it", async () => {
    const factory = vi.fn(fakeClient);
    const lazy = new LazyDbClient(factory);

    await lazy.query("SELECT 1");
    await lazy.query("SELECT 2");

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("propagates a construction error from the factory (e.g. missing GOVERNANCE_DB_* config)", async () => {
    const lazy = new LazyDbClient(() => {
      throw new Error("boom");
    });

    await expect(lazy.query("SELECT 1")).rejects.toThrow("boom");
  });

  it("end() is a no-op if the underlying client was never constructed", async () => {
    const factory = vi.fn(fakeClient);
    const lazy = new LazyDbClient(factory);

    await expect(lazy.end()).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("end() delegates to the underlying client once it has been constructed", async () => {
    const client = fakeClient();
    const lazy = new LazyDbClient(() => client);

    await lazy.query("SELECT 1");
    await lazy.end();

    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
