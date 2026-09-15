import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

import type { ManagementSigningKeySet } from "./managementSigningKeys.js";
import {
  GOVERNANCE_ACTOR_IDENTITY,
  clampAssertionTtlSeconds,
  type ManagementTransportConfig,
} from "./managementConfig.js";

// 1A.4/1A.8.1 — mints the short-lived, signed assertion Governance's backend
// sends to Infrakinetic's `/management/v1/*`. Engine operations retain their
// original target_engine claim; 1A.8.1 adds a generic target-resource pair so
// non-engine management commands are not forced to invent a fake engine.

export interface MintManagementAssertionParams {
  /** Already-authenticated operator identity — never accept this from an unauthenticated caller. */
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  /** The operator's full granted scopes, for the subset check below — not emitted verbatim. */
  operatorGrantedScopes: readonly string[];
  /** The narrow scope(s) this specific call actually needs — must be a subset of operatorGrantedScopes. */
  requestedScopes: readonly string[];
  targetTenantId?: string;
  /** Backward-compatible engine address. Existing 1A.6 callers keep using this unchanged. */
  targetEngine?: string;
  /** Generic management-resource address for non-engine operations. */
  targetResourceType?: string;
  targetResourceId?: string;
  requestedAction: string;
  correlationId?: string;
  ttlSeconds?: number;
}

export class ScopeNotGrantedError extends Error {
  constructor(scope: string) {
    super(`Cannot mint a management assertion requesting scope '${scope}': operator was not granted it.`);
    this.name = "ScopeNotGrantedError";
  }
}

export class InvalidManagementTargetError extends Error {
  constructor(reason: string) {
    super(`Cannot mint management assertion: ${reason}`);
    this.name = "InvalidManagementTargetError";
  }
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveTarget(params: MintManagementAssertionParams): {
  targetEngine?: string;
  targetResourceType: string;
  targetResourceId: string;
} {
  const hasEngine = nonEmpty(params.targetEngine);
  const hasResourceType = nonEmpty(params.targetResourceType);
  const hasResourceId = nonEmpty(params.targetResourceId);

  if (hasResourceType !== hasResourceId) {
    throw new InvalidManagementTargetError("targetResourceType and targetResourceId must be supplied together.");
  }

  if (hasEngine) {
    if (hasResourceType && (params.targetResourceType !== "engine" || params.targetResourceId !== params.targetEngine)) {
      throw new InvalidManagementTargetError("targetEngine conflicts with the generic target-resource address.");
    }
    return {
      targetEngine: params.targetEngine!,
      targetResourceType: "engine",
      targetResourceId: params.targetEngine!,
    };
  }

  if (!hasResourceType || !hasResourceId) {
    throw new InvalidManagementTargetError("an engine target or a complete generic target-resource address is required.");
  }

  return {
    targetResourceType: params.targetResourceType!,
    targetResourceId: params.targetResourceId!,
  };
}

export async function mintManagementAssertion(
  keys: ManagementSigningKeySet,
  config: ManagementTransportConfig,
  params: MintManagementAssertionParams,
): Promise<string> {
  const grantedScopeSet = new Set(params.operatorGrantedScopes);
  for (const scope of params.requestedScopes) {
    if (!grantedScopeSet.has(scope)) throw new ScopeNotGrantedError(scope);
  }
  if (params.requestedScopes.length === 0) {
    throw new Error("Cannot mint a management assertion with zero scopes.");
  }

  const target = resolveTarget(params);
  const ttlSeconds = clampAssertionTtlSeconds(params.ttlSeconds);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const claims: Record<string, unknown> = {
    operator_id: params.operatorId,
    operator_session_id: params.operatorSessionId,
    roles: params.operatorRoles,
    scopes: params.requestedScopes,
    actor_tenant_id: GOVERNANCE_ACTOR_IDENTITY,
    target_resource_type: target.targetResourceType,
    target_resource_id: target.targetResourceId,
    requested_action: params.requestedAction,
    correlation_id: params.correlationId ?? randomUUID(),
  };
  if (target.targetEngine !== undefined) {
    // Preserve the existing engine-specific claim exactly for 1A.6 callers.
    claims.target_engine = target.targetEngine;
  }
  if (params.targetTenantId !== undefined) {
    claims.target_tenant_id = params.targetTenantId;
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keys.activeKid })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ttlSeconds)
    .setJti(randomUUID())
    .sign(keys.activePrivateKey);
}
