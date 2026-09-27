import { createPublicKey, randomUUID, sign, verify } from "node:crypto";

import type { DbClient } from "../../db/dbClient.js";
import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi, isNeverDispatchedNetworkError } from "../managementApiClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { buildSafeSnapshot, redactSecretShapedFields } from "./evidence.js";
import { canonicalStringify, computeSafePayloadHash, sha256Hex } from "./canonicalHash.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";
import type { ApprovalRecord, ManagementApprovalStore } from "./managementApprovalStore.js";

// Phase 1A.14 §8 — Governance side of the global configuration restore
// framework. Sequence (master plan §44):
//
//   submit/author -> schema+version validation (owner contract) ->
//   signature+hash validation (trust ring / Governance attestation) ->
//   dry-run (owner, against live) -> impact (owner blockers) ->
//   maker-checker (R4, step-up) -> pre-apply snapshot + owner apply
//   (single transaction, owner) -> post-apply verification (owner) ->
//   effective-state observation (Governance re-reads the owner snapshot)
//
// Rollback / forward-fix are NEW packages (operator-authored, attested,
// purpose rollback|forward_fix) through the identical gate — never an undo.
// Nothing here ever builds SQL; the owner applies through its own typed
// per-class function.

export const GLOBAL_CONFIG_PACKAGE_FORMAT = "polynovea.global-config-package.v1";
export const GLOBAL_CONFIG_FLEET = "global_config_fleet";
const OWNER_EXPORT_KEY_PREFIX = "infrakinetic-global-config-export:";
const GOVERNANCE_ATTESTATION_KEY_PREFIX = "governance-management:";
const HEADER_FIELDS = ["packageFormat", "packageId", "classKey", "classSchemaVersion", "sourceEnvironment", "producedAt", "producedBy", "rowCount", "contentHash"] as const;
// Same window as the other R3/R4 approvals.
const APPROVAL_TTL_SECONDS = 24 * 60 * 60;

export type PackagePurpose = "backup" | "restore" | "rollback" | "forward_fix";

export interface GlobalConfigPackage {
  packageFormat: string;
  packageId: string;
  classKey: string;
  classSchemaVersion: string;
  sourceEnvironment: string;
  producedAt: string;
  producedBy: Record<string, unknown>;
  rowCount: number;
  contentHash: string;
  rows: Array<Record<string, unknown>>;
  signature: { alg: string; keyId: string; value: string };
}

export interface ClassContract {
  classKey: string;
  ownerEngine: string;
  applyMode: "supported" | "not_supported";
  naturalKey: string[];
  fields: string[];
  mutableFields: string[];
  classSchemaVersion: string;
  packageFormat: string;
}

export class GlobalConfigPackageRejectedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GlobalConfigPackageRejectedError";
  }
}

export class UnknownGlobalConfigPackageError extends Error {
  constructor(readonly id: string) {
    super(`Global configuration package or restore operation '${id}' not found.`);
    this.name = "UnknownGlobalConfigPackageError";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Canonical hashing / signing — byte-compatible with Infrakinetic's
// globalConfigRestore.js (canonicalStringify == its stableStringify for JSON
// data; pinned by a shared-vector test on both sides).
// ─────────────────────────────────────────────────────────────────────────

export const contentHashOf = (rows: unknown) => sha256Hex(canonicalStringify(rows));

export function packageSigningInput(pkg: Pick<GlobalConfigPackage, (typeof HEADER_FIELDS)[number]>): Buffer {
  return Buffer.from(canonicalStringify(Object.fromEntries(HEADER_FIELDS.map((f) => [f, (pkg as Record<string, unknown>)[f] ?? null]))));
}

export function snapshotHashOf(contract: Pick<ClassContract, "classKey" | "classSchemaVersion" | "naturalKey">, rows: Array<Record<string, unknown>>): string {
  const keyOf = (row: Record<string, unknown>) => JSON.stringify(contract.naturalKey.map((k) => row[k]));
  const sorted = [...rows].sort((a, b) => { const x = keyOf(a); const y = keyOf(b); return x < y ? -1 : x > y ? 1 : 0; });
  return sha256Hex(canonicalStringify({ classKey: contract.classKey, classSchemaVersion: contract.classSchemaVersion, rows: sorted }));
}

/** Versioned owner export public-key ring: GLOBAL_CONFIG_EXPORT_PUBLIC_KEYS_JSON = {"<version>": "<PEM>"}. */
export function loadOwnerExportKeyRing(raw = process.env.GLOBAL_CONFIG_EXPORT_PUBLIC_KEYS_JSON): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, (v as string).replaceAll("\\n", "\n")]));
  } catch {
    return {};
  }
}

