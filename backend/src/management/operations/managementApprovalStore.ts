import type { DbClient } from "../../db/dbClient.js";
import type { RiskClass } from "./riskClassification.js";

// Phase 1A.12.5 — the minimal reusable maker-checker approval substrate
// (§10 of the 1A.12 scoping doc; migration 0012). Deliberately generic —
// requestedAction/targetResourceType/targetResourceId, not identity-
// specific columns — so 1A.19 can reuse this table/store for every other
// high-risk vertical instead of building a second one.

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalDecision = "approved" | "rejected";

export interface ApprovalRecord {
  approvalId: string;
  requestedAction: string;
  targetTenantId?: string;
  targetResourceType: string;
  targetResourceId: string;
  safePayloadHash: string;
  riskClass: RiskClass;
  reason: string;
  makerOperatorId: string;
  checkerOperatorId?: string;
  status: ApprovalStatus;
  correlationId: string;
  requestedAt: string;
  decidedAt?: string;
  executedAt?: string;
  expiresAt: string;
}

export class ApprovalNotFoundError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval '${approvalId}' does not exist.`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalExpiredError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval '${approvalId}' has expired.`);
    this.name = "ApprovalExpiredError";
  }
}

export class ApprovalNotPendingError extends Error {
  constructor(readonly approvalId: string, readonly status: ApprovalStatus) {
    super(`Approval '${approvalId}' is '${status}', not 'pending' — it cannot be decided again.`);
    this.name = "ApprovalNotPendingError";
  }
}

// The one rule this whole substrate exists to enforce.
export class SelfApprovalNotAllowedError extends Error {
  constructor(readonly approvalId: string) {
    super(`Operator who requested approval '${approvalId}' cannot also decide it.`);
    this.name = "SelfApprovalNotAllowedError";
  }
}

export class ApprovalNotApprovedError extends Error {
  constructor(readonly approvalId: string, readonly status: ApprovalStatus) {
    super(`Approval '${approvalId}' is '${status}', not 'approved' — it cannot be executed.`);
    this.name = "ApprovalNotApprovedError";
  }
}

