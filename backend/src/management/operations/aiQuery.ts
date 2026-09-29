import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";
import { UnknownTenantError } from "./tenantRegistryQuery.js";
import { aiRoute, ownerPath, resolveTarget, type AiTarget } from "./aiContract.js";

// Phase 1A.15 — AI operator reads (R0, `ai.read`). No ledger, no
// idempotency, no persistence: every call is owner-composed live by
// module_ai (Infrakinetic ai/aiOwnerState.js). Governance keeps no copy of
// AI usage/provider/quota truth (scoping §4).
//
// Route shape (scope, requested action, target binding, path) is READ from the
// owner's published contract (aiContract.ts) — a read cannot disagree with the
// owner's route table.
//
// Defence in depth for A2/A38: before relaying an owner DTO, Governance
// refuses any response that carries a secret-shaped FIELD NAME anywhere in
// it. The owner contract is explicit-allowlist by construction; this guard
// makes a future owner-side regression fail closed at the Governance
// boundary instead of reaching the browser. BYOAI credential metadata
// (refId, providerKey, version, status, maskedHint, timestamps) passes it by
// design; there is no route through which raw credential material could.

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

/** A field an owner without the newer contract still reports as not modelled; never a fabricated value. */
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
  /** Presence/version posture of the BYOAI keyring only — never key material. */
  byoaiKeyringPosture?: "configured" | "missing" | "dev_fallback" | string;
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
  commissioning: { mode: "legacy_additive" | "explicit"; commissioned: boolean };
  featureFlag: { key: string; explicitRow: boolean; enabled: boolean } | null;
  providerKey: string | null;
  modelKey: string | null;
  effective: boolean;
  mismatchReason?: string;
}

export interface AiModelState {
  /** The owner's model row id — the address of lifecycle and certification commands. */
  modelId?: string;
  modelKey: string;
  providerModelIdentifier: string;
  version: string | null;
  modality: string;
  capabilityClasses: string[];
  lifecycle: "active" | "deprecated" | "retired" | string;
  certification: "uncertified" | "synthetic_certified" | "provider_certified" | string;
  lifecycleChangedAt?: string | null;
  certificationChangedAt?: string | null;
  certificationEvidenceRef?: string | null;
  pricingVersion: { id: string; effectiveFrom: string; currency: string } | null;
}

export interface AiProviderState {
  providerKey: string;
  displayName: string;
  status: "active" | "disabled" | "deprecated" | string;
  egressClass: string;
  credentialSource: string;
  governedVia: string;
  plane: string;
  adapterRegistered: boolean | null;
  enforcement: { executor: string; statusEnforced: string; moduleAiGated: boolean };
  models: AiModelState[];
}

export type AiQuotaState = "normal" | "warning" | "soft_exceeded" | "hard_reached" | "grace_active" | "grace_exhausted" | "disabled";

export interface TenantAiQuotaState {
  policyId: string;
  /** The address of quota set / remove / grace commands (owner-computed; Governance never parses it). */
  policyKey?: string;
  origin: "root" | "technology";
  scope: { type: string; key: string | null; plane: string | null };
  period: "daily" | "weekly" | "monthly" | "billing_period";
  window: { start: string; end: string };
  limitType: string;
  hard: number;
  warningPct: number | null;
  softLimit: number | null;
  overage: { mode: "none" | "grace"; graceActiveForWindow: boolean; graceLimit: number | null; graceExpiresAt: string | null };
  enabled: boolean;
  used: number | null;
  state: AiQuotaState;
  recordedState: { state: AiQuotaState; updatedAt: string } | null;
}

