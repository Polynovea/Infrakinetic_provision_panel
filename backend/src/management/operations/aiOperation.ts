import { randomUUID } from "node:crypto";

import { mintManagementAssertion, ScopeNotGrantedError } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi, isNeverDispatchedNetworkError } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { canonicalStringify, computeSafePayloadHash } from "./canonicalHash.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { UnexpectedManagementApiResponseError } from "./engineStateOperation.js";
import { ApprovalAlreadyExecutedError, ApprovalNotApprovedError, type ApprovalRecord, type ManagementApprovalStore } from "./managementApprovalStore.js";
import { UnknownTenantError } from "./tenantRegistryQuery.js";
import {
  AI_CONTRACT,
  InvalidAiRequestError,
  aiRoute,
  aiRouteByAction,
  effectiveRisk,
  ownerPath,
  requestSchemaWithoutIdempotency,
  resolveTarget,
  validateAiBody,
  validateAiSchema,
  type AiContractRoute,
  type AiTarget,
} from "./aiContract.js";
import {
  getAiAdminCommandReceipt,
  getAiCatalog,
  getManagedAiCredentials,
  getTenantAiCredentials,
  findSecretShapedField,
  getTenantAiState,
  safeAiBody,
  type AiCatalog,
  type AiModelState,
  type AiOperatorParams,
  type AiProviderState,
  type AiQueryDeps,
} from "./aiQuery.js";
import type { Scope } from "../../identity/roles.js";

// Phase 1A.15 final closure — Governance's AI mutation plane (operator side).
//
// Semantics stay in Infrakinetic's module_ai: this module records the
// operation in Governance's ledger, enforces the risk controls the contract
// declares, signs a per-call assertion, calls the owner's /management/v1 route
// with an idempotency key and an explicit reason, and independently observes
// the effect. It never writes an owner table, never imports owner source, and
// has no route that could carry BYOAI credential material (the only BYOAI
// mutation is `tenant.credential.revoke`, which has no fields at all).
//
// EVERYTHING route-shaped — scope, requested action, method, path, risk class,
// target binding, approval requirement, request schema — is READ from the
// owner's published contract (aiContract.ts, hash-pinned copy), so a Governance
// operation cannot silently disagree with the owner's route table.
//
//   R1  metering-exception / reconciliation-line resolve
//   R2  planes, capability commissioning, commissioning mode, quota set /
//       remove / grace, billing anchor, tenant model policy, provider state
//       (activate), credential revoke
//   R3  tenant resume, model lifecycle, model certification, managed-pool source cutover
//   R4  tenant suspend and provider narrowing (disable / deprecate)
//
// R3/R4 binds a checker-visible safe diff into the approval at request time.
// Execution re-reads the owner's CURRENT state and refuses — BEFORE the
// approval is consumed — if the facts the checker approved no longer hold; the
// assertion then carries signed approval evidence, so the owner takes the
// maker/checker from the signature, never from a body.

export interface AiOperationDeps extends AiQueryDeps {
  ledger: ManagementOperationLedger;
}

export type AiApprovalDeps = AiOperationDeps & { approvals: ManagementApprovalStore };

export class AiOperationRefusedError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus: number = 409, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "AiOperationRefusedError";
  }
}

// Free text an operator types must never be a credential. The owner applies the same guard to evidenceRef; the
// shapes are the ones the platform's own secret scanners look for. (`aicred_` refs are identifiers, not material.)
const SECRET_SHAPE = /(nvapi-|sk-[A-Za-z0-9]|bearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN)/i;
const EVIDENCE_SECRET_SHAPE = /(nvapi-|sk-[A-Za-z0-9]|bearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN|aicred_)/i;

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

// ── contract lookups ────────────────────────────────────────────────────

export const AI_MUTATION_ROUTES = AI_CONTRACT.routes.filter((route) => route.kind === "mutation");
/** Receipted mutations executed through executeAiCommand (R1/R2/R4, or R3 through the approval pair). */
export const AI_LEDGERED_ROUTES = AI_MUTATION_ROUTES.filter((route) => route.receipted !== false);
export const AI_APPROVAL_ROUTES = AI_MUTATION_ROUTES.filter(
  (route) => route.approval === "maker_checker" || route.approvalWhenNarrowing === "maker_checker",
);

function approvalRequiredFor(route: AiContractRoute, fields: Record<string, unknown>): boolean {
  if (route.approval === "maker_checker") return true;
  return route.approvalWhenNarrowing === "maker_checker" && effectiveRisk(route, fields) === "R4";
}

export function isAiApproval(approval: { requestedAction: string }): boolean {
  return AI_APPROVAL_ROUTES.some((route) => route.action === approval.requestedAction);
}

export function aiApprovalScope(approval: { requestedAction: string }): Scope | undefined {
  return AI_APPROVAL_ROUTES.find((route) => route.action === approval.requestedAction)?.scope as Scope | undefined;
}

// ── transport ───────────────────────────────────────────────────────────

interface CallParams extends AiOperatorParams {
  route: AiContractRoute;
  target: AiTarget;
  path: string;
  body?: unknown;
  correlationId: string;
  approvalEvidence?: { approvalId: string; makerOperatorId: string; checkerOperatorId: string };
}

