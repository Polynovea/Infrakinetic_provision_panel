export interface OAuthLoginTransactionRecord {
  transactionHash: string;
  stateHash: string;
  nonce: string;
  codeVerifier: string;
  returnPath: string;
  createdAt: string;
  expiresAt: string;
}

export interface NewBrowserSession {
  sessionId: string;
  sessionTokenHash: string;
  csrfToken: string;
  operatorId: string;
  cognitoSub: string;
  cognitoTokenId: string;
  issuedAt: string;
  expiresAt: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface BrowserSessionRecord extends NewBrowserSession {
  revokedAt?: string;
  revokedReason?: string;
}

/**
 * Browser-auth persistence only. browser_sessions answers which Governance
 * browser session an opaque cookie represents. OperatorSessionStore remains
 * the durable revocation/step-up evidence port used by authorization.
 */
export interface BrowserAuthStore {
  createLoginTransaction(record: OAuthLoginTransactionRecord): Promise<void>;
  consumeLoginTransaction(transactionHash: string): Promise<OAuthLoginTransactionRecord | undefined>;
  createSession(record: NewBrowserSession): Promise<void>;
  findSessionByTokenHash(sessionTokenHash: string): Promise<BrowserSessionRecord | undefined>;
  revokeSession(sessionId: string, reason: string): Promise<void>;
}
