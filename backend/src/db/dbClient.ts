// Minimal query surface the identity adapters and migration runner depend
// on. Kept deliberately narrow (not the full `pg.Pool` API) so it can be
// satisfied both by a real `pg.Pool` (pgDbClient.ts) and, in tests, by
// pg-mem's pg-compatible adapter (`newDb().adapters.createPg().Pool`) — the
// same technique 1A.2 used to test Cognito JWT verification against a local
// JWKS instead of a network call to real Cognito.
export interface DbClient {
  query<T extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
}
