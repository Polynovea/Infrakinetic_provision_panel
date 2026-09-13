import { randomUUID } from "node:crypto";

import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildCommandEnvelope, validateCommandEnvelope, type ManagementCommandEnvelope } from "./commandEnvelope.js";
import { buildSafeSnapshot } from "./evidence.js";
import type { RiskClass } from "./riskClassification.js";

// 1A.5 — the synthetic certification path (instruction #10). Proves the
// full local chain — authentication already happened upstream (1A.4),
// idempotency reservation, immutable ledger entry, management.command
// envelope creation/validation, a synthetic/no-op "acceptance", and ledger
// finalization — WITHOUT ever performing a real Infrakinetic business
// mutation. There is deliberately no HTTP call to Infrakinetic anywhere in
// this file: the "acceptance" step is a synthetic, in-process function,
// not a call to any real mutation endpoint (none exists yet — that is
// 1A.6). This is what makes the exit-gate proof safe to run for real,
// including against the live-deployed Governance backend.

export interface SyntheticManagementRequest {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  requestedAction: string;
  targetTenantId?: string | null;
  targetEngine: string;
  reason?: string;
  riskClass: RiskClass;
  approvalEvidence?: unknown;
  payload: unknown;
  correlationId?: string;
  causationId?: string;
}

export interface SyntheticCertificationResult {
  operation: ManagementOperationRecord;
  envelope: ManagementCommandEnvelope;
  replay: boolean;
}

// A synthetic/no-op acceptance function — this is the ONLY place a real
// call to Infrakinetic could ever be plugged in, and 1A.5 deliberately
// does not plug one in. It exists so the certification path has something
// to "accept" the command without a real domain side effect ever
// happening, matching instruction #10's acceptable pattern exactly:
// "...management command envelope creation/validation -> synthetic/no-op
// acceptance path -> ledger finalization. No engine state flip yet."
function synthesizeAcceptance(envelope: ManagementCommandEnvelope): { accepted: true; note: string } {
  return { accepted: true, note: `synthetic acceptance only — no call made to Infrakinetic for ${envelope.requested_action}` };
}

export async function certifySyntheticManagementOperation(
  ledger: ManagementOperationLedger,
  request: SyntheticManagementRequest,
): Promise<SyntheticCertificationResult> {
  const correlationId = request.correlationId ?? randomUUID();
  const requestedAt = new Date().toISOString();

  const { operation: submitted, replay } = await ledger.createOrReplayOperation({
    idempotencyKey: request.idempotencyKey,
    operatorId: request.operatorId,
    operatorSessionId: request.operatorSessionId,
    requestedAction: request.requestedAction,
    targetTenantId: request.targetTenantId,
    targetEngine: request.targetEngine,
    reason: request.reason,
    riskClass: request.riskClass,
    approvalEvidence: request.approvalEvidence,
    payload: request.payload,
    contractVersion: "platform-management.operation.v1",
    correlationId,
    causationId: request.causationId,
  });

  const envelope = validateCommandEnvelope(
    buildCommandEnvelope({
      commandId: randomUUID(),
      idempotencyKey: submitted.idempotencyKey,
      operatorId: submitted.operatorId,
      operatorSessionId: submitted.operatorSessionId ?? request.operatorSessionId,
      tenantId: submitted.targetTenantId ?? null,
      targetEngine: submitted.targetEngine,
      requestedAction: submitted.requestedAction,
      correlationId: submitted.correlationId,
      requestedAt,
      payload: request.payload,
    }),
  );

  if (replay) {
    // A replay of an already-finalized (or still in-flight) operation must
    // not re-run acceptance/finalization — that would duplicate ledger
    // events for the same idempotency key. The caller gets the operation
    // exactly as it stands.
    return { operation: submitted, envelope, replay: true };
  }

  const beforeSnapshot = buildSafeSnapshot({ engineState: "unknown-not-observed-in-synthetic-path" });
  await ledger.transitionOperation(submitted.operationId, {
    toStatus: "accepted",
    beforeStateSafeSnapshot: beforeSnapshot,
    detail: { envelopeContract: envelope.contract, commandId: envelope.command_id },
  });
  await ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const acceptance = synthesizeAcceptance(envelope);
  const finalOperation = await ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    result: acceptance,
    afterStateSafeSnapshot: buildSafeSnapshot({ synthetic: true, realMutationPerformed: false }),
  });

  return { operation: finalOperation, envelope, replay: false };
}