async function mintAndCall(deps: AiQueryDeps, params: CallParams) {
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: [params.route.scope],
    targetTenantId: params.target.targetTenantId,
    targetResourceType: params.target.targetResourceType,
    targetResourceId: params.target.targetResourceId,
    requestedAction: params.route.action,
    correlationId: params.correlationId,
    approvalEvidence: params.approvalEvidence,
  });
  return callInfrakineticManagementApi({
    baseUrl: deps.infrakineticBaseUrl,
    path: params.path,
    assertion,
    method: params.route.method,
    body: params.body,
    correlationId: params.correlationId,
    fetchImpl: deps.fetchImpl,
  });
}

// ── commissioning-mode dry run (unreceipted; changes nothing) ───────────

export interface AiCommissioningModePreview {
  tenantId: string;
  dryRun: true;
  currentMode: string;
  targetMode: string;
  changes: Array<{ capabilityKey: string; plane: string; before: { effective: boolean; mismatchReason?: string }; after: { effective: boolean; mismatchReason?: string } }>;
  losing: number;
  gaining: number;
  /** Bound into the apply: the owner refuses the set if the diff has since changed. */
  diffHash: string;
  operatorId?: string;
  correlationId?: string;
  executedAt?: string;
}

export async function previewCommissioningMode(
  deps: AiQueryDeps,
  params: AiOperatorParams & { tenantId: string; mode: string },
): Promise<AiCommissioningModePreview> {
  const route = aiRoute("tenant.commissioning-mode.preview");
  const body = { mode: params.mode };
  const violations = validateAiBody(route, body);
  if (violations.length > 0) throw new InvalidAiRequestError(route.id, violations);
  const pathParams = { tenantId: params.tenantId };
  const path = ownerPath(route, pathParams);
  const result = await mintAndCall(deps, {
    ...params, route, target: resolveTarget(route, pathParams, body), path, body, correlationId: params.correlationId ?? randomUUID(),
  });
  if (result.status === 404) throw new UnknownTenantError(params.tenantId);
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  return safeAiBody<AiCommissioningModePreview>(result.body);
}

// ── independent effective-state observation ─────────────────────────────

export interface AiObservation {
  /**
   * verified       a fresh owner read shows the requested state
   * mismatch       the owner answered 200 but a fresh read disagrees
   * unavailable    the observation read itself failed
   * not_observable no owner read exposes this effect (or the operator cannot read AI state); the owner's
   *                durable receipt is the proof
   */
  status: "verified" | "mismatch" | "unavailable" | "not_observable";
  via: "tenant_state" | "catalog" | "credentials" | "receipt" | "none";
  expected?: unknown;
  observed?: unknown;
  message?: string;
}

interface ObserveContext {
  deps: AiQueryDeps;
  operator: AiOperatorParams;
  route: AiContractRoute;
  target: AiTarget;
  pathParams: Record<string, string>;
  fields: Record<string, unknown>;
  idempotencyKey: string;
}

const same = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);

function compare(via: AiObservation["via"], expected: unknown, observed: unknown, message?: string): AiObservation {
  return { status: same(expected, observed) ? "verified" : "mismatch", via, expected, observed, ...(message ? { message } : {}) };
}

function findModel(catalog: AiCatalog, modelId: string): { provider: AiProviderState; model: AiModelState } | undefined {
  for (const provider of catalog.providers) {
    const model = provider.models.find((entry) => entry.modelId === modelId);
    if (model) return { provider, model };
  }
  return undefined;
}

async function observeReceipt(ctx: ObserveContext, extra?: { expectedResult?: Record<string, unknown> }): Promise<AiObservation> {
  const receipt = await getAiAdminCommandReceipt(ctx.deps, { ...ctx.operator, idempotencyKey: ctx.idempotencyKey, target: ctx.target });
  const command = receipt.command;
  const observed = { status: command.status, action: command.action, target: command.target, ...(extra?.expectedResult ? { result: Object.fromEntries(Object.keys(extra.expectedResult).map((key) => [key, command.result?.[key]])) } : {}) };
  const expected = {
    status: "completed",
    action: ctx.route.action,
    target: { type: ctx.target.targetResourceType, id: ctx.target.targetResourceId },
    ...(extra?.expectedResult ? { result: extra.expectedResult } : {}),
  };
  return compare("receipt", expected, observed);
}

const tenantOf = (ctx: ObserveContext) => ctx.pathParams.tenantId as string;
const tenantState = (ctx: ObserveContext) => getTenantAiState(ctx.deps, { ...ctx.operator, tenantId: tenantOf(ctx) });

