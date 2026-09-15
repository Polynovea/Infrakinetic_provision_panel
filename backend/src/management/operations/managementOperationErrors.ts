// 1A.5 — typed rejection reasons for the operation-durability boundary,
// mirroring identity/errors.ts's ManagementAuthError shape (abstract base
// + code + httpStatus) so callers can assert on *why* a request was
// rejected and so any future HTTP surface gets a stable machine-readable
// error code for free.

export abstract class ManagementOperationError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MissingIdempotencyKeyError extends ManagementOperationError {
  readonly code = "OPERATION_IDEMPOTENCY_KEY_MISSING";
  readonly httpStatus = 400;
  constructor() {
    super("A management mutation requires a non-empty idempotency key.");
  }
}

export class InvalidRiskClassError extends ManagementOperationError {
  readonly code = "OPERATION_RISK_CLASS_INVALID";
  readonly httpStatus = 400;
  constructor(value: unknown) {
    super(`'${String(value)}' is not a known risk class (expected one of R0-R4).`);
  }
}

export class MissingReasonError extends ManagementOperationError {
  readonly code = "OPERATION_REASON_REQUIRED";
  readonly httpStatus = 400;
  constructor(riskClass: string) {
    super(`Risk class ${riskClass} requires a non-empty reason.`);
  }
}

export class InvalidManagementTargetError extends ManagementOperationError {
  readonly code = "OPERATION_TARGET_INVALID";
  readonly httpStatus = 400;
  constructor(reason: string) {
    super(`Invalid management target: ${reason}`);
  }
}

// Same idempotency key, but the canonical hash of
// {requestedAction, targetTenantId, targetEngine, payload} disagrees with
// the hash recorded on first use — master plan §59: "same key + different
// payload -> reject".
export class IdempotencyConflictError extends ManagementOperationError {
  readonly code = "OPERATION_IDEMPOTENCY_CONFLICT";
  readonly httpStatus = 409;
  constructor(readonly idempotencyKey: string) {
    super(
      `Idempotency key '${idempotencyKey}' was already used for a request with a different action/tenant/engine/payload.`,
    );
  }
}

export class ActionMismatchError extends ManagementOperationError {
  readonly code = "OPERATION_ACTION_MISMATCH";
  readonly httpStatus = 409;
  constructor(expected: string, actual: string) {
    super(`Idempotency key is bound to requested_action '${expected}', not '${actual}'.`);
  }
}

export class TargetMismatchError extends ManagementOperationError {
  readonly code = "OPERATION_TARGET_MISMATCH";
  readonly httpStatus = 409;
  constructor(field: "target_tenant_id" | "target_engine" | "target_resource_type" | "target_resource_id", expected: string, actual: string) {
    super(`Idempotency key is bound to ${field} '${expected}', not '${actual}'.`);
  }
}

export class OperationNotFoundError extends ManagementOperationError {
  readonly code = "OPERATION_NOT_FOUND";
  readonly httpStatus = 404;
  constructor(operationId: string) {
    super(`No management operation found for operation_id '${operationId}'.`);
  }
}

export class InvalidLifecycleTransitionError extends ManagementOperationError {
  readonly code = "OPERATION_INVALID_TRANSITION";
  readonly httpStatus = 409;
  constructor(from: string, to: string) {
    super(`Cannot transition a management operation from '${from}' to '${to}'.`);
  }
}

export class ConcurrentTransitionConflictError extends ManagementOperationError {
  readonly code = "OPERATION_CONCURRENT_TRANSITION_CONFLICT";
  readonly httpStatus = 409;
  constructor(operationId: string) {
    super(
      `Operation '${operationId}' was transitioned by a concurrent caller between read and write; retry against its current state.`,
    );
  }
}
