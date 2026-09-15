import type {
  BrowserAuthStore,
  BrowserSessionRecord,
  NewBrowserSession,
  OAuthLoginTransactionRecord,
} from "../browserAuthStore.js";

export class InMemoryBrowserAuthStore implements BrowserAuthStore {
  private readonly transactions = new Map<string, OAuthLoginTransactionRecord>();
  private readonly sessionsByHash = new Map<string, BrowserSessionRecord>();

  async createLoginTransaction(record: OAuthLoginTransactionRecord): Promise<void> {
    this.transactions.set(record.transactionHash, { ...record });
  }

  async consumeLoginTransaction(transactionHash: string): Promise<OAuthLoginTransactionRecord | undefined> {
    const record = this.transactions.get(transactionHash);
    if (!record) return undefined;
    this.transactions.delete(transactionHash);
    if (new Date(record.expiresAt).getTime() <= Date.now()) return undefined;
    return { ...record };
  }

  async consumeLoginTransactionByStateHash(stateHash: string): Promise<OAuthLoginTransactionRecord | undefined> {
    for (const [hash, record] of this.transactions) {
      if (record.stateHash !== stateHash) continue;
      this.transactions.delete(hash);
      if (new Date(record.expiresAt).getTime() <= Date.now()) return undefined;
      return { ...record };
    }
    return undefined;
  }

  async createSession(record: NewBrowserSession): Promise<void> {
    this.sessionsByHash.set(record.sessionTokenHash, { ...record });
  }

  async findSessionByTokenHash(sessionTokenHash: string): Promise<BrowserSessionRecord | undefined> {
    const record = this.sessionsByHash.get(sessionTokenHash);
    if (!record || record.revokedAt || new Date(record.expiresAt).getTime() <= Date.now()) return undefined;
    return { ...record };
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    for (const [hash, record] of this.sessionsByHash) {
      if (record.sessionId !== sessionId) continue;
      this.sessionsByHash.set(hash, {
        ...record,
        revokedAt: new Date().toISOString(),
        revokedReason: reason,
      });
      return;
    }
  }
}