const OBSERVERS: Record<string, (ctx: ObserveContext) => Promise<AiObservation>> = {
  "tenant.suspend": async (ctx) => compare("tenant_state", "suspended", (await tenantState(ctx)).emergency.state),
  "tenant.resume": async (ctx) => compare("tenant_state", "none", (await tenantState(ctx)).emergency.state),
  "tenant.planes.set": async (ctx) =>
    compare("tenant_state", [...(ctx.fields.planes as string[])].sort(), [...(await tenantState(ctx)).rootPolicy.allowedPlanes].sort()),
  "tenant.commissioning-mode.set": async (ctx) => compare("tenant_state", ctx.fields.mode, (await tenantState(ctx)).rootPolicy.commissioningMode),
  "tenant.billing-anchor.set": async (ctx) => compare("tenant_state", ctx.fields.billingAnchorDay, (await tenantState(ctx)).rootPolicy.billingAnchorDay),
  "tenant.capability.commission": async (ctx) => {
    const state = await tenantState(ctx);
    if (state.rootPolicy.commissioningMode !== "explicit") {
      // legacy_additive: the feature flag alone decides, so the commission row has no visible effect yet.
      const receipt = await observeReceipt(ctx);
      return { ...receipt, message: "commissioning has no effect until the tenant is in explicit mode; verified against the owner receipt" };
    }
    const wanted = ctx.fields.state === "commissioned";
    const entry = state.capabilities.find((cap) => cap.capabilityKey === ctx.pathParams.capabilityKey && cap.plane === ctx.fields.plane);
    return compare("tenant_state", wanted, entry ? entry.commissioning.commissioned : null);
  },
  "tenant.quota.set": async (ctx) => {
    const state = await tenantState(ctx);
    if (!state.quotas.some((quota) => quota.policyKey !== undefined)) return observeReceipt(ctx);
    const policy = ctx.fields.policy as { hardLimit: number; enabled?: boolean };
    const quota = state.quotas.find((entry) => entry.policyKey === ctx.pathParams.policyKey);
    const expected = { present: true, hard: policy.hardLimit, ...(policy.enabled === undefined ? {} : { enabled: policy.enabled }) };
    const observed = quota
      ? { present: true, hard: quota.hard, ...(policy.enabled === undefined ? {} : { enabled: quota.enabled }) }
      : { present: false };
    return compare("tenant_state", expected, observed);
  },
  "tenant.quota.remove": async (ctx) => {
    const state = await tenantState(ctx);
    if (!state.quotas.some((quota) => quota.policyKey !== undefined)) return observeReceipt(ctx);
    return compare("tenant_state", { present: false }, { present: state.quotas.some((entry) => entry.policyKey === ctx.pathParams.policyKey) });
  },
  "tenant.quota.grace.grant": async (ctx) => {
    const state = await tenantState(ctx);
    if (!state.quotas.some((quota) => quota.policyKey !== undefined)) return observeReceipt(ctx);
    const quota = state.quotas.find((entry) => entry.policyKey === ctx.pathParams.policyKey);
    return compare("tenant_state", { graceActive: true, graceLimit: ctx.fields.graceLimit }, { graceActive: quota?.overage.graceActiveForWindow ?? false, graceLimit: quota?.overage.graceLimit ?? null });
  },
  "tenant.credential.revoke": async (ctx) => {
    const metadata = await getTenantAiCredentials(ctx.deps, { ...ctx.operator, tenantId: tenantOf(ctx) });
    return compare("credentials", "revoked", metadata.credentials.find((entry) => entry.refId === ctx.pathParams.refId)?.status ?? null);
  },
  "managed-credential.add": async (ctx) => {
    const inventory = await getManagedAiCredentials(ctx.deps, ctx.operator);
    const pool = inventory.pools.find((entry) => entry.poolKey === ctx.pathParams.poolKey);
    return compare("credentials", true, Boolean(pool?.managedCredentials.some((entry) => entry.label === ctx.fields.label && entry.status === "active")));
  },
  "managed-credential.rotate": (ctx) => observeReceipt(ctx),
  "managed-credential.status.set": async (ctx) => {
    const inventory = await getManagedAiCredentials(ctx.deps, ctx.operator);
    const pool = inventory.pools.find((entry) => entry.poolKey === ctx.pathParams.poolKey);
    return compare("credentials", ctx.fields.status, pool?.managedCredentials.find((entry) => entry.credentialId === ctx.pathParams.credentialId)?.status ?? null);
  },
  "managed-credential.pool-source.set": async (ctx) => {
    const inventory = await getManagedAiCredentials(ctx.deps, ctx.operator);
    return compare("credentials", ctx.fields.source, inventory.pools.find((entry) => entry.poolKey === ctx.pathParams.poolKey)?.runtimeSource ?? null);
  },
  "provider.state.set": async (ctx) => {
    const catalog = await getAiCatalog(ctx.deps, ctx.operator);
    return compare("catalog", ctx.fields.status, catalog.providers.find((entry) => entry.providerKey === ctx.pathParams.providerKey)?.status ?? null);
  },
  "model.lifecycle.set": async (ctx) => {
    const found = findModel(await getAiCatalog(ctx.deps, ctx.operator), ctx.pathParams.modelId as string);
    return compare("catalog", ctx.fields.lifecycle, found?.model.lifecycle ?? null);
  },
  "model.certification.set": async (ctx) => {
    const found = findModel(await getAiCatalog(ctx.deps, ctx.operator), ctx.pathParams.modelId as string);
    return compare("catalog", { certification: ctx.fields.certification, evidenceRef: ctx.fields.evidenceRef }, { certification: found?.model.certification ?? null, evidenceRef: found?.model.certificationEvidenceRef ?? null });
  },
  // No owner read exposes these effects: the tenant model-policy table, and the resolution state of a single
  // exception / reconciliation line. The owner's durable receipt for this exact command is the proof.
  "tenant.model-policy.set": (ctx) => observeReceipt(ctx, { expectedResult: { decision: ctx.fields.decision } }),
  "metering-exception.resolve": (ctx) => observeReceipt(ctx),
  "reconciliation.line.resolve": (ctx) => observeReceipt(ctx),
};

