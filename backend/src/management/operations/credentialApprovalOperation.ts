import { randomUUID, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi, isNeverDispatchedNetworkError } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { computeSafePayloadHash } from "./canonicalHash.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { MANAGEMENT_V1_PREFIX } from "./engineStateOperation.js";
import { ManagementApprovalStore, type ApprovalRecord, type ApprovalDecision } from "./managementApprovalStore.js";
import type { Scope } from "../../identity/roles.js";

// 1A.13 — R3 credential actions (rotate, revoke). Mirrors
// identityApprovalOperation.ts's three-phase flow: request (maker) -> decide
// (checker, != maker) -> execute (fresh step-up, approval consumed exactly
// once). Step-up freshness is enforced by requireStepUp at the route layer
// (routes/management/index.ts), not here — this module only owns the
// approval/ledger mechanics, reusing ManagementApprovalStore (1A.12.5's
// reusable maker-checker substrate) rather than a second approval mechanism.
//
// Audit remediation H1 (2026-09-25) — master plan §58 "checker reviews safe
// diff". Originally the rotate approval bound only {action, tenant,
// credential}; secret kind, overlap window, webhook endpoint AND the new
// material were all supplied by whoever executed — including the checker —
// so maker-checker authorised "a rotation happens", never "these keys". An
// executor could install an api_key_pair for a merchant account they
// control. Rotate now works like this:
//
//   request  — the maker submits kind, overlap, endpoint AND the material.
//              Governance keeps no plaintext (never at rest, not even across
//              the 24h approval window): it folds a salted, deliberately slow
//              scrypt digest of the material into the approval's safe
//              payload hash, and stores a checker-visible safe diff
//              (safe_request_summary, migration 0013): kind, overlap,
//              endpoint, a masked hint of the provider key id (a public
//              identifier, not the secret half) and a short fingerprint.
//   decide   — the checker sees that safe diff, so an approval now means
//              "rotate to THIS key id / fingerprint".
//   execute  — kind/overlap/endpoint come from the approved summary, never
//              the executor; the executor must resubmit material whose
//              digest reproduces the approved hash, or markExecuted fails
//              with APPROVAL_PAYLOAD_MISMATCH before anything is sent.
//
// This also retires the 1A.13 "kind chosen at execute time" accepted debt.
// Revoke has no parameters beyond the target and is unchanged.

export const CREDENTIAL_R3_ACTIONS = {
  rotate: { action: "credential.rotate", scope: "credentials.rotate" as Scope, segment: "rotate" },
  revoke: { action: "credential.revoke", scope: "credentials.revoke" as Scope, segment: "revoke" },
} as const;

export type CredentialR3ActionKey = keyof typeof CREDENTIAL_R3_ACTIONS;
export type RotateSecretKind = "webhook_secret" | "api_key_pair";

// Same 24h window as identity's R3 actions — see identityApprovalOperation.ts's
// header for the rationale; revisit under 1A.19 if a different policy value
// is warranted platform-wide.
const APPROVAL_TTL_SECONDS = 24 * 60 * 60;

// Mirrors Infrakinetic's own clamp (credentialAdministration.js) so the
// approved value is exactly the value that will be applied.
const MIN_OVERLAP_HOURS = 1;
const MAX_OVERLAP_HOURS = 72;
const DEFAULT_OVERLAP_HOURS = 24;

const scrypt = promisify(scryptCallback) as (password: string, salt: string, keylen: number, options: { N: number; r: number; p: number }) => Promise<Buffer>;
// ~16 MiB / tens of ms per digest: negligible for one request, expensive
// for anyone brute-forcing a low-entropy webhook secret from a DB read.
const MATERIAL_DIGEST_PARAMS = { N: 16384, r: 8, p: 1 } as const;

export class UnknownCredentialR3ActionError extends Error {
  constructor(readonly requestedAction: string) {
    super(`'${requestedAction}' is not a known R3 credential action.`);
    this.name = "UnknownCredentialR3ActionError";
  }
}

export class MissingCredentialApprovalTargetError extends Error {
  constructor(field: string) {
    super(`A credential R3 approval requires a real ${field}.`);
    this.name = "MissingCredentialApprovalTargetError";
  }
}

