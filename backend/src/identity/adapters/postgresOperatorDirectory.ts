import type { DbClient } from "../../db/dbClient.js";
import type { OperatorDirectory } from "../operatorDirectory.js";
import { isRole, isScope, type Role, type Scope } from "../roles.js";
import type { OperatorRecord, OperatorStatus } from "../types.js";

interface OperatorRow {
  operator_id: string;
  cognito_sub: string;
  email: string;
  display_name: string;
  status: string;
  mfa_enrolled: boolean;
  created_at: string;
  disabled_at: string | null;
  disabled_reason: string | null;
}

// 1A.3 — Postgres-backed OperatorDirectory, implementing the exact port
// InMemoryOperatorDirectory (1A.2) implements, against the schema in
// migrations/0001_operator_identity_schema.sql. This is the adapter swap
// docs/1A.2_status.md described as 1A.3's deliverable: no change to
// OperatorDirectory itself, requireManagementApiAuth, or any route.
//
// UNVERIFIED AGAINST A REAL POSTGRES SERVER as of 1A.3. Tested against
// pg-mem's pg-compatible adapter in
// test/identity/postgresOperatorDirectory.test.ts, which exercises the real
// SQL below (joins, row shaping, role/scope vocabulary filtering) — not a
// claim it has run against a real database. See docs/1A.3_status.md.
export class PostgresOperatorDirectory implements OperatorDirectory {
  constructor(private readonly db: DbClient) {}

  async findByCognitoSub(cognitoSub: string): Promise<OperatorRecord | undefined> {
    const operatorResult = await this.db.query<OperatorRow>(
      `SELECT operator_id, cognito_sub, email, display_name, status, mfa_enrolled,
              created_at, disabled_at, disabled_reason
       FROM governance.operators
       WHERE cognito_sub = $1`,
      [cognitoSub],
    );
    const row = operatorResult.rows[0];
    if (!row) return undefined;

    const [rolesResult, scopesResult] = await Promise.all([
      this.db.query<{ role: string }>("SELECT role FROM governance.operator_roles WHERE operator_id = $1", [
        row.operator_id,
      ]),
      this.db.query<{ scope: string }>("SELECT scope FROM governance.operator_scopes WHERE operator_id = $1", [
        row.operator_id,
      ]),
    ]);

    // Schema CHECK constraints already restrict stored values to the known
    // vocabulary; this filter is defense in depth against a row inserted by
    // a future tool that bypasses the constraint (e.g. a restore path), not
    // an expectation that it will ever actually drop a row in practice.
    const roles: Role[] = rolesResult.rows.map((r) => r.role).filter(isRole);
    const scopes: Scope[] = scopesResult.rows.map((r) => r.scope).filter(isScope);

    const record: OperatorRecord = {
      operatorId: row.operator_id,
      cognitoSub: row.cognito_sub,
      email: row.email,
      displayName: row.display_name,
      status: row.status as OperatorStatus,
      roles,
      scopes,
      mfaEnrolled: row.mfa_enrolled,
      createdAt: new Date(row.created_at).toISOString(),
      disabledAt: row.disabled_at ? new Date(row.disabled_at).toISOString() : undefined,
      disabledReason: row.disabled_reason ?? undefined,
    };
    return record;
  }
}
