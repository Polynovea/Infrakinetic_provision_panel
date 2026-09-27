import { createHash, randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi, isNeverDispatchedNetworkError } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { computeSafePayloadHash } from "./canonicalHash.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";
import type { ManagementApprovalStore, ApprovalRecord, ApprovalDecision } from "./managementApprovalStore.js";
import type { RiskClass } from "./riskClassification.js";
import type { Scope } from "../../identity/roles.js";

// Phase 1A.14 — payment adapter lifecycle, Governance side (scoping doc §5).
// Semantics stay in Infrakinetic's module_payments; Governance only records
// the operation, enforces risk controls, and signs the assertion.
//
//   R0  list / detail / revoke-impact / per-worker runtime       (no ledger)
//   R2  submit, certify, deprecate                               (ledger)
//   R3  approve, retire                     (step-up + maker-checker + ledger)
//   R4  revoke                              (step-up + maker-checker + ledger)
//
// R3/R4 bind a checker-visible safe diff into the approval, and execution
// mints the assertion with signed approval evidence so the owner takes the
// approver (checker) from the signature — never from a body or from whoever
// executes (scoping D1). Revoke's approval binds the owner-reported impact
// at request time; the owner recounts under lock at execution and refuses
// any difference (D3).
//
// Adapters are platform-global: nothing here ever carries a tenant id.

export const PAYMENT_ADAPTER_FLEET = "payment_adapter_fleet";

export interface PaymentAdapterDeps {
  ledger: ManagementOperationLedger;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface OperatorParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

export class UnknownPaymentAdapterReleaseError extends Error {
  constructor(readonly releaseId: string) {
    super(`Payment adapter release '${releaseId}' not found.`);
    this.name = "UnknownPaymentAdapterReleaseError";
  }
}

export class MissingPaymentAdapterFieldError extends Error {
  constructor(field: string) {
    super(`A payment adapter command requires a real ${field}.`);
    this.name = "MissingPaymentAdapterFieldError";
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

type Target = { targetResourceType: string; targetResourceId: string };
const fleetTarget = (): Target => ({ targetResourceType: PAYMENT_ADAPTER_FLEET, targetResourceId: PAYMENT_ADAPTER_FLEET });
const releaseTarget = (releaseId: string): Target => ({ targetResourceType: "payment_adapter_release", targetResourceId: releaseId });

async function mintAndCall(
  deps: Omit<PaymentAdapterDeps, "ledger">,
  params: OperatorParams & Target & {
    scope: Scope;
    requestedAction: string;
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    correlationId: string;
    approvalEvidence?: { approvalId: string; makerOperatorId: string; checkerOperatorId: string };
  },
) {
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: [params.scope],
    targetResourceType: params.targetResourceType,
    targetResourceId: params.targetResourceId,
    requestedAction: params.requestedAction,
    correlationId: params.correlationId,
    approvalEvidence: params.approvalEvidence,
  });
  return callInfrakineticManagementApi({
    baseUrl: deps.infrakineticBaseUrl,
    path: params.path,
    assertion,
    method: params.method,
    body: params.body,
    correlationId: params.correlationId,
    fetchImpl: deps.fetchImpl,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// R0 reads
// ─────────────────────────────────────────────────────────────────────────

async function read(deps: Omit<PaymentAdapterDeps, "ledger">, params: OperatorParams, requestedAction: string, path: string, target: Target, releaseId?: string) {
  const result = await mintAndCall(deps, {
    ...params, ...target, scope: "payments.adapters.read", requestedAction, method: "GET", path,
    correlationId: params.correlationId ?? randomUUID(),
  });
  if (result.status === 404 && releaseId) throw new UnknownPaymentAdapterReleaseError(releaseId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return result.body as Record<string, unknown>;
}

export const listPaymentAdapters = (deps: Omit<PaymentAdapterDeps, "ledger">, params: OperatorParams) =>
  read(deps, params, "payment.adapter.list", `${MANAGEMENT_V1_PREFIX}/payment-adapters`, fleetTarget());

export const getPaymentAdapterRuntime = (deps: Omit<PaymentAdapterDeps, "ledger">, params: OperatorParams) =>
  read(deps, params, "payment.adapter.runtime.read", `${MANAGEMENT_V1_PREFIX}/payment-adapters/runtime`, fleetTarget());

export const getPaymentAdapter = (deps: Omit<PaymentAdapterDeps, "ledger">, params: OperatorParams & { releaseId: string }) =>
  read(deps, params, "payment.adapter.detail", `${MANAGEMENT_V1_PREFIX}/payment-adapters/${encodeURIComponent(params.releaseId)}`, releaseTarget(params.releaseId), params.releaseId);

export const getPaymentAdapterRevokeImpact = (deps: Omit<PaymentAdapterDeps, "ledger">, params: OperatorParams & { releaseId: string }) =>
  read(deps, params, "payment.adapter.revoke-impact", `${MANAGEMENT_V1_PREFIX}/payment-adapters/${encodeURIComponent(params.releaseId)}/revoke-impact`, releaseTarget(params.releaseId), params.releaseId);

// ─────────────────────────────────────────────────────────────────────────
// Ledgered command execution (shared by R2 and approved R3/R4)
// ─────────────────────────────────────────────────────────────────────────

export interface PaymentAdapterOperationResult {
  operation: ManagementOperationRecord;
  replay: boolean;
}

async function executeAdapterCommand(
  deps: PaymentAdapterDeps,
  params: OperatorParams & Target & {
    idempotencyKey: string;
    riskClass: RiskClass;
    scope: Scope;
    requestedAction: string;
    reason: string;
    /** Hashed for idempotency only — must never carry vendor test vectors or other material. */
    payload: Record<string, unknown>;
    path: string;
    body: Record<string, unknown>;
    causationId?: string;
    approvalEvidence?: { approvalId: string; makerOperatorId: string; checkerOperatorId: string };
    approvalLedgerEvidence?: Record<string, unknown>;
  },
): Promise<PaymentAdapterOperationResult> {
  const correlationId = params.correlationId ?? randomUUID();
  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: params.requestedAction,
    targetResourceType: params.targetResourceType,
    targetResourceId: params.targetResourceId,
    reason: params.reason,
    riskClass: params.riskClass,
    payload: params.payload,
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: params.causationId,
    approvalEvidence: params.approvalLedgerEvidence,
  });
  if (replay) return { operation: submitted, replay: true };

  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  let result;
  try {
    result = await mintAndCall(deps, {
      ...params, method: "POST", correlationId,
      body: { ...params.body, reason: params.reason, idempotencyKey: params.idempotencyKey, commandId: randomUUID() },
    });
  } catch (err) {
    if (isNeverDispatchedNetworkError(err)) {
      const failed = await deps.ledger.transitionOperation(submitted.operationId, {
        toStatus: "failed",
        partialFailureState: { stage: "mutation-call-never-dispatched", message: err instanceof Error ? err.message : String(err) },
      });
      return { operation: failed, replay: false };
    }
    // Dispatched, response lost: the owner receipt
    // (/payment-adapter-admin-commands/:idempotencyKey) resolves it.
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      partialFailureState: { stage: "mutation-call", message: err instanceof Error ? err.message : String(err) },
    });
    return { operation: partial, replay: false };
  }

