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

// 1A.13 — R3 credential actions (rotate, revoke). Mirrors
// identityApprovalOperation.ts's three-phase flow exactly: request (maker)
// -> decide (checker, != maker) -> execute (fresh step-up, approval
// consumed exactly once). Step-up freshness is enforced by requireStepUp at
// the route layer (routes/management/index.ts), not here — this module
// only owns the approval/ledger mechanics, reusing the same
// ManagementApprovalStore 1A.12.5 built as the "minimal reusable maker-
// checker approval substrate" (1A.12 handoff's explicit instruction to
// reuse this for the next high-risk vertical, rather than build a second
// approval mechanism).
//
// One real difference from identity's R3 actions: force-reset/mfa-reset are
// parameterless, so identityApprovalOperation.ts's execute() sends an empty
// body. Rotate needs the actual new secret value, which must NOT be held by
// Governance across a pending approval's lifetime (up to
// APPROVAL_TTL_SECONDS = 24h) — Governance never persists a raw secret at
// rest, even temporarily. So the approval hash covers only the ACTION
// (rotate this credential), never the value; the value is supplied only at
// execute() time, by whichever operator with the required scope + fresh
// step-up actually executes the already-approved request.
//
// Closure-remediation audit (2026-09-23) — rotate now covers two secret
// kinds (webhook_secret, with an overlap window; api_key_pair, an atomic
// cutover of both provider key halves — see credentialAdministration.js's
// header on the Infrakinetic side for why api_key_id/api_key_secret were
// collapsed into one pseudo-kind). WHICH kind is being rotated is, like the
// secret value itself, deferred to execute() time rather than bound into
// the approval: ManagementApprovalStore has no column for structured
// per-request metadata beyond the safe payload hash (see
// managementApprovalStore.ts), and both kinds share the exact same risk
// tier, scope (`credentials.rotate`), and step-up requirement, so nothing
// is weakened by letting the executing operator — who must independently
// hold that scope and a fresh step-up — pick the kind at execute time. This
// is accepted architecture debt in the same shape the secret-value deferral
// already was, not a new gap; §13 of the scoping doc records it explicitly
// rather than silently relying on it.

export const CREDENTIAL_R3_ACTIONS = {
  rotate: { action: "credential.rotate", scope: "credentials.rotate" as Scope, segment: "rotate" },
  revoke: { action: "credential.revoke", scope: "credentials.revoke" as Scope, segment: "revoke" },
} as const;

export type CredentialR3ActionKey = keyof typeof CREDENTIAL_R3_ACTIONS;

// Same 24h window as identity's R3 actions — see identityApprovalOperation.ts's
// header for the rationale; revisit under 1A.19 if a different policy value
// is warranted platform-wide.
const APPROVAL_TTL_SECONDS = 24 * 60 * 60;

export class UnknownCredentialR3ActionError extends Error {
  constructor(readonly requestedAction: string) {
    super(`'${requestedAction}' is not a known R3 credential action.`);
    this.name = "UnknownCredentialR3ActionError";
  }
}

export class MissingCredentialApprovalTargetError extends Error {
  constructor(field: string) {
    super(`A credential R3 approval requires a real ${field}.`);
    this.name = "MissingCredentialApprovalTargetError";
  }
}

function computeCredentialApprovalHash(requestedAction: string, tenantId: string, credentialId: string): string {
  return computeSafePayloadHash({
    requestedAction,
    targetTenantId: tenantId,
    targetResourceType: "credential",
    targetResourceId: credentialId,
    payload: { tenantId, credentialId },
  });
}

