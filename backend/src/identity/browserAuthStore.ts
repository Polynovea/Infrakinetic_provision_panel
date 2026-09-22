export interface OAuthLoginTransactionRecord {
  transactionHash: string;
  stateHash: string;
  nonce: string;
  codeVerifier: string;
  returnPath: string;
  createdAt: string;
  expiresAt: string;
}

// Phase 1A.12.4 — a step-up transaction is deliberately NOT an
// OAuthLoginTransactionRecord with extra fields: a login transaction's
// success path creates a brand-new session; a step-up transaction's
// success path must only ever annotate an EXISTING operator session
// (recordStepUp) for the SAME Cognito subject it was minted for. Keeping
// the types/storage separate makes "this can never mint a session" a
// structural property, not a runtime check that could be bypassed by a
// future refactor.
export interface StepUpTransactionRecord {
  transactionHash: string;
  stateHash: string;
  nonce: string;
  codeVerifier: string;
  /** The Governance operator session this step-up, if it succeeds, must annotate. */
  boundOperatorSessionId: string;
  /** The Cognito subject the callback's fresh re-auth MUST match — a mismatch fails closed. */
  boundCognitoSub: string;
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
  // Fallback lookup keyed by the OAuth `state` param instead of the
  // governance_oauth cookie. `state` is round-tripped through Cognito on
  // the URL itself and observed to survive even when some browsers discard
  // the cookie across the redirect to Cognito and back (see
  // routes/auth/index.ts's callback handler for why this is safe to use as
  // the primary lookup, with the cookie kept as an additional binding check
  // only when present).
  consumeLoginTransactionByStateHash(stateHash: string): Promise<OAuthLoginTransactionRecord | undefined>;
  createSession(record: NewBrowserSession): Promise<void>;
  findSessionByTokenHash(sessionTokenHash: string): Promise<BrowserSessionRecord | undefined>;
  revokeSession(sessionId: string, reason: string): Promise<void>;

  // Phase 1A.12.4 — step-up transactions (see StepUpTransactionRecord above).
  createStepUpTransaction(record: StepUpTransactionRecord): Promise<void>;
  consumeStepUpTransactionByStateHash(stateHash: string): Promise<StepUpTransactionRecord | undefined>;
}