function verifyPackageSignature(pkg: GlobalConfigPackage, ring: Record<string, string>, signingKeys: ManagementSigningKeySet): "owner-export" | "operator-authored" {
  const sig = pkg.signature;
  if (!sig || typeof sig.value !== "string" || typeof sig.keyId !== "string") throw new GlobalConfigPackageRejectedError("BAD_SIGNATURE", "Package is unsigned.");
  const input = packageSigningInput(pkg);
  const value = Buffer.from(sig.value, "base64");
  if (sig.keyId.startsWith(OWNER_EXPORT_KEY_PREFIX)) {
    const pem = ring[sig.keyId.slice(OWNER_EXPORT_KEY_PREFIX.length)];
    if (!pem) throw new GlobalConfigPackageRejectedError("UNKNOWN_SIGNING_KEY", `Signing key '${sig.keyId}' is not in the trusted owner export key ring.`);
    if (sig.alg !== "EdDSA" || !verify(null, input, pem, value)) throw new GlobalConfigPackageRejectedError("BAD_SIGNATURE", "Owner export signature does not verify.");
    if ((pkg.producedBy as { kind?: unknown })?.kind !== "owner-export") throw new GlobalConfigPackageRejectedError("BAD_SIGNATURE", "Signature key and declared provenance disagree.");
    return "owner-export";
  }
  if (sig.keyId.startsWith(GOVERNANCE_ATTESTATION_KEY_PREFIX)) {
    const kid = sig.keyId.slice(GOVERNANCE_ATTESTATION_KEY_PREFIX.length);
    const jwk = signingKeys.publicJwks.find((k) => k.kid === kid);
    if (!jwk) throw new GlobalConfigPackageRejectedError("UNKNOWN_SIGNING_KEY", `Attestation key '${kid}' is not a current Governance management key.`);
    if (sig.alg !== "RS256" || !verify("sha256", input, createPublicKey({ key: jwk as never, format: "jwk" }), value)) {
      throw new GlobalConfigPackageRejectedError("BAD_SIGNATURE", "Governance attestation does not verify.");
    }
    if ((pkg.producedBy as { kind?: unknown })?.kind !== "operator-authored") throw new GlobalConfigPackageRejectedError("BAD_SIGNATURE", "Signature key and declared provenance disagree.");
    return "operator-authored";
  }
  throw new GlobalConfigPackageRejectedError("UNKNOWN_SIGNING_KEY", `Signing key '${sig.keyId}' is not recognised.`);
}

// ─────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────

export interface StoredPackage {
  packageId: string;
  classKey: string;
  classSchemaVersion: string;
  contentHash: string;
  provenance: "owner-export" | "operator-authored";
  purpose: PackagePurpose;
  rollbackOfOperationId: string | null;
  status: string;
  rowCount: number;
  lastDryRun: Record<string, unknown> | null;
  lastDryRunAt: string | null;
  submittedBy: string;
  submittedAt: string;
  package: GlobalConfigPackage;
}

export interface RestoreOperation {
  restoreOperationId: string;
  packageId: string;
  classKey: string;
  managementOperationId: string;
  approvalId: string;
  approvedBeforeHash: string;
  approvedDiffHash: string;
  expectedAfterHash: string;
  afterSnapshotHash: string | null;
  beforeSnapshot: { rows: Array<Record<string, unknown>>; rowCount: number; contentHash: string } | null;
  status: string;
  lastObservation: Record<string, unknown> | null;
  lastObservedAt: string | null;
  createdAt: string;
}

const asJson = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string | null));

function mapPackage(row: Record<string, unknown>): StoredPackage {
  const pkg: GlobalConfigPackage = {
    packageFormat: row.package_format as string,
    packageId: row.package_id as string,
    classKey: row.class_key as string,
    classSchemaVersion: row.class_schema_version as string,
    sourceEnvironment: row.source_environment as string,
    producedAt: iso(row.produced_at) as string,
    producedBy: asJson(row.produced_by),
    rowCount: row.row_count as number,
    contentHash: row.content_hash as string,
    rows: asJson(row.rows),
    signature: { alg: row.signature_alg as string, keyId: row.signature_key_id as string, value: row.signature_value as string },
  };
  return {
    packageId: pkg.packageId, classKey: pkg.classKey, classSchemaVersion: pkg.classSchemaVersion, contentHash: pkg.contentHash,
    provenance: row.provenance as StoredPackage["provenance"], purpose: row.purpose as PackagePurpose,
    rollbackOfOperationId: (row.rollback_of_operation_id as string) ?? null, status: row.status as string, rowCount: pkg.rowCount,
    lastDryRun: row.last_dry_run ? asJson(row.last_dry_run) : null, lastDryRunAt: iso(row.last_dry_run_at),
    submittedBy: row.submitted_by as string, submittedAt: iso(row.submitted_at) as string, package: pkg,
  };
}

