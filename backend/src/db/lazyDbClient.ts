import type { DbClient } from "./dbClient.js";

// Defers construction of the wrapped DbClient (and therefore validation of
// GOVERNANCE_DB_* env vars) until the first query, exactly mirroring
// identity/providers/lazyIdentityProvider.ts for Cognito. Server startup and
// /healthz never depend on the Governance database existing — only an
// actual /management/v1/* request that reaches the operator directory or
// session store does, and it fails closed with a typed
// DatabaseUnavailableError (503) rather than crashing the process.
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

  async end(): Promise<void> {
    await this.instance?.end?.();
  }
}
