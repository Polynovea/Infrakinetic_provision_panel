import { randomUUID } from "node:crypto";

import type { DbClient, DbExecutor } from "../../db/dbClient.js";
import { computeSafePayloadHash } from "./canonicalHash.js";
import { redactSecretShapedFields, type SafeSnapshot } from "./evidence.js";
import { isRiskClass, riskClassRequiresReason, type RiskClass } from "./riskClassification.js";
import { isValidTransition, toIdempotencyKeyStatus, type OperationStatus } from "./lifecycle.js";
import {
  MissingIdempotencyKeyError,
  InvalidRiskClassError,
  MissingReasonError,
  InvalidManagementTargetError,
  IdempotencyConflictError,
  OperationNotFoundError,
  InvalidLifecycleTransitionError,
  ConcurrentTransitionConflictError,
} from "./managementOperationErrors.js";

// 1A.5 — the durable management-operation ledger (master plan §19/§59/§60).
// Postgres-backed only (instruction #6: "do not use an in-memory-only
// store") — every method either reads from or writes to
// governance.management_operations/management_idempotency_keys/
// operator_audit_log via the injected DbClient. No caller of this class
// ever needs to know the table shapes.
//
// IMPORTANT — why business errors are never thrown from inside
// `db.transaction(...)`: PgDbClient.transaction() catches ANY error its
// work callback throws and rewraps it as DatabaseUnavailableError (see
// db/pgDbClient.ts), which is correct for genuine DB failures but would
// silently destroy a typed error like IdempotencyConflictError. Every
// method below therefore has its transactional work callback return a
// plain discriminated-union VALUE describing the outcome (never throwing
// for an expected business outcome), and only inspects/throws on that
// value AFTER the transaction has resolved.

export interface ManagementOperationRecord {
  operationId: string;
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId?: string;
  requestedAction: string;
  targetTenantId?: string;
  targetEngine?: string;
  targetResourceType?: string;
  targetResourceId?: string;
  reason?: string;
  riskClass: RiskClass;
  approvalEvidence?: unknown;
  safePayloadHash: string;
  contractVersion: string;
  correlationId: string;
  causationId?: string;
  requestedAt: string;
  acceptedAt?: string;
  completedAt?: string;
  failedAt?: string;
  status: OperationStatus;
  beforeStateSafeSnapshot?: SafeSnapshot;
  afterStateSafeSnapshot?: SafeSnapshot;
  result?: unknown;
  partialFailureState?: unknown;
  rollbackReference?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CreateManagementOperationParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId?: string;
  requestedAction: string;
  targetTenantId?: string | null;
  targetEngine?: string;
  targetResourceType?: string;
  targetResourceId?: string;
  reason?: string;
  riskClass: RiskClass;
  approvalEvidence?: unknown;
  payload: unknown;
  contractVersion: string;
  correlationId: string;
  causationId?: string;
}

export interface CreateOrReplayResult {
  operation: ManagementOperationRecord;
  /** true when this call returned an already-existing operation rather than creating a new one. */
  replay: boolean;
}

// 1A.1–1A.7 closure pass — the operator dashboard needs a "recent
// privileged operations" feed; until now the only read primitive was
// getOperation(operationId), a lookup by id. This is a plain, bounded,
// read-only list over the same table — no new ledger semantics, no
// mutation, no idempotency key (matches tenantRegistryQuery.ts's own R0
// reasoning: a read needs none of that). Deliberately built with a
// conditionally-assembled WHERE clause and plain equality (no casts, no
// COALESCE/NULL-OR tricks) rather than a single clever parameterized
// query — this repo's own migration file
// (0003_management_operation_ledger.sql) notes pg-mem "implements very few
// native SQL functions," and the test double must run the exact same SQL
// as production.
export interface ListOperationsParams {
  limit?: number;
  status?: OperationStatus;
  requestedAction?: string;
  targetTenantId?: string;
  targetEngine?: string;
  targetResourceType?: string;
  targetResourceId?: string;
}

export const OPERATIONS_LIST_DEFAULT_LIMIT = 20;
export const OPERATIONS_LIST_MAX_LIMIT = 100;

export interface TransitionOperationParams {
  toStatus: OperationStatus;
  beforeStateSafeSnapshot?: SafeSnapshot;
  afterStateSafeSnapshot?: SafeSnapshot;
  result?: unknown;
  partialFailureState?: unknown;
  detail?: unknown;
}

