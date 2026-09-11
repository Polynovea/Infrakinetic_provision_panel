import type { DbClient } from "../../db/dbClient.js";
import type { OperatorSessionStore } from "../sessionStore.js";
import type { StepUpState } from "../types.js";

interface SessionRow {
  revoked_at: string | null;
  step_up_at: string | null;
  step_up_method: string | null;
}

// 1A.3 — Postgres-backed OperatorSessionStore, against the schema in
// migrations/0001_operator_identity_schema.sql as corrected by migration
// 0002 (see that file's header for why operator_id/issued_at/expires_at had
// to become nullable: the OperatorSessionStore port never carries them,
// because 1A.2 does not mint a separate management assertion with its own
// issuance event — "session" is just the verified token's own jti, and
// revoke()/recordStepUp() may be the first write ever made for a given
// session id).
//
// revoke() and recordStepUp() therefore UPSERT by session_id rather than
// UPDATE an existing row, because no prior row is guaranteed to exist.
//
// UNVERIFIED AGAINST A REAL POSTGRES SERVER as of 1A.3. Tested against
// pg-mem's pg-compatible adapter in
// test/identity/postgresSessionStore.test.ts. See docs/1A.3_status.md.
export class PostgresSessionStore implements OperatorSessionStore {
  constructor(private readonly db: DbClient) {}

  async isRevoked(sessionId: string): Promise<boolean> {
    const result = await this.db.query<SessionRow>(
      "SELECT revoked_at, step_up_at, step_up_method FROM operator_sessions WHERE session_id = $1",
      [sessionId],
    );
    return result.rows[0]?.revoked_at != null;
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.db.query(
      `INSERT INTO operator_sessions (session_id, revoked_at, revoked_reason)
       VALUES ($1, now(), $2)
       ON CONFLICT (session_id) DO UPDATE
       SET revoked_at = EXCLUDED.revoked_at, revoked_reason = EXCLUDED.revoked_reason`,
      [sessionId, reason],
    );
  }

  async recordStepUp(sessionId: string, state: StepUpState): Promise<void> {
    await this.db.query(
      `INSERT INTO operator_sessions (session_id, step_up_at, step_up_method)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id) DO UPDATE
       SET step_up_at = EXCLUDED.step_up_at, step_up_method = EXCLUDED.step_up_method`,
      [sessionId, state.verifiedAt, state.method],
    );
  }

  async getStepUp(sessionId: string): Promise<StepUpState | undefined> {
    const result = await this.db.query<SessionRow>(
      "SELECT revoked_at, step_up_at, step_up_method FROM operator_sessions WHERE session_id = $1",
      [sessionId],
    );
    const row = result.rows[0];
    if (!row?.step_up_at || !row.step_up_method) return undefined;
    return { verifiedAt: new Date(row.step_up_at).toISOString(), method: row.step_up_method };
  }
}
