import type { DbClient } from "../../db/dbClient.js";
import type {
  BrowserAuthStore,
  BrowserSessionRecord,
  NewBrowserSession,
  OAuthLoginTransactionRecord,
} from "../browserAuthStore.js";

interface OAuthRow {
  transaction_hash: string;
  state_hash: string;
  nonce: string;
  code_verifier: string;
  return_path: string;
  created_at: string;
  expires_at: string;
}

interface SessionRow {
  session_id: string;
  session_token_hash: string;
  csrf_token: string;
  operator_id: string;
  cognito_sub: string;
  cognito_token_jti: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export class PostgresBrowserAuthStore implements BrowserAuthStore {
  constructor(private readonly db: DbClient) {}

  async createLoginTransaction(record: OAuthLoginTransactionRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO governance.oauth_login_transactions
       (transaction_hash, state_hash, nonce, code_verifier, return_path, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [record.transactionHash, record.stateHash, record.nonce, record.codeVerifier, record.returnPath, record.createdAt, record.expiresAt],
    );
  }

  async consumeLoginTransaction(transactionHash: string): Promise<OAuthLoginTransactionRecord | undefined> {
    const result = await this.db.query<OAuthRow>(
      `UPDATE governance.oauth_login_transactions
       SET consumed_at = now()
       WHERE transaction_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING transaction_hash, state_hash, nonce, code_verifier, return_path, created_at, expires_at`,
      [transactionHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      transactionHash: row.transaction_hash,
      stateHash: row.state_hash,
      nonce: row.nonce,
      codeVerifier: row.code_verifier,
      returnPath: row.return_path,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  async createSession(record: NewBrowserSession): Promise<void> {
    await this.db.query(
      `INSERT INTO governance.browser_sessions
       (session_id, session_token_hash, csrf_token, operator_id, cognito_sub, cognito_token_jti,
        issued_at, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.sessionId,
        record.sessionTokenHash,
        record.csrfToken,
        record.operatorId,
        record.cognitoSub,
        record.cognitoTokenId,
        record.issuedAt,
        record.expiresAt,
        record.ipAddress ?? null,
        record.userAgent ?? null,
      ],
    );
  }

  async findSessionByTokenHash(sessionTokenHash: string): Promise<BrowserSessionRecord | undefined> {
    const result = await this.db.query<SessionRow>(
      `SELECT session_id, session_token_hash, csrf_token, operator_id, cognito_sub, cognito_token_jti,
              issued_at, expires_at, revoked_at, revoked_reason, ip_address, user_agent
       FROM governance.browser_sessions
       WHERE session_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [sessionTokenHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      sessionTokenHash: row.session_token_hash,
      csrfToken: row.csrf_token,
      operatorId: row.operator_id,
      cognitoSub: row.cognito_sub,
      cognitoTokenId: row.cognito_token_jti,
      issuedAt: new Date(row.issued_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
      revokedReason: row.revoked_reason ?? undefined,
      ipAddress: row.ip_address ?? undefined,
      userAgent: row.user_agent ?? undefined,
    };
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE governance.browser_sessions SET revoked_at = now(), revoked_reason = $2
       WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
  }
}