function mapOperation(row: Record<string, unknown>): RestoreOperation {
  return {
    restoreOperationId: row.restore_operation_id as string, packageId: row.package_id as string, classKey: row.class_key as string,
    managementOperationId: row.management_operation_id as string, approvalId: row.approval_id as string,
    approvedBeforeHash: row.approved_before_hash as string, approvedDiffHash: row.approved_diff_hash as string, expectedAfterHash: row.expected_after_hash as string,
    afterSnapshotHash: (row.after_snapshot_hash as string) ?? null,
    beforeSnapshot: row.before_snapshot ? asJson(row.before_snapshot) : null,
    status: row.status as string, lastObservation: row.last_observation ? asJson(row.last_observation) : null,
    lastObservedAt: iso(row.last_observed_at), createdAt: iso(row.created_at) as string,
  };
}

function withoutPackageBody(stored: StoredPackage): Omit<StoredPackage, "package"> {
  const meta: Partial<StoredPackage> = { ...stored };
  delete meta.package;
  return meta as Omit<StoredPackage, "package">;
}

export class GlobalConfigRestoreStore {
  constructor(private readonly db: DbClient) {}

  async insertPackage(p: { pkg: GlobalConfigPackage; provenance: string; purpose: PackagePurpose; rollbackOfOperationId?: string | null; submittedBy: string }): Promise<StoredPackage> {
    const active = await this.db.query(
      `SELECT package_id FROM governance.global_config_restore_packages WHERE class_key = $1 AND content_hash = $2 AND status IN ('validated','dry_run','approval_requested') AND purpose <> 'backup'`,
      [p.pkg.classKey, p.pkg.contentHash],
    );
    // Backups are storage and never conflict with staged intent.
    if (p.purpose !== "backup" && active.rows.length) throw new GlobalConfigPackageRejectedError("DUPLICATE_PACKAGE", `Identical ${p.pkg.classKey} content is already staged.`);
    const existing = await this.db.query(`SELECT package_id FROM governance.global_config_restore_packages WHERE package_id = $1`, [p.pkg.packageId]);
    if (existing.rows.length) throw new GlobalConfigPackageRejectedError("DUPLICATE_PACKAGE", `Package '${p.pkg.packageId}' was already submitted.`);
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO governance.global_config_restore_packages
         (package_id, class_key, class_schema_version, content_hash, package_format, source_environment, produced_at, produced_by, provenance,
          signature_alg, signature_key_id, signature_value, row_count, rows, purpose, rollback_of_operation_id, status, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,'validated',$17) RETURNING *`,
      [p.pkg.packageId, p.pkg.classKey, p.pkg.classSchemaVersion, p.pkg.contentHash, p.pkg.packageFormat, p.pkg.sourceEnvironment, p.pkg.producedAt,
        JSON.stringify(p.pkg.producedBy), p.provenance, p.pkg.signature.alg, p.pkg.signature.keyId, p.pkg.signature.value, p.pkg.rowCount,
        JSON.stringify(p.pkg.rows), p.purpose, p.rollbackOfOperationId ?? null, p.submittedBy],
    );
    return mapPackage(rows[0]);
  }

  async getPackage(packageId: string): Promise<StoredPackage> {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM governance.global_config_restore_packages WHERE package_id = $1`, [packageId]);
    if (!rows[0]) throw new UnknownGlobalConfigPackageError(packageId);
    return mapPackage(rows[0]);
  }

  async listPackages(classKey?: string): Promise<Array<Omit<StoredPackage, "package">>> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM governance.global_config_restore_packages ${classKey ? "WHERE class_key = $1" : ""} ORDER BY submitted_at DESC LIMIT 100`,
      classKey ? [classKey] : [],
    );
    return rows.map((r) => withoutPackageBody(mapPackage(r)));
  }

  async setDryRun(packageId: string, dryRun: unknown, status: string) {
    await this.db.query(
      `UPDATE governance.global_config_restore_packages SET last_dry_run = $2::jsonb, last_dry_run_at = now(), status = $3, updated_at = now() WHERE package_id = $1`,
      [packageId, JSON.stringify(dryRun), status],
    );
  }

  async setPackageStatus(packageId: string, status: string) {
    await this.db.query(`UPDATE governance.global_config_restore_packages SET status = $2, updated_at = now() WHERE package_id = $1`, [packageId, status]);
  }

  async insertOperation(o: Omit<RestoreOperation, "afterSnapshotHash" | "beforeSnapshot" | "status" | "lastObservation" | "lastObservedAt" | "createdAt">): Promise<RestoreOperation> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO governance.global_config_restore_operations
         (restore_operation_id, package_id, class_key, management_operation_id, approval_id, approved_before_hash, approved_diff_hash, expected_after_hash, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running') RETURNING *`,
      [o.restoreOperationId, o.packageId, o.classKey, o.managementOperationId, o.approvalId, o.approvedBeforeHash, o.approvedDiffHash, o.expectedAfterHash],
    );
    return mapOperation(rows[0]);
  }

  async finishOperation(id: string, status: string, afterSnapshotHash: string | null, beforeSnapshot: unknown): Promise<RestoreOperation> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE governance.global_config_restore_operations
         SET status = $2, after_snapshot_hash = $3, before_snapshot = COALESCE(before_snapshot, $4::jsonb), updated_at = now()
       WHERE restore_operation_id = $1 RETURNING *`,
      [id, status, afterSnapshotHash, beforeSnapshot === null || beforeSnapshot === undefined ? null : JSON.stringify(beforeSnapshot)],
    );
    return mapOperation(rows[0]);
  }

  async getOperation(id: string): Promise<RestoreOperation> {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM governance.global_config_restore_operations WHERE restore_operation_id = $1`, [id]);
    if (!rows[0]) throw new UnknownGlobalConfigPackageError(id);
    return mapOperation(rows[0]);
  }

  async listOperations(classKey?: string): Promise<Array<Omit<RestoreOperation, "beforeSnapshot">>> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM governance.global_config_restore_operations ${classKey ? "WHERE class_key = $1" : ""} ORDER BY created_at DESC LIMIT 100`,
      classKey ? [classKey] : [],
    );
    return rows.map((r) => { const op: Partial<RestoreOperation> = mapOperation(r); delete op.beforeSnapshot; return op as Omit<RestoreOperation, "beforeSnapshot">; });
  }

  async findOperationByManagementOperation(managementOperationId: string): Promise<RestoreOperation | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM governance.global_config_restore_operations WHERE management_operation_id = $1`, [managementOperationId]);
    return rows[0] ? mapOperation(rows[0]) : null;
  }

  async setObservation(id: string, observation: unknown): Promise<RestoreOperation> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE governance.global_config_restore_operations SET last_observation = $2::jsonb, last_observed_at = now(), updated_at = now() WHERE restore_operation_id = $1 RETURNING *`,
      [id, JSON.stringify(observation)],
    );
    return mapOperation(rows[0]);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────

export interface GlobalConfigDeps {
  store: GlobalConfigRestoreStore;
  ledger: ManagementOperationLedger;
  approvals: ManagementApprovalStore;
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  infrakineticBaseUrl: string;
  ownerExportKeyRing?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface OperatorParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

async function ownerCall(
  deps: Omit<GlobalConfigDeps, "store" | "ledger" | "approvals">,
  op: OperatorParams & { scope: "global_config.restore" | "global_config.restore.apply"; action: string; classKey?: string; method: "GET" | "POST"; path: string; body?: unknown; correlationId: string; approvalEvidence?: { approvalId: string; makerOperatorId: string; checkerOperatorId: string } },
) {
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: op.operatorId, operatorSessionId: op.operatorSessionId, operatorRoles: op.operatorRoles, operatorGrantedScopes: op.operatorGrantedScopes,
    requestedScopes: [op.scope],
    targetResourceType: op.classKey ? "global_config_class" : GLOBAL_CONFIG_FLEET,
    targetResourceId: op.classKey ?? GLOBAL_CONFIG_FLEET,
    requestedAction: op.action, correlationId: op.correlationId, approvalEvidence: op.approvalEvidence,
  });
  return callInfrakineticManagementApi({ baseUrl: deps.infrakineticBaseUrl, path: op.path, assertion, method: op.method, body: op.body, correlationId: op.correlationId, fetchImpl: deps.fetchImpl });
}

function ok<T>(result: { status: number; body: unknown }, path: string): T {
  if (result.status !== 200) {
    const code = (result.body as { error?: unknown })?.error;
    if (typeof code === "string" && result.status < 500) throw new GlobalConfigPackageRejectedError(code, (result.body as { message?: string })?.message ?? code);
    throw new UnexpectedManagementApiResponseError(result.status, path);
  }
  return result.body as T;
}

export async function listGlobalConfigClasses(deps: Omit<GlobalConfigDeps, "store" | "ledger" | "approvals">, op: OperatorParams): Promise<ClassContract[]> {
  const path = `${MANAGEMENT_V1_PREFIX}/global-config/classes`;
  return ok<{ classes: ClassContract[] }>(await ownerCall(deps, { ...op, scope: "global_config.restore", action: "global-config.contracts.read", method: "GET", path, correlationId: op.correlationId ?? randomUUID() }), path).classes;
}

async function contractFor(deps: Omit<GlobalConfigDeps, "store" | "ledger" | "approvals">, op: OperatorParams, classKey: string): Promise<ClassContract> {
  const contract = (await listGlobalConfigClasses(deps, op)).find((c) => c.classKey === classKey);
  if (!contract) throw new GlobalConfigPackageRejectedError("UNKNOWN_GLOBAL_CONFIG_CLASS", `'${classKey}' is not a published global configuration class.`);
  return contract;
}

/** Schema/version + hash + signature validation — master plan §44 steps 2 and 3. */
export async function validatePackage(deps: GlobalConfigDeps, op: OperatorParams, pkg: GlobalConfigPackage): Promise<{ provenance: "owner-export" | "operator-authored"; contract: ClassContract }> {
  if (!pkg || typeof pkg !== "object" || pkg.packageFormat !== GLOBAL_CONFIG_PACKAGE_FORMAT) throw new GlobalConfigPackageRejectedError("UNSUPPORTED_PACKAGE_FORMAT", "Unsupported package format.");
  if (typeof pkg.packageId !== "string" || !/^[0-9a-f-]{36}$/i.test(pkg.packageId)) throw new GlobalConfigPackageRejectedError("PACKAGE_ID_INVALID", "packageId must be a UUID.");
  const contract = await contractFor(deps, op, pkg.classKey);
  if (pkg.classSchemaVersion !== contract.classSchemaVersion) throw new GlobalConfigPackageRejectedError("INCOMPATIBLE_PACKAGE_VERSION", "Package was produced against a different class contract version.");
  if (!Array.isArray(pkg.rows) || pkg.rowCount !== pkg.rows.length) throw new GlobalConfigPackageRejectedError("PACKAGE_ROWS_INVALID", "rows must be an array matching rowCount.");
  const allowed = new Set(contract.fields);
  for (const row of pkg.rows) {
    if (!row || typeof row !== "object" || Object.keys(row).some((f) => !allowed.has(f))) throw new GlobalConfigPackageRejectedError("PACKAGE_UNKNOWN_FIELD", "A row carries fields outside the class contract.");
  }
  if (contentHashOf(pkg.rows) !== pkg.contentHash) throw new GlobalConfigPackageRejectedError("PACKAGE_HASH_MISMATCH", "Package content does not match its contentHash.");
  const provenance = verifyPackageSignature(pkg, deps.ownerExportKeyRing ?? loadOwnerExportKeyRing(), deps.signingKeys);
  return { provenance, contract };
}

export async function submitPackage(deps: GlobalConfigDeps, op: OperatorParams & { pkg: GlobalConfigPackage; purpose?: PackagePurpose }): Promise<StoredPackage> {
  const { provenance } = await validatePackage(deps, op, op.pkg);
  return deps.store.insertPackage({ pkg: op.pkg, provenance, purpose: op.purpose ?? "restore", submittedBy: op.operatorId });
}

/** Captures the owner's signed live snapshot as a backup package (master plan §68 configuration export). */
export async function captureSnapshot(deps: GlobalConfigDeps, op: OperatorParams & { classKey: string }): Promise<StoredPackage> {
  const path = `${MANAGEMENT_V1_PREFIX}/global-config/${encodeURIComponent(op.classKey)}/snapshot`;
  const body = ok<{ package: GlobalConfigPackage }>(await ownerCall(deps, { ...op, scope: "global_config.restore", action: "global-config.snapshot", classKey: op.classKey, method: "GET", path, correlationId: op.correlationId ?? randomUUID() }), path);
  return submitPackage(deps, { ...op, pkg: body.package, purpose: "backup" });
}

/** Operator-authored package, attested by Governance's management key with the maker bound into the signed header. */
export async function authorPackage(
  deps: GlobalConfigDeps,
  op: OperatorParams & { classKey: string; rows: Array<Record<string, unknown>>; purpose: Exclude<PackagePurpose, "backup">; rollbackOfOperationId?: string },
): Promise<StoredPackage> {
  const contract = await contractFor(deps, op, op.classKey);
  const pkg: GlobalConfigPackage = {
    packageFormat: GLOBAL_CONFIG_PACKAGE_FORMAT,
    packageId: randomUUID(),
    classKey: op.classKey,
    classSchemaVersion: contract.classSchemaVersion,
    sourceEnvironment: "governance",
    producedAt: new Date().toISOString(),
    producedBy: { kind: "operator-authored", makerOperatorId: op.operatorId, purpose: op.purpose, ...(op.rollbackOfOperationId ? { rollbackOfOperationId: op.rollbackOfOperationId } : {}) },
    rowCount: op.rows.length,
    contentHash: contentHashOf(op.rows),
    rows: op.rows,
    signature: { alg: "RS256", keyId: `${GOVERNANCE_ATTESTATION_KEY_PREFIX}${deps.signingKeys.activeKid}`, value: "" },
  };
  pkg.signature.value = sign("sha256", packageSigningInput(pkg), deps.signingKeys.activePrivateKey).toString("base64");
  await validatePackage(deps, op, pkg);
  return deps.store.insertPackage({ pkg, provenance: "operator-authored", purpose: op.purpose, rollbackOfOperationId: op.rollbackOfOperationId ?? null, submittedBy: op.operatorId });
}

export interface DryRunResult {
  classKey: string;
  applyMode: string;
  beforeSnapshotHash: string;
  expectedAfterSnapshotHash: string;
  diff: { insert: Array<Record<string, unknown>>; update: Array<{ key: Record<string, unknown>; changedFields: string[]; before: Record<string, unknown>; after: Record<string, unknown> }>; unchangedCount: number; untouched: Array<Record<string, unknown>> };
  diffHash: string;
  changeCount: number;
  blockers: Array<Record<string, unknown>>;
  applicable: boolean;
}

async function ownerDryRun(deps: GlobalConfigDeps, op: OperatorParams, stored: StoredPackage): Promise<DryRunResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/global-config/${encodeURIComponent(stored.classKey)}/dry-run`;
  return ok<{ dryRun: DryRunResult }>(await ownerCall(deps, { ...op, scope: "global_config.restore", action: "global-config.restore.dry-run", classKey: stored.classKey, method: "POST", path, body: { package: stored.package }, correlationId: op.correlationId ?? randomUUID() }), path).dryRun;
}

