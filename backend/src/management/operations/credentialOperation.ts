import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi, isNeverDispatchedNetworkError } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";
import type { RiskClass } from "./riskClassification.js";

// 1A.13 — the routine (R2) credential-administration mutation: replace (an
// immediate secret-value swap, no overlap window — §7.1 of the scoping doc:
// "nothing to break on a first-time submission" reasoning). Mirrors
// identityOperation.ts's executeIdentityCommand shape (ledger reservation ->
// mint -> mutate -> complete/partial) exactly.
//
// R3 actions (rotate, revoke) deliberately live in a separate module
// (credentialApprovalOperation.ts) — they require step-up and maker-checker
// approval before this shape even applies. `test` (R0/R1, no reason/
// idempotency per §8 of the scoping doc) is also here but deliberately does
// NOT go through the ledger — same read-adjacent bar as a detail read, just
// issued as a POST because it triggers a live provider call on the
// Infrakinetic side.

const CREDENTIAL_RISK_CLASS: RiskClass = "R2";

export class MissingCredentialTargetError extends Error {
  constructor(field: string) {
    super(`A credential-administration mutation requires a real ${field}.`);
    this.name = "MissingCredentialTargetError";
  }
}

export interface CredentialOperationDeps {
  ledger: ManagementOperationLedger;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface CredentialOperationResult {
  operation: ManagementOperationRecord;
  replay: boolean;
}

function mintAndCall(
  deps: CredentialOperationDeps,
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

interface CredentialMutationBody {
  [key: string]: unknown;
}

async function executeCredentialCommand(
  deps: CredentialOperationDeps,
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
    body: CredentialMutationBody;
    correlationId?: string;
    causationId?: string;
  },
): Promise<CredentialOperationResult> {
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
    riskClass: CREDENTIAL_RISK_CLASS,
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
  // credentialAdministration.js's header, which guarantees no secret/
  // ciphertext/key material ever appears here. buildSafeSnapshot
  // additionally redacts anything secret-shaped as a defense-in-depth net —
  // this is the one route family where that net matters most, since the
  // request itself (unlike identity) legitimately carries a raw secretValue
  // field that must never leak into afterStateSafeSnapshot/result.
  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot(result.body),
    result: result.body,
  });
  return { operation: completed, replay: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Replace (R2)
// ─────────────────────────────────────────────────────────────────────────

export interface RequestCredentialReplaceParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  tenantId: string;
  credentialId: string;
  secretKind: string;
  secretValue: string;
  reason: string;
  correlationId?: string;
  causationId?: string;
}

export async function requestCredentialReplace(deps: CredentialOperationDeps, params: RequestCredentialReplaceParams) {
  if (!params.tenantId || params.tenantId.trim() === "") throw new MissingCredentialTargetError("tenantId");
  if (!params.credentialId || params.credentialId.trim() === "") throw new MissingCredentialTargetError("credentialId");
  return executeCredentialCommand(deps, {
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    tenantId: params.tenantId,
    requestedAction: "credential.replace",
    requestedScope: "credentials.submit",
    targetResourceType: "credential",
    targetResourceId: params.credentialId,
    // secretValue is deliberately excluded from payload — payload is only
    // ever hashed for idempotency (managementOperationLedger.ts never
    // persists it verbatim), but "never hashed" is a weaker guarantee than
    // "never in memory as part of a logged/snapshotted object" — keeping it
    // out of payload means it can never accidentally end up in a future
    // debug log of the hash input either.
    payload: { tenantId: params.tenantId, credentialId: params.credentialId, secretKind: params.secretKind },
    reason: params.reason,
    path: `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/credentials/${encodeURIComponent(params.credentialId)}/replace`,
    body: { secretKind: params.secretKind, secretValue: params.secretValue },
    correlationId: params.correlationId,
    causationId: params.causationId,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Test (R0/R1) — no reason/idempotency, no ledger row. Same bar as a detail
// read; issued as POST only because it triggers a live provider call.
// ─────────────────────────────────────────────────────────────────────────

export interface RequestCredentialTestParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  tenantId: string;
  credentialId: string;
  correlationId?: string;
}

export interface CredentialTestResult {
  tenantId: string;
  credentialId: string;
  validationStatus: string;
  testedAt: string;
  correlationId: string;
}

export async function requestCredentialTest(
  deps: Pick<CredentialOperationDeps, "signingKeys" | "transportConfig" | "infrakineticBaseUrl" | "fetchImpl">,
  params: RequestCredentialTestParams,
): Promise<CredentialTestResult> {
  if (!params.tenantId || params.tenantId.trim() === "") throw new MissingCredentialTargetError("tenantId");
  if (!params.credentialId || params.credentialId.trim() === "") throw new MissingCredentialTargetError("credentialId");
  const correlationId = params.correlationId ?? randomUUID();
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/credentials/${encodeURIComponent(params.credentialId)}/test`;
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["credentials.metadata.read"],
    targetTenantId: params.tenantId,
    targetResourceType: "credential",
    targetResourceId: params.credentialId,
    requestedAction: "credential.test",
    correlationId,
  });
  const result = await callInfrakineticManagementApi({
    baseUrl: deps.infrakineticBaseUrl,
    path,
    assertion,
    method: "POST",
    correlationId,
    fetchImpl: deps.fetchImpl,
  });
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as CredentialTestResult;
}
