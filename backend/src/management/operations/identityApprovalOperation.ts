import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi, isNeverDispatchedNetworkError } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { computeSafePayloadHash } from "./canonicalHash.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { MANAGEMENT_V1_PREFIX } from "./engineStateOperation.js";
import { ManagementApprovalStore, type ApprovalRecord, type ApprovalDecision } from "./managementApprovalStore.js";
import type { Scope } from "../../identity/roles.js";

// 1A.12.5 — R3 identity actions (force-reset, mfa.reset). Unlike
// identityOperation.ts's R2 commands (reserve -> mint -> mutate in one
// call), an R3 action is a three-phase flow: request (maker) -> decide
// (checker, != maker) -> execute (fresh step-up, approval consumed
// exactly once). Step-up freshness is enforced by requireStepUp at the
// route layer (routes/management/index.ts), not here — this module only
// owns the approval/ledger mechanics.

export const IDENTITY_R3_ACTIONS = {
  "force-reset": { action: "identity.force-reset", scope: "identity.recovery" as Scope, segment: "force-reset" },
  "mfa-reset": { action: "identity.mfa.reset", scope: "identity.mfa_reset" as Scope, segment: "mfa/reset" },
} as const;

export type IdentityR3ActionKey = keyof typeof IDENTITY_R3_ACTIONS;

// 24h: long enough for a real second human to review and decide, short
// enough that a forgotten request cannot linger indefinitely as a standing
// grant. Revisit under 1A.19 if a different policy value is warranted
// platform-wide.
const APPROVAL_TTL_SECONDS = 24 * 60 * 60;

export class UnknownIdentityR3ActionError extends Error {
  constructor(readonly requestedAction: string) {
    super(`'${requestedAction}' is not a known R3 identity action.`);
    this.name = "UnknownIdentityR3ActionError";
  }
}

export class MissingIdentityApprovalTargetError extends Error {
  constructor(field: string) {
    super(`An identity R3 approval requires a real ${field}.`);
    this.name = "MissingIdentityApprovalTargetError";
  }
}

function computeIdentityApprovalHash(requestedAction: string, tenantId: string, userId: string): string {
  return computeSafePayloadHash({
    requestedAction,
    targetTenantId: tenantId,
    targetResourceType: "identity_user",
    targetResourceId: userId,
    payload: { tenantId, userId },
  });
}