export async function dryRunPackage(deps: GlobalConfigDeps, op: OperatorParams & { packageId: string }): Promise<{ package: Omit<StoredPackage, "package">; dryRun: DryRunResult }> {
  const stored = await deps.store.getPackage(op.packageId);
  if (!["validated", "dry_run"].includes(stored.status)) throw new GlobalConfigPackageRejectedError("PACKAGE_NOT_STAGED", `Package is '${stored.status}'.`);
  const dryRun = await ownerDryRun(deps, op, stored);
  await deps.store.setDryRun(stored.packageId, dryRun, "dry_run");
  return { package: withoutPackageBody(await deps.store.getPackage(stored.packageId)), dryRun };
}

function approvalHash(packageId: string, summary: Record<string, unknown>) {
  return computeSafePayloadHash({ requestedAction: "global-config.restore.apply", targetResourceType: "global_config_restore_package", targetResourceId: packageId, payload: summary });
}

/** Maker step (R4): re-runs the dry-run NOW and binds its hashes and safe diff into the approval. */
export async function requestRestoreApply(deps: GlobalConfigDeps, op: OperatorParams & { packageId: string; reason: string }): Promise<ApprovalRecord> {
  const stored = await deps.store.getPackage(op.packageId);
  if (!["validated", "dry_run"].includes(stored.status)) throw new GlobalConfigPackageRejectedError("PACKAGE_NOT_STAGED", `Package is '${stored.status}'.`);
  const dryRun = await ownerDryRun(deps, op, stored);
  await deps.store.setDryRun(stored.packageId, dryRun, "dry_run");
  if (!dryRun.applicable) throw new GlobalConfigPackageRejectedError(dryRun.blockers[0]?.code ? String(dryRun.blockers[0].code) : "NOTHING_TO_APPLY", "Dry-run is not applicable; resolve blockers first.");

  // Checker-visible safe diff: identity + exactly what changes.
  const summary: Record<string, unknown> = {
    classKey: stored.classKey,
    packageId: stored.packageId,
    contentHash: stored.contentHash,
    purpose: stored.purpose,
    provenance: stored.provenance,
    rollbackOfOperationId: stored.rollbackOfOperationId,
    beforeSnapshotHash: dryRun.beforeSnapshotHash,
    expectedAfterSnapshotHash: dryRun.expectedAfterSnapshotHash,
    diffHash: dryRun.diffHash,
    changeCount: dryRun.changeCount,
    inserts: dryRun.diff.insert,
    updates: dryRun.diff.update.map((u) => ({ key: u.key, changes: Object.fromEntries(u.changedFields.map((f) => [f, { before: u.before[f], after: u.after[f] }])) })),
    untouchedCount: dryRun.diff.untouched.length,
  };
  const approval = await deps.approvals.createApproval({
    approvalId: randomUUID(),
    requestedAction: "global-config.restore.apply",
    targetResourceType: "global_config_restore_package",
    targetResourceId: stored.packageId,
    safePayloadHash: approvalHash(stored.packageId, summary),
    safeRequestSummary: summary,
    riskClass: "R4",
    reason: op.reason,
    makerOperatorId: op.operatorId,
    correlationId: op.correlationId ?? randomUUID(),
    ttlSeconds: APPROVAL_TTL_SECONDS,
  });
  await deps.store.setPackageStatus(stored.packageId, "approval_requested");
  return approval;
}

