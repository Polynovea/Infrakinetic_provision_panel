import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";
import { UnknownTenantError } from "./tenantRegistryQuery.js";

// Phase 1A.14 §4.1 — tenant integration inventory read. R0: no ledger, no
// idempotency (same reasoning as credentialQuery.ts). Governance persists
// nothing from this read — the inventory is owner-projected live on every
// call (scoping §9: no integration_inventory replica table).

export interface IntegrationQueryDeps {
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface IntegrationWebhook {
  endpointId: string;
  status: string;
  allowedEvents: string[];
  lastReceiptAt: string | null;
  quarantined24h: number;
  failed24h: number;
}

export interface TenantIntegration {
  integrationId: string;
  owningEngine: "payments" | "marketing" | "migration";
  kind: string;
  provider: string;
  adapterVersion: string | null;
  environment: string | null;
  status: string;
  connectedAt: string | null;
  revokedAt: string | null;
  lastTestedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorClass: string | null;
  externalRefHint: string | null;
  credentialRef: { kind: string; id: string; secretVersions: Array<{ kind: string; version: number; status: string; maskedHint: string | null }> } | null;
  webhooks: IntegrationWebhook[];
}

export interface IntegrationObservation {
  owningEngine: string;
  status: "healthy" | "failed";
  observedAt: string;
  count?: number;
  errorClass?: string;
}

export interface TenantIntegrationsResult {
  tenantId: string;
  integrations: TenantIntegration[];
  observations: IntegrationObservation[];
  observedAt: string;
  source: string;
  freshness: string;
}

export async function listTenantIntegrations(
  deps: IntegrationQueryDeps,
  params: { tenantId: string; operatorId: string; operatorSessionId: string; operatorRoles: readonly string[]; operatorGrantedScopes: readonly string[]; correlationId?: string },
): Promise<TenantIntegrationsResult> {
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["integrations.read"],
    targetTenantId: params.tenantId,
    targetResourceType: "integration_registry",
    targetResourceId: params.tenantId,
    requestedAction: "integration.list",
    correlationId,
  });
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/integrations`;
  const result = await callInfrakineticManagementApi({ baseUrl: deps.infrakineticBaseUrl, path, assertion, method: "GET", correlationId, fetchImpl: deps.fetchImpl });
  if (result.status === 404) throw new UnknownTenantError(params.tenantId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as TenantIntegrationsResult;
}