export interface CredentialApprovalOperationDeps {
  approvals: ManagementApprovalStore;
  ledger: ManagementOperationLedger;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface RequestCredentialR3ApprovalParams {
  actionKey: CredentialR3ActionKey;
  tenantId: string;
  credentialId: string;
  reason: string;
  makerOperatorId: string;
  correlationId?: string;
}

// Only the approval store is needed to request/decide — no assertion is
// minted and no Infrakinetic call happens until execute(). Same narrower
// Pick as identityApprovalOperation.ts, same reasoning.
export async function requestCredentialR3Approval(
  deps: Pick<CredentialApprovalOperationDeps, "approvals">,
  params: RequestCredentialR3ApprovalParams,
): Promise<ApprovalRecord> {
  if (!params.tenantId || params.tenantId.trim() === "") throw new MissingCredentialApprovalTargetError("tenantId");
  if (!params.credentialId || params.credentialId.trim() === "") throw new MissingCredentialApprovalTargetError("credentialId");
  const entry = CREDENTIAL_R3_ACTIONS[params.actionKey];
  if (!entry) throw new UnknownCredentialR3ActionError(params.actionKey);

  return deps.approvals.createApproval({
    approvalId: randomUUID(),
    requestedAction: entry.action,
    targetTenantId: params.tenantId,
    targetResourceType: "credential",
    targetResourceId: params.credentialId,
    safePayloadHash: computeCredentialApprovalHash(entry.action, params.tenantId, params.credentialId),
    riskClass: "R3",
    reason: params.reason,
    makerOperatorId: params.makerOperatorId,
    correlationId: params.correlationId ?? randomUUID(),
    ttlSeconds: APPROVAL_TTL_SECONDS,
  });
}

export interface DecideCredentialR3ApprovalParams {
  approvalId: string;
  checkerOperatorId: string;
  decision: ApprovalDecision;
}

export function decideCredentialR3Approval(
  deps: Pick<CredentialApprovalOperationDeps, "approvals">,
  params: DecideCredentialR3ApprovalParams,
): Promise<ApprovalRecord> {
  // Thin pass-through today, same as identityApprovalOperation.ts's own
  // decide() — kept as its own operation-layer function so a future
  // audit/notification hook has one place to add it.
  return deps.approvals.decideApproval(params);
}

export interface ExecuteCredentialR3ApprovalParams {
  approvalId: string;
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
  causationId?: string;
  /** Rotate only — which kind is being rotated ("webhook_secret" | "api_key_pair"). See this module's header for why it is supplied here, not at request time. Ignored for revoke. */
  secretKind?: "webhook_secret" | "api_key_pair";
  /** Rotate + secretKind "webhook_secret" only — the actual new secret value. */
  secretValue?: string;
  /** Rotate + secretKind "api_key_pair" only — both halves, supplied together. */
  apiKeyId?: string;
  apiKeySecret?: string;
  overlapHours?: number;
  webhookEndpointId?: string;
}

export interface ExecuteCredentialR3ApprovalResult {
  operation: ManagementOperationRecord;
  approval: ApprovalRecord;
  replay: boolean;
}

export async function executeCredentialR3Approval(
  deps: CredentialApprovalOperationDeps,
  params: ExecuteCredentialR3ApprovalParams,
): Promise<ExecuteCredentialR3ApprovalResult> {
  const approval = await deps.approvals.getApproval(params.approvalId);
  const entry = Object.values(CREDENTIAL_R3_ACTIONS).find((e) => e.action === approval.requestedAction);
  if (!entry) throw new UnknownCredentialR3ActionError(approval.requestedAction);
  if (!approval.targetTenantId) throw new MissingCredentialApprovalTargetError("tenantId");

  if (approval.requestedAction === CREDENTIAL_R3_ACTIONS.rotate.action) {
    if (params.secretKind !== "webhook_secret" && params.secretKind !== "api_key_pair") {
      throw new MissingCredentialApprovalTargetError("secretKind");
    }
    if (params.secretKind === "webhook_secret" && (!params.secretValue || params.secretValue.trim() === "")) {
      throw new MissingCredentialApprovalTargetError("secretValue");
    }
    if (params.secretKind === "api_key_pair" && (!params.apiKeyId || params.apiKeyId.trim() === "" || !params.apiKeySecret || params.apiKeySecret.trim() === "")) {
      throw new MissingCredentialApprovalTargetError("apiKeyId/apiKeySecret");
    }
  }

  // Single-use gate FIRST — same discipline as identityApprovalOperation.ts:
  // whatever happens to the mutation call below, this approval can never
  // authorize a second attempt.
  const expectedHash = computeCredentialApprovalHash(approval.requestedAction, approval.targetTenantId, approval.targetResourceId);
  const executedApproval = await deps.approvals.markExecuted(params.approvalId, expectedHash);

  const correlationId = params.correlationId ?? randomUUID();
  const tenantId = approval.targetTenantId;
  const credentialId = approval.targetResourceId;

  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: approval.requestedAction,
    targetTenantId: tenantId,
    targetResourceType: "credential",
    targetResourceId: credentialId,
    reason: approval.reason,
    riskClass: "R3",
    // secretValue/apiKeyId/apiKeySecret deliberately excluded from payload,
    // same reasoning as credentialOperation.ts's requestCredentialReplace.
    // secretKind is a label, not material — safe to record.
    payload: {
      tenantId,
      credentialId,
      secretKind: approval.requestedAction === CREDENTIAL_R3_ACTIONS.rotate.action ? params.secretKind ?? null : null,
      approvalId: approval.approvalId,
    },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: params.causationId,
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
    targetResourceType: "credential",
    targetResourceId: credentialId,
    requestedAction: approval.requestedAction,
    correlationId,
  });

  const commandId = randomUUID();
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/${entry.segment}`;
  const body: Record<string, unknown> = { reason: approval.reason, idempotencyKey: params.idempotencyKey, commandId };
  if (approval.requestedAction === CREDENTIAL_R3_ACTIONS.rotate.action) {
    body.secretKind = params.secretKind;
    if (params.secretKind === "api_key_pair") {
      body.apiKeyId = params.apiKeyId;
      body.apiKeySecret = params.apiKeySecret;
    } else {
      body.secretValue = params.secretValue;
    }
    if (params.overlapHours !== undefined) body.overlapHours = params.overlapHours;
    if (params.webhookEndpointId !== undefined) body.webhookEndpointId = params.webhookEndpointId;
  }

  let result;
  try {
    result = await callInfrakineticManagementApi({
      baseUrl: deps.infrakineticBaseUrl,
      path,
      assertion,
      method: "POST",
      body,
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
