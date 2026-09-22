import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi, isNeverDispatchedNetworkError } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { MANAGEMENT_V1_PREFIX } from "./engineStateOperation.js";
import type { RiskClass } from "./riskClassification.js";

// 1A.12.2 — the routine (R2) identity-administration mutations: invitation
// lifecycle, user-controlled recovery initiation, suspend/restore, and
// session/global-signout revocation. Mirrors tenantLifecycleOperation.ts's
// requestTenantTransition shape (ledger reservation -> mint -> mutate ->
// complete/partial), minus that module's commissioned_tenants projection
// bookkeeping — there is no Governance-side identity projection to keep in
// sync; identityQuery.ts's fresh reads ARE the effective-state observation.
//
// R3 actions (force-reset, mfa.reset) deliberately live in a separate
// module (identityApprovalOperation.ts, 1A.12.5) — they require step-up and
// maker-checker approval before this shape even applies.

const IDENTITY_RISK_CLASS: RiskClass = "R2";

export class MissingIdentityTargetError extends Error {
  constructor(field: string) {
    super(`An identity-administration mutation requires a real ${field}.`);
    this.name = "MissingIdentityTargetError";
  }
}

export interface IdentityOperationDeps {
  ledger: ManagementOperationLedger;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface IdentityOperationResult {
  operation: ManagementOperationRecord;
  replay: boolean;
}

function mintAndCall(
  deps: IdentityOperationDeps,
  params: {
    operatorId: string;
    operatorSessionId: string;
    operatorRoles: readonly string[];
    operatorGrantedScopes: readonly string[];
    requestedScope: string;
    targetTenantId: string;
    targetResourceType: string;
    targetResourceId: string;
    requestedAction: string;
    correlationId: string;
  },
) {
  return async (method: "GET" | "POST", path: string, body?: unknown) => {
    const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
      operatorId: params.operatorId,
      operatorSessionId: params.operatorSessionId,
      operatorRoles: params.operatorRoles,
      operatorGrantedScopes: params.operatorGrantedScopes,
      requestedScopes: [params.requestedScope],
      targetTenantId: params.targetTenantId,
      targetResourceType: params.targetResourceType,
      targetResourceId: params.targetResourceId,
      requestedAction: params.requestedAction,
      correlationId: params.correlationId,
    });
    return callInfrakineticManagementApi({
      baseUrl: deps.infrakineticBaseUrl,
      path,
      assertion,
      method,
      body,
      correlationId: params.correlationId,
      fetchImpl: deps.fetchImpl,
    });
  };
}

interface IdentityMutationBody {
  [key: string]: unknown;
}

// Shared reserve -> mint -> call -> complete/partial shape for every R2
// identity command below. `payload` is what gets hashed for idempotency
// (never persisted verbatim — managementOperationLedger.ts only ever hashes
// it); `body` is what is actually sent to Infrakinetic (may be a superset,
// e.g. carrying `email` for invitation issuance).
async function executeIdentityCommand(
  deps: IdentityOperationDeps,
  params: {
    idempotencyKey: string;
    operatorId: string;
    operatorSessionId: string;
    operatorRoles: readonly string[];
    operatorGrantedScopes: readonly string[];
    tenantId: string;
    requestedAction: string;
    requestedScope: string;
    targetResourceType: string;
    targetResourceId: string;
    payload: unknown;
    reason: string;
    path: string;
    body: IdentityMutationBody;
    correlationId?: string;
    causationId?: string;
  },
): Promise<IdentityOperationResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: params.requestedAction,
    targetTenantId: params.tenantId,
    targetResourceType: params.targetResourceType,
    targetResourceId: params.targetResourceId,
    reason: params.reason,
    riskClass: IDENTITY_RISK_CLASS,
    payload: params.payload,
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: params.causationId,
  });

  if (replay) return { operation: submitted, replay: true };

  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const call = mintAndCall(deps, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScope: params.requestedScope,
    targetTenantId: params.tenantId,
    targetResourceType: params.targetResourceType,
    targetResourceId: params.targetResourceId,
    requestedAction: params.requestedAction,
    correlationId,
  });

  const commandId = randomUUID();
  let result;
  try {
    result = await call("POST", params.path, { ...params.body, reason: params.reason, idempotencyKey: params.idempotencyKey, commandId });
  } catch (err) {
    if (isNeverDispatchedNetworkError(err)) {
      const failed = await deps.ledger.transitionOperation(submitted.operationId, {
        toStatus: "failed",
        partialFailureState: { stage: "mutation-call-never-dispatched", message: err instanceof Error ? err.message : String(err) },
      });
      return { operation: failed, replay: false };
    }
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      partialFailureState: { stage: "mutation-call", message: err instanceof Error ? err.message : String(err) },
    });
    return { operation: partial, replay: false };
  }

  if (result.status !== 200) {
    const failed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: { stage: "mutation-response", status: result.status, body: redactSecretShapedFields(result.body) },
    });
    return { operation: failed, replay: false };
  }

  const ownerCommandStatus =
    result.body && typeof result.body === "object" && "commandStatus" in result.body
      ? (result.body as { commandStatus?: unknown }).commandStatus
      : undefined;
  if (ownerCommandStatus === "partially_completed") {
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      afterStateSafeSnapshot: buildSafeSnapshot(result.body),
      result: result.body,
      partialFailureState: { stage: "owner-reported-partial", body: redactSecretShapedFields(result.body) },
    });
    return { operation: partial, replay: false };
  }

  // result.body is already Infrakinetic's own sanitized safeResult — see
  // identityAdministration.js's header, which guarantees no
  // password/reset-code/token/MFA-secret ever appears here. buildSafeSnapshot
  // additionally redacts anything secret-shaped as a defense-in-depth net.
  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot(result.body),
    result: result.body,
  });
  return { operation: completed, replay: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Invitation lifecycle
// ─────────────────────────────────────────────────────────────────────────

export interface RequestIdentityInvitationParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  tenantId: string;
  invitationRequestId: string;
  email: string;
  fullName?: string;
  roleKey?: string;
  reason: string;
  correlationId?: string;
  causationId?: string;
}