async function observe(ctx: ObserveContext): Promise<AiObservation> {
  const observer = OBSERVERS[ctx.route.id];
  if (!observer) return { status: "not_observable", via: "none", message: `no observer is defined for ${ctx.route.id}` };
  try {
    return await observer(ctx);
  } catch (err) {
    // An operator without ai.read cannot observe; the owner's 200 and receipt stand, honestly labelled.
    if (err instanceof ScopeNotGrantedError) return { status: "not_observable", via: "none", message: "operator was not granted ai.read; effect not independently observed" };
    return { status: "unavailable", via: "none", message: err instanceof Error ? err.message : String(err) };
  }
}

// ── shared pre-ledger validation ────────────────────────────────────────

function assertNoSecretShapedText(fields: Record<string, unknown>, reason: string): void {
  if (SECRET_SHAPE.test(reason)) throw new AiOperationRefusedError("AI_TEXT_LOOKS_LIKE_SECRET", "reason must describe the change, never contain a credential", 400);
  if (typeof fields.recoveryIntent === "string" && SECRET_SHAPE.test(fields.recoveryIntent)) {
    throw new AiOperationRefusedError("AI_TEXT_LOOKS_LIKE_SECRET", "recoveryIntent must describe the recovery path, never contain a credential", 400);
  }
  if (typeof fields.evidenceRef === "string" && EVIDENCE_SECRET_SHAPE.test(fields.evidenceRef)) {
    throw new AiOperationRefusedError("EVIDENCE_REF_LOOKS_LIKE_SECRET", "evidenceRef must be an identifier, never a credential", 400);
  }
}

function assertContractPreconditions(route: AiContractRoute, fields: Record<string, unknown>): void {
  const narrowing = route.riskNarrowing !== undefined && fields.status !== undefined && fields.status !== "active";
  if ((route.recoveryIntent || (route.recoveryIntentWhenNarrowing && narrowing)) && !isText(fields.recoveryIntent)) {
    throw new AiOperationRefusedError("AI_RECOVERY_INTENT_REQUIRED", `${route.action} requires a recoveryIntent describing how the change will be reversed`, 400);
  }
  if (route.requiresDryRunHash && !isText(fields.expectedDiffHash)) {
    throw new AiOperationRefusedError("AI_DIFF_REQUIRED", "Setting the commissioning mode requires the expectedDiffHash of a dry-run preview taken for that mode", 400);
  }
  if (route.requiresEvidenceRef && !isText(fields.evidenceRef)) {
    throw new AiOperationRefusedError("AI_EVIDENCE_REF_REQUIRED", "Certifying a model requires an evidenceRef (the certification run or artefact identifier)", 400);
  }
}

// ── ledgered execution (shared by R1/R2/R4 and approved R3) ─────────────

export interface AiOperationResult {
  operation: ManagementOperationRecord;
  replay: boolean;
}

export interface AiCommandParams extends AiOperatorParams {
  routeId: string;
  /** Values of the route's path parameters (tenantId, policyKey, providerKey, modelId, refId, exceptionId, …). */
  pathParams: Record<string, string>;
  /** The route's body fields, WITHOUT idempotencyKey / reason (added below). */
  fields?: Record<string, unknown>;
  reason: string;
  idempotencyKey: string;
  causationId?: string;
}

interface RunContext extends AiCommandParams {
  route: AiContractRoute;
  approvalEvidence?: { approvalId: string; makerOperatorId: string; checkerOperatorId: string };
  approvalLedgerEvidence?: Record<string, unknown>;
  /** Extra material bound into the idempotency hash (an approval id and its safe summary). */
  payloadExtra?: Record<string, unknown>;
}

// The ledger's redactor treats any key containing "credential" as secret-shaped; the revoke result's metadata
// (ref id, masked hint, status) is safe and is what an auditor needs.
function evidenceSafe(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && "credential" in (body as Record<string, unknown>)) {
    const { credential, ...rest } = body as Record<string, unknown>;
    return { ...rest, revoked: credential };
  }
  return body;
}

function persistenceSafeFields(route: AiContractRoute, fields: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...fields };
  for (const field of route.sensitiveFields ?? []) {
    if (!(field in safe)) continue;
    const value = safe[field];
    safe[field] = {
      redacted: true,
      materialDigest: computeSafePayloadHash({ requestedAction: `sensitive:${route.id}:${field}`, payload: value }),
    };
  }
  return safe;
}

