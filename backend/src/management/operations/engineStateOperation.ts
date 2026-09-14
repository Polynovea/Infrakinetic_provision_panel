import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import type { RiskClass } from "./riskClassification.js";

// 1A.6 — the first real Governance -> Infrakinetic mutation, per the master
// plan's own §7 sequencing: "PolyNovea Platform Governance -> management
// command -> setPlatformEngineState() -> effective request access changes
// -> independent effective-state observation." This is a synchronous
// server-to-server RPC over the already-live 1A.4 transport, NOT the async
// management.command outbox scaffold managementCommandContract.js defines
// on the Infrakinetic side — that scaffold stays reserved for whenever an
// actually-async internal dispatch is needed; a real-time HTTP mutation
// with an immediate result (which this is) has no use for a queue. The
// `platform-management.command.v1` contract version is still recorded on
// every operation for audit fidelity, matching §17's shape conceptually.
//
// Every identity/routing fact (operator, session, target engine, requested
// action, correlation id) travels ONLY inside the signed assertion minted
// per call — never re-asserted in a request body, which would just be an
// unverified claim duplicating what the assertion already proves.
//
// Idempotency is 1A.5's ledger, not a second store here or on the
// Infrakinetic side: createOrReplayOperation() decides, once, whether this
// is a new request or a replay. On replay, this function returns
// immediately after resolving the canonical engine (a read, not a
// mutation) — it never calls the PUT mutation route or the post-mutation
// effective-read a second time. That is what makes
// "setPlatformEngineState() called exactly once for idempotent retry" true
// by construction, not by a retry-count check.

export class UnknownEngineError extends Error {
  constructor(readonly engineKeyOrAlias: string) {
    super(`'${engineKeyOrAlias}' does not resolve to a known Infrakinetic engine.`);
    this.name = "UnknownEngineError";
  }
}

export class MissingRecoveryIntentError extends Error {
  constructor() {
    super("Disabling an engine requires an explicit recoveryIntent describing how/when it will be restored.");
    this.name = "MissingRecoveryIntentError";
  }
}

export class UnexpectedManagementApiResponseError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`Unexpected status ${status} from Infrakinetic's management API at ${path}.`);
    this.name = "UnexpectedManagementApiResponseError";
  }
}

export interface EngineStateOperationDeps {
  ledger: ManagementOperationLedger;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin (e.g. "http://127.0.0.1:4000") — every path below adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

// Every route this module calls lives under Infrakinetic's /management/v1
// mount (routes/management/v1/index.js) — never the bare path. Exported so
// other read-only query modules (e.g. tenantRegistryQuery.ts) share the same
// constant instead of redeclaring it.
export const MANAGEMENT_V1_PREFIX = "/management/v1";

export type PlatformEngineState = "operational" | "degraded" | "disabled";

export interface RequestEngineStateChangeParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  engineKeyOrAlias: string;
  desiredState: PlatformEngineState;
  reason: string;
  metadata?: Record<string, unknown>;
  /** Required when desiredState === "disabled" (instruction #6: "explicit recovery intent"). */
  recoveryIntent?: string;
  correlationId?: string;
  causationId?: string;
  /** Set when this call is itself a recovery of a prior operation. */
  rollbackOfOperationId?: string;
}

export interface EngineStateOperationResult {
  operation: ManagementOperationRecord;
  replay: boolean;
}

interface EffectiveStateReadBody {
  engineKey: string;
  state: string;
  reason: string | null;
}

function riskClassFor(desiredState: PlatformEngineState): RiskClass {
  // Master plan §20 example lists "global engine disable" as R4; degraded
  // and operational (including restoring from disabled) are meaningful
  // operational changes, closer to §20's R2 ("tenant operational... requires
  // reason and idempotency") than either R0 (read-only) or R1 (low-impact
  // metadata) — this platform-wide primitive has no R0/R1-shaped case.
  return desiredState === "disabled" ? "R4" : "R2";
}