export const isGlobalConfigRestoreApproval = (approval: { requestedAction: string }) => approval.requestedAction === "global-config.restore.apply";

export async function executeRestoreApply(
  deps: GlobalConfigDeps,
  params: OperatorParams & { approvalId: string; idempotencyKey: string },
): Promise<{ operation: ManagementOperationRecord; restoreOperation: RestoreOperation | null; approval: ApprovalRecord; replay: boolean }> {
  const approval = await deps.approvals.getApproval(params.approvalId);
  if (!isGlobalConfigRestoreApproval(approval) || !approval.safeRequestSummary) throw new GlobalConfigPackageRejectedError("NOT_A_RESTORE_APPROVAL", "Approval is not a global configuration restore.");
  const summary = approval.safeRequestSummary as Record<string, string | number>;

  const prior = await deps.ledger.findApprovalExecutionReplay(params.idempotencyKey, approval.approvalId, approval.requestedAction);
  if (prior) return { operation: prior, replay: true, approval, restoreOperation: await deps.store.findOperationByManagementOperation(prior.operationId) };

  const executed = await deps.approvals.markExecuted(params.approvalId, approvalHash(approval.targetResourceId, approval.safeRequestSummary));
  const stored = await deps.store.getPackage(approval.targetResourceId);
  if (stored.contentHash !== summary.contentHash) throw new GlobalConfigPackageRejectedError("APPROVED_PACKAGE_CHANGED", "Stored package no longer matches the approved content.");
  const classKey = stored.classKey;
  const correlationId = params.correlationId ?? randomUUID();

  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: "global-config.restore.apply",
    targetResourceType: "global_config_class",
    targetResourceId: classKey,
    reason: approval.reason,
    riskClass: "R4",
    payload: { packageId: stored.packageId, contentHash: stored.contentHash, approvalId: approval.approvalId, beforeSnapshotHash: summary.beforeSnapshotHash, diffHash: summary.diffHash },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
    approvalEvidence: { approvalId: approval.approvalId, checkerOperatorId: executed.checkerOperatorId, decidedAt: executed.decidedAt },
  });
  if (replay) return { operation: submitted, replay: true, approval: executed, restoreOperation: await deps.store.findOperationByManagementOperation(submitted.operationId) };

  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });
  const restoreOperation = await deps.store.insertOperation({
    restoreOperationId: randomUUID(), packageId: stored.packageId, classKey, managementOperationId: submitted.operationId, approvalId: approval.approvalId,
    approvedBeforeHash: String(summary.beforeSnapshotHash), approvedDiffHash: String(summary.diffHash), expectedAfterHash: String(summary.expectedAfterSnapshotHash),
  });

  const path = `${MANAGEMENT_V1_PREFIX}/global-config/${encodeURIComponent(classKey)}/apply`;
  let result;
  try {
    result = await ownerCall(deps, {
      ...params, scope: "global_config.restore.apply", action: "global-config.restore.apply", classKey, method: "POST", path, correlationId,
      body: { package: stored.package, approvedBeforeSnapshotHash: summary.beforeSnapshotHash, approvedDiffHash: summary.diffHash, idempotencyKey: params.idempotencyKey, commandId: randomUUID() },
      approvalEvidence: { approvalId: approval.approvalId, makerOperatorId: approval.makerOperatorId, checkerOperatorId: executed.checkerOperatorId! },
    });
  } catch (err) {
    const neverSent = isNeverDispatchedNetworkError(err);
    const operation = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: neverSent ? "failed" : "partially_completed",
      partialFailureState: { stage: neverSent ? "mutation-call-never-dispatched" : "mutation-call", message: err instanceof Error ? err.message : String(err) },
    });
    const ro = await deps.store.finishOperation(restoreOperation.restoreOperationId, neverSent ? "failed" : "partially_completed", null, null);
    return { operation, restoreOperation: ro, approval: executed, replay: false };
  }

  if (result.status !== 200) {
    const operation = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "failed",
      partialFailureState: { stage: "mutation-response", status: result.status, body: redactSecretShapedFields(result.body) },
    });
    const ro = await deps.store.finishOperation(restoreOperation.restoreOperationId, "failed", null, null);
    await deps.store.setPackageStatus(stored.packageId, "dry_run");
    return { operation, restoreOperation: ro, approval: executed, replay: false };
  }

  const body = result.body as { afterSnapshotHash: string; beforeSnapshot: unknown; beforeSnapshotHash: string };
  const { beforeSnapshot, ...safeBody } = body;
  const verified = body.afterSnapshotHash === summary.expectedAfterSnapshotHash && body.beforeSnapshotHash === summary.beforeSnapshotHash;
  const operation = await deps.ledger.transitionOperation(submitted.operationId, verified
    ? { toStatus: "completed", afterStateSafeSnapshot: buildSafeSnapshot(safeBody), result: safeBody }
    : { toStatus: "partially_completed", result: safeBody, partialFailureState: { stage: "governance-verification", message: "Owner-reported hashes differ from the approved expectation." } });
  const ro = await deps.store.finishOperation(restoreOperation.restoreOperationId, verified ? "completed" : "partially_completed", body.afterSnapshotHash, beforeSnapshot);
  await deps.store.setPackageStatus(stored.packageId, "applied");
  return { operation, restoreOperation: ro, approval: executed, replay: false };
}