async function runAiCommand(deps: AiOperationDeps, ctx: RunContext): Promise<AiOperationResult> {
  const { route } = ctx;
  // Defence in depth behind the route's requireScope: an operator without the command's scope reserves no key,
  // writes no ledger row and sends nothing — it is not an outcome-ambiguous "partial" of anything.
  if (!ctx.operatorGrantedScopes.includes(route.scope)) throw new ScopeNotGrantedError(route.scope);
  const fields = ctx.fields ?? {};
  const body = { ...fields, idempotencyKey: ctx.idempotencyKey, reason: ctx.reason };
  const violations = validateAiBody(route, body);
  if (violations.length > 0) throw new InvalidAiRequestError(route.id, violations);
  assertContractPreconditions(route, fields);
  assertNoSecretShapedText(fields, ctx.reason);

  const target = resolveTarget(route, ctx.pathParams, fields);
  const risk = effectiveRisk(route, fields);
  const correlationId = ctx.correlationId ?? randomUUID();

  const persistedFields = persistenceSafeFields(route, fields);
  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: ctx.idempotencyKey,
    operatorId: ctx.operatorId,
    operatorSessionId: ctx.operatorSessionId,
    requestedAction: route.action,
    targetTenantId: target.targetTenantId ?? null,
    targetResourceType: target.targetResourceType,
    targetResourceId: target.targetResourceId,
    reason: ctx.reason,
    riskClass: risk,
    approvalEvidence: ctx.approvalLedgerEvidence,
    payload: { fields: persistedFields, reason: ctx.reason, ...(ctx.payloadExtra ?? {}) },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: ctx.causationId,
  });
  if (replay) return { operation: submitted, replay: true };

  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const path = ownerPath(route, ctx.pathParams);
  let result;
  try {
    result = await mintAndCall(deps, { ...ctx, route, target, path, body, correlationId, approvalEvidence: ctx.approvalEvidence });
  } catch (err) {
    // Never-dispatched (DNS / connection refused) is unambiguous: no owner mutation could have happened. Anything
    // else is outcome-ambiguous — the owner may have executed — and lands in partially_completed; the owner's
    // receipt (/ai-admin-commands/:idempotencyKey) resolves it.
    if (isNeverDispatchedNetworkError(err)) {
      const failed = await deps.ledger.transitionOperation(submitted.operationId, {
        toStatus: "failed",
        partialFailureState: { stage: "mutation-call-never-dispatched", message: err instanceof Error ? err.message : String(err) },
      });
      return { operation: failed, replay: false };
    }
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

  // The owner executed (200), but a response carrying a secret-shaped field is never stored or relayed. The
  // operation is closed as outcome-ambiguous for reconciliation against the owner receipt — never left 'running'.
  const unsafeField = findSecretShapedField(result.body);
  if (unsafeField) {
    const unsafe = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      partialFailureState: { stage: "owner-response-unsafe", fieldPath: unsafeField },
    });
    return { operation: unsafe, replay: false };
  }
  const ownerResult = result.body as Record<string, unknown>;
  const observation = await observe({
    deps, operator: ctx, route, target, pathParams: ctx.pathParams, fields, idempotencyKey: ctx.idempotencyKey,
  });

  if (observation.status === "mismatch" || observation.status === "unavailable") {
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      afterStateSafeSnapshot: buildSafeSnapshot({ target, ownerResult: evidenceSafe(ownerResult), observation }),
      partialFailureState: observation.status === "mismatch"
        ? { stage: "effective-mismatch", via: observation.via, expected: observation.expected, observed: observation.observed }
        : { stage: "effective-observation", message: observation.message },
    });
    return { operation: partial, replay: false };
  }

  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot({ target, ownerResult: evidenceSafe(ownerResult), observation }),
    result: { ownerResult: evidenceSafe(ownerResult), observation },
  });
  return { operation: completed, replay: false };
}

/**
 * Executes a receipted, non-maker-checker AI command (R1, R2, R4). R3 commands go through requestAiApproval /
 * executeAiApproval — calling this for one is refused, never silently downgraded.
 */
export async function executeAiCommand(deps: AiOperationDeps, params: AiCommandParams): Promise<AiOperationResult> {
  const route = aiRoute(params.routeId);
  if (route.kind !== "mutation" || route.receipted === false) {
    throw new AiOperationRefusedError("AI_ROUTE_NOT_EXECUTABLE", `${route.id} is not a receipted AI command`, 400);
  }
  const fields = params.fields ?? {};
  // Fail closed before revealing approval policy: authorization, schema,
  // recovery/precondition and secret-shape validation all happen first.
  if (!params.operatorGrantedScopes.includes(route.scope)) throw new ScopeNotGrantedError(route.scope);
  const body = { ...fields, idempotencyKey: params.idempotencyKey, reason: params.reason };
  const violations = validateAiBody(route, body);
  if (violations.length > 0) throw new InvalidAiRequestError(route.id, violations);
  assertContractPreconditions(route, fields);
  assertNoSecretShapedText(fields, params.reason);
  if (approvalRequiredFor(route, fields)) {
    throw new AiOperationRefusedError("AI_APPROVAL_REQUIRED", `${route.action} requires maker-checker approval: request an approval, have a different operator decide it, then execute it`, 409);
  }
  return runAiCommand(deps, { ...params, route });
}

// ── R3/R4 maker-checker ───────────────────────────────────────────────

