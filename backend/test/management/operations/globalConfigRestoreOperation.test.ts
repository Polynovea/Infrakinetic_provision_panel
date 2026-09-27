import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeJwt, exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { ManagementApprovalStore, SelfApprovalNotAllowedError, ApprovalAlreadyExecutedError } from "../../../src/management/operations/managementApprovalStore.js";
import {
  GlobalConfigRestoreStore,
  GLOBAL_CONFIG_PACKAGE_FORMAT,
  authorPackage,
  captureSnapshot,
  contentHashOf,
  createRollbackPackage,
  dryRunPackage,
  executeRestoreApply,
  observeRestoreOperation,
  packageSigningInput,
  requestRestoreApply,
  snapshotHashOf,
  submitPackage,
  type GlobalConfigPackage,
} from "../../../src/management/operations/globalConfigRestoreOperation.js";
import type { DbClient } from "../../../src/db/dbClient.js";

// Phase 1A.14 §8 — Governance side of global configuration restore, per
// master plan §65: bad signature, incompatible version, dry-run, duplicate
// package, approved apply, post-apply verification, rollback/forward-fix —
// plus maker-checker, single-use approval, signed checker evidence and
// effective-state observation (match and drift). The owner here is a fake
// that follows the owner contract's hashing rules exactly (pinned against
// the real Infrakinetic code by globalConfigHashParity.test.ts).

const MAKER = "11111111-1111-4111-8111-111111111111";
const CHECKER = "22222222-2222-4222-8222-222222222222";
const EXECUTOR = "33333333-3333-4333-8333-333333333333";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCOPES = ["global_config.restore", "global_config.restore.apply"];
const op = (operatorId: string) => ({ operatorId, operatorSessionId: SESSION, operatorRoles: ["platform_admin"], operatorGrantedScopes: SCOPES });

const CONTRACT = {
  classKey: "payment_provider_catalog", ownerEngine: "payments", applyMode: "supported" as const,
  naturalKey: ["provider_key", "adapter_version"], fields: ["provider_key", "adapter_version", "display_name", "capabilities", "configuration_schema", "status", "manifest_hash"],
  mutableFields: ["display_name", "capabilities", "configuration_schema", "status"], classSchemaVersion: "d".repeat(64), packageFormat: GLOBAL_CONFIG_PACKAGE_FORMAT,
};
const EVENT_CONTRACT = { ...CONTRACT, classKey: "event_catalog", applyMode: "not_supported" as const, naturalKey: ["event_type"], fields: ["event_type", "description"], mutableFields: [], classSchemaVersion: "e".repeat(64) };

const ownerKeys = generateKeyPairSync("ed25519");
const RING = { v1: ownerKeys.publicKey.export({ type: "spki", format: "pem" }) as string };
const keyOf = (row: Record<string, unknown>) => JSON.stringify(CONTRACT.naturalKey.map((k) => row[k]));