interface OperationRow {
  operation_id: string;
  idempotency_key: string;
  operator_id: string;
  operator_session_id: string | null;
  requested_action: string;
  target_tenant_id: string | null;
  target_engine: string | null;
  target_resource_type: string | null;
  target_resource_id: string | null;
  reason: string | null;
  risk_class: string;
  approval_evidence: unknown;
  safe_payload_hash: string;
  contract_version: string;
  correlation_id: string;
  causation_id: string | null;
  requested_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  status: string;
  before_state_safe_snapshot: unknown;
  after_state_safe_snapshot: unknown;
  result: unknown;
  partial_failure_state: unknown;
  rollback_reference: unknown;
  created_at: string;
  updated_at: string;
}

function parseJsonbField(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function toJsonbParam(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function mapOperationRow(row: OperationRow): ManagementOperationRecord {
  return {
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    operatorId: row.operator_id,
    operatorSessionId: row.operator_session_id ?? undefined,
    requestedAction: row.requested_action,
    targetTenantId: row.target_tenant_id ?? undefined,
    targetEngine: row.target_engine ?? undefined,
    targetResourceType: row.target_resource_type ?? undefined,
    targetResourceId: row.target_resource_id ?? undefined,
    reason: row.reason ?? undefined,
    riskClass: row.risk_class as RiskClass,
    approvalEvidence: parseJsonbField(row.approval_evidence),
    safePayloadHash: row.safe_payload_hash,
    contractVersion: row.contract_version,
    correlationId: row.correlation_id,
    causationId: row.causation_id ?? undefined,
    requestedAt: row.requested_at,
    acceptedAt: row.accepted_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    status: row.status as OperationStatus,
    beforeStateSafeSnapshot: parseJsonbField(row.before_state_safe_snapshot) as SafeSnapshot | undefined,
    afterStateSafeSnapshot: parseJsonbField(row.after_state_safe_snapshot) as SafeSnapshot | undefined,
    result: parseJsonbField(row.result),
    partialFailureState: parseJsonbField(row.partial_failure_state),
    rollbackReference: parseJsonbField(row.rollback_reference),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface AppendAuditEventParams {
  operatorId?: string;
  operatorSessionId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  riskClass?: RiskClass;
  reason?: string;
  idempotencyKey?: string;
  correlationId?: string;
  result: OperationStatus;
  beforeState?: unknown;
  afterState?: unknown;
  detail?: unknown;
  operationId?: string;
  causationId?: string;
  contractVersion?: string;
}

async function appendAuditEvent(exec: DbExecutor, p: AppendAuditEventParams): Promise<void> {
  await exec.query(
    `INSERT INTO governance.operator_audit_log
       (occurred_at, operator_id, operator_session_id, action, target_type, target_id, risk_class, reason,
        idempotency_key, correlation_id, result, before_state, after_state, detail,
        operation_id, causation_id, contract_version)
     VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16)`,
    [
      p.operatorId ?? null,
      p.operatorSessionId ?? null,
      p.action,
      p.targetType ?? null,
      p.targetId ?? null,
      p.riskClass ?? null,
      p.reason ?? null,
      p.idempotencyKey ?? null,
      p.correlationId ?? null,
      p.result,
      toJsonbParam(p.beforeState),
      toJsonbParam(p.afterState),
      toJsonbParam(p.detail),
      p.operationId ?? null,
      p.causationId ?? null,
      p.contractVersion ?? null,
    ],
  );
}

type TransitionOutcome = { kind: "transitioned"; row: OperationRow } | { kind: "stale" };

// PgDbClient's error wrapping (db/pgDbClient.ts's wrapDbError) discards the
// original driver error code, preserving only a message string — so a
// unique-constraint violation is detected by matching Postgres's own
// standard wording, which pg-mem (this repo's test double) reproduces
// exactly. This is deliberately narrow: it must not match a config/network
// failure as if it were an expected conflict.
// Exported so other repositories needing the identical "was this the
// tenant_id/idempotency_key unique constraint" check (1A.10.2's
// getOrCreateLegacyExisting(), specifically) reuse the same narrow,
// PgDbClient-error-wrapping-aware match instead of re-deriving it.
export function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate key value violates unique constraint/i.test(message);
}

function nonEmptyTargetPart(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveManagementTarget(params: CreateManagementOperationParams): {
  targetEngine?: string;
  targetResourceType: string;
  targetResourceId: string;
} {
  const hasEngine = nonEmptyTargetPart(params.targetEngine);
  const hasType = nonEmptyTargetPart(params.targetResourceType);
  const hasId = nonEmptyTargetPart(params.targetResourceId);

  if (hasType !== hasId) {
    throw new InvalidManagementTargetError("targetResourceType and targetResourceId must be supplied together.");
  }
  if (hasEngine) {
    if (hasType && (params.targetResourceType !== "engine" || params.targetResourceId !== params.targetEngine)) {
      throw new InvalidManagementTargetError("targetEngine conflicts with the generic target-resource address.");
    }
    return {
      targetEngine: params.targetEngine!,
      targetResourceType: "engine",
      targetResourceId: params.targetEngine!,
    };
  }
  if (!hasType || !hasId) {
    throw new InvalidManagementTargetError("an engine target or a complete generic target-resource address is required.");
  }
  return { targetResourceType: params.targetResourceType!, targetResourceId: params.targetResourceId! };
}

function deriveAuditTarget(op: {
  targetTenantId?: string | null;
  targetEngine?: string;
  targetResourceType?: string;
  targetResourceId?: string;
}): { targetType?: string; targetId?: string } {
  // Preserve exact 1A.6 audit semantics: engine operations that also carry a
  // tenant target were historically audited against the tenant first.
  if (op.targetTenantId) return { targetType: "tenant", targetId: op.targetTenantId };
  if (op.targetEngine) return { targetType: "engine", targetId: op.targetEngine };
  if (op.targetResourceType && op.targetResourceId) {
    return { targetType: op.targetResourceType, targetId: op.targetResourceId };
  }
  return {};
}

export class ManagementOperationLedger {
  constructor(private readonly db: DbClient) {}

  // Reserves the idempotency key, then creates the operation + its initial
  // 'submitted' ledger event, OR — if the key is already in use — safely
  // replays the existing durable result (same key, same payload) or rejects
  // (same key, different payload).
  //
  // Race-safety (instruction #11) comes from a plain INSERT (no
  // ON CONFLICT) into management_idempotency_keys, whose PRIMARY KEY on
  // idempotency_key means Postgres itself guarantees at most one concurrent
  // caller's INSERT can succeed — there is no application-level
  // check-then-insert window. The loser observes a unique-violation, not a
  // race it has to reason about.
  //
  // This deliberately does NOT use `INSERT ... ON CONFLICT DO NOTHING
  // RETURNING` to detect the winner/loser: that combination is unreliable
  // under this repo's test double (pg-mem returns the attempted row even
  // when the insert was skipped), and — independently of that — a
  // statement that fails inside a multi-statement transaction poisons the
  // rest of that transaction in real Postgres without a SAVEPOINT. Instead,
  // the reservation attempt is its own standalone (autocommit) statement,
  // and the unique-violation is caught and treated as "someone already
  // holds this key", read via wrapDbError's message text since
  // PgDbClient's error wrapping does not preserve the original driver
  // error code.
  async createOrReplayOperation(params: CreateManagementOperationParams): Promise<CreateOrReplayResult> {
    if (!params.idempotencyKey || params.idempotencyKey.trim() === "") {
      throw new MissingIdempotencyKeyError();
    }
    if (!isRiskClass(params.riskClass)) {
      throw new InvalidRiskClassError(params.riskClass);
    }
    if (riskClassRequiresReason(params.riskClass) && (!params.reason || params.reason.trim() === "")) {
      throw new MissingReasonError(params.riskClass);
    }

    const target = resolveManagementTarget(params);

    // IMPORTANT: hash the caller-supplied generic fields, not the derived
    // engine projection. Existing 1A.6 callers pass only targetEngine, so
    // their canonical object/hash remains byte-identical to pre-1A.8.1.
    const safePayloadHash = computeSafePayloadHash({
      requestedAction: params.requestedAction,
      targetTenantId: params.targetTenantId ?? null,
      targetEngine: params.targetEngine,
      targetResourceType: params.targetResourceType,
      targetResourceId: params.targetResourceId,
      payload: params.payload,
    });

    let reservedNewly: boolean;
    try {
      await this.db.query(
        `INSERT INTO governance.management_idempotency_keys
           (idempotency_key, requested_action, operator_id, request_hash, status, created_at)
         VALUES ($1, $2, $3, $4, 'in_progress', now())`,
        [params.idempotencyKey, params.requestedAction, params.operatorId, safePayloadHash],
      );
      reservedNewly = true;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      reservedNewly = false;
    }

    if (reservedNewly) {
      const operationId = randomUUID();
      const safeApprovalEvidence =
        params.approvalEvidence !== undefined ? redactSecretShapedFields(params.approvalEvidence) : undefined;

      // Audit remediation M5 (secondary): the reservation above autocommits
      // on its own, so a DB failure inside the transaction below used to
      // leave the key 'in_progress' with no operation row — permanently
      // burned (every retry looped, then 409'd). Release the reservation on
      // failure; the guard makes the release a no-op if the operation row
      // did land.
      // Best-effort: if the release itself fails the key stays reserved,
      // which is the pre-fix behaviour, never worse.
      const releaseReservation = async (): Promise<void> => {
        try {
          if (await this.getByIdempotencyKey(params.idempotencyKey)) return;
          await this.db.query(
            `DELETE FROM governance.management_idempotency_keys WHERE idempotency_key = $1 AND status = 'in_progress'`,
            [params.idempotencyKey],
          );
        } catch {
          // swallow — see above
        }
      };

      const row = await this.db.transaction(async (tx) => {
        const inserted = await tx.query<OperationRow>(
          `INSERT INTO governance.management_operations
             (operation_id, idempotency_key, operator_id, operator_session_id, requested_action,
              target_tenant_id, target_engine, target_resource_type, target_resource_id, reason, risk_class,
              approval_evidence, safe_payload_hash, contract_version, correlation_id, causation_id,
              requested_at, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16,
                   now(), 'submitted', now(), now())
           RETURNING *`,
          [
            operationId,
            params.idempotencyKey,
            params.operatorId,
            params.operatorSessionId ?? null,
            params.requestedAction,
            params.targetTenantId ?? null,
            target.targetEngine ?? null,
            target.targetResourceType,
            target.targetResourceId,
            params.reason ?? null,
            params.riskClass,
            toJsonbParam(safeApprovalEvidence),
            safePayloadHash,
            params.contractVersion,
            params.correlationId,
            params.causationId ?? null,
          ],
        );
        await appendAuditEvent(tx, {
          operatorId: params.operatorId,
          operatorSessionId: params.operatorSessionId,
          action: params.requestedAction,
          ...deriveAuditTarget({ ...params, ...target }),
          riskClass: params.riskClass,
          reason: params.reason,
          idempotencyKey: params.idempotencyKey,
          correlationId: params.correlationId,
          result: "submitted",
          operationId,
          causationId: params.causationId,
          contractVersion: params.contractVersion,
        });
        return inserted.rows[0];
      }).catch(async (err: unknown) => {
        await releaseReservation();
        throw err;
      });
      return { operation: mapOperationRow(row), replay: false };
    }

    // Someone else already holds this key. Read what is actually recorded
    // and decide replay vs. conflict.
    const existingKey = await this.db.query<{ request_hash: string }>(
      `SELECT request_hash FROM governance.management_idempotency_keys WHERE idempotency_key = $1`,
      [params.idempotencyKey],
    );
    if (existingKey.rows[0]?.request_hash !== safePayloadHash) {
      throw new IdempotencyConflictError(params.idempotencyKey);
    }

    // Same key, same hash — a legitimate replay, OR a concurrent caller
    // that lost the reservation race by microseconds while making an
    // identical request, whose winner has not yet finished writing the
    // management_operations row. Bounded retry covers that narrow window
    // without ever fabricating a result.
    for (let attempt = 0; attempt < 5; attempt++) {
      const existingOp = await this.getByIdempotencyKey(params.idempotencyKey);
      if (existingOp) return { operation: existingOp, replay: true };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new IdempotencyConflictError(params.idempotencyKey);
  }

  async getOperation(operationId: string): Promise<ManagementOperationRecord> {
    const result = await this.db.query<OperationRow>(
      `SELECT * FROM governance.management_operations WHERE operation_id = $1`,
      [operationId],
    );
    const row = result.rows[0];
    if (!row) throw new OperationNotFoundError(operationId);
    return mapOperationRow(row);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<ManagementOperationRecord | undefined> {
    const result = await this.db.query<OperationRow>(
      `SELECT * FROM governance.management_operations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row ? mapOperationRow(row) : undefined;
  }

  // Audit remediation M5 — commission and invitation-issue operations are
  // addressed by a Governance-minted request id (targetResourceId), which is
  // part of the safe payload hash. Minting a fresh id on every HTTP call made
  // a same-key timeout retry hash differently and 409 instead of replaying
  // (§59). Routes resolve the id through here: a key already bound to an
  // operation of this action/resource type reuses that operation's id (so a
  // genuine replay hashes identically, and a changed payload still
  // conflicts); an unused key gets a fresh id.
  async resolveStableRequestId(idempotencyKey: string, requestedAction: string, targetResourceType: string): Promise<string> {
    if (!idempotencyKey || idempotencyKey.trim() === "") throw new MissingIdempotencyKeyError();
    const existing = await this.getByIdempotencyKey(idempotencyKey);
    if (existing && existing.requestedAction === requestedAction && existing.targetResourceType === targetResourceType && existing.targetResourceId) {
      return existing.targetResourceId;
    }
    return randomUUID();
  }

  // Audit remediation M5 — §59 "same key + same payload -> safe replay" for
  // maker-checker execution. Approval execution consumes the approval
  // (markExecuted) before creating the ledger operation, so a timeout retry
  // with the SAME idempotency key used to hit APPROVAL_ALREADY_EXECUTED
  // instead of replaying. Execute paths call this BEFORE markExecuted: an
  // existing operation under this key that was produced by this same
  // approval is returned as a replay; one produced by anything else is a
  // key-reuse conflict. Undefined means "never executed under this key".
  async findApprovalExecutionReplay(
    idempotencyKey: string,
    approvalId: string,
    requestedAction: string,
  ): Promise<ManagementOperationRecord | undefined> {
    if (!idempotencyKey || idempotencyKey.trim() === "") throw new MissingIdempotencyKeyError();
    const existing = await this.getByIdempotencyKey(idempotencyKey);
    if (!existing) return undefined;
    const priorApprovalId = (existing.approvalEvidence as { approvalId?: unknown } | undefined)?.approvalId;
    if (priorApprovalId !== approvalId || existing.requestedAction !== requestedAction) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return existing;
  }

  // Newest-first, bounded. Powers the Overview dashboard's "recent
  // privileged operations" feed — see this file's own header comment above
  // ListOperationsParams for why this is deliberately narrow.
  async listOperations(params: ListOperationsParams = {}): Promise<ManagementOperationRecord[]> {
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? OPERATIONS_LIST_DEFAULT_LIMIT), 1), OPERATIONS_LIST_MAX_LIMIT);

    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.status !== undefined) {
      values.push(params.status);
      conditions.push(`status = $${values.length}`);
    }
    if (params.requestedAction !== undefined) {
      values.push(params.requestedAction);
      conditions.push(`requested_action = $${values.length}`);
    }
    if (params.targetTenantId !== undefined) {
      values.push(params.targetTenantId);
      conditions.push(`target_tenant_id = $${values.length}`);
    }
    if (params.targetEngine !== undefined) {
      values.push(params.targetEngine);
      conditions.push(`target_engine = $${values.length}`);
    }
    if (params.targetResourceType !== undefined) {
      values.push(params.targetResourceType);
      conditions.push(`target_resource_type = $${values.length}`);
    }
    if (params.targetResourceId !== undefined) {
      values.push(params.targetResourceId);
      conditions.push(`target_resource_id = $${values.length}`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(limit);

    const result = await this.db.query<OperationRow>(
      `SELECT * FROM governance.management_operations ${whereClause} ORDER BY requested_at DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapOperationRow);
  }

  // Advances the operation's lifecycle by exactly one validated transition
  // (lifecycle.ts's ALLOWED_TRANSITIONS), updating the matching
  // idempotency-key status (lifecycle.ts's toIdempotencyKeyStatus) and
  // appending an immutable audit event, all in one transaction. The UPDATE
  // is guarded by `WHERE status = <the status we last observed>`, so a
  // concurrent transition of the same operation between our read and write
  // is detected (0 rows updated) rather than silently overwritten.
  async transitionOperation(
    operationId: string,
    params: TransitionOperationParams,
  ): Promise<ManagementOperationRecord> {
    const current = await this.getOperation(operationId);
    if (!isValidTransition(current.status, params.toStatus)) {
      throw new InvalidLifecycleTransitionError(current.status, params.toStatus);
    }

    // Audit remediation L3 — snapshots were redacted but `result` and
    // `partialFailureState` were stored verbatim, so whatever an owner
    // response carried (e.g. a tenant user's email) landed in the ledger.
    // Same central redaction as every other evidence field.
    const safeResult = params.result === undefined ? undefined : redactSecretShapedFields(params.result);
    const safePartialFailureState = params.partialFailureState === undefined ? undefined : redactSecretShapedFields(params.partialFailureState);

    const outcome: TransitionOutcome = await this.db.transaction(async (tx) => {
      const updated = await tx.query<OperationRow>(
        `UPDATE governance.management_operations
         SET status = $2,
             updated_at = now(),
             accepted_at = CASE WHEN $2 = 'accepted' THEN now() ELSE accepted_at END,
             completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
             failed_at = CASE WHEN $2 = 'failed' THEN now() ELSE failed_at END,
             before_state_safe_snapshot = COALESCE($3::jsonb, before_state_safe_snapshot),
             after_state_safe_snapshot = COALESCE($4::jsonb, after_state_safe_snapshot),
             result = COALESCE($5::jsonb, result),
             partial_failure_state = COALESCE($6::jsonb, partial_failure_state)
         WHERE operation_id = $1 AND status = $7
         RETURNING *`,
        [
          operationId,
          params.toStatus,
          toJsonbParam(params.beforeStateSafeSnapshot),
          toJsonbParam(params.afterStateSafeSnapshot),
          toJsonbParam(safeResult),
          toJsonbParam(safePartialFailureState),
          current.status,
        ],
      );
      if (updated.rows.length === 0) {
        return { kind: "stale" };
      }
      const row = updated.rows[0];
      await tx.query(
        `UPDATE governance.management_idempotency_keys
         SET status = $2, completed_at = CASE WHEN $2 <> 'in_progress' THEN now() ELSE completed_at END
         WHERE idempotency_key = $1`,
        [row.idempotency_key, toIdempotencyKeyStatus(params.toStatus)],
      );
      await appendAuditEvent(tx, {
        operatorId: current.operatorId,
        operatorSessionId: current.operatorSessionId,
        action: current.requestedAction,
        ...deriveAuditTarget(current),
        riskClass: current.riskClass,
        reason: current.reason,
        idempotencyKey: current.idempotencyKey,
        correlationId: current.correlationId,
        result: params.toStatus,
        beforeState: params.beforeStateSafeSnapshot,
        afterState: params.afterStateSafeSnapshot,
        detail: params.detail,
        operationId: current.operationId,
        causationId: current.causationId,
        contractVersion: current.contractVersion,
      });
      return { kind: "transitioned", row };
    });

    if (outcome.kind === "stale") {
      throw new ConcurrentTransitionConflictError(operationId);
    }
    return mapOperationRow(outcome.row);
  }

  // Attaches a rollback/reversal reference without itself being a lifecycle
  // transition (instruction #4's "rollback_or_reversal_reference" is
  // evidence attached to an operation, not a status). A single UPDATE is
  // already atomic, so this deliberately does not use db.transaction() —
  // see this file's header for why that matters for error propagation.
  async attachRollbackReference(operationId: string, reference: unknown): Promise<ManagementOperationRecord> {
    const current = await this.getOperation(operationId);
    const safeReference = redactSecretShapedFields(reference);
    const result = await this.db.query<OperationRow>(
      `UPDATE governance.management_operations
       SET rollback_reference = $2::jsonb, updated_at = now()
       WHERE operation_id = $1
       RETURNING *`,
      [operationId, toJsonbParam(safeReference)],
    );
    await appendAuditEvent(this.db, {
      operatorId: current.operatorId,
      operatorSessionId: current.operatorSessionId,
      action: current.requestedAction,
      ...deriveAuditTarget(current),
      riskClass: current.riskClass,
      reason: current.reason,
      idempotencyKey: current.idempotencyKey,
      correlationId: current.correlationId,
      result: current.status,
      detail: { rollbackReferenceAttached: true },
      operationId: current.operationId,
      causationId: current.causationId,
      contractVersion: current.contractVersion,
    });
    return mapOperationRow(result.rows[0]);
  }
}