/** Rollback = a new operator-authored package from the stored before-snapshot, through the same gate. */
export async function createRollbackPackage(deps: GlobalConfigDeps, op: OperatorParams & { restoreOperationId: string }): Promise<StoredPackage> {
  const operation = await deps.store.getOperation(op.restoreOperationId);
  if (operation.status !== "completed" || !operation.beforeSnapshot) throw new GlobalConfigPackageRejectedError("NO_ROLLBACK_SOURCE", "Only a completed restore with a before-snapshot can be rolled back.");
  return authorPackage(deps, { ...op, classKey: operation.classKey, rows: operation.beforeSnapshot.rows, purpose: "rollback", rollbackOfOperationId: operation.restoreOperationId });
}

/**
 * Effective-state observation: re-reads the owner snapshot and compares it
 * with what the operation left behind. Drift is surfaced, never repaired
 * here (master plan §68 — operator decides governed repair).
 */
export async function observeRestoreOperation(deps: GlobalConfigDeps, op: OperatorParams & { restoreOperationId: string }): Promise<RestoreOperation> {
  const operation = await deps.store.getOperation(op.restoreOperationId);
  const contract = await contractFor(deps, op, operation.classKey);
  const path = `${MANAGEMENT_V1_PREFIX}/global-config/${encodeURIComponent(operation.classKey)}/snapshot`;
  const live = ok<{ package: GlobalConfigPackage }>(await ownerCall(deps, { ...op, scope: "global_config.restore", action: "global-config.snapshot", classKey: operation.classKey, method: "GET", path, correlationId: op.correlationId ?? randomUUID() }), path).package;
  const observedHash = snapshotHashOf(contract, live.rows);
  const observation = {
    observedAt: new Date().toISOString(),
    source: "infrakinetic-owner-snapshot",
    freshness: "live",
    observedSnapshotHash: observedHash,
    expectedSnapshotHash: operation.afterSnapshotHash,
    status: operation.afterSnapshotHash === null ? "unknown" : observedHash === operation.afterSnapshotHash ? "matches" : "drift",
  };
  return deps.store.setObservation(operation.restoreOperationId, observation);
}
