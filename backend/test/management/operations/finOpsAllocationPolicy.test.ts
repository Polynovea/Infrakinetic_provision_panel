import { describe, expect, it } from "vitest";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { seedAiOperators, OPERATOR } from "../../helpers/aiOwnerFake.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import {
  FinOpsAllocationPolicyStore,
  applyFinOpsAllocation,
  replaceFinOpsAllocationPolicy,
  validateFinOpsAllocationRules,
} from "../../../src/management/operations/finOpsAllocationPolicy.js";

const rules = (percentage = 60) => [{
  ruleId: "ec2-to-platform",
  match: { source: "aws" as const, costClass: "compute" },
  allocations: [{ dimension: "environment" as const, key: "production", percentage }],
}];

async function setup() {
  const { client } = buildMigratedPgMemClient();
  await seedAiOperators(client);
  return { client, store: new FinOpsAllocationPolicyStore(client), ledger: new ManagementOperationLedger(client) };
}

describe("Phase 1A.17 versioned FinOps allocation policy", () => {
  it("creates immutable versions and supersedes the previous active policy", async () => {
    const { store } = await setup();
    expect(await store.getActive()).toBeNull();
    const v1 = await store.replace({ rules: rules(), reason: "allocate production EC2", operatorId: OPERATOR });
    expect(v1.status).toBe("active");
    expect(v1.supersedesPolicyVersion).toBeUndefined();

    const v2 = await store.replace({ rules: rules(75), reason: "revised allocation evidence", operatorId: OPERATOR });
    expect(v2.policyVersion).not.toBe(v1.policyVersion);
    expect(v2.supersedesPolicyVersion).toBe(v1.policyVersion);
    expect((await store.getActive())?.policyVersion).toBe(v2.policyVersion);
    const history = await store.list();
    expect(history).toHaveLength(2);
    expect(history.find((p) => p.policyVersion === v1.policyVersion)?.status).toBe("superseded");
  });

  it("uses the management ledger for idempotent policy replacement", async () => {
    const { store, ledger } = await setup();
    const params = { operatorId: OPERATOR, operatorSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", idempotencyKey: "finops-policy-1", reason: "explicit allocation", rules: rules() };
    const first = await replaceFinOpsAllocationPolicy({ ledger, store }, params);
    const second = await replaceFinOpsAllocationPolicy({ ledger, store }, params);
    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.policy.policyVersion).toBe(first.policy.policyVersion);
    expect(await store.list()).toHaveLength(1);
    expect((await ledger.getByIdempotencyKey("finops-policy-1"))?.status).toBe("completed");
  });

  it("accepts AWS, Azure and AI sources and refuses ambiguous/overallocated rules", () => {
    expect(() => validateFinOpsAllocationRules(rules(101))).toThrow(/percentage/);
    expect(() => validateFinOpsAllocationRules([{ ruleId: "x", match: { source: "aws" }, allocations: [
      { dimension: "service", key: "a", percentage: 60 },
      { dimension: "service", key: "b", percentage: 50 },
    ] }])).toThrow(/> 100%/);
    expect(validateFinOpsAllocationRules([{ ruleId: "azure-refund", match: { source: "azure", financialClass: "refund" }, allocations: [{ dimension: "environment", key: "production", percentage: 100 }] }])[0]?.match).toEqual({ source: "azure", financialClass: "refund" });
    expect(validateFinOpsAllocationRules([{ ruleId: "ai", match: { source: "ai_reconciled", providerKey: "nvidia_nim" }, allocations: [{ dimension: "provider", key: "nvidia", percentage: 100 }] }])[0]?.match.source).toBe("ai_reconciled");
    expect(() => validateFinOpsAllocationRules([{ ruleId: "bad", match: { source: "gcp" }, allocations: [{ dimension: "service", key: "x", percentage: 100 }] }])).toThrow(/aws, azure or ai_reconciled/);
  });

  it("keeps provider charge types distinct and leaves every unmatched remainder unallocated", () => {
    const snapshot = {
      sources: {
        aws: { rows: [
          { provider: "AWS", service: "EC2", recordType: "Usage", financialClass: "usage", costClass: "compute", amount: 10, currency: "USD", estimated: true },
          { provider: "AWS", service: "EC2", recordType: "Credit", financialClass: "credit", costClass: "compute", amount: -2, currency: "USD", estimated: true },
          { provider: "AWS", service: "S3", recordType: "Usage", financialClass: "usage", costClass: "storage", amount: 4, currency: "USD", estimated: true },
        ] },
        azure: { rows: [
          { provider: "Azure", service: "Azure Container Apps", chargeType: "Usage", financialClass: "usage", costClass: "compute", amount: 6, currency: "USD", estimated: false },
          { provider: "Azure", service: "Bandwidth", chargeType: "Refund", financialClass: "refund", costClass: "network", amount: -1, currency: "USD", estimated: false },
        ] },
        ai: { reconciled: [{ providerKey: "nvidia_nim", currency: "USD", actualAmount: 5, unallocatedAmount: 3, tenantAttributedAmount: 2 }] },
      },
    };
    const noPolicy = applyFinOpsAllocation(snapshot, null);
    expect(noPolicy.facts.map((fact) => fact.unallocatedAmount)).toEqual([10, -2, 4, 6, -1, 3]);
    expect(new Set(noPolicy.facts.map((fact) => fact.factId)).size).toBe(noPolicy.facts.length);
    expect(noPolicy.facts.find((fact) => fact.factId === "aws:EC2:Credit:USD")?.financialClass).toBe("credit");
    expect(noPolicy.facts.find((fact) => fact.factId === "azure:Bandwidth:Refund:USD")?.financialClass).toBe("refund");

    const policy = {
      policyVersion: "00000000-0000-4000-8000-000000000001",
      status: "active" as const,
      rules: [
        ...rules(),
        { ruleId: "azure-compute", match: { source: "azure" as const, costClass: "compute" }, allocations: [{ dimension: "environment" as const, key: "production", percentage: 50 }] },
      ],
      reason: "test",
      createdBy: OPERATOR,
      createdAt: "2026-10-02T00:00:00.000Z",
    };
    const allocated = applyFinOpsAllocation(snapshot, policy);
    const ec2Usage = allocated.facts.find((fact) => fact.factId === "aws:EC2:Usage:USD")!;
    expect(ec2Usage.allocations).toEqual([{ dimension: "environment", key: "production", percentage: 60, amount: 6, currency: "USD" }]);
    expect(ec2Usage.unallocatedAmount).toBe(4);
    // The same cost-class rule deliberately applies the provider credit consistently; financialClass can narrow this when desired.
    expect(allocated.facts.find((fact) => fact.factId === "aws:EC2:Credit:USD")?.unallocatedAmount).toBe(-0.8);
    expect(allocated.facts.find((fact) => fact.factId === "azure:Azure Container Apps:Usage:USD")?.unallocatedAmount).toBe(3);
    expect(allocated.facts.find((fact) => fact.factId === "aws:S3:Usage:USD")?.unallocatedAmount).toBe(4);
    // Only the provider statement's pool-level unallocated portion (3), never the already tenant-attributed 2, is eligible.
    expect(allocated.facts.find((fact) => fact.factId === "ai:nvidia_nim:USD")?.amount).toBe(3);
  });
});