function fakeOwner() {
  let live: Array<Record<string, unknown>> = [
    { provider_key: "razorpay", adapter_version: "1.0.0", display_name: "Razorpay", capabilities: { refunds: true }, configuration_schema: {}, status: "certified", manifest_hash: "a".repeat(64) },
    { provider_key: "stripe", adapter_version: "1.0.0", display_name: "Stripe", capabilities: {}, configuration_schema: {}, status: "certified", manifest_hash: "b".repeat(64) },
  ];
  const applyClaims: Array<Record<string, unknown>> = [];
  function exportPkg(): GlobalConfigPackage {
    const rows = structuredClone(live);
    const pkg: GlobalConfigPackage = {
      packageFormat: GLOBAL_CONFIG_PACKAGE_FORMAT, packageId: crypto.randomUUID(), classKey: CONTRACT.classKey, classSchemaVersion: CONTRACT.classSchemaVersion,
      sourceEnvironment: "synthetic", producedAt: new Date().toISOString(), producedBy: { kind: "owner-export", ownerEngine: "payments" },
      rowCount: rows.length, contentHash: contentHashOf(rows), rows, signature: { alg: "EdDSA", keyId: "infrakinetic-global-config-export:v1", value: "" },
    };
    pkg.signature.value = sign(null, packageSigningInput(pkg), ownerKeys.privateKey).toString("base64");
    return pkg;
  }
  function dry(pkg: GlobalConfigPackage) {
    const byKey = new Map(live.map((r) => [keyOf(r), r]));
    const insert: unknown[] = []; const update: Array<Record<string, unknown>> = [];
    for (const row of pkg.rows) {
      const before = byKey.get(keyOf(row));
      if (!before) { insert.push(row); continue; }
      const changedFields = CONTRACT.fields.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(row[f]));
      if (changedFields.length) update.push({ key: { provider_key: row.provider_key, adapter_version: row.adapter_version }, changedFields, before, after: row });
    }
    const expected = new Map(byKey); for (const row of pkg.rows) expected.set(keyOf(row), row);
    return {
      classKey: CONTRACT.classKey, applyMode: "supported", beforeSnapshotHash: snapshotHashOf(CONTRACT, live), expectedAfterSnapshotHash: snapshotHashOf(CONTRACT, [...expected.values()]),
      diff: { insert, update, unchangedCount: 0, untouched: [] }, diffHash: contentHashOf({ insert, update }), changeCount: insert.length + update.length,
      blockers: [], applicable: insert.length + update.length > 0,
    };
  }
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const claims = decodeJwt((new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, ""));
    const json = (status: number, b: unknown) => ({ status, json: async () => b }) as Response;
    if (url.pathname.endsWith("/global-config/classes")) return json(200, { classes: [CONTRACT, EVENT_CONTRACT] });
    if (url.pathname.endsWith("/snapshot")) return json(200, { package: exportPkg() });
    if (url.pathname.endsWith("/dry-run")) return json(200, { dryRun: dry(body.package) });
    if (url.pathname.endsWith("/apply") && method === "POST") {
      applyClaims.push(claims as Record<string, unknown>);
      const d = dry(body.package);
      if (d.beforeSnapshotHash !== body.approvedBeforeSnapshotHash) return json(409, { error: "LIVE_STATE_DRIFT" });
      const beforeRows = structuredClone(live);
      const next = new Map(live.map((r) => [keyOf(r), r])); for (const row of body.package.rows) next.set(keyOf(row), row);
      live = [...next.values()];
      return json(200, { commandStatus: "completed", beforeSnapshotHash: d.beforeSnapshotHash, afterSnapshotHash: snapshotHashOf(CONTRACT, live), beforeSnapshot: { rows: beforeRows, rowCount: beforeRows.length, contentHash: contentHashOf(beforeRows) } });
    }
    return json(404, { error: "NO_FIXTURE" });
  }) as typeof fetch;
  return { fetchImpl, applyClaims, liveHash: () => snapshotHashOf(CONTRACT, live), mutate: () => { live[1] = { ...live[1], display_name: "changed out of band" }; } };
}

async function setup() {
  const { client } = buildMigratedPgMemClient();
  for (const [id, sub] of [[MAKER, "m"], [CHECKER, "c"], [EXECUTOR, "e"]] as const) {
    await (client as DbClient).query(`INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at) VALUES ($1,$2,$2||'@x.invalid','O','active',true,now(),now())`, [id, sub]);
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey); jwk.kid = "gov-k1"; jwk.alg = "RS256"; jwk.use = "sig";
  const owner = fakeOwner();
  const deps = {
    store: new GlobalConfigRestoreStore(client), ledger: new ManagementOperationLedger(client), approvals: new ManagementApprovalStore(client),
    signingKeys: { activeKid: "gov-k1", activePrivateKey: privateKey, publicJwks: [jwk] },
    transportConfig: { issuer: "https://governance.test.invalid", audience: "infrakinetic-management-api-test" },
    infrakineticBaseUrl: "https://infrakinetic.test.invalid", ownerExportKeyRing: RING, fetchImpl: owner.fetchImpl,
  };
  return { deps, owner };
}

