import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";

// 1A.13 — credential administration reads (list/detail/history). Deliberately
// NOT an "operation" in 1A.5's ledger sense, same reasoning as
// identityQuery.ts (1A.12.1): R0 per the risk classification, so no
// idempotency key, no createOrReplayOperation() call, no
// management_operations row. Mirrors that file's "mint one assertion, call
// one Infrakinetic route" shape exactly. Single-credential reads bind the
// generic target-resource pair to the exact credentialId being addressed.

export class UnknownCredentialError extends Error {
  constructor(readonly tenantId: string, readonly credentialId: string) {
    super(`Credential '${credentialId}' not found in tenant '${tenantId}'.`);
    this.name = "UnknownCredentialError";
  }
}

export interface CredentialQueryDeps {
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface CredentialQueryParams {
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

// Real shapes, mirroring credentialAdministration.js's safe DTO (1A.13
// scoping doc §5, adjusted during implementation to match the real
// Payments-connection-with-multiple-secret-kinds shape — see that module's
// header) — present here so a future accidental widening on the
// Infrakinetic side is caught by TypeScript rather than silently passed
// through to the UI.
export interface CredentialSecretSummary {
  kind: string;
  version: number;
  status: string;
  maskedHint: string | null;
  validFrom: string;
  validUntil: string | null;
}

export interface CredentialSummary {
  tenantId: string;
  credentialId: string;
  owningEngine: string;
  provider: string;
  adapterVersion: string;
  environment: string;
  displayName: string;
  status: string;
  activatedAt: string | null;
  revokedAt: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  secrets: CredentialSecretSummary[];
}

export interface CredentialAdminCommandReceipt {
  idempotencyKey: string;
  commandId: string;
  action: string;
  owningEngine: string;
  tenantId: string;
  credentialId: string | null;
  secretKind: string | null;
  status: string;
  executionStage: string | null;
  safeResult: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type CredentialListResult = FreshnessEnvelope & { tenantId: string; credentials: CredentialSummary[] };
export type CredentialDetailResult = FreshnessEnvelope & { credential: CredentialSummary };
export type CredentialHistoryResult = FreshnessEnvelope & { history: CredentialAdminCommandReceipt[] };

async function mintAndCall(
  deps: CredentialQueryDeps,
  params: CredentialQueryParams,
  requestedAction: string,
  path: string,
  targetTenantId: string,
  targetCredentialId?: string,
): Promise<{ status: number; body: unknown }> {
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["credentials.metadata.read"],
    targetTenantId,
    // Same reasoning as identityQuery.ts's mintAndCall: mintManagementAssertion
    // requires either an engine or a complete generic target-resource pair —
    // a tenant-scoped list read with no specific credential addresses the
    // tenant's whole credential registry as its own resource.
    ...(targetCredentialId !== undefined
      ? { targetResourceType: "credential", targetResourceId: targetCredentialId }
      : { targetResourceType: "credential_registry", targetResourceId: targetTenantId }),
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

export async function listTenantCredentials(
  deps: CredentialQueryDeps,
  params: CredentialQueryParams & { tenantId: string },
): Promise<CredentialListResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/credentials`;
  const result = await mintAndCall(deps, params, "credential.list", path, params.tenantId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as CredentialListResult;
}

export async function getCredentialDetail(
  deps: CredentialQueryDeps,
  params: CredentialQueryParams & { tenantId: string; credentialId: string },
): Promise<CredentialDetailResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/credentials/${encodeURIComponent(params.credentialId)}`;
  const result = await mintAndCall(deps, params, "credential.detail", path, params.tenantId, params.credentialId);
  if (result.status === 404) throw new UnknownCredentialError(params.tenantId, params.credentialId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as CredentialDetailResult;
}

export async function getCredentialHistory(
  deps: CredentialQueryDeps,
  params: CredentialQueryParams & { tenantId: string; credentialId: string },
): Promise<CredentialHistoryResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/credentials/${encodeURIComponent(params.credentialId)}/history`;
  const result = await mintAndCall(deps, params, "credential.history", path, params.tenantId, params.credentialId);
  if (result.status === 404) throw new UnknownCredentialError(params.tenantId, params.credentialId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as CredentialHistoryResult;
}