export async function requestEngineStateChange(
  deps: EngineStateOperationDeps,
  params: RequestEngineStateChangeParams,
): Promise<EngineStateOperationResult> {
  if (params.desiredState === "disabled" && (!params.recoveryIntent || params.recoveryIntent.trim() === "")) {
    throw new MissingRecoveryIntentError();
  }

  const correlationId = params.correlationId ?? randomUUID();

  const mint = (requestedAction: string, scope: string, targetEngine: string): Promise<string> =>
    mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
      operatorId: params.operatorId,
      operatorSessionId: params.operatorSessionId,
      operatorRoles: params.operatorRoles,
      operatorGrantedScopes: params.operatorGrantedScopes,
      requestedScopes: [scope],
      targetEngine,
      requestedAction,
      correlationId,
    });

  const call = (assertion: string, method: "GET" | "PUT", path: string, body?: unknown) =>
    callInfrakineticManagementApi({
      baseUrl: deps.infrakineticBaseUrl,
      path,
      assertion,
      method,
      body,
      correlationId,
      fetchImpl: deps.fetchImpl,
    });

  // Step 1 — resolve + validate the engine via the EXISTING 1A.4 read
  // route (no local catalog, no cross-repo import: instruction #4). This
  // also captures the "before" state as independently-observed evidence,
  // not merely asserted by the caller.
  const resolveReadPath = `${MANAGEMENT_V1_PREFIX}/engines/${encodeURIComponent(params.engineKeyOrAlias)}/state`;
  const resolveAssertion = await mint("engines.state.read", "engines.read", params.engineKeyOrAlias);
  const resolveResult = await call(resolveAssertion, "GET", resolveReadPath);
  if (resolveResult.status === 404) {
    throw new UnknownEngineError(params.engineKeyOrAlias);
  }
  if (resolveResult.status !== 200) {
    throw new UnexpectedManagementApiResponseError(resolveResult.status, resolveReadPath);
  }
  const resolved = resolveResult.body as EffectiveStateReadBody;
  const canonicalEngine = resolved.engineKey;
  const beforeState = { state: resolved.state, reason: resolved.reason };

  // Step 2 — idempotency reservation + immutable ledger entry (1A.5). The
  // canonical key, never the caller's alias, is what gets bound into the
  // hash and persisted (instruction #4).
  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: "platform.engine-state.set",
    targetTenantId: null,
    targetEngine: canonicalEngine,
    reason: params.reason,
    riskClass: riskClassFor(params.desiredState),
    approvalEvidence:
      params.recoveryIntent || params.rollbackOfOperationId
        ? { recoveryIntent: params.recoveryIntent, rollbackOfOperationId: params.rollbackOfOperationId }
        : undefined,
    payload: {
      desiredState: params.desiredState,
      metadata: params.metadata ?? {},
      recoveryIntent: params.recoveryIntent ?? null,
      rollbackOfOperationId: params.rollbackOfOperationId ?? null,
    },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: params.causationId,
  });

  if (replay) {
    // No mutation, no effective re-read — the durable result already
    // recorded from the first real attempt is the answer.
    return { operation: submitted, replay: true };
  }

  await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "accepted",
    beforeStateSafeSnapshot: buildSafeSnapshot({ engineKey: canonicalEngine, ...beforeState }),
  });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const commandId = randomUUID();
  const mutatePath = `${MANAGEMENT_V1_PREFIX}/engine-state/${encodeURIComponent(canonicalEngine)}`;
  const mutateAssertion = await mint("platform.engine-state.set", "engines.platform_state.write", canonicalEngine);

  let mutateResult;
  try {
    mutateResult = await call(mutateAssertion, "PUT", mutatePath, {
      desiredState: params.desiredState,
      reason: params.reason,
      metadata: params.metadata,
      recoveryIntent: params.recoveryIntent,
      commandId,
      idempotencyKey: params.idempotencyKey,
    });
  } catch (err) {
    const failed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: {
        stage: "mutation-call",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return { operation: failed, replay: false };
  }

  if (mutateResult.status !== 200) {
    const failed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: {
        stage: "mutation-response",
        status: mutateResult.status,
        body: redactSecretShapedFields(mutateResult.body),
      },
    });
    return { operation: failed, replay: false };
  }

  // Step 3 — independent effective-state observation (instruction #10): a
  // FRESH read, with its own freshly-minted assertion, never trusting the
  // mutation response alone as proof the change actually stuck.
  const verifyReadPath = `${MANAGEMENT_V1_PREFIX}/engines/${encodeURIComponent(canonicalEngine)}/state`;
  const verifyAssertion = await mint("engines.state.read", "engines.read", canonicalEngine);
  let effective: EffectiveStateReadBody;
  try {
    const verifyResult = await call(verifyAssertion, "GET", verifyReadPath);
    if (verifyResult.status !== 200) {
      throw new UnexpectedManagementApiResponseError(verifyResult.status, verifyReadPath);
    }
    effective = verifyResult.body as EffectiveStateReadBody;
  } catch (err) {
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      afterStateSafeSnapshot: buildSafeSnapshot({ mutationResult: mutateResult.body }),
      partialFailureState: {
        stage: "effective-observation",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return { operation: partial, replay: false };
  }

  if (effective.state !== params.desiredState) {
    const mismatch = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      afterStateSafeSnapshot: buildSafeSnapshot({ engineKey: canonicalEngine, effective }),
      partialFailureState: {
        stage: "effective-mismatch",
        expected: params.desiredState,
        observed: effective.state,
      },
    });
    return { operation: mismatch, replay: false };
  }

  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot({ engineKey: canonicalEngine, effective }),
    result: {
      commandId,
      canonicalEngine,
      previousState: beforeState,
      requestedState: params.desiredState,
      resultingState: mutateResult.body,
      effectiveState: effective,
    },
  });
  return { operation: completed, replay: false };
}