export async function requestIdentityInvitation(deps: IdentityOperationDeps, params: RequestIdentityInvitationParams) {
  if (!params.tenantId || params.tenantId.trim() === "") throw new MissingIdentityTargetError("tenantId");
  return executeIdentityCommand(deps, {
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    tenantId: params.tenantId,
    requestedAction: "identity.invitation.issue",
    requestedScope: "identity.recovery",
    targetResourceType: "identity_invitation_request",
    targetResourceId: params.invitationRequestId,
    payload: { tenantId: params.tenantId, email: params.email, fullName: params.fullName ?? null, roleKey: params.roleKey ?? null },
    reason: params.reason,
    path: `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/identity-invitations`,
    body: { invitationRequestId: params.invitationRequestId, email: params.email, fullName: params.fullName, roleKey: params.roleKey },
    correlationId: params.correlationId,
    causationId: params.causationId,
  });
}

export interface RequestIdentityInvitationActionParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  tenantId: string;
  invitationId: string;
  reason: string;
  correlationId?: string;
  causationId?: string;
}

async function requestIdentityInvitationAction(
  action: "resend" | "cancel",
  deps: IdentityOperationDeps,
  params: RequestIdentityInvitationActionParams,
) {
  if (!params.tenantId || params.tenantId.trim() === "") throw new MissingIdentityTargetError("tenantId");
  if (!params.invitationId || params.invitationId.trim() === "") throw new MissingIdentityTargetError("invitationId");
  return executeIdentityCommand(deps, {
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    tenantId: params.tenantId,
    requestedAction: `identity.invitation.${action}`,
    requestedScope: "identity.recovery",
    targetResourceType: "identity_invitation",
    targetResourceId: params.invitationId,
    payload: { tenantId: params.tenantId, invitationId: params.invitationId },
    reason: params.reason,
    path: `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/identity-invitations/${encodeURIComponent(params.invitationId)}/${action}`,
    body: {},
    correlationId: params.correlationId,
    causationId: params.causationId,
  });
}

export function requestIdentityInvitationResend(deps: IdentityOperationDeps, params: RequestIdentityInvitationActionParams) {
  return requestIdentityInvitationAction("resend", deps, params);
}
export function requestIdentityInvitationCancel(deps: IdentityOperationDeps, params: RequestIdentityInvitationActionParams) {
  return requestIdentityInvitationAction("cancel", deps, params);
}

// ─────────────────────────────────────────────────────────────────────────
// Single-user commands: recovery initiate, suspend, restore,
// global-signout, sessions/revoke — same request/target shape.
// ─────────────────────────────────────────────────────────────────────────

export interface RequestIdentityUserActionParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  tenantId: string;
  userId: string;
  reason: string;
  correlationId?: string;
  causationId?: string;
}

const USER_ACTIONS: Record<string, { action: string; scope: string; segment: string }> = {
  recovery: { action: "identity.recovery.initiate", scope: "identity.recovery", segment: "recovery" },
  suspend: { action: "identity.suspend", scope: "identity.disable", segment: "suspend" },
  restore: { action: "identity.restore", scope: "identity.disable", segment: "restore" },
  globalSignout: { action: "identity.global-signout", scope: "identity.disable", segment: "global-signout" },
  sessionsRevoke: { action: "identity.sessions.revoke", scope: "identity.disable", segment: "sessions/revoke" },
};

async function requestIdentityUserAction(
  key: keyof typeof USER_ACTIONS,
  deps: IdentityOperationDeps,
  params: RequestIdentityUserActionParams,
) {
  if (!params.tenantId || params.tenantId.trim() === "") throw new MissingIdentityTargetError("tenantId");
  if (!params.userId || params.userId.trim() === "") throw new MissingIdentityTargetError("userId");
  const { action, scope, segment } = USER_ACTIONS[key];
  return executeIdentityCommand(deps, {
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    tenantId: params.tenantId,
    requestedAction: action,
    requestedScope: scope,
    targetResourceType: "identity_user",
    targetResourceId: params.userId,
    payload: { tenantId: params.tenantId, userId: params.userId },
    reason: params.reason,
    path: `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/identities/${encodeURIComponent(params.userId)}/${segment}`,
    body: {},
    correlationId: params.correlationId,
    causationId: params.causationId,
  });
}

export function requestIdentityRecovery(deps: IdentityOperationDeps, params: RequestIdentityUserActionParams) {
  return requestIdentityUserAction("recovery", deps, params);
}
export function requestIdentitySuspend(deps: IdentityOperationDeps, params: RequestIdentityUserActionParams) {
  return requestIdentityUserAction("suspend", deps, params);
}
export function requestIdentityRestore(deps: IdentityOperationDeps, params: RequestIdentityUserActionParams) {
  return requestIdentityUserAction("restore", deps, params);
}
export function requestIdentityGlobalSignout(deps: IdentityOperationDeps, params: RequestIdentityUserActionParams) {
  return requestIdentityUserAction("globalSignout", deps, params);
}
export function requestIdentitySessionsRevoke(deps: IdentityOperationDeps, params: RequestIdentityUserActionParams) {
  return requestIdentityUserAction("sessionsRevoke", deps, params);
}