// Same 24h window as identity/credential/payment-adapter R3.
const APPROVAL_TTL_SECONDS = 24 * 60 * 60;

export interface RequestAiApprovalParams extends AiOperatorParams {
  routeId: string;
  pathParams: Record<string, string>;
  fields?: Record<string, unknown>;
  reason: string;
}

function approvalHash(requestedAction: string, target: AiTarget, summary: Record<string, unknown>): string {
  return computeSafePayloadHash({
    requestedAction,
    targetTenantId: target.targetTenantId ?? null,
    targetResourceType: target.targetResourceType,
    targetResourceId: target.targetResourceId,
    payload: summary,
  });
}

function approvalRouteFor(routeId: string, fields: Record<string, unknown>): AiContractRoute {
  const route = aiRoute(routeId);
  if (route.kind !== "mutation" || !approvalRequiredFor(route, fields)) {
    throw new AiOperationRefusedError("AI_ROUTE_NOT_APPROVAL_GATED", `${route.id} does not require maker-checker approval for this requested state`, 400);
  }
  return route;
}

const modelNotFound = (modelId: string) => new AiOperationRefusedError("AI_MODEL_NOT_FOUND", `The owner catalog has no model '${modelId}'`, 404);

/**
 * Maker step. Reads the owner's current facts so the checker approves a concrete safe diff, never "an action
 * happens". Mints read assertions only; no mutation is sent.
 */
export async function requestAiApproval(deps: AiApprovalDeps, params: RequestAiApprovalParams): Promise<ApprovalRecord> {
  const fields = params.fields ?? {};
  const route = approvalRouteFor(params.routeId, fields);
  const violations = validateAiSchema(requestSchemaWithoutIdempotency(route), { ...fields, reason: params.reason });
  if (violations.length > 0) throw new InvalidAiRequestError(route.id, violations);
  assertContractPreconditions(route, fields);
  assertNoSecretShapedText(fields, params.reason);

  const target = resolveTarget(route, params.pathParams, fields);
  const summary = await summaryFor(deps, params, route, fields, params.pathParams);

  return deps.approvals.createApproval({
    approvalId: randomUUID(),
    requestedAction: route.action,
    targetTenantId: target.targetTenantId,
    targetResourceType: target.targetResourceType as string,
    targetResourceId: target.targetResourceId as string,
    safePayloadHash: approvalHash(route.action, target, summary),
    safeRequestSummary: summary,
    riskClass: effectiveRisk(route, fields),
    reason: params.reason,
    makerOperatorId: params.operatorId,
    correlationId: params.correlationId ?? randomUUID(),
    ttlSeconds: APPROVAL_TTL_SECONDS,
  });
}

async function summaryFor(deps: AiQueryDeps, operator: AiOperatorParams, route: AiContractRoute, fields: Record<string, unknown>, pathParams: Record<string, string>): Promise<Record<string, unknown>> {
  if (route.id === "tenant.suspend") {
    const state = await getTenantAiState(deps, { ...operator, tenantId: pathParams.tenantId as string });
    if (state.emergency.state === "suspended") {
      throw new AiOperationRefusedError("AI_TENANT_ALREADY_SUSPENDED", "This tenant's AI is already suspended", 409);
    }
    return {
      tenantId: pathParams.tenantId,
      emergencyStateAtRequest: state.emergency.state,
      emergencySinceAtRequest: state.emergency.since,
      emergencyOperationIdAtRequest: state.emergency.operationId,
      requestedRecoveryIntent: fields.recoveryIntent,
      suspendsTo: "suspended",
    };
  }
  if (route.id === "provider.state.set") {
    const catalog = await getAiCatalog(deps, operator);
    const provider = catalog.providers.find((entry) => entry.providerKey === pathParams.providerKey);
    if (!provider) throw new AiOperationRefusedError("AI_PROVIDER_NOT_FOUND", `The owner catalog has no provider '${pathParams.providerKey}'`, 404);
    if (provider.status === fields.status) throw new AiOperationRefusedError("AI_NO_CHANGE", `The provider is already '${provider.status}'`, 409);
    return {
      providerKey: provider.providerKey,
      providerStatusAtRequest: provider.status,
      requestedStatus: fields.status,
      requestedRecoveryIntent: fields.recoveryIntent,
    };
  }
  if (route.id === "tenant.resume") {
    const state = await getTenantAiState(deps, { ...operator, tenantId: pathParams.tenantId as string });
    if (state.emergency.state !== "suspended") {
      throw new AiOperationRefusedError("AI_TENANT_NOT_SUSPENDED", "This tenant's AI is not suspended, so there is nothing to resume", 409);
    }
    return {
      tenantId: pathParams.tenantId,
      emergencyStateAtRequest: "suspended",
      suspendedSince: state.emergency.since,
      suspendOperationId: state.emergency.operationId,
      suspendReason: state.emergency.reason,
      recoveryIntent: state.emergency.recoveryIntent,
      resumesTo: "none",
    };
  }
  if (route.id === "managed-credential.pool-source.set") {
    const inventory = await getManagedAiCredentials(deps, operator);
    const pool = inventory.pools.find((entry) => entry.poolKey === pathParams.poolKey);
    if (!pool) throw new AiOperationRefusedError("AI_MANAGED_POOL_NOT_FOUND", `The owner has no managed credential pool '${pathParams.poolKey}'`, 404);
    if (pool.runtimeSource === fields.source) throw new AiOperationRefusedError("AI_NO_CHANGE", `The pool is already using '${pool.runtimeSource}'`, 409);
    return {
      poolKey: pool.poolKey, providerKey: pool.providerKey, workloadLabel: pool.workloadLabel,
      currentSource: pool.runtimeSource, requestedSource: fields.source,
      environmentCredentialCount: pool.environmentCredentials.length,
      managedActiveCredentialCount: pool.managedCredentials.filter((entry) => entry.status === "active").length,
      keyringPosture: inventory.keyringPosture, runtimeReadyAtRequest: pool.runtimeReady,
    };
  }
  const modelId = pathParams.modelId as string;
  const catalog = await getAiCatalog(deps, operator);
  const found = findModel(catalog, modelId);
  if (!found) throw modelNotFound(modelId);
  const { provider, model } = found;
  const base = {
    modelId,
    providerKey: provider.providerKey,
    modelKey: model.modelKey,
    providerStatusAtRequest: provider.status,
    lifecycleAtRequest: model.lifecycle,
    certificationAtRequest: model.certification,
  };
  if (route.id === "model.lifecycle.set") {
    if (model.lifecycle === "retired") throw new AiOperationRefusedError("AI_MODEL_RETIRED", "A retired model is terminal and cannot change lifecycle", 409);
    if (model.lifecycle === fields.lifecycle) throw new AiOperationRefusedError("AI_NO_CHANGE", `The model is already '${model.lifecycle}'`, 409);
    return {
      ...base,
      requestedLifecycle: fields.lifecycle,
      // The checker sees what would lose its default model, from the owner's own catalog.
      capabilitiesUsingAsDefault: catalog.capabilities
        .filter((capability) => capability.defaultProviderKey === provider.providerKey && capability.defaultModelKey === model.modelKey)
        .map((capability) => capability.capabilityKey)
        .sort(),
    };
  }
  if (route.id === "model.certification.set") {
    return { ...base, requestedCertification: fields.certification, evidenceRef: fields.evidenceRef };
  }
  throw new AiOperationRefusedError("AI_ROUTE_NOT_APPROVAL_GATED", `${route.id} has no approval summary`, 400);
}