export interface RotateMaterial {
  secretValue?: string;
  apiKeyId?: string;
  apiKeySecret?: string;
}

interface ApprovedRotateParameters {
  secretKind: RotateSecretKind;
  overlapHours: number | null;
  webhookEndpointId: string | null;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function assertRotateMaterial(secretKind: RotateSecretKind, material: RotateMaterial): void {
  if (secretKind === "webhook_secret" && !nonEmpty(material.secretValue)) {
    throw new MissingCredentialApprovalTargetError("secretValue");
  }
  if (secretKind === "api_key_pair" && (!nonEmpty(material.apiKeyId) || !nonEmpty(material.apiKeySecret))) {
    throw new MissingCredentialApprovalTargetError("apiKeyId/apiKeySecret");
  }
}

function normalizeRotateParameters(input: {
  secretKind?: string;
  overlapHours?: number;
  webhookEndpointId?: string;
}): ApprovedRotateParameters {
  if (input.secretKind !== "webhook_secret" && input.secretKind !== "api_key_pair") {
    throw new MissingCredentialApprovalTargetError("secretKind");
  }
  let overlapHours: number | null = null;
  if (input.secretKind === "webhook_secret") {
    const raw = input.overlapHours ?? DEFAULT_OVERLAP_HOURS;
    if (!Number.isFinite(raw)) throw new MissingCredentialApprovalTargetError("overlapHours");
    overlapHours = Math.min(MAX_OVERLAP_HOURS, Math.max(MIN_OVERLAP_HOURS, Math.trunc(raw)));
  }
  return {
    secretKind: input.secretKind,
    overlapHours,
    webhookEndpointId: input.secretKind === "webhook_secret" && nonEmpty(input.webhookEndpointId) ? input.webhookEndpointId : null,
  };
}

// Salted per approval so identical material under two approvals never
// yields the same digest.
async function computeRotateMaterialDigest(approvalId: string, secretKind: RotateSecretKind, material: RotateMaterial): Promise<string> {
  const canonical = secretKind === "api_key_pair"
    ? JSON.stringify(["api_key_pair", material.apiKeyId, material.apiKeySecret])
    : JSON.stringify(["webhook_secret", material.secretValue]);
  const digest = await scrypt(canonical, `polynovea-governance:credential-rotate-approval:${approvalId}`, 32, MATERIAL_DIGEST_PARAMS);
  return digest.toString("hex");
}

// The provider key id (e.g. Razorpay's rzp_live_…) is a public identifier —
// it ships in client-side checkout — not the secret half. A masked form is
// what lets the checker confirm the keys belong to the merchant's account.
export function maskKeyId(apiKeyId: string): string {
  const trimmed = apiKeyId.trim();
  if (trimmed.length >= 12) return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
  return `…${trimmed.slice(-2)}`;
}

function computeCredentialApprovalHash(
  requestedAction: string,
  tenantId: string,
  credentialId: string,
  rotate?: ApprovedRotateParameters & { materialDigest: string },
): string {
  return computeSafePayloadHash({
    requestedAction,
    targetTenantId: tenantId,
    targetResourceType: "credential",
    targetResourceId: credentialId,
    // Revoke keeps its original, byte-identical payload shape.
    payload: rotate ? { tenantId, credentialId, ...rotate } : { tenantId, credentialId },
  });
}

export interface CredentialApprovalOperationDeps {
  approvals: ManagementApprovalStore;
  ledger: ManagementOperationLedger;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface RequestCredentialR3ApprovalParams extends RotateMaterial {
  actionKey: CredentialR3ActionKey;
  tenantId: string;
  credentialId: string;
  reason: string;
  makerOperatorId: string;
  correlationId?: string;
  /** Rotate only — bound into the approval; the executor cannot change them. */
  secretKind?: RotateSecretKind;
  overlapHours?: number;
  webhookEndpointId?: string;
}

// Only the approval store is needed to request/decide — no assertion is
// minted and no Infrakinetic call happens until execute(). Same narrower
// Pick as identityApprovalOperation.ts, same reasoning.
export async function requestCredentialR3Approval(
  deps: Pick<CredentialApprovalOperationDeps, "approvals">,
  params: RequestCredentialR3ApprovalParams,
): Promise<ApprovalRecord> {
  if (!nonEmpty(params.tenantId)) throw new MissingCredentialApprovalTargetError("tenantId");
  if (!nonEmpty(params.credentialId)) throw new MissingCredentialApprovalTargetError("credentialId");
  const entry = CREDENTIAL_R3_ACTIONS[params.actionKey];
  if (!entry) throw new UnknownCredentialR3ActionError(params.actionKey);

  const approvalId = randomUUID();
  let safePayloadHash: string;
  let safeRequestSummary: Record<string, unknown> | undefined;
  if (entry.action === CREDENTIAL_R3_ACTIONS.rotate.action) {
    const approved = normalizeRotateParameters(params);
    assertRotateMaterial(approved.secretKind, params);
    const materialDigest = await computeRotateMaterialDigest(approvalId, approved.secretKind, params);
    safePayloadHash = computeCredentialApprovalHash(entry.action, params.tenantId, params.credentialId, { ...approved, materialDigest });
    safeRequestSummary = {
      ...approved,
      apiKeyIdHint: approved.secretKind === "api_key_pair" ? maskKeyId(params.apiKeyId!) : null,
      materialFingerprint: materialDigest.slice(0, 12),
    };
  } else {
    safePayloadHash = computeCredentialApprovalHash(entry.action, params.tenantId, params.credentialId);
  }

  return deps.approvals.createApproval({
    approvalId,
    requestedAction: entry.action,
    targetTenantId: params.tenantId,
    targetResourceType: "credential",
    targetResourceId: params.credentialId,
    safePayloadHash,
    safeRequestSummary,
    riskClass: "R3",
    reason: params.reason,
    makerOperatorId: params.makerOperatorId,
    correlationId: params.correlationId ?? randomUUID(),
    ttlSeconds: APPROVAL_TTL_SECONDS,
  });
}

export interface DecideCredentialR3ApprovalParams {
  approvalId: string;
  checkerOperatorId: string;
  decision: ApprovalDecision;
}

export function decideCredentialR3Approval(
  deps: Pick<CredentialApprovalOperationDeps, "approvals">,
  params: DecideCredentialR3ApprovalParams,
): Promise<ApprovalRecord> {
  // Thin pass-through today, same as identityApprovalOperation.ts's own
  // decide() — kept as its own operation-layer function so a future
  // audit/notification hook has one place to add it.
  return deps.approvals.decideApproval(params);
}

export interface ExecuteCredentialR3ApprovalParams extends RotateMaterial {
  approvalId: string;
  idempotencyKey: string;
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
  causationId?: string;
}

export interface ExecuteCredentialR3ApprovalResult {
  operation: ManagementOperationRecord;
  approval: ApprovalRecord;
  replay: boolean;
}

function approvedRotateParameters(approval: ApprovalRecord): ApprovedRotateParameters {
  const summary = approval.safeRequestSummary;
  // A rotate approval created before migration 0013 bound no parameters at
  // all — fail closed; the operator must raise a fresh request.
  if (!summary) throw new MissingCredentialApprovalTargetError("approved rotate parameters (re-request this rotation)");
  return normalizeRotateParameters({
    secretKind: typeof summary.secretKind === "string" ? summary.secretKind : undefined,
    overlapHours: typeof summary.overlapHours === "number" ? summary.overlapHours : undefined,
    webhookEndpointId: typeof summary.webhookEndpointId === "string" ? summary.webhookEndpointId : undefined,
  });
}

export async function executeCredentialR3Approval(
  deps: CredentialApprovalOperationDeps,
  params: ExecuteCredentialR3ApprovalParams,
): Promise<ExecuteCredentialR3ApprovalResult> {
  const approval = await deps.approvals.getApproval(params.approvalId);
  const entry = Object.values(CREDENTIAL_R3_ACTIONS).find((e) => e.action === approval.requestedAction);
  if (!entry) throw new UnknownCredentialR3ActionError(approval.requestedAction);
  if (!approval.targetTenantId) throw new MissingCredentialApprovalTargetError("tenantId");
  const isRotate = approval.requestedAction === CREDENTIAL_R3_ACTIONS.rotate.action;

  // §59 replay BEFORE the single-use gate (audit remediation M5): a retry
  // of an execution that already produced an operation returns it.
  const prior = await deps.ledger.findApprovalExecutionReplay(params.idempotencyKey, approval.approvalId, approval.requestedAction);
  if (prior) return { operation: prior, replay: true, approval };

  let rotate: ApprovedRotateParameters | undefined;
  let expectedHash: string;
  if (isRotate) {
    rotate = approvedRotateParameters(approval);
    assertRotateMaterial(rotate.secretKind, params);
    const materialDigest = await computeRotateMaterialDigest(approval.approvalId, rotate.secretKind, params);
    expectedHash = computeCredentialApprovalHash(approval.requestedAction, approval.targetTenantId, approval.targetResourceId, { ...rotate, materialDigest });
  } else {
    expectedHash = computeCredentialApprovalHash(approval.requestedAction, approval.targetTenantId, approval.targetResourceId);
  }

  // Single-use gate — whatever happens to the mutation call below, this
  // approval can never authorize a second attempt. A material mismatch
  // fails here (APPROVAL_PAYLOAD_MISMATCH) without consuming the approval.
  const executedApproval = await deps.approvals.markExecuted(params.approvalId, expectedHash);

  const correlationId = params.correlationId ?? randomUUID();
  const tenantId = approval.targetTenantId;
  const credentialId = approval.targetResourceId;

  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: approval.requestedAction,
    targetTenantId: tenantId,
    targetResourceType: "credential",
    targetResourceId: credentialId,
    reason: approval.reason,
    riskClass: "R3",
    // Material deliberately excluded, same reasoning as
    // credentialOperation.ts's requestCredentialReplace. secretKind is a
    // label, not material — safe to record.
    payload: {
      tenantId,
      credentialId,
      secretKind: rotate?.secretKind ?? null,
      approvalId: approval.approvalId,
    },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    causationId: params.causationId,
    approvalEvidence: { approvalId: approval.approvalId, checkerOperatorId: approval.checkerOperatorId, decidedAt: approval.decidedAt },
  });
  if (replay) return { operation: submitted, replay: true, approval: executedApproval };

  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });

  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: [entry.scope],
    targetTenantId: tenantId,
    targetResourceType: "credential",
    targetResourceId: credentialId,
    requestedAction: approval.requestedAction,
    correlationId,
  });

  const commandId = randomUUID();
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/${entry.segment}`;
  const body: Record<string, unknown> = { reason: approval.reason, idempotencyKey: params.idempotencyKey, commandId };
  if (rotate) {
    body.secretKind = rotate.secretKind;
    if (rotate.secretKind === "api_key_pair") {
      body.apiKeyId = params.apiKeyId;
      body.apiKeySecret = params.apiKeySecret;
    } else {
      body.secretValue = params.secretValue;
      if (rotate.overlapHours !== null) body.overlapHours = rotate.overlapHours;
      if (rotate.webhookEndpointId !== null) body.webhookEndpointId = rotate.webhookEndpointId;
    }
  }

  let result;
  try {
    result = await callInfrakineticManagementApi({
      baseUrl: deps.infrakineticBaseUrl,
      path,
      assertion,
      method: "POST",
      body,
      correlationId,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    if (isNeverDispatchedNetworkError(err)) {
      const failed = await deps.ledger.transitionOperation(submitted.operationId, {
        toStatus: "failed",
        partialFailureState: { stage: "mutation-call-never-dispatched", message: err instanceof Error ? err.message : String(err) },
      });
      return { operation: failed, replay: false, approval: executedApproval };
    }
    const partial = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "partially_completed",
      partialFailureState: { stage: "mutation-call", message: err instanceof Error ? err.message : String(err) },
    });
    return { operation: partial, replay: false, approval: executedApproval };
  }

  if (result.status !== 200) {
    const failed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: { stage: "mutation-response", status: result.status, body: redactSecretShapedFields(result.body) },
    });
    return { operation: failed, replay: false, approval: executedApproval };
  }

  const completed = await deps.ledger.transitionOperation(submitted.operationId, {
    toStatus: "completed",
    afterStateSafeSnapshot: buildSafeSnapshot(result.body),
    result: result.body,
  });
  return { operation: completed, replay: false, approval: executedApproval };
}
