import type { DbClient, DbExecutor } from "./dbClient.js";

// Defers construction of the wrapped DbClient (and therefore validation of
// GOVERNANCE_DB_* env vars) until the first real database operation. Server
// startup and /healthz never depend on the Governance database existing.
export class LazyDbClient implements DbClient {
  private instance: DbClient | undefined;

  constructor(private readonly factory: () => DbClient) {}

  private resolve(): DbClient {
    if (!this.instance) {
      this.instance = this.factory();
    }
    return this.instance;
  }

  async query<T extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }> {
    return this.resolve().query<T>(text, params);
  }

  async transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.resolve().transaction(work);
  }

  async end(): Promise<void> {
    await this.instance?.end?.();
  }
}