/** Safe BYOAI credential metadata. There is no field here, or on the owner route, that could carry material. */
export interface AiCredentialRef {
  refId: string;
  providerKey: string;
  version: number;
  status: "active" | "revoked" | string;
  maskedHint: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface AiDelegationAllocation {
  allocationId: string;
  scope: { type: string; key: string | null; plane: string | null };
  period: string;
  limitType: string;
  usageUnit: string | null;
  allocated: number;
  rootCeiling: number;
  effective: number;
  status: string;
  createdAt: string;
}

export interface AiMeteringSummary {
  open: number;
  resolved?: number;
  byType: Array<{ type: string; open: number; resolved?: number }>;
  recentOpen?: Array<Record<string, unknown>>;
}

interface AiUsageBreakdownRow { request_count: number; input_tokens: number; output_tokens: number; reasoning_tokens: number; total_tokens: number; estimated_cost: number }

export interface TenantAiState {
  contractVersion: string;
  tenantId: string;
  moduleAi: { entitled: boolean; explicitRow: boolean; source: string; writer: string; platformEngineState: string };
  rootPolicy: {
    source: "default" | "root_policy";
    policyVersion: number;
    allowedPlanes: string[];
    commissioningMode: "legacy_additive" | "explicit";
    billingAnchorDay: number;
  };
  emergency: { state: "none" | "suspended"; reason: string | null; recoveryIntent: string | null; operationId: string | null; since: string | null };
  planes: Array<{ plane: string; desired: { allowed: boolean; source: string }; effective: boolean; mismatchReason?: string }>;
  capabilities: TenantAiCapabilityState[];
  providersModels: AiProviderState[];
  credentialRefs: AiCredentialRef[] | NotModelled;
  delegation?: { tenantId: string; allocations: AiDelegationAllocation[] };
  quotas: TenantAiQuotaState[];
  usage: {
    commercial: { day: AiCommercialWindow; week: AiCommercialWindow; month: AiCommercialWindow; billingPeriod: AiCommercialWindow; lifetime: AiCommercialWindow | NotModelled };
    byEngine?: Array<AiUsageBreakdownRow & { engine_key: string }>;
    byCapability?: Array<AiUsageBreakdownRow & { capability_key: string }>;
    byProvider?: Array<AiUsageBreakdownRow & { provider_key: string }>;
    telemetry: {
      since: string;
      attempts: { total: number; logicalRequests: number; success: number; failed: number; retries: number; timeouts: number; providerFailures: number };
      evidence: { requests: number; success: number; failed: number; rejectedOutput: number; open: number };
      policyDenials: number | NotModelled;
      quotaDenials: number | NotModelled;
      denialsByReason?: Record<string, number>;
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
  meteringExceptions: AiMeteringSummary | NotModelled;
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
  meteringExceptions: AiMeteringSummary | NotModelled;
  /** Newer owners publish `reconciliation`; older ones report `reconciliationExceptions` as not modelled. */
  reconciliation?: {
    byOutcome: Array<{ outcome: string; lines: number; open: number }>;
    openExceptions: number;
    latestStatements: Array<Record<string, unknown>>;
  };
  reconciliationExceptions?: NotModelled;
  enforcement: AiEnforcementFacts;
  observedAt: string;
  source: string;
  freshness: string;
}

export interface AiCatalog {
  contractVersion: string;
  providers: AiProviderState[];
  capabilities: Array<Record<string, unknown> & { capabilityKey: string; status: string; tenantFeatureKey: string | null; defaultProviderKey?: string | null; defaultModelKey?: string | null }>;
  legacyKillSwitches: Array<{ libraryKey: string; enabled: boolean; updatedAt: string; status: string }>;
  enforcement: AiEnforcementFacts;
  observedAt: string;
  source: string;
  freshness: string;
}

export interface AiCredentialMetadata {
  tenantId: string;
  credentials: AiCredentialRef[];
  observedAt: string;
  source: string;
  freshness: string;
  correlationId?: string;
}

export interface AiMeteringException {
  exceptionId: string;
  tenantId: string;
  logicalRequestId: string | null;
  type: string;
  capabilityKey: string | null;
  providerKey: string | null;
  plane: string | null;
  observedAttempts: number;
  expectedAttempts: number | null;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface AiMeteringExceptions {
  state: "open" | "resolved";
  exceptions: AiMeteringException[];
  observedAt: string;
  source: string;
  freshness: string;
  correlationId?: string;
}

export interface AiReconciliationStatement {
  statementId: string;
  providerKey: string;
  sourceKind: string;
  sourceSha256: string;
  sourceLabel: string | null;
  currency: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  supersedes: string | null;
  supersededBy: string | null;
  lineCount: number;
  totalAmount: number;
  importedBy: string;
  importedAt: string;
}

export interface AiReconciliationLine {
  reconciliationId: string;
  statementId: string;
  sourceKind: string;
  grainKey: string;
  providerKey: string;
  modelKey: string | null;
  credentialKind: string | null;
  credentialIdentity: string | null;
  serviceDay: string;
  currency: string;
  outcome: string;
  estimatedAmount: number | null;
  actualAmount: number | null;
  variance: number | null;
  estimatedUnits: number | null;
  actualUnits: number | null;
  usageRequests: number;
  tenantId: string | null;
  poolLevel: boolean;
  reason: string | null;
  resolutionState: "open" | "resolved" | string;
  resolutionNote: string | null;
  resolvedAt: string | null;
  reconciledAt: string;
}

export interface AiReconciliation {
  contractVersion: string;
  statements: AiReconciliationStatement[];
  lines: AiReconciliationLine[];
  observedAt: string;
  source: string;
  freshness: string;
  correlationId?: string;
}

export interface AiAdminCommandReceipt {
  command: {
    idempotencyKey: string;
    commandId: string;
    action: string;
    tenantId: string | null;
    target: { type: string; id: string };
    reason: string;
    operatorId: string;
    approval: { approvalId: string; makerOperatorId: string; checkerOperatorId: string } | null;
    status: string;
    result: Record<string, unknown>;
    createdAt: string;
    completedAt: string | null;
  };
  observedAt: string;
  source: string;
  freshness: string;
  correlationId?: string;
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

export function safeAiBody<T>(body: unknown): T {
  const hit = findSecretShapedField(body);
  if (hit) throw new UnsafeAiOwnerResponseError(hit);
  return body as T;
}

// ── contract-driven owner read ──────────────────────────────────────────

export interface AiOwnerReadParams extends AiOperatorParams {
  routeId: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  /** Overrides the route's declared binding (receipt reads are bound to the receipt's own target). */
  target?: AiTarget;
}

/** GET an owner read route; returns the raw status + body (callers map 404s and apply the secret guard). */
export async function aiOwnerRead(deps: AiQueryDeps, params: AiOwnerReadParams): Promise<{ status: number; body: unknown; path: string }> {
  const route = aiRoute(params.routeId);
  if (route.kind !== "read") throw new Error(`route ${route.id} is not a read`);
  const pathParams = params.pathParams ?? {};
  const target = params.target ?? resolveTarget(route, pathParams);
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: [route.scope],
    targetTenantId: target.targetTenantId,
    targetResourceType: target.targetResourceType as string,
    targetResourceId: target.targetResourceId as string,
    requestedAction: route.action,
    correlationId,
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params.query ?? {})) if (value !== undefined && value !== "") search.set(key, String(value));
  const queryString = search.toString();
  const path = `${ownerPath(route, pathParams)}${queryString !== "" ? `?${queryString}` : ""}`;
  const result = await callInfrakineticManagementApi({ baseUrl: deps.infrakineticBaseUrl, path, assertion, method: "GET", correlationId, fetchImpl: deps.fetchImpl });
  return { ...result, path };
}

async function readOk<T>(deps: AiQueryDeps, params: AiOwnerReadParams, notFound?: () => Error): Promise<T> {
  const result = await aiOwnerRead(deps, params);
  if (result.status === 404 && notFound) throw notFound();
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, result.path);
  return safeAiBody<T>(result.body);
}

export function getTenantAiState(deps: AiQueryDeps, params: AiOperatorParams & { tenantId: string }): Promise<TenantAiState> {
  return readOk<TenantAiState>(deps, { ...params, routeId: "tenant.state.read", pathParams: { tenantId: params.tenantId } }, () => new UnknownTenantError(params.tenantId));
}

export function getFleetAiSummary(deps: AiQueryDeps, params: AiOperatorParams): Promise<FleetAiSummary> {
  return readOk<FleetAiSummary>(deps, { ...params, routeId: "fleet.summary.read" });
}

export function getAiCatalog(deps: AiQueryDeps, params: AiOperatorParams): Promise<AiCatalog> {
  return readOk<AiCatalog>(deps, { ...params, routeId: "catalog.read" });
}

/** Safe metadata only: ref id, provider, version, status, masked hint, timestamps. */
export function getTenantAiCredentials(deps: AiQueryDeps, params: AiOperatorParams & { tenantId: string }): Promise<AiCredentialMetadata> {
  return readOk<AiCredentialMetadata>(deps, { ...params, routeId: "tenant.credentials.read", pathParams: { tenantId: params.tenantId } }, () => new UnknownTenantError(params.tenantId));
}

export function listAiMeteringExceptions(
  deps: AiQueryDeps,
  params: AiOperatorParams & { state?: "open" | "resolved"; tenantId?: string; limit?: number },
): Promise<AiMeteringExceptions> {
  return readOk<AiMeteringExceptions>(deps, { ...params, routeId: "metering-exceptions.read", query: { state: params.state, tenantId: params.tenantId, limit: params.limit } });
}

export function getAiReconciliation(
  deps: AiQueryDeps,
  params: AiOperatorParams & { outcome?: string; state?: "open" | "resolved"; providerKey?: string; limit?: number },
): Promise<AiReconciliation> {
  return readOk<AiReconciliation>(deps, { ...params, routeId: "reconciliation.read", query: { outcome: params.outcome, state: params.state, providerKey: params.providerKey, limit: params.limit } });
}

export class UnknownAiAdminCommandError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`The owner holds no AI admin command receipt for idempotency key '${idempotencyKey}'.`);
    this.name = "UnknownAiAdminCommandError";
  }
}

/**
 * The owner's durable receipt for a command. The owner binds the read to the receipt's own target, so the
 * caller passes the target the command was issued against (the Governance operation's own address).
 */
export function getAiAdminCommandReceipt(
  deps: AiQueryDeps,
  params: AiOperatorParams & { idempotencyKey: string; target: AiTarget },
): Promise<AiAdminCommandReceipt> {
  return readOk<AiAdminCommandReceipt>(
    deps,
    { ...params, routeId: "admin-command.read", pathParams: { idempotencyKey: params.idempotencyKey }, target: params.target },
    () => new UnknownAiAdminCommandError(params.idempotencyKey),
  );
}
