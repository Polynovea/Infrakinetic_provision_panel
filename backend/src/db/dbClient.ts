// Narrow database surface used by Governance. `DbExecutor` is the query
// capability available both on the pool-backed client and on a pinned
// transaction connection. `DbClient.transaction()` is intentionally part of
// the contract so migration code can be atomic without depending on pg.Pool
// implementation details (a sequence of pool.query() calls is NOT a
// transaction because each call may use a different connection).
export interface DbExecutor {
  query<T extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface DbClient extends DbExecutor {
  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T>;
  end?(): Promise<void>;
}
