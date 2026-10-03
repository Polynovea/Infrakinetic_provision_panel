import { randomUUID } from "node:crypto";

import type { Scope } from "../../identity/roles.js";
import { computeSafePayloadHash } from "./canonicalHash.js";
import { listEngineCatalog, type EngineCatalogQueryDeps } from "./engineCatalogQuery.js";
import {
  ApprovedEngineStateChangedError,
  MissingRecoveryIntentError,
  UnknownEngineError,
  requestEngineStateChange,
  type EngineStateOperationDeps,
  type EngineStateOperationResult,
  type PlatformEngineState,
} from "./engineStateOperation.js";
import type { ApprovalRecord, ManagementApprovalStore } from "./managementApprovalStore.js";

const APPROVAL_TTL_SECONDS = 24 * 60 * 60;
export const ENGINE_DISABLE_APPROVAL_ACTION = "platform.engine-state.set";
export const ENGINE_DISABLE_APPROVAL_SCOPE: Scope = "engines.platform_state.write";
const TARGET_TYPE = "platform_engine";

export interface EngineStateApprovalDeps extends EngineStateOperationDeps, EngineCatalogQueryDeps {
  approvals: ManagementApprovalStore;
}

interface OperatorParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

export interface RequestEngineDisableApprovalParams extends OperatorParams {
  engineKeyOrAlias: string;
  reason: string;
  recoveryIntent: string;
  metadata?: Record<string, unknown>;
}

function approvalHash(engineKey: string, summary: Record<string, unknown>): string {
  return computeSafePayloadHash({
    requestedAction: ENGINE_DISABLE_APPROVAL_ACTION,
    targetResourceType: TARGET_TYPE,
    targetResourceId: engineKey,
    payload: summary,
  });
}

function resolveEngine(
  engines: Awaited<ReturnType<typeof listEngineCatalog>>["engines"],
  keyOrAlias: string,
) {
  return engines.find((entry) => entry.engineKey === keyOrAlias || entry.aliases.includes(keyOrAlias));
}

export function isEngineDisableApproval(approval: { requestedAction: string; targetResourceType?: string; riskClass?: string }): boolean {
  return approval.requestedAction === ENGINE_DISABLE_APPROVAL_ACTION && approval.targetResourceType === TARGET_TYPE && approval.riskClass === "R4";
}

export function engineDisableApprovalScope(approval: { requestedAction: string; targetResourceType?: string; riskClass?: string }): Scope | undefined {
  return isEngineDisableApproval(approval) ? ENGINE_DISABLE_APPROVAL_SCOPE : undefined;
}

export async function requestEngineDisableApproval(
  deps: EngineStateApprovalDeps,
  params: RequestEngineDisableApprovalParams,
): Promise<ApprovalRecord> {
  if (!params.recoveryIntent || params.recoveryIntent.trim() === "") throw new MissingRecoveryIntentError();
  const catalog = await listEngineCatalog(deps, params);
  const engine = resolveEngine(catalog.engines, params.engineKeyOrAlias);
  if (!engine) throw new UnknownEngineError(params.engineKeyOrAlias);
  if (engine.state === "unknown") throw new Error(`Cannot approve disable for '${engine.engineKey}' while its effective state is unknown.`);
  if (engine.state === "disabled") throw new Error(`Engine '${engine.engineKey}' is already disabled.`);

  const summary: Record<string, unknown> = {
    canonicalEngine: engine.engineKey,
    desiredState: "disabled",
    stateAtRequest: engine.state,
    reasonAtRequest: engine.reason,
    recoveryIntent: params.recoveryIntent,
    metadata: params.metadata ?? {},
  };
  return deps.approvals.createApproval({
    approvalId: randomUUID(),
    requestedAction: ENGINE_DISABLE_APPROVAL_ACTION,
    targetResourceType: TARGET_TYPE,
    targetResourceId: engine.engineKey,
    safePayloadHash: approvalHash(engine.engineKey, summary),
    safeRequestSummary: summary,
    riskClass: "R4",
    reason: params.reason,
    makerOperatorId: params.operatorId,
    correlationId: params.correlationId ?? randomUUID(),
    ttlSeconds: APPROVAL_TTL_SECONDS,
  });
}

export interface ExecuteEngineDisableApprovalParams extends OperatorParams {
  approvalId: string;
  idempotencyKey: string;
}

export async function executeEngineDisableApproval(
  deps: EngineStateApprovalDeps,
  params: ExecuteEngineDisableApprovalParams,
): Promise<EngineStateOperationResult & { approval: ApprovalRecord }> {
  const approval = await deps.approvals.getApproval(params.approvalId);
  if (!isEngineDisableApproval(approval) || !approval.safeRequestSummary) throw new Error("Approval is not an engine-disable approval.");
  if (![approval.makerOperatorId, approval.checkerOperatorId].includes(params.operatorId)) {
    throw new Error("Only the approval maker or checker may execute this R4 engine-disable approval.");
  }

  const prior = await deps.ledger.findApprovalExecutionReplay(params.idempotencyKey, approval.approvalId, approval.requestedAction);
  if (prior) return { operation: prior, replay: true, approval };

  const summary = approval.safeRequestSummary;
  const engineKey = String(summary.canonicalEngine ?? approval.targetResourceId);
  const expectedState = summary.stateAtRequest as PlatformEngineState;
  const expectedReason = (summary.reasonAtRequest as string | null | undefined) ?? null;
  const catalog = await listEngineCatalog(deps, params);
  const current = resolveEngine(catalog.engines, engineKey);
  if (!current || current.state === "unknown") throw new Error(`Cannot execute approved disable for '${engineKey}' because current state cannot be verified.`);
  if (current.state !== expectedState || current.reason !== expectedReason) {
    throw new ApprovedEngineStateChangedError(
      { state: expectedState, reason: expectedReason },
      { state: current.state, reason: current.reason },
    );
  }

  const executed = await deps.approvals.markExecuted(
    approval.approvalId,
    approvalHash(approval.targetResourceId, summary),
  );
  if (!executed.checkerOperatorId) throw new Error("Approved engine-disable request has no checker evidence.");

  const result = await requestEngineStateChange(deps, {
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    engineKeyOrAlias: engineKey,
    desiredState: "disabled",
    reason: approval.reason,
    recoveryIntent: String(summary.recoveryIntent),
    metadata: (summary.metadata as Record<string, unknown> | undefined) ?? {},
    correlationId: params.correlationId,
    approvalEvidence: {
      approvalId: approval.approvalId,
      makerOperatorId: approval.makerOperatorId,
      checkerOperatorId: executed.checkerOperatorId,
    },
    expectedBeforeState: { state: expectedState, reason: expectedReason },
  });
  return { ...result, approval: executed };
}