describe("package validation", () => {
  it("accepts a verified owner export as a backup and refuses the same content twice (duplicate package)", async () => {
    const { deps } = await setup();
    const backup = await captureSnapshot(deps, { ...op(MAKER), classKey: "payment_provider_catalog" });
    expect(backup).toMatchObject({ provenance: "owner-export", purpose: "backup", status: "validated" });
    await expect(submitPackage(deps, { ...op(MAKER), pkg: backup.package })).rejects.toMatchObject({ code: "DUPLICATE_PACKAGE" });
  });

  it("refuses staging identical content twice for apply, but a backup never blocks restoring to that state", async () => {
    const { deps } = await setup();
    const backup = await captureSnapshot(deps, { ...op(MAKER), classKey: "payment_provider_catalog" });
    const rows = [{ ...backup.package.rows[0], display_name: "same change" }];
    await authorPackage(deps, { ...op(MAKER), classKey: "payment_provider_catalog", rows, purpose: "restore" });
    await expect(authorPackage(deps, { ...op(MAKER), classKey: "payment_provider_catalog", rows, purpose: "forward_fix" })).rejects.toMatchObject({ code: "DUPLICATE_PACKAGE" });
    await expect(authorPackage(deps, { ...op(MAKER), classKey: "payment_provider_catalog", rows: backup.package.rows, purpose: "restore" })).resolves.toMatchObject({ status: "validated" });
  });

  it("rejects a bad signature, an unknown key, a provenance/key mismatch, a hash mismatch and an incompatible version", async () => {
    const { deps } = await setup();
    const pkg = (await captureSnapshot(deps, { ...op(MAKER), classKey: "payment_provider_catalog" })).package;
    const fresh = () => ({ ...structuredClone(pkg), packageId: crypto.randomUUID() });
    await expect(submitPackage(deps, { ...op(MAKER), pkg: fresh() })).rejects.toMatchObject({ code: "BAD_SIGNATURE" }); // new packageId breaks the signature
    await expect(submitPackage(deps, { ...op(MAKER), pkg: { ...structuredClone(pkg), signature: { ...pkg.signature, keyId: "infrakinetic-global-config-export:v9" } } })).rejects.toMatchObject({ code: "UNKNOWN_SIGNING_KEY" });
    await expect(submitPackage(deps, { ...op(MAKER), pkg: { ...structuredClone(pkg), producedBy: { kind: "operator-authored" } } })).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    await expect(submitPackage(deps, { ...op(MAKER), pkg: { ...structuredClone(pkg), rows: [{ ...pkg.rows[0], display_name: "tampered" }, pkg.rows[1]] } })).rejects.toMatchObject({ code: "PACKAGE_HASH_MISMATCH" });
    await expect(submitPackage(deps, { ...op(MAKER), pkg: { ...structuredClone(pkg), classSchemaVersion: "0".repeat(64) } })).rejects.toMatchObject({ code: "INCOMPATIBLE_PACKAGE_VERSION" });
    await expect(submitPackage(deps, { ...op(MAKER), pkg: { ...structuredClone(pkg), rows: [{ ...pkg.rows[0], injected: "x" }], rowCount: 1 } })).rejects.toMatchObject({ code: "PACKAGE_UNKNOWN_FIELD" });
  });
});