function fieldsFromSummary(route: AiContractRoute, summary: Record<string, unknown>): Record<string, unknown> {
  if (route.id === "tenant.suspend") return { recoveryIntent: summary.requestedRecoveryIntent };
  if (route.id === "provider.state.set") return { status: summary.requestedStatus, recoveryIntent: summary.requestedRecoveryIntent };
  if (route.id === "tenant.resume") return {};
  if (route.id === "managed-credential.pool-source.set") return { source: summary.requestedSource };
  if (route.id === "model.lifecycle.set") return { lifecycle: summary.requestedLifecycle };
  return { certification: summary.requestedCertification, evidenceRef: summary.evidenceRef };
}

/** The fresh-state gate: the facts the checker approved must still be the owner's current facts. */
async function assertApprovedFactsStillHold(deps: AiQueryDeps, operator: AiOperatorParams, route: AiContractRoute, pathParams: Record<string, string>, summary: Record<string, unknown>): Promise<void> {
  const changed = (what: string, approved: unknown, current: unknown) =>
    new AiOperationRefusedError(
      "AI_APPROVAL_TARGET_CHANGED",
      `The owner's ${what} is no longer what the checker approved; request a new approval`,
      409,
      { approved, current },
    );
  if (route.id === "tenant.suspend") {
    const state = await getTenantAiState(deps, { ...operator, tenantId: pathParams.tenantId as string });
    const current = { state: state.emergency.state, since: state.emergency.since, operationId: state.emergency.operationId };
    const approved = { state: summary.emergencyStateAtRequest, since: summary.emergencySinceAtRequest, operationId: summary.emergencyOperationIdAtRequest };
    if (!same(current, approved)) throw changed("emergency state", approved, current);
    return;
  }
  if (route.id === "provider.state.set") {
    const catalog = await getAiCatalog(deps, operator);
    const provider = catalog.providers.find((entry) => entry.providerKey === pathParams.providerKey);
    if (!provider) throw new AiOperationRefusedError("AI_PROVIDER_NOT_FOUND", `The owner catalog has no provider '${pathParams.providerKey}'`, 404);
    if (provider.status !== summary.providerStatusAtRequest) throw changed("provider state", summary.providerStatusAtRequest, provider.status);
    return;
  }
  if (route.id === "tenant.resume") {
    const state = await getTenantAiState(deps, { ...operator, tenantId: pathParams.tenantId as string });
    const current = { state: state.emergency.state, since: state.emergency.since, operationId: state.emergency.operationId };
    const approved = { state: "suspended", since: summary.suspendedSince, operationId: summary.suspendOperationId };
    if (!same(current, approved)) throw changed("emergency suspension", approved, current);
    return;
  }
  if (route.id === "managed-credential.pool-source.set") {
    const inventory = await getManagedAiCredentials(deps, operator);
    const pool = inventory.pools.find((entry) => entry.poolKey === pathParams.poolKey);
    if (!pool) throw new AiOperationRefusedError("AI_MANAGED_POOL_NOT_FOUND", `The owner has no managed credential pool '${pathParams.poolKey}'`, 404);
    const current = {
      source: pool.runtimeSource,
      environmentCredentialCount: pool.environmentCredentials.length,
      managedActiveCredentialCount: pool.managedCredentials.filter((entry) => entry.status === "active").length,
      keyringPosture: inventory.keyringPosture,
    };
    const approved = {
      source: summary.currentSource,
      environmentCredentialCount: summary.environmentCredentialCount,
      managedActiveCredentialCount: summary.managedActiveCredentialCount,
      keyringPosture: summary.keyringPosture,
    };
    if (!same(current, approved)) throw changed("managed credential pool readiness", approved, current);
    return;
  }
  const found = findModel(await getAiCatalog(deps, operator), pathParams.modelId as string);
  if (!found) throw modelNotFound(pathParams.modelId as string);
  const current = { lifecycle: found.model.lifecycle, certification: found.model.certification };
  const approved = { lifecycle: summary.lifecycleAtRequest, certification: summary.certificationAtRequest };
  if (!same(current, approved)) throw changed("model lifecycle/certification", approved, current);
}

