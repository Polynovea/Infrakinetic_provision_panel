// 1A.5 — Governance's own copy of the `management.command` envelope shape
// (master plan §17). Deliberately NOT imported from the Infrakinetic repo
// (README.md hard rule: no filesystem imports from Infrakinetic) — this is
// the same conceptual contract as CRM's
// api-server/src/management/managementCommandContract.js, reimplemented
// independently on this side, the same way both repos already keep their
// own copy of "management" concepts without ever importing each other's
// source (see docs/1A.4_status.md's own note on the two independent
// `requireManagementApiAuth` files).
//
// 1A.4 left this envelope validated-but-unused; 1A.5 only builds and
// validates it as part of the synthetic certification path
// (syntheticCertification.ts) — it is never sent over the network to
// Infrakinetic here, and no mutation route exists to receive it yet
// (that begins at 1A.6).

export const MANAGEMENT_COMMAND_CONTRACT = "platform-management.command.v1";

export interface ManagementCommandEnvelope {
  contract: typeof MANAGEMENT_COMMAND_CONTRACT;
  command_id: string;
  idempotency_key: string;
  operator_id: string;
  operator_session_id: string;
  tenant_id: string | null;
  target_engine: string;
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
  targetEngine: string;
  requestedAction: string;
  correlationId: string;
  requestedAt: string;
  payload: unknown;
}

export function buildCommandEnvelope(params: BuildCommandEnvelopeParams): ManagementCommandEnvelope {
  return {
    contract: MANAGEMENT_COMMAND_CONTRACT,
    command_id: params.commandId,
    idempotency_key: params.idempotencyKey,
    operator_id: params.operatorId,
    operator_session_id: params.operatorSessionId,
    tenant_id: params.tenantId ?? null,
    target_engine: params.targetEngine,
    requested_action: params.requestedAction,
    correlation_id: params.correlationId,
    requested_at: params.requestedAt,
    payload: params.payload,
  };
}

const UUID_LIKE = /^[0-9a-f-]{8,}$/i;

export class InvalidCommandEnvelopeError extends Error {
  constructor(reason: string) {
    super(`Invalid management.command envelope: ${reason}`);
    this.name = "InvalidCommandEnvelopeError";
  }
}

// Structural validation only — this is the shape contract, not an
// authorization check (that already happened upstream: 1A.4's
// requireManagementApiAuth/requireManagementScope on the Infrakinetic side,
// and this ledger's own idempotency/risk checks on the Governance side).
export function validateCommandEnvelope(value: unknown): ManagementCommandEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new InvalidCommandEnvelopeError("not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.contract !== MANAGEMENT_COMMAND_CONTRACT) {
    throw new InvalidCommandEnvelopeError(`contract must be '${MANAGEMENT_COMMAND_CONTRACT}'`);
  }
  for (const field of ["command_id", "idempotency_key", "operator_id", "operator_session_id", "target_engine", "requested_action", "correlation_id", "requested_at"]) {
    if (typeof v[field] !== "string" || (v[field] as string).length === 0) {
      throw new InvalidCommandEnvelopeError(`'${field}' must be a non-empty string`);
    }
  }
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