export class ApprovalAlreadyExecutedError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval '${approvalId}' has already been executed. A repeat action requires a new approval.`);
    this.name = "ApprovalAlreadyExecutedError";
  }
}

// Changing the target/action/payload after approval invalidates it (§10) —
// execution recomputes the safe payload hash from the request it is about
// to perform and this is thrown if it no longer matches what was approved.
export class ApprovalPayloadMismatchError extends Error {
  constructor(readonly approvalId: string) {
    super(`Approval '${approvalId}' does not match the request being executed — the approved payload has changed.`);
    this.name = "ApprovalPayloadMismatchError";
  }
}

export interface CreateApprovalParams {
  approvalId: string;
  requestedAction: string;
  targetTenantId?: string;
  targetResourceType: string;
  targetResourceId: string;
  safePayloadHash: string;
  riskClass: RiskClass;
  reason: string;
  makerOperatorId: string;
  correlationId: string;
  ttlSeconds: number;
}

export interface DecideApprovalParams {
  approvalId: string;
  checkerOperatorId: string;
  decision: ApprovalDecision;
}

interface ApprovalRow {
  approval_id: string;
  requested_action: string;
  target_tenant_id: string | null;
  target_resource_type: string;
  target_resource_id: string;
  safe_payload_hash: string;
  risk_class: string;
  reason: string;
  maker_operator_id: string;
  checker_operator_id: string | null;
  status: string;
  correlation_id: string;
  requested_at: string;
  decided_at: string | null;
  executed_at: string | null;
  expires_at: string;
}

function mapRow(row: ApprovalRow): ApprovalRecord {
  return {
    approvalId: row.approval_id,
    requestedAction: row.requested_action,
    targetTenantId: row.target_tenant_id ?? undefined,
    targetResourceType: row.target_resource_type,
    targetResourceId: row.target_resource_id,
    safePayloadHash: row.safe_payload_hash,
    riskClass: row.risk_class as RiskClass,
    reason: row.reason,
    makerOperatorId: row.maker_operator_id,
    checkerOperatorId: row.checker_operator_id ?? undefined,
    status: row.status as ApprovalStatus,
    correlationId: row.correlation_id,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? undefined,
    executedAt: row.executed_at ?? undefined,
    expiresAt: row.expires_at,
  };
}

// An approval past its TTL is treated as expired even before any sweep job
// touches its row — every read/decide/execute path below checks this
// first, so a stale pending approval can never be approved or executed
// just because nothing has run the (future, 1A.19) housekeeping job yet.
function isPastExpiry(record: ApprovalRecord): boolean {
  return record.status === "pending" && new Date(record.expiresAt).getTime() <= Date.now();
}

export class ManagementApprovalStore {
  constructor(private readonly db: DbClient) {}

  async createApproval(params: CreateApprovalParams): Promise<ApprovalRecord> {
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000).toISOString();
    const result = await this.db.query<ApprovalRow>(
      `INSERT INTO governance.management_approvals
         (approval_id, requested_action, target_tenant_id, target_resource_type, target_resource_id,
          safe_payload_hash, risk_class, reason, maker_operator_id, status, correlation_id, requested_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, now(), $11)
       RETURNING *`,
      [
        params.approvalId,
        params.requestedAction,
        params.targetTenantId ?? null,
        params.targetResourceType,
        params.targetResourceId,
        params.safePayloadHash,
        params.riskClass,
        params.reason,
        params.makerOperatorId,
        params.correlationId,
        expiresAt,
      ],
    );
    return mapRow(result.rows[0]);
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord> {
    const result = await this.db.query<ApprovalRow>(
      `SELECT * FROM governance.management_approvals WHERE approval_id = $1`,
      [approvalId],
    );
    const row = result.rows[0];
    if (!row) throw new ApprovalNotFoundError(approvalId);
    return mapRow(row);
  }

  async decideApproval(params: DecideApprovalParams): Promise<ApprovalRecord> {
    const current = await this.getApproval(params.approvalId);
    if (isPastExpiry(current)) throw new ApprovalExpiredError(params.approvalId);
    if (current.status !== "pending") throw new ApprovalNotPendingError(params.approvalId, current.status);
    if (params.checkerOperatorId === current.makerOperatorId) throw new SelfApprovalNotAllowedError(params.approvalId);

    const result = await this.db.query<ApprovalRow>(
      `UPDATE governance.management_approvals
       SET status = $2, checker_operator_id = $3, decided_at = now()
       WHERE approval_id = $1 AND status = 'pending'
       RETURNING *`,
      [params.approvalId, params.decision, params.checkerOperatorId],
    );
    const row = result.rows[0];
    if (!row) throw new ApprovalNotPendingError(params.approvalId, current.status);
    return mapRow(row);
  }

  // Grants exactly one execution. `expectedSafePayloadHash` must be
  // recomputed by the caller from the request it is about to perform — a
  // mismatch means the target/action/payload changed since approval.
  async markExecuted(approvalId: string, expectedSafePayloadHash: string): Promise<ApprovalRecord> {
    const current = await this.getApproval(approvalId);
    if (isPastExpiry(current)) throw new ApprovalExpiredError(approvalId);
    if (current.status !== "approved") throw new ApprovalNotApprovedError(approvalId, current.status);
    if (current.executedAt) throw new ApprovalAlreadyExecutedError(approvalId);
    if (current.safePayloadHash !== expectedSafePayloadHash) throw new ApprovalPayloadMismatchError(approvalId);

    const result = await this.db.query<ApprovalRow>(
      `UPDATE governance.management_approvals
       SET executed_at = now()
       WHERE approval_id = $1 AND status = 'approved' AND executed_at IS NULL
       RETURNING *`,
      [approvalId],
    );
    const row = result.rows[0];
    if (!row) throw new ApprovalAlreadyExecutedError(approvalId);
    return mapRow(row);
  }
}
