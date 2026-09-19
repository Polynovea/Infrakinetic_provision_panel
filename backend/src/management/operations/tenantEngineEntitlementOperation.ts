import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError, ManagementApiUnreachableError } from "./engineStateOperation.js";
import type { RiskClass } from "./riskClassification.js";

// 1A.9.3 — engine entitlement lifecycle. Mirrors engineStateOperation.ts's
// proven shape (resolve-before-read -> ledger reservation -> mint -> mutate
// -> fresh independent-after-read -> compare -> complete/partial) but for a
// tenant-AND-engine-scoped command instead of a platform-wide one. Per
// Governance's own Phase1A.9_Ground_Truth_and_Scoping_2026-09-17.md §1.6,
// the assertion/ledger model already carries both `targetTenantId` and
// `targetEngine` as independent claims with zero schema change — this is
// the first operation module to set both on the same assertion.
//
// Risk class is uniformly R2 (§3.2) — unlike engine-state's own R2/R4
// split, entitlement has no platform-wide blast-radius case to elevate to
// R4; it is always exactly one tenant, one engine. No recoveryIntent gate
// either (that was specific to engine-state's platform-wide emergency
// shape) — reason + idempotency only, same bar as tenant suspend/resume/
// decommission.
//
// Platform engine state is read and carried as CONTEXT on every response,
// never a write-time gate (§3.4) — resolveAccessForUser on the Infrakinetic
// side already applies platform-state precedence ahead of tenant
// entitlement at the enforcement layer; duplicating that here would violate
// §10.3 ("must not duplicate the effective-access algorithm").

export class UnknownEntitlementEngineError extends Error {
  constructor(readonly engineKeyOrAlias: string) {
    super(`'${engineKeyOrAlias}' does not resolve to a known Infrakinetic engine.`);
    this.name = "UnknownEntitlementEngineError";
  }
}

export class UnknownEntitlementTenantError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant '${tenantId}' not found.`);
    this.name = "UnknownEntitlementTenantError";
  }
}

export class MissingEntitlementTenantIdentifierError extends Error {
  constructor() {
    super("An entitlement mutation requires a real tenantId.");
    this.name = "MissingEntitlementTenantIdentifierError";
  }
}

export interface TenantEngineEntitlementOperationDeps {
  ledger: ManagementOperationLedger;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — every path below adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface RequestTenantEngineEntitlementChangeParams {
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  tenantId: string;
  engineKeyOrAlias: string;
  enabled: boolean;
  reason: string;
  correlationId?: string;
  causationId?: string;
}

export interface TenantEngineEntitlementOperationResult {
  operation: ManagementOperationRecord;
  replay: boolean;
}

interface EntitlementReadBody {
  tenantId: string;
  canonicalEngine: string;
  configured: boolean;
  effectiveEnabled: boolean;
  defaultDeny: boolean;
  platformEngineState: { state: string; reason: string | null };
}

interface EntitlementErrorBody {
  error?: string;
}

const ENTITLEMENT_RISK_CLASS: RiskClass = "R2";

export async function requestTenantEngineEntitlementChange(
  deps: TenantEngineEntitlementOperationDeps,
  params: RequestTenantEngineEntitlementChangeParams,
): Promise<TenantEngineEntitlementOperationResult> {
  if (!params.tenantId || params.tenantId.trim() === "") {
    throw new MissingEntitlementTenantIdentifierError();
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
      targetTenantId: params.tenantId,
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

  // Step 1 — resolve + validate via the existing 1A.9.2 read route (no
  // local catalog, no cross-repo import). This also captures the "before"
  // state as independently-observed evidence, not merely asserted.
  const resolveReadPath = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/engines/${encodeURIComponent(params.engineKeyOrAlias)}/entitlement`;
  const resolveAssertion = await mint("tenants.engine-entitlement.read", "tenants.read", params.engineKeyOrAlias);
  let resolveResult;
  try {
    resolveResult = await call(resolveAssertion, "GET", resolveReadPath);
  } catch (err) {
    throw new ManagementApiUnreachableError(resolveReadPath, err);
  }
  if (resolveResult.status === 404) {
    const body = resolveResult.body as EntitlementErrorBody;
    if (body?.error === "UNKNOWN_TENANT") throw new UnknownEntitlementTenantError(params.tenantId);
    throw new UnknownEntitlementEngineError(params.engineKeyOrAlias);
  }
  if (resolveResult.status !== 200) {
    throw new UnexpectedManagementApiResponseError(resolveResult.status, resolveReadPath);
  }
  const resolved = resolveResult.body as EntitlementReadBody;
  const canonicalEngine = resolved.canonicalEngine;
  const beforeEntitlement = {
    configured: resolved.configured,
    effectiveEnabled: resolved.effectiveEnabled,
    defaultDeny: resolved.defaultDeny,
  };

  // Step 2 — idempotency reservation + immutable ledger entry (1A.5). The
  // canonical key, never the caller's alias, is bound into the hash and
  // persisted — same discipline as engineStateOperation.ts.
  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: "tenant.engine.entitlement.set",
    targetTenantId: params.tenantId,
    targetEngine: canonicalEngine,
    reason: params.reason,
    riskClass: ENTITLEMENT_RISK_CLASS,
    payload: {
      tenantId: params.tenantId,
      canonicalEngine,
      enabled: params.enabled,
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
    beforeStateSafeSnapshot: buildSafeSnapshot({ tenantId: params.tenantId, canonicalEngine, ...beforeEntitlement }),
  });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const commandId = randomUUID();
  const mutatePath = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/engines/${encodeURIComponent(canonicalEngine)}/entitlement`;
  const mutateAssertion = await mint("tenant.engine.entitlement.set", "engines.entitlement.write", canonicalEngine);

  let mutateResult;
  try {
    mutateResult = await call(mutateAssertion, "PUT", mutatePath, {
      enabled: params.enabled,
      reason: params.reason,
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

  // Step 3 — independent effective-state observation: a FRESH read, with
  // its own freshly-minted assertion, never trusting the mutation response
  // alone as proof the change actually stuck (same discipline
  // engineStateOperation.ts applies).
  const verifyReadPath = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/engines/${encodeURIComponent(canonicalEngine)}/entitlement`;
  const verifyAssertion = await mint("tenants.engine-entitlement.read", "tenants.read", canonicalEngine);
  let effective: EntitlementReadBody;
  try {
    const verifyResult = await call(verifyAssertion, "GET", verifyReadPath);
    if (verifyResult.status !== 200) {
      throw new UnexpectedManagementApiResponseError(verifyResult.status, verifyReadPath);
    }
    effective = verifyResult.body as EntitlementReadBody;
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

  if (effective.effectiveEnabled !== params.enabled) {
    const mismatch = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      afterStateSafeSnapshot: buildSafeSnapshot({ tenantId: params.tenantId, canonicalEngine, effective }),
      partialFailureState: {
        stage: "effective-mismatch",
        expected: params.enabled,
        observed: effective.effectiveEnabled,
      },
    });
    return { operation: mismatch, replay: false };
  }

  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot({ tenantId: params.tenantId, canonicalEngine, effective }),
    result: {
      commandId,
      canonicalEngine,
      previousEntitlement: beforeEntitlement,
      requestedEnabled: params.enabled,
      resultingEntitlement: {
        configured: effective.configured,
        effectiveEnabled: effective.effectiveEnabled,
        defaultDeny: effective.defaultDeny,
      },
      platformEngineState: effective.platformEngineState,
    },
  });
  return { operation: completed, replay: false };
}
