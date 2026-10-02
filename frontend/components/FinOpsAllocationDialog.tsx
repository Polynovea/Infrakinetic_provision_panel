"use client";

import { useMemo, useState } from "react";

import { ActionDialog } from "./AiActions";

export interface AllocationTargetDraft { dimension: string; key: string; percentage: number }
export interface AllocationRuleDraft {
  ruleId: string;
  match: { source: "aws" | "ai_reconciled"; provider?: string; service?: string; costClass?: string; providerKey?: string; currency?: string };
  allocations: AllocationTargetDraft[];
}

interface Common { onClose: () => void; onDone: () => void }
const DIMENSIONS = ["tenant", "engine", "environment", "provider", "region", "service", "integration", "ai_capability", "release", "shared"] as const;
const AWS_MATCH = ["all", "costClass", "service", "currency"] as const;
const AI_MATCH = ["all", "providerKey", "currency"] as const;

function id() {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `allocation-${suffix}`;
}

function blankRule(): AllocationRuleDraft {
  return { ruleId: id(), match: { source: "aws" }, allocations: [{ dimension: "environment", key: "production", percentage: 100 }] };
}

function matchField(rule: AllocationRuleDraft): string {
  for (const field of ["costClass", "service", "providerKey", "currency"] as const) if (rule.match[field]) return field;
  return "all";
}

function setMatch(rule: AllocationRuleDraft, field: string, value: string): AllocationRuleDraft {
  const next: AllocationRuleDraft["match"] = { source: rule.match.source };
  if (field !== "all" && value.trim()) (next as Record<string, string>)[field] = value.trim();
  return { ...rule, match: next };
}

export function FinOpsAllocationDialog({ initialRules, onClose, onDone }: Common & { initialRules?: AllocationRuleDraft[] }) {
  const [rules, setRules] = useState<AllocationRuleDraft[]>(initialRules?.length ? structuredClone(initialRules) : [blankRule()]);
  const invalid = useMemo(() => rules.some((rule) => {
    if (!rule.ruleId.trim() || rule.allocations.length === 0) return true;
    const total = rule.allocations.reduce((n, target) => n + Number(target.percentage || 0), 0);
    return total <= 0 || total > 100 || rule.allocations.some((target) => !target.key.trim() || target.percentage <= 0 || target.percentage > 100);
  }), [rules]);

  const updateRule = (index: number, next: AllocationRuleDraft) => setRules((current) => current.map((rule, i) => i === index ? next : rule));
  const removeRule = (index: number) => setRules((current) => current.filter((_rule, i) => i !== index));

  return (
    <ActionDialog
      title="Replace FinOps allocation policy"
      description="This creates a new immutable policy version. Only matching shared/unallocated operating cost is attributed. Anything unmatched, or any percentage below 100%, remains explicitly unallocated. This does not create Finance journals."
      confirmLabel="Create new policy version"
      canSubmit={!invalid}
      build={(reason, idempotencyKey) => ({ method: "PUT", path: "/management/v1/finops/allocation-policy", body: { idempotencyKey, reason, rules } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div style={{ display: "grid", gap: "0.75rem" }}>
        {rules.map((rule, ruleIndex) => {
          const field = matchField(rule);
          const fields = rule.match.source === "aws" ? AWS_MATCH : AI_MATCH;
          const matchValue = field === "all" ? "" : String((rule.match as Record<string, unknown>)[field] ?? "");
          const total = rule.allocations.reduce((n, target) => n + Number(target.percentage || 0), 0);
          return (
            <div key={`${rule.ruleId}:${ruleIndex}`} className="card" style={{ padding: "0.75rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "center" }}>
                <strong>Rule {ruleIndex + 1}</strong>
                {rules.length > 1 && <button type="button" className="btn" style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }} onClick={() => removeRule(ruleIndex)}>Remove rule</button>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))", gap: "0.5rem", marginTop: "0.55rem" }}>
                <div className="field"><label>Rule ID</label><input value={rule.ruleId} maxLength={120} onChange={(e) => updateRule(ruleIndex, { ...rule, ruleId: e.target.value })} /></div>
                <div className="field"><label>Cost source</label><select value={rule.match.source} onChange={(e) => updateRule(ruleIndex, { ...rule, match: { source: e.target.value as "aws" | "ai_reconciled" } })}><option value="aws">AWS billing</option><option value="ai_reconciled">AI provider actual</option></select></div>
                <div className="field"><label>Match by</label><select value={field} onChange={(e) => updateRule(ruleIndex, setMatch(rule, e.target.value, ""))}>{fields.map((value) => <option key={value} value={value}>{value === "all" ? "All cost from source" : value.replace(/([A-Z])/g, " $1").toLowerCase()}</option>)}</select></div>
                {field !== "all" && <div className="field"><label>Match value</label><input value={matchValue} onChange={(e) => updateRule(ruleIndex, setMatch(rule, field, e.target.value))} placeholder={field === "costClass" ? "e.g. compute" : field === "providerKey" ? "e.g. nvidia_nim" : undefined} /></div>}
              </div>
              <div style={{ marginTop: "0.45rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}><span className="overlay-note" style={{ margin: 0 }}>Allocation targets · {total}% allocated · {Math.max(0, 100 - total)}% remains unallocated</span><button type="button" className="btn" style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }} onClick={() => updateRule(ruleIndex, { ...rule, allocations: [...rule.allocations, { dimension: "environment", key: "production", percentage: Math.max(1, 100 - total) }] })}>Add target</button></div>
                {rule.allocations.map((target, targetIndex) => (
                  <div key={targetIndex} style={{ display: "grid", gridTemplateColumns: "minmax(8rem, 1fr) minmax(10rem, 1.5fr) 7rem auto", gap: "0.4rem", alignItems: "end", marginTop: "0.4rem" }}>
                    <div className="field"><label>Dimension</label><select value={target.dimension} onChange={(e) => updateRule(ruleIndex, { ...rule, allocations: rule.allocations.map((item, i) => i === targetIndex ? { ...item, dimension: e.target.value } : item) })}>{DIMENSIONS.map((dimension) => <option key={dimension} value={dimension}>{dimension.replace(/_/g, " ")}</option>)}</select></div>
                    <div className="field"><label>Target key</label><input value={target.key} maxLength={200} onChange={(e) => updateRule(ruleIndex, { ...rule, allocations: rule.allocations.map((item, i) => i === targetIndex ? { ...item, key: e.target.value } : item) })} /></div>
                    <div className="field"><label>Percent</label><input type="number" min={0.01} max={100} step={0.01} value={target.percentage} onChange={(e) => updateRule(ruleIndex, { ...rule, allocations: rule.allocations.map((item, i) => i === targetIndex ? { ...item, percentage: Number(e.target.value) } : item) })} /></div>
                    <button type="button" className="btn" style={{ marginBottom: "0.3rem", fontSize: "0.75rem", padding: "0.15rem 0.5rem" }} disabled={rule.allocations.length === 1} onClick={() => updateRule(ruleIndex, { ...rule, allocations: rule.allocations.filter((_item, i) => i !== targetIndex) })}>Remove</button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        <button type="button" className="btn" onClick={() => setRules((current) => [...current, blankRule()])}>Add allocation rule</button>
        {invalid && <p className="field-hint">Each rule needs an ID, at least one target, valid target keys, and a combined allocation between 0% and 100%.</p>}
      </div>
    </ActionDialog>
  );
}
