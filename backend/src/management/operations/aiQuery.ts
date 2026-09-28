import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";
import { UnknownTenantError } from "./tenantRegistryQuery.js";

// Phase 1A.15 Slice 1 — AI operator reads (R0, `ai.read`). No ledger, no
// idempotency, no persistence: every call is owner-composed live by
// module_ai (Infrakinetic ai/aiOwnerState.js). Governance keeps no copy of
// AI usage/provider/quota truth (scoping §4).
//
// Defence in depth for A2/A38: before relaying an owner DTO, Governance
// refuses any response that carries a secret-shaped FIELD NAME anywhere in
// it. The owner contract is explicit-allowlist by construction; this guard
// makes a future owner-side regression fail closed at the Governance
// boundary instead of reaching the browser.

export interface AiQueryDeps {
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface AiOperatorParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

/** A field a later 1A.15 slice will model; never a fabricated value. */
export interface NotModelled {
  notModelled: true;
  slice: number;
  note?: string;
}

export interface AiEnforcementFacts {
  platformEngineStateEnforcedOnExecution: boolean;
  quotaConcurrencySafe: boolean;
  usageAttributionComplete: boolean;
  fingerprintSecretPosture: "configured" | "migration_env_only" | "dev_fallback" | "missing";
}

export interface AiCommercialWindow {
  since: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  currency: string | null;
}

export interface TenantAiCapabilityState {
  capabilityKey: string;
  ownerEngine: string;
  plane: string;
  commissioning: NotModelled;
  featureFlag: { key: string; explicitRow: boolean; enabled: boolean } | null;
  providerKey: string | null;
  modelKey: string | null;
  effective: boolean;
  mismatchReason?: string;
}

export interface AiModelState {
  modelKey: string;
  providerModelIdentifier: string;
  version: string | null;
  modality: string;
  capabilityClasses: string[];
  lifecycle: string;
  certification: string;
  pricingVersion: { id: string; effectiveFrom: string; currency: string } | null;
}

export interface AiProviderState {
  providerKey: string;
  displayName: string;
  status: string;
  egressClass: string;
  credentialSource: string;
  governedVia: string;
  plane: string;
  adapterRegistered: boolean | null;
  enforcement: { executor: string; statusEnforced: string; moduleAiGated: boolean };
  models: AiModelState[];
}

export interface TenantAiQuotaState {
  policyId: string;
  scope: { type: string; key: string | null; plane: string | null };
  period: string;
  limitType: string;
  hard: number;
  enabled: boolean;
  used: number | null;
  state: string;
}

export interface TenantAiState {
  contractVersion: string;
  tenantId: string;
  moduleAi: { entitled: boolean; explicitRow: boolean; source: string; writer: string; platformEngineState: string };
  emergency: NotModelled;
  planes: Array<{ plane: string; desired: NotModelled; effective: boolean; mismatchReason?: string }>;
  capabilities: TenantAiCapabilityState[];
  providersModels: AiProviderState[];
  credentialRefs: NotModelled;
  quotas: TenantAiQuotaState[];
  usage: {
    commercial: { day: AiCommercialWindow; week: AiCommercialWindow; month: AiCommercialWindow; billingPeriod: NotModelled; lifetime: NotModelled };
    telemetry: {
      since: string;
      attempts: { total: number; logicalRequests: number; success: number; failed: number; retries: number; timeouts: number; providerFailures: number };
      evidence: { requests: number; success: number; failed: number; rejectedOutput: number; open: number };
      policyDenials: NotModelled;
      quotaDenials: NotModelled;
      lastUsageAt: string | null;
    };
  };
  migrationInternal: {
    source: string;
    gatedBy: string;
    moduleAiGated: false;
    providerStatus: string | null;
    providerStatusEnforced: string;
    month: { since: string; requests: number; totalTokens: number; estimatedCost: number; currency: string | null };
  };
  meteringExceptions: NotModelled;
  enforcement: AiEnforcementFacts;
  observedAt: string;
  source: string;
  freshness: string;
}

interface Windowed { day: number; week: number; month: number }

export interface FleetAiSummary {
  contractVersion: string;
  windows: { day: string; week: string; month: string };
  planes: Array<{ plane: string; source: string; gatedBy?: string; tokens: Windowed; requests: Windowed; estimatedCost: Windowed }>;
  top: {
    tenants: Array<{ tenantId: string; totalTokens: number; estimatedCost: number }>;
    engines: Array<{ engineKey: string; totalTokens: number }>;
    capabilities: Array<{ capabilityKey: string; totalTokens: number }>;
    models: Array<{ providerKey: string; modelKey: string | null; totalTokens: number }>;
  };
  providerHealth7d: Array<{ providerKey: string; attempts: number; failures: number; rateLimited: number }>;
  providers: Array<Omit<AiProviderState, "models"> & { models: Array<Pick<AiModelState, "modelKey" | "lifecycle" | "certification">> }>;
  entitlement: { moduleAiEntitledTenants: number; moduleAiExplicitlyDisabled: number };
  quotaRisk: Array<{ tenantId: string; policyId: string; period: string; limitType: string; hard: number; used: number; state: string }>;
  meteringExceptions: NotModelled;
  reconciliationExceptions: NotModelled;
  enforcement: AiEnforcementFacts;
  observedAt: string;
  source: string;
  freshness: string;
}

export interface AiCatalog {
  contractVersion: string;
  providers: AiProviderState[];
  capabilities: Array<Record<string, unknown> & { capabilityKey: string; status: string; tenantFeatureKey: string | null }>;
  legacyKillSwitches: Array<{ libraryKey: string; enabled: boolean; updatedAt: string; status: string }>;
  enforcement: AiEnforcementFacts;
  observedAt: string;
  source: string;
  freshness: string;
}

// Field NAMES that must never appear in an AI operator DTO. Anchored at the
// end of the key so safe metadata names ("maskedHint",
// "fingerprintSecretPosture", "credentialSource") pass.
const SECRET_SHAPED_KEY = /(secret|password|passphrase|token|api[_-]?key|private[_-]?key|ciphertext|authorization|plaintext|key[_-]?material|fingerprint)$/i;

export function findSecretShapedField(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findSecretShapedField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_SHAPED_KEY.test(key)) return `${path}.${key}`;
      const hit = findSecretShapedField(child, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

export class UnsafeAiOwnerResponseError extends Error {
  readonly code = "AI_OWNER_RESPONSE_UNSAFE";
  readonly httpStatus = 502;
  constructor(readonly fieldPath: string) {
    super(`module_ai owner response carried a secret-shaped field (${fieldPath}); refused at the Governance boundary`);
    this.name = "UnsafeAiOwnerResponseError";
  }
}

function safeBody<T>(body: unknown): T {
  const hit = findSecretShapedField(body);
  if (hit) throw new UnsafeAiOwnerResponseError(hit);
  return body as T;
}

async function mint(deps: AiQueryDeps, params: AiOperatorParams, target: {
  requestedAction: string; targetTenantId?: string; targetResourceType: string; targetResourceId: string; correlationId: string;
}) {
  return mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["ai.read"],
    ...target,
  });
}

