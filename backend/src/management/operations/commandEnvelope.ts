// 1A.5/1A.8.1 — Governance's independent copy of the management.command
// envelope. The generic target-resource pair extends the engine-only v1
// shape without requiring Governance to import Infrakinetic source.

export const MANAGEMENT_COMMAND_CONTRACT = "platform-management.command.v1";

export interface ManagementCommandEnvelope {
  contract: typeof MANAGEMENT_COMMAND_CONTRACT;
  command_id: string;
  idempotency_key: string;
  operator_id: string;
  operator_session_id: string;
  tenant_id: string | null;
  target_engine?: string;
  target_resource_type?: string;
  target_resource_id?: string;
  requested_action: string;
  correlation_id: string;
  requested_at: string;
  payload: unknown;
}

export interface BuildCommandEnvelopeParams {
  commandId: string;
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  tenantId?: string | null;
  targetEngine?: string;
  targetResourceType?: string;
  targetResourceId?: string;
  requestedAction: string;
  correlationId: string;
  requestedAt: string;
  payload: unknown;
}

const UUID_LIKE = /^[0-9a-f-]{8,}$/i;

export class InvalidCommandEnvelopeError extends Error {
  constructor(reason: string) {
    super(`Invalid management.command envelope: ${reason}`);
    this.name = "InvalidCommandEnvelopeError";
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateAddress(targetEngine: unknown, targetResourceType: unknown, targetResourceId: unknown): void {
  const hasEngine = nonEmpty(targetEngine);
  const hasType = nonEmpty(targetResourceType);
  const hasId = nonEmpty(targetResourceId);

  if (hasType !== hasId) {
    throw new InvalidCommandEnvelopeError("target_resource_type and target_resource_id must be supplied together");
  }
  if (!hasEngine && !hasType) {
    throw new InvalidCommandEnvelopeError("an engine target or a complete generic target-resource address is required");
  }
  if (hasEngine && hasType && (targetResourceType !== "engine" || targetResourceId !== targetEngine)) {
    throw new InvalidCommandEnvelopeError("target_engine conflicts with the generic target-resource address");
  }
}

export function buildCommandEnvelope(params: BuildCommandEnvelopeParams): ManagementCommandEnvelope {
  const targetResourceType = params.targetEngine !== undefined ? "engine" : params.targetResourceType;
  const targetResourceId = params.targetEngine !== undefined ? params.targetEngine : params.targetResourceId;
  validateAddress(params.targetEngine, targetResourceType, targetResourceId);

  return {
    contract: MANAGEMENT_COMMAND_CONTRACT,
    command_id: params.commandId,
    idempotency_key: params.idempotencyKey,
    operator_id: params.operatorId,
    operator_session_id: params.operatorSessionId,
    tenant_id: params.tenantId ?? null,
    ...(params.targetEngine !== undefined ? { target_engine: params.targetEngine } : {}),
    target_resource_type: targetResourceType,
    target_resource_id: targetResourceId,
    requested_action: params.requestedAction,
    correlation_id: params.correlationId,
    requested_at: params.requestedAt,
    payload: params.payload,
  };
}

// Structural validation only — authorization is enforced by the signed
// management assertion and the receiving route's required scope/action.
export function validateCommandEnvelope(value: unknown): ManagementCommandEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new InvalidCommandEnvelopeError("not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.contract !== MANAGEMENT_COMMAND_CONTRACT) {
    throw new InvalidCommandEnvelopeError(`contract must be '${MANAGEMENT_COMMAND_CONTRACT}'`);
  }
  for (const field of [
    "command_id",
    "idempotency_key",
    "operator_id",
    "operator_session_id",
    "requested_action",
    "correlation_id",
    "requested_at",
  ]) {
    if (!nonEmpty(v[field])) {
      throw new InvalidCommandEnvelopeError(`'${field}' must be a non-empty string`);
    }
  }
  validateAddress(v.target_engine, v.target_resource_type, v.target_resource_id);
  if (v.tenant_id !== null && typeof v.tenant_id !== "string") {
    throw new InvalidCommandEnvelopeError("'tenant_id' must be a string or null");
  }
  if (!UUID_LIKE.test(v.command_id as string)) {
    throw new InvalidCommandEnvelopeError("'command_id' does not look like an identifier");
  }
  if (!("payload" in v)) {
    throw new InvalidCommandEnvelopeError("'payload' is required (an empty object is valid)");
  }
  return v as unknown as ManagementCommandEnvelope;
}
