import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";
import { UnknownEntitlementEngineError, UnknownEntitlementTenantError } from "./tenantEngineEntitlementOperation.js";

// 1A.9.4 — the read half of engine entitlement (§4.2/§4.3 of Governance's
// Phase1A.9_Ground_Truth_and_Scoping_2026-09-17.md). R0 per 1A.5's own risk
// classification (no ledger entry, no idempotency key) — same reasoning
// tenantRegistryQuery.ts/engineCatalogQuery.ts already document for their
// own reads. Shape mirrors both exactly: mint-then-call, sanitized DTO,
// freshness envelope.

export interface TenantEngineEntitlementQueryDeps {
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface TenantEngineEntitlementQueryParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

export interface PlatformEngineStateContext {
  state: string;
  reason: string | null;
}

// Real field set Infrakinetic's entitlement read routes return (§4.2/§4.3) —
// same "catch an accidental widening here" role TenantRegistryEntry plays.
export interface TenantEngineEntitlementEntry {
  canonicalEngine: string;
  label?: string;
  configured: boolean;
  effectiveEnabled: boolean;
  defaultDeny: boolean;
  platformEngineState: PlatformEngineStateContext;
}

interface FreshnessEnvelope {
  observedAt: string;
  source: string;
  freshness: string;
}

export type TenantEngineEntitlementResult = FreshnessEnvelope & { tenantId: string } & TenantEngineEntitlementEntry;
export type TenantEngineEntitlementListResult = FreshnessEnvelope & { tenantId: string; engines: TenantEngineEntitlementEntry[] };

// Sentinel address for the list read, which spans every catalog engine for
// one tenant rather than addressing a single engine — same technique
// engineCatalogQuery.ts's ENGINE_CATALOG_TARGET and tenantRegistryQuery.ts's
// TENANT_REGISTRY_TARGET already use for their own catalog-shaped reads.
const TENANT_ENGINE_ENTITLEMENTS_TARGET = "tenant-engine-entitlements";

async function mintAndCall(
  deps: TenantEngineEntitlementQueryDeps,
  params: TenantEngineEntitlementQueryParams & { tenantId: string; targetEngine: string; requestedAction: string },
  path: string,
): Promise<{ status: number; body: unknown }> {
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["tenants.read"],
    targetEngine: params.targetEngine,
    targetTenantId: params.tenantId,
    requestedAction: params.requestedAction,
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

export async function getTenantEngineEntitlementRead(
  deps: TenantEngineEntitlementQueryDeps,
  params: TenantEngineEntitlementQueryParams & { tenantId: string; engineKeyOrAlias: string },
): Promise<TenantEngineEntitlementResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/engines/${encodeURIComponent(params.engineKeyOrAlias)}/entitlement`;
  const result = await mintAndCall(
    deps,
    { ...params, targetEngine: params.engineKeyOrAlias, requestedAction: "tenants.engine-entitlement.read" },
    path,
  );
  if (result.status === 404) {
    const body = result.body as { error?: string } | undefined;
    if (body?.error === "UNKNOWN_TENANT") throw new UnknownEntitlementTenantError(params.tenantId);
    throw new UnknownEntitlementEngineError(params.engineKeyOrAlias);
  }
  if (result.status !== 200) {
    throw new UnexpectedManagementApiResponseError(result.status, path);
  }
  return result.body as TenantEngineEntitlementResult;
}

export async function listTenantEngineEntitlements(
  deps: TenantEngineEntitlementQueryDeps,
  params: TenantEngineEntitlementQueryParams & { tenantId: string },
): Promise<TenantEngineEntitlementListResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.tenantId)}/engines`;
  const result = await mintAndCall(
    deps,
    { ...params, targetEngine: TENANT_ENGINE_ENTITLEMENTS_TARGET, requestedAction: "tenants.engines.read" },
    path,
  );
  if (result.status === 404) {
    throw new UnknownEntitlementTenantError(params.tenantId);
  }
  if (result.status !== 200) {
    throw new UnexpectedManagementApiResponseError(result.status, path);
  }
  return result.body as TenantEngineEntitlementListResult;
}
