import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createRequire } from "node:module";
import {
  AI_CONTRACT, AI_CONTRACT_VERSION, aiRoute, effectiveRisk, ownerPath, resolveTarget, validateAiSchema, type AiContractRoute,
} from "../../src/management/operations/aiContract.js";
import { AI_APPROVAL_ROUTES, AI_LEDGERED_ROUTES } from "../../src/management/operations/aiOperation.js";
import { findSecretShapedField } from "../../src/management/operations/aiQuery.js";
import { OPERATION_STATUSES } from "../../src/management/operations/lifecycle.js";
import { ROLE_SCOPE_CEILING, SCOPES, isScope } from "../../src/identity/roles.js";

// 1A.15 final closure — Governance's side of the cross-repo contract. Governance keeps a byte-identical copy of the
// owner's published artefact (never its source) and proves, WITHOUT the owner repository present, that:
//   - the copy is the one the owner published (hash pin),
//   - Governance's independently-written validator agrees with the owner validator on every recorded vector,
//   - every contract route is implemented by a Governance operation/route (a new owner route fails here),
//   - risk, scope, approval, step-up and role-ceiling expectations are the approved ones,
//   - the DTO fields Governance CONSUMES exist in the owner's published examples,
//   - BYOAI is safe metadata + revoke only.
// The live agreement (Governance operations against the owner's real router) is certified separately.

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(here, "../../src/management/contracts");
const normalize = (text: string) => text.replace(/\r\n/g, "\n");
const sha256 = (file: string) => createHash("sha256").update(normalize(readFileSync(path.join(contractsDir, file), "utf8"))).digest("hex");
const examplesJson = createRequire(import.meta.url)("../../src/management/contracts/aiManagement.examples.json") as { contractVersion: string; examples: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const examples = examplesJson.examples;

describe("the contract copy is the one the owner published", () => {
  it("matches its pinned hashes (line-ending independent)", () => {
    const pins = Object.fromEntries(
      normalize(readFileSync(path.join(contractsDir, "aiManagement.sha256"), "utf8")).trim().split("\n").map((line) => {
        const [hash, file] = line.split(/\s+\*?/);
        return [file, hash];
      }),
    );
    expect(pins["aiManagement.contract.json"]).toBe(sha256("aiManagement.contract.json"));
    expect(pins["aiManagement.examples.json"]).toBe(sha256("aiManagement.examples.json"));
  });

  it("declares the version Governance was written against, for the examples too", () => {
    expect(AI_CONTRACT_VERSION).toBe("ai-management/v1");
    expect((examplesJson as { contractVersion: string }).contractVersion).toBe(AI_CONTRACT_VERSION);
  });

  it("uses only scopes Governance knows, and never a scope no role could hold", () => {
    for (const scope of AI_CONTRACT.scopes) expect(isScope(scope), scope).toBe(true);
    for (const route of AI_CONTRACT.routes) expect(AI_CONTRACT.scopes, route.id).toContain(route.scope);
    for (const scope of AI_CONTRACT.scopes) expect(SCOPES).toContain(scope);
  });
});

describe("Governance's validator agrees with the owner's on every recorded schema vector", () => {
  const vectors = AI_CONTRACT.schemaVectors;

  it("has real coverage of both verdicts", () => {
    expect(vectors.filter((v) => v.valid).length).toBeGreaterThanOrEqual(30);
    expect(vectors.filter((v) => !v.valid).length).toBeGreaterThanOrEqual(200);
    const mutationRoutes = new Set(AI_CONTRACT.routes.filter((route) => route.requestSchema).map((route) => route.id));
    expect(new Set(vectors.map((v) => v.routeId))).toEqual(mutationRoutes);
  });

  it("returns the owner's verdict for every vector", () => {
    const disagreements: string[] = [];
    for (const vector of vectors) {
      const route = aiRoute(vector.routeId);
      const violations = validateAiSchema(route.requestSchema!, vector.body);
      if ((violations.length === 0) !== vector.valid) disagreements.push(`${vector.routeId}/${vector.name}: owner=${vector.valid} governance=${violations.length === 0} ${violations.join("; ")}`);
    }
    expect(disagreements).toEqual([]);
  });

  it("every request schema is strict: unknown fields are refused", () => {
    for (const route of AI_CONTRACT.routes.filter((r) => r.requestSchema)) {
      expect(route.requestSchema!.additionalProperties, route.id).toBe(false);
      expect(validateAiSchema(route.requestSchema!, { smuggled: 1 }).join(), route.id).toContain("unknown property");
    }
  });
});

describe("every contract route is implemented by Governance", () => {
  // Reads are served by aiQuery.ts / routes; the preview by previewCommissioningMode; the rest by executeAiCommand / the approval pair.
  const READS = ["tenant.state.read", "fleet.summary.read", "catalog.read", "tenant.credentials.read", "metering-exceptions.read", "reconciliation.read", "admin-command.read"];
  const PREVIEW = ["tenant.commissioning-mode.preview"];

  it("a route added to the owner contract without a Governance implementation fails here", () => {
    const covered = [...READS, ...PREVIEW, ...AI_LEDGERED_ROUTES.map((route) => route.id)].sort();
    expect(AI_CONTRACT.routes.map((route) => route.id).sort()).toEqual(covered);
  });

  it("classifies reads, the unreceipted preview and receipted commands consistently", () => {
    for (const route of AI_CONTRACT.routes) {
      if (READS.includes(route.id)) { expect(route.kind).toBe("read"); expect(route.method).toBe("GET"); }
      else if (PREVIEW.includes(route.id)) { expect(route.kind).toBe("mutation"); expect(route.receipted).toBe(false); expect(route.risk).toBe("R0"); }
      else { expect(route.kind).toBe("mutation"); expect(route.receipted).not.toBe(false); }
    }
  });
});

interface Expectation { risk: string; narrowing?: string; scope: string; approval: "none" | "maker_checker"; stepUp?: boolean; method: string }

// The approved semantics, written independently of the contract (the source of truth for the assertions below).
const APPROVED: Record<string, Expectation> = {
  "tenant.planes.set": { risk: "R2", scope: "ai.entitlement.write", approval: "none", method: "PUT" },
  "tenant.capability.commission": { risk: "R2", scope: "ai.entitlement.write", approval: "none", method: "PUT" },
  "tenant.commissioning-mode.preview": { risk: "R0", scope: "ai.entitlement.write", approval: "none", method: "POST" },
  "tenant.commissioning-mode.set": { risk: "R2", scope: "ai.entitlement.write", approval: "none", method: "PUT" },
  "tenant.quota.set": { risk: "R2", scope: "ai.quota.write", approval: "none", method: "PUT" },
  "tenant.quota.remove": { risk: "R2", scope: "ai.quota.write", approval: "none", method: "DELETE" },
  "tenant.quota.grace.grant": { risk: "R2", scope: "ai.quota.write", approval: "none", method: "POST" },
  "tenant.billing-anchor.set": { risk: "R2", scope: "ai.quota.write", approval: "none", method: "PUT" },
  "tenant.model-policy.set": { risk: "R2", scope: "ai.provider_policy.write", approval: "none", method: "PUT" },
  "provider.state.set": { risk: "R2", narrowing: "R4", scope: "ai.provider_policy.write", approval: "none", method: "PUT" },
  "model.lifecycle.set": { risk: "R3", scope: "ai.provider_policy.write", approval: "maker_checker", method: "PUT" },
  "model.certification.set": { risk: "R3", scope: "ai.provider_policy.write", approval: "maker_checker", method: "PUT" },
  "tenant.suspend": { risk: "R4", scope: "ai.emergency_suspend", approval: "none", stepUp: true, method: "POST" },
  "tenant.resume": { risk: "R3", scope: "ai.emergency_suspend", approval: "maker_checker", method: "POST" },
  "tenant.credential.revoke": { risk: "R2", scope: "credentials.revoke", approval: "none", method: "POST" },
  "metering-exception.resolve": { risk: "R1", scope: "ai.quota.write", approval: "none", method: "POST" },
  "reconciliation.line.resolve": { risk: "R1", scope: "finops.policy.write", approval: "none", method: "POST" },
};

describe("risk classes, scopes, approvals and step-up are the approved ones", () => {
  it.each(Object.entries(APPROVED))("%s", (id, expected) => {
    const route = aiRoute(id);
    expect(route.risk).toBe(expected.risk);
    expect(route.riskNarrowing).toBe(expected.narrowing);
    expect(route.scope).toBe(expected.scope);
    expect(route.approval).toBe(expected.approval);
    expect(Boolean(route.stepUp)).toBe(Boolean(expected.stepUp));
    expect(route.method).toBe(expected.method);
    expect(route.action).toMatch(/^ai\./);
  });

  it("every mutation route is in the approved table (no unreviewed command)", () => {
    expect(AI_CONTRACT.routes.filter((route) => route.kind === "mutation").map((route) => route.id).sort()).toEqual(Object.keys(APPROVED).sort());
  });

  it("reads are R0 under ai.read", () => {
    for (const route of AI_CONTRACT.routes.filter((r) => r.kind === "read")) {
      expect(route.risk, route.id).toBe("R0");
      expect(route.scope, route.id).toBe("ai.read");
    }
  });

  it("R3 is exactly the maker-checker set: resume, model lifecycle, model certification", () => {
    expect(AI_CONTRACT.r3Actions.slice().sort()).toEqual(["ai.model.certification.set", "ai.model.lifecycle.set", "ai.tenant.emergency.resume"]);
    expect(AI_APPROVAL_ROUTES.map((route) => route.action).sort()).toEqual(AI_CONTRACT.r3Actions.slice().sort());
    for (const route of AI_CONTRACT.routes.filter((r) => r.kind === "mutation")) {
      expect(route.approval === "maker_checker", route.id).toBe(route.risk === "R3");
    }
  });

  it("suspend and provider narrowing demand a recovery intent; certification demands evidence; the mode apply demands its dry-run hash", () => {
    expect(aiRoute("tenant.suspend").recoveryIntent).toBe(true);
    expect(aiRoute("tenant.suspend").requestSchema!.required).toContain("recoveryIntent");
    expect(aiRoute("provider.state.set").recoveryIntentWhenNarrowing).toBe(true);
    expect(aiRoute("model.certification.set").requiresEvidenceRef).toBe(true);
    expect(aiRoute("model.certification.set").requestSchema!.required).toContain("evidenceRef");
    expect(aiRoute("tenant.commissioning-mode.set").requiresDryRunHash).toBe(true);
  });

  it("effectiveRisk narrows only provider disable/deprecate", () => {
    const provider = aiRoute("provider.state.set");
    expect(effectiveRisk(provider, { status: "active" })).toBe("R2");
    expect(effectiveRisk(provider, { status: "disabled" })).toBe("R4");
    expect(effectiveRisk(provider, { status: "deprecated" })).toBe("R4");
    expect(effectiveRisk(aiRoute("tenant.suspend"), {})).toBe("R4");
    expect(effectiveRisk(aiRoute("tenant.quota.set"), { status: "disabled" })).toBe("R2");
  });

  it("no role ceiling was widened: who can hold each AI scope", () => {
    const holders = (scope: string) => (Object.keys(ROLE_SCOPE_CEILING) as Array<keyof typeof ROLE_SCOPE_CEILING>).filter((role) => (ROLE_SCOPE_CEILING[role] as readonly string[]).includes(scope)).sort();
    expect(holders("ai.entitlement.write")).toEqual(["break_glass", "platform_admin"]);
    expect(holders("ai.provider_policy.write")).toEqual(["break_glass", "platform_admin"]);
    expect(holders("ai.quota.write")).toEqual(["break_glass", "finops_operator", "platform_admin"]);
    expect(holders("ai.emergency_suspend")).toEqual(["break_glass", "platform_admin", "security_operator"]);
    expect(holders("credentials.revoke")).toEqual(["break_glass", "platform_admin", "security_operator"]);
    expect(holders("finops.policy.write")).toEqual(["break_glass", "finops_operator", "platform_admin"]);
    expect(holders("ai.read")).toEqual(["break_glass", "finops_operator", "platform_admin", "platform_operator", "platform_viewer", "security_operator"]);
  });
});

describe("addressing: path, target binding and tenant claim", () => {
  const TENANT = "00000000-0000-4000-8000-000000000002";

  it("encodes path parameters (the quota policy key contains ':' and '*')", () => {
    expect(ownerPath(aiRoute("tenant.quota.remove"), { tenantId: TENANT, policyKey: "tenant:*:*:daily:requests:*" })).toBe(`/management/v1/ai/tenants/${TENANT}/quotas/tenant%3A*%3A*%3Adaily%3Arequests%3A*`);
    expect(() => ownerPath(aiRoute("tenant.quota.remove"), { tenantId: TENANT })).toThrow(/policyKey/);
  });

  it.each([
    ["tenant.suspend", { tenantId: TENANT }, {}, { targetTenantId: TENANT, targetResourceType: "tenant", targetResourceId: TENANT }],
    ["tenant.capability.commission", { tenantId: TENANT, capabilityKey: "a.b" }, {}, { targetTenantId: TENANT, targetResourceType: "ai_capability", targetResourceId: "a.b" }],
    ["tenant.quota.set", { tenantId: TENANT, policyKey: "k" }, {}, { targetTenantId: TENANT, targetResourceType: "ai_quota_policy", targetResourceId: "k" }],
    ["tenant.model-policy.set", { tenantId: TENANT }, { providerKey: "p", modelKey: "m" }, { targetTenantId: TENANT, targetResourceType: "ai_model_policy", targetResourceId: "p/m" }],
    ["tenant.model-policy.set", { tenantId: TENANT }, { providerKey: "p", modelKey: null }, { targetTenantId: TENANT, targetResourceType: "ai_model_policy", targetResourceId: "p/*" }],
    ["provider.state.set", { providerKey: "nvidia_nim" }, {}, { targetResourceType: "ai_provider", targetResourceId: "nvidia_nim" }],
    ["model.lifecycle.set", { modelId: "m1" }, {}, { targetResourceType: "ai_model", targetResourceId: "m1" }],
    ["tenant.credential.revoke", { tenantId: TENANT, refId: "aicred_1" }, {}, { targetTenantId: TENANT, targetResourceType: "ai_credential", targetResourceId: "aicred_1" }],
    ["metering-exception.resolve", { exceptionId: "e1" }, {}, { targetResourceType: "ai_metering_exception", targetResourceId: "e1" }],
    ["reconciliation.line.resolve", { reconciliationId: "l1" }, {}, { targetResourceType: "ai_reconciliation_line", targetResourceId: "l1" }],
    ["tenant.state.read", { tenantId: TENANT }, {}, { targetTenantId: TENANT, targetResourceType: "tenant", targetResourceId: TENANT }],
    ["fleet.summary.read", {}, {}, { targetResourceType: "ai_fleet", targetResourceId: "ai_fleet" }],
    ["catalog.read", {}, {}, { targetResourceType: "ai_catalog", targetResourceId: "ai_catalog" }],
  ] as const)("%s addresses %j", (id, params, body, expected) => {
    expect(resolveTarget(aiRoute(id), params as Record<string, string>, body as Record<string, unknown>)).toEqual(expected);
  });

  it("global (non-tenant) commands carry no tenant claim", () => {
    for (const route of AI_CONTRACT.routes.filter((r: AiContractRoute) => r.binding.tenant === null)) {
      expect(resolveTarget(route, { providerKey: "p", modelId: "m", exceptionId: "e", reconciliationId: "r" }).targetTenantId, route.id).toBeUndefined();
    }
  });
});

describe("DTOs Governance consumes exist in the owner's published examples", () => {
  it("every example is free of secret-shaped field names", () => {
    for (const [name, example] of Object.entries(examples)) expect(findSecretShapedField(example), name).toBeNull();
  });

  it("every command result carries the shared envelope and a completed status", () => {
    const names = Object.keys(examples).filter((name) => name.startsWith("AiCommandResult."));
    expect(names.length).toBe(AI_CONTRACT.routes.filter((r) => r.kind === "mutation" && r.receipted !== false).length);
    for (const name of names) {
      for (const key of AI_CONTRACT.commandResultEnvelope) expect(examples[name], `${name}.${key}`).toHaveProperty(key);
      expect(examples[name].commandStatus, name).toBe("completed");
    }
  });

  it("every receipted mutation route has an example named after it, and R3 results carry their approval id", () => {
    for (const route of AI_CONTRACT.routes.filter((r) => r.kind === "mutation" && r.receipted !== false)) {
      const example = examples[`AiCommandResult.${route.id}`];
      expect(example, route.id).toBeDefined();
      expect(example.action, route.id).toBe(route.action);
      if (route.approval === "maker_checker") expect(typeof example.approvalId, route.id).toBe("string");
    }
  });

  it("the operation states Governance records are the ones the owner's receipts speak", () => {
    for (const status of ["accepted", "running", "completed", "failed", "partially_completed"]) expect(OPERATION_STATUSES).toContain(status);
    expect(examples.AiAdminCommandReceipt.command.status).toBe("completed");
  });

  it("tenant state exposes what the observers and safe diffs read", () => {
    const state = examples.TenantAiState;
    expect(state.emergency).toEqual(expect.objectContaining({ state: expect.any(String), since: expect.anything(), operationId: expect.anything() }));
    expect(Object.keys(state.emergency)).toEqual(expect.arrayContaining(["state", "reason", "recoveryIntent", "operationId", "since"]));
    expect(Object.keys(state.rootPolicy)).toEqual(expect.arrayContaining(["allowedPlanes", "commissioningMode", "billingAnchorDay", "policyVersion"]));
    expect(state.capabilities[0].commissioning).toEqual({ mode: expect.any(String), commissioned: expect.any(Boolean) });
    for (const quota of state.quotas) {
      expect(typeof quota.policyKey).toBe("string");
      expect(Object.keys(quota.overage).sort()).toEqual(["graceActiveForWindow", "graceExpiresAt", "graceLimit", "mode"]);
      expect(typeof quota.hard).toBe("number");
      expect(typeof quota.enabled).toBe("boolean");
    }
  });

  it("the catalog addresses models by id and shows lifecycle, certification and evidence", () => {
    for (const provider of examples.AiCatalog.providers) {
      expect(["active", "disabled", "deprecated"]).toContain(provider.status);
      for (const model of provider.models) {
        expect(Object.keys(model)).toEqual(expect.arrayContaining(["modelId", "modelKey", "lifecycle", "certification", "certificationEvidenceRef"]));
        expect(AI_CONTRACT.enums.modelLifecycles).toContain(model.lifecycle);
        expect(AI_CONTRACT.enums.modelCertifications).toContain(model.certification);
      }
    }
    for (const capability of examples.AiCatalog.capabilities) expect(Object.keys(capability)).toEqual(expect.arrayContaining(["defaultProviderKey", "defaultModelKey"]));
  });

  it("BYOAI metadata is the safe shape and nothing else — in the read, the state and the revoke result", () => {
    const SAFE = ["createdAt", "maskedHint", "providerKey", "refId", "revokedAt", "status", "version"];
    for (const credential of examples.AiCredentialMetadata.credentials) expect(Object.keys(credential).sort()).toEqual(SAFE);
    for (const credential of examples.TenantAiState.credentialRefs) expect(Object.keys(credential).sort()).toEqual(SAFE);
    expect(Object.keys(examples["AiCommandResult.tenant.credential.revoke"].credential).sort()).toEqual(SAFE);
    // A masked hint is at most a short suffix marker, never a key.
    for (const credential of examples.AiCredentialMetadata.credentials) expect((credential.maskedHint as string).length).toBeLessThanOrEqual(8);
  });

  it("BYOAI has no operator route beyond the metadata read and revoke", () => {
    const routes = AI_CONTRACT.routes.filter((route) => /credential/i.test(route.id + route.path));
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(["GET /ai/tenants/:tenantId/credentials", "POST /ai/tenants/:tenantId/credentials/:refId/revoke"]);
    expect(Object.keys(aiRoute("tenant.credential.revoke").requestSchema!.properties!).sort()).toEqual(["idempotencyKey", "reason"]);
    expect(JSON.stringify(AI_CONTRACT.routes)).not.toMatch(/submit|rotate|decrypt|apiKey|secretValue|plaintext|ciphertext/i);
  });

  it("reconciliation DTOs carry statements, lines and the resolution state Governance filters on", () => {
    const reconciliation = examples.AiReconciliation;
    expect(reconciliation.statements.length).toBeGreaterThan(0);
    for (const line of reconciliation.lines) {
      expect(AI_CONTRACT.enums.reconciliationOutcomes).toContain(line.outcome);
      expect(["open", "resolved"]).toContain(line.resolutionState);
      expect(Object.keys(line)).toEqual(expect.arrayContaining(["reconciliationId", "statementId", "providerKey", "outcome", "resolutionState", "actualAmount", "estimatedAmount", "variance", "tenantId", "poolLevel"]));
    }
    // Statement ingestion is owner-side (CLI/job): there is no contract route that uploads one.
    expect(AI_CONTRACT.routes.some((route) => /statement|upload|ingest/i.test(route.id + route.path))).toBe(false);
  });

  it("allocations and effective ceilings are exposed read-only and never exceed the root ceiling", () => {
    const { delegation } = examples.TenantAiState;
    expect(delegation.allocations.length).toBeGreaterThan(0);
    for (const allocation of delegation.allocations) {
      expect(Object.keys(allocation)).toEqual(expect.arrayContaining(["allocationId", "allocated", "rootCeiling", "effective", "status"]));
      expect(allocation.effective).toBeLessThanOrEqual(allocation.rootCeiling);
    }
    expect(AI_CONTRACT.routes.some((route) => /allocation/i.test(route.id + route.path))).toBe(false);
  });

  it("the commissioning-mode preview exposes the diff and the hash the apply is bound to", () => {
    const preview = examples.AiCommissioningModePreview;
    expect(preview.dryRun).toBe(true);
    expect(preview.diffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.losing).toBe(preview.changes.filter((change: any) => change.before.effective && !change.after.effective).length); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(aiRoute("tenant.commissioning-mode.set").requestSchema!.properties!.expectedDiffHash!.pattern).toBe("^[0-9a-f]{64}$");
  });

  it("the fleet summary reports metering and reconciliation posture without any operator upload surface", () => {
    expect(examples.FleetAiSummary.meteringExceptions).toEqual(expect.objectContaining({ open: expect.any(Number), byType: expect.any(Array) }));
    expect(examples.FleetAiSummary.reconciliation).toEqual(expect.objectContaining({ byOutcome: expect.any(Array), openExceptions: expect.any(Number) }));
    expect(examples.FleetAiSummary.enforcement.byoaiKeyringPosture).toBeDefined();
  });
});
