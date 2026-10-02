import { randomUUID } from "node:crypto";

import type { DbClient, DbExecutor } from "../../db/dbClient.js";
import type { ManagementOperationLedger, ManagementOperationRecord } from "./managementOperationLedger.js";
import { MANAGEMENT_COMMAND_CONTRACT } from "./commandEnvelope.js";
import { buildSafeSnapshot } from "./evidence.js";

export const FINOPS_ALLOCATION_ACTION = "finops.allocation-policy.replace";
export const FINOPS_ALLOCATION_RESOURCE = "finops_allocation_policy";

const SOURCES = ["aws", "azure", "ai_reconciled"] as const;
const DIMENSIONS = ["tenant", "engine", "environment", "provider", "region", "service", "integration", "ai_capability", "release", "shared"] as const;

export interface FinOpsAllocationTarget {
  dimension: (typeof DIMENSIONS)[number];
  key: string;
  percentage: number;
}

export interface FinOpsAllocationRule {
  ruleId: string;
  match: {
    source: (typeof SOURCES)[number];
    provider?: string;
    service?: string;
    costClass?: string;
    financialClass?: string;
    providerKey?: string;
    currency?: string;
  };
  allocations: FinOpsAllocationTarget[];
}

export interface FinOpsAllocationPolicyRecord {
  policyVersion: string;
  supersedesPolicyVersion?: string;
  status: "active" | "superseded";
  rules: FinOpsAllocationRule[];
  reason: string;
  createdBy: string;
  createdAt: string;
  supersededAt?: string;
}

interface PolicyRow {
  policy_version: string;
  supersedes_policy_version: string | null;
  status: "active" | "superseded";
  rules: FinOpsAllocationRule[];
  reason: string;
  created_by: string;
  created_at: Date | string;
  superseded_at: Date | string | null;
}

const iso = (value: Date | string | null) => value === null ? undefined : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const mapPolicy = (row: PolicyRow): FinOpsAllocationPolicyRecord => ({
  policyVersion: row.policy_version,
  supersedesPolicyVersion: row.supersedes_policy_version ?? undefined,
  status: row.status,
  rules: row.rules,
  reason: row.reason,
  createdBy: row.created_by,
  createdAt: iso(row.created_at)!,
  supersededAt: iso(row.superseded_at),
});

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${field} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}

export function validateFinOpsAllocationRules(value: unknown): FinOpsAllocationRule[] {
  if (!Array.isArray(value)) throw new Error("rules must be an array");
  if (value.length > 100) throw new Error("rules may contain at most 100 entries");
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`rules[${index}] must be an object`);
    const row = raw as Record<string, unknown>;
    const ruleId = text(row.ruleId, `rules[${index}].ruleId`, 120);
    if (ids.has(ruleId)) throw new Error(`duplicate ruleId '${ruleId}'`);
    ids.add(ruleId);
    if (!row.match || typeof row.match !== "object" || Array.isArray(row.match)) throw new Error(`rules[${index}].match must be an object`);
    const matchRaw = row.match as Record<string, unknown>;
    const source = matchRaw.source;
    if (!SOURCES.includes(source as never)) throw new Error(`rules[${index}].match.source must be aws, azure or ai_reconciled`);
    const match: FinOpsAllocationRule["match"] = { source: source as FinOpsAllocationRule["match"]["source"] };
    for (const key of ["provider", "service", "costClass", "financialClass", "providerKey", "currency"] as const) {
      if (matchRaw[key] !== undefined) match[key] = text(matchRaw[key], `rules[${index}].match.${key}`, 200);
    }
    if (!Array.isArray(row.allocations) || row.allocations.length === 0 || row.allocations.length > 20) throw new Error(`rules[${index}].allocations must contain 1..20 targets`);
    let total = 0;
    const allocations = row.allocations.map((entry, allocationIndex) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`rules[${index}].allocations[${allocationIndex}] must be an object`);
      const target = entry as Record<string, unknown>;
      if (!DIMENSIONS.includes(target.dimension as never)) throw new Error(`rules[${index}].allocations[${allocationIndex}].dimension is invalid`);
      const percentage = Number(target.percentage);
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) throw new Error(`rules[${index}].allocations[${allocationIndex}].percentage must be > 0 and <= 100`);
      total += percentage;
      return { dimension: target.dimension as FinOpsAllocationTarget["dimension"], key: text(target.key, `rules[${index}].allocations[${allocationIndex}].key`, 200), percentage };
    });
    if (total > 100.000001) throw new Error(`rules[${index}] allocates ${total}% (> 100%)`);
    return { ruleId, match, allocations };
  });
}