describe("governed apply", () => {
  it("dry-run -> maker request -> checker approval -> execution with signed checker evidence -> verified -> observed", async () => {
    const { deps, owner } = await setup();
    const base = (await captureSnapshot(deps, { ...op(MAKER), classKey: "payment_provider_catalog" })).package;
    const originalHash = owner.liveHash();
    const authored = await authorPackage(deps, { ...op(MAKER), classKey: "payment_provider_catalog", rows: [{ ...base.rows[0], display_name: "Razorpay (1A.14 cert)" }], purpose: "restore" });
    expect(authored.provenance).toBe("operator-authored");
    expect(authored.package.producedBy).toMatchObject({ makerOperatorId: MAKER });

    const { dryRun } = await dryRunPackage(deps, { ...op(MAKER), packageId: authored.packageId });
    expect(dryRun.changeCount).toBe(1);

    const approval = await requestRestoreApply(deps, { ...op(MAKER), packageId: authored.packageId, reason: "synthetic certification" });
    expect(approval.riskClass).toBe("R4");
    expect(approval.safeRequestSummary).toMatchObject({ changeCount: 1, updates: [{ changes: { display_name: { before: "Razorpay", after: "Razorpay (1A.14 cert)" } } }] });
    await expect(deps.approvals.decideApproval({ approvalId: approval.approvalId, checkerOperatorId: MAKER, decision: "approved" })).rejects.toBeInstanceOf(SelfApprovalNotAllowedError);
    await deps.approvals.decideApproval({ approvalId: approval.approvalId, checkerOperatorId: CHECKER, decision: "approved" });

    const result = await executeRestoreApply(deps, { ...op(EXECUTOR), approvalId: approval.approvalId, idempotencyKey: "apply-1" });
    expect(result.operation.status).toBe("completed");
    expect(result.operation.riskClass).toBe("R4");
    expect(result.restoreOperation).toMatchObject({ status: "completed", afterSnapshotHash: owner.liveHash() });
    expect(result.restoreOperation?.beforeSnapshot?.rows).toHaveLength(2);
    expect(owner.applyClaims[0]).toMatchObject({ operator_id: EXECUTOR, approval: { approval_id: approval.approvalId, maker_operator_id: MAKER, checker_operator_id: CHECKER }, scopes: ["global_config.restore.apply"], target_resource_type: "global_config_class" });
    // The rollback source lives on the restore operation, never in the ledger.
    expect(JSON.stringify(result.operation)).not.toContain('"beforeSnapshot":');
    expect(JSON.stringify(result.operation)).toContain('"beforeSnapshotHash":');
    await expect(executeRestoreApply(deps, { ...op(EXECUTOR), approvalId: approval.approvalId, idempotencyKey: "apply-2" })).rejects.toBeInstanceOf(ApprovalAlreadyExecutedError);

    const observed = await observeRestoreOperation(deps, { ...op(MAKER), restoreOperationId: result.restoreOperation!.restoreOperationId });
    expect(observed.lastObservation).toMatchObject({ status: "matches", freshness: "live" });
    owner.mutate();
    const drifted = await observeRestoreOperation(deps, { ...op(MAKER), restoreOperationId: result.restoreOperation!.restoreOperationId });
    expect(drifted.lastObservation).toMatchObject({ status: "drift" });

    // Rollback: new attested package from the before-snapshot, same gate.
    const rollback = await createRollbackPackage(deps, { ...op(MAKER), restoreOperationId: result.restoreOperation!.restoreOperationId });
    expect(rollback).toMatchObject({ purpose: "rollback", rollbackOfOperationId: result.restoreOperation!.restoreOperationId });
    const rbApproval = await requestRestoreApply(deps, { ...op(MAKER), packageId: rollback.packageId, reason: "rollback certification" });
    await deps.approvals.decideApproval({ approvalId: rbApproval.approvalId, checkerOperatorId: CHECKER, decision: "approved" });
    const rb = await executeRestoreApply(deps, { ...op(EXECUTOR), approvalId: rbApproval.approvalId, idempotencyKey: "rollback-1" });
    expect(rb.operation.status).toBe("completed");
    expect(owner.liveHash()).toBe(originalHash);
  });

  it("a not-applicable dry-run cannot even be submitted for approval", async () => {
    const { deps } = await setup();
    const base = (await captureSnapshot(deps, { ...op(MAKER), classKey: "payment_provider_catalog" })).package;
    const noChange = await authorPackage(deps, { ...op(MAKER), classKey: "payment_provider_catalog", rows: [base.rows[0]], purpose: "restore" });
    await expect(requestRestoreApply(deps, { ...op(MAKER), packageId: noChange.packageId, reason: "x" })).rejects.toMatchObject({ code: "NOTHING_TO_APPLY" });
  });

  it("owner-side drift after approval fails the operation without marking the package applied", async () => {
    const { deps, owner } = await setup();
    const base = (await captureSnapshot(deps, { ...op(MAKER), classKey: "payment_provider_catalog" })).package;
    const pkg = await authorPackage(deps, { ...op(MAKER), classKey: "payment_provider_catalog", rows: [{ ...base.rows[0], display_name: "x" }], purpose: "forward_fix" });
    const approval = await requestRestoreApply(deps, { ...op(MAKER), packageId: pkg.packageId, reason: "fix" });
    await deps.approvals.decideApproval({ approvalId: approval.approvalId, checkerOperatorId: CHECKER, decision: "approved" });
    owner.mutate();
    const result = await executeRestoreApply(deps, { ...op(EXECUTOR), approvalId: approval.approvalId, idempotencyKey: "d1" });
    expect(result.operation.status).toBe("failed");
    expect(result.restoreOperation?.status).toBe("failed");
    expect((await deps.store.getPackage(pkg.packageId)).status).toBe("dry_run");
  });
});
