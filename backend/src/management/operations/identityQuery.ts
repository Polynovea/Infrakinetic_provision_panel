import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";

// 1A.12.1 — identity administration reads (list/detail/history). Deliberately
// NOT an "operation" in 1A.5's ledger sense, same reasoning as
// tenantRegistryQuery.ts: R0 per the risk classification, so no idempotency
// key, no createOrReplayOperation() call, no management_operations row.
// Mirrors that file's "mint one assertion, call one Infrakinetic route"
// shape exactly. Single-identity reads bind the generic target-resource
// pair to the exact userId being addressed (§7 of the 1A.12 scoping doc),
// the same way tenantEngineEntitlementQuery.ts binds targetEngine.

export class UnknownIdentityError extends Error {
  constructor(readonly tenantId: string, readonly userId: string) {
    super(`Identity '${userId}' not found in tenant '${tenantId}'.`);
    this.name = "UnknownIdentityError";
  }
}

export interface IdentityQueryDeps {
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface IdentityQueryParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

interface FreshnessEnvelope {
  observedAt: string;
  source: string;
  freshness: string;
}

// Real shapes, mirroring identityAdministration.js's safe DTO (§6.1) —
// present here so a future accidental widening on the Infrakinetic side is
// caught by TypeScript rather than silently passed through to the UI.
export interface IdentitySummary {
  userId: string;
  email: string;
  displayName: string;
  appAccountStatus: string;
  roleKey: string;
  activity: { lastActiveAt: string | null };
}

export interface IdentityProviderDetail {
  exists: boolean;
  tenantBindingMismatch?: boolean;
  enabled?: boolean;
  userStatus?: string;
  confirmed?: boolean;
  resetRequired?: boolean;
  createdAt?: string | null;
  modifiedAt?: string | null;
  preferredMfa?: string | null;
  mfaMethods?: unknown[];
  verifiedEmail?: boolean;
  verifiedPhone?: boolean;
}

export interface IdentityDetail {
  tenantId: string;
  userId: string;
  email: string;
  displayName: string;
  appAccountStatus: string;
  roleKey: string;
  provider: IdentityProviderDetail;
  sessions: {
    activeApplicationSessionCount: number;
    lastApplicationSessionSeenAt: string | null;
    lastApplicationSessionRevokedAt: string | null;
  };
  activity: { lastActiveAt: string | null; source: string };
  invitation: { state: string; expiresAt: string | null; lastSentAt: string } | null;
  drift: string[];
}

export interface IdentityAdminCommandReceipt {
  idempotencyKey: string;
  commandId: string;
  action: string;
  tenantId: string;
  userId: string | null;
  status: string;
  executionStage: string | null;
  safeResult: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface IdentityInvitationSummary {
  invitationId: string;
  email: string;
  displayName: string;
  roleKey: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type IdentityListResult = FreshnessEnvelope & { tenantId: string; identities: IdentitySummary[] };
export type IdentityDetailResult = FreshnessEnvelope & { identity: IdentityDetail };
export type IdentityHistoryResult = FreshnessEnvelope & { history: IdentityAdminCommandReceipt[] };
export type IdentityInvitationListResult = FreshnessEnvelope & { tenantId: string; invitations: IdentityInvitationSummary[] };

async function mintAndCall(
  deps: IdentityQueryDeps,
  params: IdentityQueryParams,
  requestedAction: string,
  path: string,
  targetTenantId: string,
  targetUserId?: string,
): Promise<{ status: number; body: unknown }> {
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["identity.read"],
    targetTenantId,
    // mintManagementAssertion requires either an engine or a complete
    // generic target-resource pair (managementAssertionIssuer.ts's
    // resolveTarget) — there is no engine here, so a tenant-scoped read
    // with no specific user (the list route) addresses the tenant's whole
    // identity registry as its own resource, the same way
    // tenantRegistryQuery.ts mints a fixed "tenant-registry" engine
    // sentinel for its own tenant-only reads.
    ...(targetUserId !== undefined
      ? { targetResourceType: "identity_user", targetResourceId: targetUserId }
      : { targetResourceType: "identity_registry", targetResourceId: targetTenantId }),
    requestedAction,
    correlationId,
  });
  return callInfrakineticManagementApi({
    baseUrl: deps.infrakineticBaseUrl,
    path,
    assertion,
    method: "GET",
    correlationId,
    fetchImpl: deps.fetchImpl,
  });
}

export async function listTenantIdentities(
  deps: IdentityQueryDeps,
  params: IdentityQueryParams & { tenantId: string },
): Promise<IdentityListResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/identities`;
  const result = await mintAndCall(deps, params, "identity.list", path, params.tenantId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as IdentityListResult;
}

export async function getIdentityDetail(
  deps: IdentityQueryDeps,
  params: IdentityQueryParams & { tenantId: string; userId: string },
): Promise<IdentityDetailResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/identities/${encodeURIComponent(params.userId)}`;
  const result = await mintAndCall(deps, params, "identity.detail", path, params.tenantId, params.userId);
  if (result.status === 404) throw new UnknownIdentityError(params.tenantId, params.userId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as IdentityDetailResult;
}

export async function listTenantInvitations(
  deps: IdentityQueryDeps,
  params: IdentityQueryParams & { tenantId: string },
): Promise<IdentityInvitationListResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/identity-invitations`;
  const result = await mintAndCall(deps, params, "identity.invitations.list", path, params.tenantId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as IdentityInvitationListResult;
}

export async function getIdentityHistory(
  deps: IdentityQueryDeps,
  params: IdentityQueryParams & { tenantId: string; userId: string },
): Promise<IdentityHistoryResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/identities/${encodeURIComponent(params.userId)}/history`;
  const result = await mintAndCall(deps, params, "identity.history", path, params.tenantId, params.userId);
  if (result.status === 404) throw new UnknownIdentityError(params.tenantId, params.userId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as IdentityHistoryResult;
}