export async function getTenantAiState(deps: AiQueryDeps, params: AiOperatorParams & { tenantId: string }): Promise<TenantAiState> {
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mint(deps, params, {
    requestedAction: "ai.tenant.state.read",
    targetTenantId: params.tenantId,
    targetResourceType: "tenant",
    targetResourceId: params.tenantId,
    correlationId,
  });
  const path = `${MANAGEMENT_V1_PREFIX}/ai/tenants/${encodeURIComponent(params.tenantId)}/state`;
  const result = await callInfrakineticManagementApi({ baseUrl: deps.infrakineticBaseUrl, path, assertion, method: "GET", correlationId, fetchImpl: deps.fetchImpl });
  if (result.status === 404) throw new UnknownTenantError(params.tenantId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return safeBody<TenantAiState>(result.body);
}

async function fleetRead<T>(deps: AiQueryDeps, params: AiOperatorParams, resource: "ai_fleet" | "ai_catalog", action: string, suffix: string): Promise<T> {
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mint(deps, params, { requestedAction: action, targetResourceType: resource, targetResourceId: resource, correlationId });
  const path = `${MANAGEMENT_V1_PREFIX}/ai/${suffix}`;
  const result = await callInfrakineticManagementApi({ baseUrl: deps.infrakineticBaseUrl, path, assertion, method: "GET", correlationId, fetchImpl: deps.fetchImpl });
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return safeBody<T>(result.body);
}

export function getFleetAiSummary(deps: AiQueryDeps, params: AiOperatorParams): Promise<FleetAiSummary> {
  return fleetRead<FleetAiSummary>(deps, params, "ai_fleet", "ai.fleet.read", "fleet/summary");
}

export function getAiCatalog(deps: AiQueryDeps, params: AiOperatorParams): Promise<AiCatalog> {
  return fleetRead<AiCatalog>(deps, params, "ai_catalog", "ai.catalog.read", "catalog");
}