export interface IdentityApprovalOperationDeps {
  approvals: ManagementApprovalStore;
  ledger: ManagementOperationLedger;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface RequestIdentityR3ApprovalParams {
  actionKey: IdentityR3ActionKey;
  tenantId: string;
  userId: string;
  reason: string;
  makerOperatorId: string;
  correlationId?: string;
}

// Only the approval store is needed to request/decide — no assertion is
// minted and no Infrakinetic call happens until execute(). Accepting the
// narrower Pick here (rather than the full IdentityApprovalOperationDeps)
// means a caller/route for these two steps never has to resolve
// getManagementSigningKeys()/loadTransportConfig() just to satisfy an
// unused dependency.
export async function requestIdentityR3Approval(
  deps: Pick<IdentityApprovalOperationDeps, "approvals">,
  params: RequestIdentityR3ApprovalParams,
): Promise<ApprovalRecord> {
  if (!params.tenantId || params.tenantId.trim() === "") throw new MissingIdentityApprovalTargetError("tenantId");
  if (!params.userId || params.userId.trim() === "") throw new MissingIdentityApprovalTargetError("userId");
  const entry = IDENTITY_R3_ACTIONS[params.actionKey];
  if (!entry) throw new UnknownIdentityR3ActionError(params.actionKey);

  return deps.approvals.createApproval({
    approvalId: randomUUID(),
    requestedAction: entry.action,
    targetTenantId: params.tenantId,
    targetResourceType: "identity_user",
    targetResourceId: params.userId,
    safePayloadHash: computeIdentityApprovalHash(entry.action, params.tenantId, params.userId),
    riskClass: "R3",
    reason: params.reason,
    makerOperatorId: params.makerOperatorId,
    correlationId: params.correlationId ?? randomUUID(),
    ttlSeconds: APPROVAL_TTL_SECONDS,
  });
}

export interface DecideIdentityR3ApprovalParams {
  approvalId: string;
  checkerOperatorId: string;
  decision: ApprovalDecision;
}

export function decideIdentityR3Approval(
  deps: Pick<IdentityApprovalOperationDeps, "approvals">,
  params: DecideIdentityR3ApprovalParams,
): Promise<ApprovalRecord> {
  // Thin pass-through today — kept as its own operation-layer function
  // (rather than calling deps.approvals directly from the route) so a
  // future audit/notification hook has one place to add it.
  return deps.approvals.decideApproval(params);
}

export interface ExecuteIdentityR3ApprovalParams {
  approvalId: string;
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
  causationId?: string;
}

export interface ExecuteIdentityR3ApprovalResult {
  operation: ManagementOperationRecord;
  approval: ApprovalRecord;
  replay: boolean;
}

export async function executeIdentityR3Approval(
  deps: IdentityApprovalOperationDeps,
  params: ExecuteIdentityR3ApprovalParams,
): Promise<ExecuteIdentityR3ApprovalResult> {
  const approval = await deps.approvals.getApproval(params.approvalId);
  const entry = Object.values(IDENTITY_R3_ACTIONS).find((e) => e.action === approval.requestedAction);
  if (!entry) throw new UnknownIdentityR3ActionError(approval.requestedAction);
  if (!approval.targetTenantId) throw new MissingIdentityApprovalTargetError("tenantId");

  // Single-use gate FIRST: whatever happens to the mutation call below, this
  // approval can never authorize a second attempt. A failed mutation after
  // this point requires a fresh approval to retry — deliberately, not a bug
  // (§10: "changing target/action/payload after approval invalidates it";
  // the same discipline applied to "approval already spent").
  const expectedHash = computeIdentityApprovalHash(approval.requestedAction, approval.targetTenantId, approval.targetResourceId);
  const executedApproval = await deps.approvals.markExecuted(params.approvalId, expectedHash);

  const correlationId = params.correlationId ?? randomUUID();
  const tenantId = approval.targetTenantId;
  const userId = approval.targetResourceId;

  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: approval.requestedAction,
    targetTenantId: tenantId,
    targetResourceType: "identity_user",
    targetResourceId: userId,
    reason: approval.reason,
    riskClass: "R3",
    payload: { tenantId, userId, approvalId: approval.approvalId },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: params.causationId,
    // Bound into the ledger's own audit evidence so a reviewer can trace
    // from the executed operation back to who approved it and when,
    // without needing a raw join — see managementOperationLedger.ts's
    // approvalEvidence field, added in 1A.5 for exactly this future use.
    approvalEvidence: { approvalId: approval.approvalId, checkerOperatorId: approval.checkerOperatorId, decidedAt: approval.decidedAt },
  });
  if (replay) return { operation: submitted, replay: true, approval: executedApproval };

  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: [entry.scope],
    targetTenantId: tenantId,
    targetResourceType: "identity_user",
    targetResourceId: userId,
    requestedAction: approval.requestedAction,
    correlationId,
  });

  const commandId = randomUUID();
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(tenantId)}/identities/${encodeURIComponent(userId)}/${entry.segment}`;
  let result;
  try {
    result = await callInfrakineticManagementApi({
      baseUrl: deps.infrakineticBaseUrl,
      path,
      assertion,
      method: "POST",
      body: { reason: approval.reason, idempotencyKey: params.idempotencyKey, commandId },
      correlationId,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    if (isNeverDispatchedNetworkError(err)) {
      const failed = await deps.ledger.transitionOperation(submitted.operationId, {
        toStatus: "failed",
        partialFailureState: { stage: "mutation-call-never-dispatched", message: err instanceof Error ? err.message : String(err) },
      });
      return { operation: failed, replay: false, approval: executedApproval };
    }
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      partialFailureState: { stage: "mutation-call", message: err instanceof Error ? err.message : String(err) },
    });
    return { operation: partial, replay: false, approval: executedApproval };
  }

  if (result.status !== 200) {
    const failed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: { stage: "mutation-response", status: result.status, body: redactSecretShapedFields(result.body) },
    });
    return { operation: failed, replay: false, approval: executedApproval };
  }

  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot(result.body),
    result: result.body,
  });
  return { operation: completed, replay: false, approval: executedApproval };
}