export class FinOpsAllocationPolicyStore {
  constructor(private readonly db: DbClient) {}

  async getActive(executor: DbExecutor = this.db): Promise<FinOpsAllocationPolicyRecord | null> {
    const { rows } = await executor.query<PolicyRow>(`SELECT policy_version, supersedes_policy_version, status, rules, reason, created_by, created_at, superseded_at FROM governance.finops_allocation_policies WHERE status='active' ORDER BY created_at DESC LIMIT 1`);
    return rows[0] ? mapPolicy(rows[0]) : null;
  }

  async list(limit = 20): Promise<FinOpsAllocationPolicyRecord[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const { rows } = await this.db.query<PolicyRow>(`SELECT policy_version, supersedes_policy_version, status, rules, reason, created_by, created_at, superseded_at FROM governance.finops_allocation_policies ORDER BY created_at DESC LIMIT $1`, [bounded]);
    return rows.map(mapPolicy);
  }

  async replace(params: { rules: FinOpsAllocationRule[]; reason: string; operatorId: string; policyVersion?: string }): Promise<FinOpsAllocationPolicyRecord> {
    const policyVersion = params.policyVersion ?? randomUUID();
    return this.db.transaction(async (tx) => {
      const prior = await this.getActive(tx);
      if (prior) await tx.query(`UPDATE governance.finops_allocation_policies SET status='superseded', superseded_at=now() WHERE policy_version=$1 AND status='active'`, [prior.policyVersion]);
      const { rows } = await tx.query<PolicyRow>(
        `INSERT INTO governance.finops_allocation_policies (policy_version, supersedes_policy_version, status, rules, reason, created_by) VALUES ($1,$2,'active',$3::jsonb,$4,$5) RETURNING policy_version, supersedes_policy_version, status, rules, reason, created_by, created_at, superseded_at`,
        [policyVersion, prior?.policyVersion ?? null, JSON.stringify(params.rules), params.reason, params.operatorId],
      );
      return mapPolicy(rows[0]!);
    });
  }
}

export interface FinOpsOperationParams {
  operatorId: string;
  operatorSessionId: string;
  idempotencyKey: string;
  reason: string;
  rules: unknown;
  correlationId?: string;
}