  if (result.status !== 200) {
    const failed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: { stage: "mutation-response", status: result.status, body: redactSecretShapedFields(result.body) },
    });
    return { operation: failed, replay: false };
  }

  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot(result.body),
    result: result.body,
  });
  return { operation: completed, replay: false };
}

const releasePath = (releaseId: string, segment: string) => `${MANAGEMENT_V1_PREFIX}/payment-adapters/${encodeURIComponent(releaseId)}/${segment}`;

// ─────────────────────────────────────────────────────────────────────────
// R2 commands
// ─────────────────────────────────────────────────────────────────────────

export interface SubmitPaymentAdapterParams extends OperatorParams {
  idempotencyKey: string;
  reason: string;
  manifest: Record<string, unknown>;
  manifestSignature: string;
  vendorPublicKey: string;
  vendorName: string;
  /** Vendor-supplied certification fixtures/vectors. Forwarded to the owner, only ever digested here. */
  fixtures?: unknown;
  signatureVectors?: unknown;
  causationId?: string;
}

export function releaseKeyOfManifest(manifest: Record<string, unknown>): string {
  const providerKey = manifest.provider_key;
  const adapterVersion = manifest.adapter_version;
  if (!nonEmpty(providerKey) || !nonEmpty(adapterVersion)) throw new MissingPaymentAdapterFieldError("manifest provider_key/adapter_version");
  return `${providerKey}@${adapterVersion}`;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

export async function submitPaymentAdapter(deps: PaymentAdapterDeps, params: SubmitPaymentAdapterParams) {
  if (!params.manifest || typeof params.manifest !== "object") throw new MissingPaymentAdapterFieldError("manifest");
  for (const field of ["manifestSignature", "vendorPublicKey", "vendorName"] as const) {
    if (!nonEmpty(params[field])) throw new MissingPaymentAdapterFieldError(field);
  }
  const releaseKey = releaseKeyOfManifest(params.manifest);
  return executeAdapterCommand(deps, {
    ...params,
    targetResourceType: "payment_adapter_release_key",
    targetResourceId: releaseKey,
    riskClass: "R2",
    scope: "payments.adapters.submit",
    requestedAction: "payment.adapter.submit",
    payload: {
      releaseKey,
      manifestDigest: digest(params.manifest),
      vendorName: params.vendorName,
      vendorPublicKeyDigest: digest(params.vendorPublicKey),
      fixturesDigest: digest({ fixtures: params.fixtures, signatureVectors: params.signatureVectors }),
    },
    path: `${MANAGEMENT_V1_PREFIX}/payment-adapters`,
    body: {
      manifest: params.manifest,
      manifestSignature: params.manifestSignature,
      vendorPublicKey: params.vendorPublicKey,
      vendorName: params.vendorName,
      fixtures: params.fixtures,
      signatureVectors: params.signatureVectors,
    },
  });
}

export interface CertifyPaymentAdapterParams extends OperatorParams {
  idempotencyKey: string;
  reason: string;
  releaseId: string;
  fixtures?: unknown;
  signatureVectors?: unknown;
  causationId?: string;
}

/** Sandbox credentials are resolved owner-side; none are accepted or forwarded here. */
export async function certifyPaymentAdapter(deps: PaymentAdapterDeps, params: CertifyPaymentAdapterParams) {
  if (!nonEmpty(params.releaseId)) throw new MissingPaymentAdapterFieldError("releaseId");
  return executeAdapterCommand(deps, {
    ...params,
    ...releaseTarget(params.releaseId),
    riskClass: "R2",
    scope: "payments.adapters.certify",
    requestedAction: "payment.adapter.certify",
    payload: { releaseId: params.releaseId, fixturesDigest: digest({ fixtures: params.fixtures, signatureVectors: params.signatureVectors }) },
    path: releasePath(params.releaseId, "certify"),
    body: { fixtures: params.fixtures, signatureVectors: params.signatureVectors },
  });
}

export interface DeprecatePaymentAdapterParams extends OperatorParams {
  idempotencyKey: string;
  reason: string;
  releaseId: string;
  retireAt?: string;
  causationId?: string;
}

export async function deprecatePaymentAdapter(deps: PaymentAdapterDeps, params: DeprecatePaymentAdapterParams) {
  if (!nonEmpty(params.releaseId)) throw new MissingPaymentAdapterFieldError("releaseId");
  return executeAdapterCommand(deps, {
    ...params,
    ...releaseTarget(params.releaseId),
    riskClass: "R2",
    scope: "payments.adapters.revoke",
    requestedAction: "payment.adapter.deprecate",
    payload: { releaseId: params.releaseId, retireAt: params.retireAt ?? null },
    path: releasePath(params.releaseId, "deprecate"),
    body: { retireAt: params.retireAt },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// R3 / R4 — maker-checker
// ─────────────────────────────────────────────────────────────────────────

export const PAYMENT_ADAPTER_APPROVAL_ACTIONS = {
  approve: { action: "payment.adapter.approve", scope: "payments.adapters.approve" as Scope, riskClass: "R3" as RiskClass, segment: "approve" },
  retire: { action: "payment.adapter.retire", scope: "payments.adapters.revoke" as Scope, riskClass: "R3" as RiskClass, segment: "retire" },
  revoke: { action: "payment.adapter.revoke", scope: "payments.adapters.revoke" as Scope, riskClass: "R4" as RiskClass, segment: "revoke" },
} as const;
export type PaymentAdapterApprovalActionKey = keyof typeof PAYMENT_ADAPTER_APPROVAL_ACTIONS;

// Same 24h window as identity/credential R3 (see identityApprovalOperation.ts).
const APPROVAL_TTL_SECONDS = 24 * 60 * 60;

export function isPaymentAdapterApproval(approval: { requestedAction: string }): boolean {
  return Object.values(PAYMENT_ADAPTER_APPROVAL_ACTIONS).some((entry) => entry.action === approval.requestedAction);
}

export function paymentAdapterApprovalScope(approval: { requestedAction: string }): Scope | undefined {
  return Object.values(PAYMENT_ADAPTER_APPROVAL_ACTIONS).find((entry) => entry.action === approval.requestedAction)?.scope;
}

function approvalHash(requestedAction: string, releaseId: string, summary: Record<string, unknown>): string {
  return computeSafePayloadHash({ requestedAction, targetResourceType: "payment_adapter_release", targetResourceId: releaseId, payload: summary });
}

export interface RequestPaymentAdapterApprovalParams extends OperatorParams {
  actionKey: PaymentAdapterApprovalActionKey;
  releaseId: string;
  reason: string;
  /** approve only. */
  effectiveFrom?: string;
  /** revoke only — R4 recovery path, bound into the approval. */
  recoveryIntent?: string;
}

/**
 * Maker step. Reads the owner's current release (and, for revoke, its live
 * impact) so the checker approves a concrete safe diff, never "an action
 * happens". Mints read assertions only; no mutation is sent.
 */
export async function requestPaymentAdapterApproval(
  deps: Omit<PaymentAdapterDeps, "ledger"> & { approvals: ManagementApprovalStore },
  params: RequestPaymentAdapterApprovalParams,
): Promise<ApprovalRecord> {
  const entry = PAYMENT_ADAPTER_APPROVAL_ACTIONS[params.actionKey];
  if (!entry) throw new MissingPaymentAdapterFieldError("known approval action");
  if (!nonEmpty(params.releaseId)) throw new MissingPaymentAdapterFieldError("releaseId");
  if (params.actionKey === "revoke" && !nonEmpty(params.recoveryIntent)) throw new MissingPaymentAdapterFieldError("recoveryIntent");

  const detail = (await getPaymentAdapter(deps, params)).release as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    releaseKey: detail.releaseKey,
    manifestHash: detail.manifestHash,
    lifecycleStatusAtRequest: detail.lifecycleStatus,
    approvalStatusAtRequest: detail.approvalStatus,
  };
  if (params.actionKey === "approve") summary.effectiveFrom = params.effectiveFrom ?? null;
  if (params.actionKey === "revoke") {
    const impact = (await getPaymentAdapterRevokeImpact(deps, params)).impact as Record<string, unknown>;
    summary.expectedAffectedConnectionCount = impact.affectedConnectionCount;
    summary.expectedAffectedTenantCount = impact.affectedTenantCount;
    summary.expectedByEnvironment = impact.byEnvironment;
    summary.recoveryIntent = params.recoveryIntent;
  }

  return deps.approvals.createApproval({
    approvalId: randomUUID(),
    requestedAction: entry.action,
    targetResourceType: "payment_adapter_release",
    targetResourceId: params.releaseId,
    safePayloadHash: approvalHash(entry.action, params.releaseId, summary),
    safeRequestSummary: summary,
    riskClass: entry.riskClass,
    reason: params.reason,
    makerOperatorId: params.operatorId,
    correlationId: params.correlationId ?? randomUUID(),
    ttlSeconds: APPROVAL_TTL_SECONDS,
  });
}

export function decidePaymentAdapterApproval(
  deps: { approvals: ManagementApprovalStore },
  params: { approvalId: string; checkerOperatorId: string; decision: ApprovalDecision },
): Promise<ApprovalRecord> {
  return deps.approvals.decideApproval(params);
}

export interface ExecutePaymentAdapterApprovalParams extends OperatorParams {
  approvalId: string;
  idempotencyKey: string;
  causationId?: string;
}

export async function executePaymentAdapterApproval(
  deps: PaymentAdapterDeps & { approvals: ManagementApprovalStore },
  params: ExecutePaymentAdapterApprovalParams,
): Promise<PaymentAdapterOperationResult & { approval: ApprovalRecord }> {
  const approval = await deps.approvals.getApproval(params.approvalId);
  const entry = Object.values(PAYMENT_ADAPTER_APPROVAL_ACTIONS).find((e) => e.action === approval.requestedAction);
  if (!entry) throw new MissingPaymentAdapterFieldError("payment adapter approval");
  const summary = approval.safeRequestSummary;
  if (!summary) throw new MissingPaymentAdapterFieldError("approved safe diff");

  // §59 replay before the single-use gate (audit remediation M5 pattern).
  const prior = await deps.ledger.findApprovalExecutionReplay(params.idempotencyKey, approval.approvalId, approval.requestedAction);
  if (prior) return { operation: prior, replay: true, approval };

  const executed = await deps.approvals.markExecuted(params.approvalId, approvalHash(approval.requestedAction, approval.targetResourceId, summary));
  if (!executed.checkerOperatorId) throw new MissingPaymentAdapterFieldError("checker");

  const releaseId = approval.targetResourceId;
  const body: Record<string, unknown> = {};
  if (entry.segment === "approve") body.effectiveFrom = summary.effectiveFrom ?? undefined;
  if (entry.segment === "revoke") {
    body.recoveryIntent = summary.recoveryIntent;
    body.expectedImpact = { affectedConnectionCount: summary.expectedAffectedConnectionCount };
  }

  const result = await executeAdapterCommand(deps, {
    ...params,
    ...releaseTarget(releaseId),
    riskClass: entry.riskClass,
    scope: entry.scope,
    requestedAction: entry.action,
    reason: approval.reason,
    payload: { releaseId, approvalId: approval.approvalId, ...summary },
    path: releasePath(releaseId, entry.segment),
    body,
    approvalEvidence: { approvalId: approval.approvalId, makerOperatorId: approval.makerOperatorId, checkerOperatorId: executed.checkerOperatorId },
    approvalLedgerEvidence: { approvalId: approval.approvalId, checkerOperatorId: executed.checkerOperatorId, decidedAt: executed.decidedAt },
  });
  return { ...result, approval: executed };
}