export interface ExecuteAiApprovalParams extends AiOperatorParams {
  approvalId: string;
  idempotencyKey: string;
  causationId?: string;
}

export async function executeAiApproval(deps: AiApprovalDeps, params: ExecuteAiApprovalParams): Promise<AiOperationResult & { approval: ApprovalRecord }> {
  const approval = await deps.approvals.getApproval(params.approvalId);
  const route = aiRouteByAction(approval.requestedAction);
  if (!route) throw new AiOperationRefusedError("AI_ROUTE_NOT_APPROVAL_GATED", "This approval is not an AI maker-checker action", 400);
  // The owner accepts an R3 execution only from a party to the approval (contract: approvalExecutor). Refused here,
  // before the single-use approval is consumed, so a wrong executor cannot burn an approval the owner would refuse.
  if (route.approvalExecutor === "maker_or_checker" && ![approval.makerOperatorId, approval.checkerOperatorId].includes(params.operatorId)) {
    throw new AiOperationRefusedError("AI_EXECUTOR_NOT_PARTY", "Only the operator who requested this approval or the operator who approved it can execute it", 403);
  }
  const summary = approval.safeRequestSummary;
  if (!summary) throw new AiOperationRefusedError("AI_APPROVAL_SUMMARY_MISSING", "The approval carries no approved safe diff", 409);
  const approvedFields = fieldsFromSummary(route, summary);
  if (!approvalRequiredFor(route, approvedFields)) throw new AiOperationRefusedError("AI_ROUTE_NOT_APPROVAL_GATED", "This approval is not for a state that requires maker-checker", 400);
  const pathParams: Record<string, string> = route.id === "tenant.resume" || route.id === "tenant.suspend"
    ? { tenantId: approval.targetResourceId }
    : route.id === "managed-credential.pool-source.set"
      ? { poolKey: approval.targetResourceId }
      : route.id === "provider.state.set"
        ? { providerKey: approval.targetResourceId }
        : { modelId: approval.targetResourceId };

  // §59 replay before the single-use gate (audit remediation M5 pattern): a timeout retry of an execution that
  // already ran must return its operation, not trip over the consumed approval or the (now changed) owner state.
  const prior = await deps.ledger.findApprovalExecutionReplay(params.idempotencyKey, approval.approvalId, approval.requestedAction);
  if (prior) return { operation: prior, replay: true, approval };

  // Only an approved, unconsumed approval earns an owner-state read.
  if (approval.status !== "approved") throw new ApprovalNotApprovedError(approval.approvalId, approval.status);
  if (approval.executedAt) throw new ApprovalAlreadyExecutedError(approval.approvalId);

  // Fresh owner state BEFORE the approval is consumed: a refusal here leaves it unexecuted (it expires on its own).
  await assertApprovedFactsStillHold(deps, params, route, pathParams, summary);

  const target = resolveTarget(route, pathParams, {});
  const executed = await deps.approvals.markExecuted(params.approvalId, approvalHash(approval.requestedAction, { ...target, targetTenantId: approval.targetTenantId ?? target.targetTenantId }, summary));
  if (!executed.checkerOperatorId) throw new AiOperationRefusedError("AI_APPROVAL_CHECKER_MISSING", "The approval has no recorded checker", 409);

  const result = await runAiCommand(deps, {
    ...params,
    route,
    routeId: route.id,
    pathParams,
    fields: approvedFields,
    reason: approval.reason,
    approvalEvidence: { approvalId: approval.approvalId, makerOperatorId: approval.makerOperatorId, checkerOperatorId: executed.checkerOperatorId },
    approvalLedgerEvidence: { approvalId: approval.approvalId, checkerOperatorId: executed.checkerOperatorId, decidedAt: executed.decidedAt },
    payloadExtra: { approvalId: approval.approvalId, summary },
  });
  return { ...result, approval: executed };
}