export interface RecoverEngineStateParams {
  originalOperationId: string;
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  reason: string;
  correlationId?: string;
}

// Restores the ACTUAL prior state recorded on the operation being reversed
// (its own before_state_safe_snapshot) — never blindly "operational"
// (instruction #14: "if the original state was degraded, restore
// degraded"). Threads causation back to the original operation and, on
// success, attaches a rollback reference to it.
export async function recoverEngineState(
  deps: EngineStateOperationDeps,
  ledgerLookup: ManagementOperationLedger,
  params: RecoverEngineStateParams,
): Promise<EngineStateOperationResult> {
  const original = await ledgerLookup.getOperation(params.originalOperationId);
  const beforeSnapshot = original.beforeStateSafeSnapshot as { data?: { state?: string; reason?: string | null } } | undefined;
  const priorState = beforeSnapshot?.data?.state;
  if (priorState !== "operational" && priorState !== "degraded" && priorState !== "disabled") {
    throw new Error(
      `Cannot recover operation '${params.originalOperationId}': no valid before-state snapshot was recorded on it.`,
    );
  }

  const result = await requestEngineStateChange(deps, {
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    engineKeyOrAlias: original.targetEngine,
    desiredState: priorState,
    reason: `Recovery of operation ${params.originalOperationId}: ${params.reason}`,
    recoveryIntent: priorState === "disabled" ? "already the recovery of a prior operation; no further action planned" : undefined,
    metadata: { restoredReason: beforeSnapshot?.data?.reason ?? null },
    correlationId: params.correlationId,
    causationId: original.operationId,
    rollbackOfOperationId: original.operationId,
  });

  if (!result.replay && result.operation.status === "completed") {
    await ledgerLookup.attachRollbackReference(original.operationId, {
      recoveryOperationId: result.operation.operationId,
      recoveryIdempotencyKey: params.idempotencyKey,
    });
  }

  return result;
}