export async function replaceFinOpsAllocationPolicy(deps: { ledger: ManagementOperationLedger; store: FinOpsAllocationPolicyStore }, params: FinOpsOperationParams): Promise<{ operation: ManagementOperationRecord; policy: FinOpsAllocationPolicyRecord; replay: boolean }> {
  const rules = validateFinOpsAllocationRules(params.rules);
  const correlationId = params.correlationId ?? randomUUID();
  const { operation: submitted, replay } = await deps.ledger.createOrReplayOperation({
    idempotencyKey: params.idempotencyKey,
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    requestedAction: FINOPS_ALLOCATION_ACTION,
    targetResourceType: FINOPS_ALLOCATION_RESOURCE,
    targetResourceId: FINOPS_ALLOCATION_RESOURCE,
    reason: text(params.reason, "reason", 1000),
    riskClass: "R1",
    payload: { rules },
    contractVersion: MANAGEMENT_COMMAND_CONTRACT,
    correlationId,
  });
  if (replay) {
    const active = await deps.store.getActive();
    if (!active) throw new Error("FinOps allocation replay exists but no active policy can be observed");
    return { operation: submitted, policy: active, replay: true };
  }
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "accepted" });
  await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "running" });
  try {
    const before = await deps.store.getActive();
    const policy = await deps.store.replace({ rules, reason: params.reason.trim(), operatorId: params.operatorId });
    const completed = await deps.ledger.transitionOperation(submitted.operationId, {
      toStatus: "completed",
      beforeStateSafeSnapshot: before ? buildSafeSnapshot(before) : undefined,
      afterStateSafeSnapshot: buildSafeSnapshot(policy),
      result: { policyVersion: policy.policyVersion, supersedesPolicyVersion: policy.supersedesPolicyVersion ?? null, ruleCount: policy.rules.length },
    });
    return { operation: completed, policy, replay: false };
  } catch (err) {
    await deps.ledger.transitionOperation(submitted.operationId, { toStatus: "failed", partialFailureState: { stage: "governance-policy-write", message: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
}

interface CostFact { factId: string; source: "aws" | "azure" | "ai_reconciled"; amount: number; currency: string; provider?: string; service?: string; costClass?: string; financialClass?: string; recordType?: string; chargeType?: string; providerKey?: string; estimated: boolean }

function matches(rule: FinOpsAllocationRule, fact: CostFact): boolean {
  if (rule.match.source !== fact.source) return false;
  for (const key of ["provider", "service", "costClass", "financialClass", "providerKey", "currency"] as const) {
    if (rule.match[key] !== undefined && rule.match[key] !== fact[key]) return false;
  }
  return true;
}

export function applyFinOpsAllocation(snapshot: Record<string, any>, policy: FinOpsAllocationPolicyRecord | null) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const facts: CostFact[] = [];
  for (const row of snapshot?.sources?.aws?.rows ?? []) facts.push({
    factId: `aws:${row.service}:${row.recordType ?? row.financialClass ?? "usage"}:${row.currency}`,
    source: "aws",
    amount: Number(row.amount ?? 0),
    currency: String(row.currency ?? "UNKNOWN"),
    provider: row.provider,
    service: row.service,
    costClass: row.costClass,
    financialClass: row.financialClass,
    recordType: row.recordType,
    estimated: Boolean(row.estimated),
  });
  for (const row of snapshot?.sources?.azure?.rows ?? []) facts.push({
    factId: `azure:${row.service}:${row.chargeType ?? row.financialClass ?? "usage"}:${row.currency}`,
    source: "azure",
    amount: Number(row.amount ?? 0),
    currency: String(row.currency ?? "UNKNOWN"),
    provider: row.provider,
    service: row.service,
    costClass: row.costClass,
    financialClass: row.financialClass,
    chargeType: row.chargeType,
    estimated: Boolean(row.estimated),
  });
  for (const row of snapshot?.sources?.ai?.reconciled ?? []) {
    const unallocated = Number(row.unallocatedAmount ?? 0);
    if (unallocated > 0) facts.push({ factId: `ai:${row.providerKey}:${row.currency}`, source: "ai_reconciled", amount: unallocated, currency: String(row.currency ?? "UNKNOWN"), provider: "AI provider", providerKey: row.providerKey, costClass: "AI", estimated: false });
  }
  return {
    policyVersion: policy?.policyVersion ?? null,
    facts: facts.map((fact) => {
      const rule = policy?.rules.find((candidate) => matches(candidate, fact));
      const allocations = (rule?.allocations ?? []).map((target) => ({ ...target, amount: fact.amount * target.percentage / 100, currency: fact.currency }));
      const allocatedPct = (rule?.allocations ?? []).reduce((sum, target) => sum + target.percentage, 0);
      return { ...fact, ruleId: rule?.ruleId ?? null, allocations, unallocatedAmount: fact.amount * Math.max(0, 100 - allocatedPct) / 100 };
    }),
  };
}
