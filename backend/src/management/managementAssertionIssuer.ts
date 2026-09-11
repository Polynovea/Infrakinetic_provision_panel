import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

import type { ManagementSigningKeySet } from "./managementSigningKeys.js";
import {
  GOVERNANCE_ACTOR_IDENTITY,
  clampAssertionTtlSeconds,
  type ManagementTransportConfig,
} from "./managementConfig.js";

// 1A.4 — mints the short-lived, signed assertion Governance's backend sends
// to Infrakinetic's `/management/v1/*`. This is the ONLY place that
// distinguishes and carries, as separate facts, the concepts the master
// plan (§16) requires never be collapsed into a single "is this trusted?"
// boolean: the authenticated Governance *service* (proven by the RS256
// signature itself, verified via JWKS — not a claim), the authenticated
// human *operator* (operator_id/operator_session_id, already established
// by requireManagementApiAuth before this is ever called), the actor
// identity (Governance itself — fixed, never caller-supplied), the
// optional target tenant, the target engine, the requested action, and the
// scope actually authorized for this one call.

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
  targetEngine: string;
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

  const ttlSeconds = clampAssertionTtlSeconds(params.ttlSeconds);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const claims: Record<string, unknown> = {
    operator_id: params.operatorId,
    operator_session_id: params.operatorSessionId,
    roles: params.operatorRoles,
    scopes: params.requestedScopes,
    // Fixed identity of the calling service — never derived from `params`,
    // so nothing a caller passes in can ever change who Governance says it
    // is. See managementConfig.ts's own comment for why this is a source
    // constant, not an environment value or request field.
    actor_tenant_id: GOVERNANCE_ACTOR_IDENTITY,
    target_engine: params.targetEngine,
    requested_action: params.requestedAction,
    correlation_id: params.correlationId ?? randomUUID(),
  };
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
