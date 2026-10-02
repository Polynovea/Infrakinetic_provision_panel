"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { ErrorState, EmptyState } from "../../../components/States";
import { FinOpsAllocationDialog, type AllocationRuleDraft } from "../../../components/FinOpsAllocationDialog";

interface CloudCostRow {
  provider: string;
  service: string;
  costClass: string;
  financialClass?: string;
  recordType?: string;
  chargeType?: string;
  amount: number;
  currency: string;
  evidence: string;
  estimated: boolean;
}
interface AiEstimated { currency: string; amount: number; attempts: number; totalTokens: number }
interface AiReconciled { providerKey: string; currency: string; actualAmount: number; estimatedAmount: number; unallocatedAmount: number; tenantAttributedAmount: number; lines: number; openLines: number }
interface AllocationPolicy { policyVersion: string; status: string; rules: AllocationRuleDraft[]; reason: string; createdBy: string; createdAt: string; supersedesPolicyVersion?: string }
interface GovernedFact { factId: string; source: string; amount: number; currency: string; service?: string; costClass?: string; financialClass?: string; providerKey?: string; estimated: boolean; ruleId: string | null; allocations: Array<{ dimension: string; key: string; percentage: number; amount: number; currency: string }>; unallocatedAmount: number }
interface CloudSource { status: string; errorCode?: string; estimated?: boolean; rows?: CloudCostRow[]; reason?: string }
interface FinOpsSnapshot {
  contractVersion: string;
  period: { kind: string; start: string; end: string };
  sources: {
    aws: CloudSource;
    ai: { status: string; estimated: AiEstimated[]; reconciled: AiReconciled[] };
    azure: CloudSource;
  };
  coverage?: { costClasses?: string[]; financialClasses?: string[]; estimatedVsReconciled?: string };
  allocation: { authority: string; policyVersion: string | null; defaultDisposition: string; note: string; activePolicy?: AllocationPolicy | null };
  governedAllocation?: { policyVersion: string | null; facts: GovernedFact[] };
  observedAt: string;
  source: string;
  freshness: string;
}

const money = (amount: number, currency: string) => {
  if (!Number.isFinite(amount)) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${amount.toFixed(2)} ${currency}`; }
};
const fmt = (n: number) => new Intl.NumberFormat().format(n);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="card" style={{ padding: "0.85rem 1rem" }}><div className="overlay-note" style={{ marginTop: 0 }}>{label}</div><div style={{ fontSize: "1.35rem", fontWeight: 650, marginTop: "0.2rem" }}>{value}</div>{note && <div className="overlay-note" style={{ marginTop: "0.15rem" }}>{note}</div>}</div>;
}

function SourceState({ status, errorCode }: { status: string; errorCode?: string }) {
  return <span title={errorCode ?? undefined}><StatusBadge value={status.replace(/_/g, " ")} /></span>;
}

function sumByCurrency(rows: CloudCostRow[]) {
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.currency, (out.get(row.currency) ?? 0) + row.amount);
  return out;
}

function displayCurrencyMap(map: Map<string, number>) {
  return map.size === 0 ? "—" : [...map].map(([currency, amount]) => money(amount, currency)).join(" + ");
}

export default function FinOpsPage() {
  const { request, operator } = useOperatorSession();
  const canPolicy = operator?.scopes.includes("finops.policy.write") ?? false;
  const [snapshot, setSnapshot] = useState<FinOpsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingPolicy, setEditingPolicy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await request("/management/v1/finops");
      if (!res.ok) { setError(res.status === 403 ? "You need finops.read to view platform operating cost." : "Could not load FinOps cost evidence."); return; }
      setSnapshot(await res.json());
    } catch { setError("Could not load FinOps cost evidence."); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => {
    if (!snapshot) return null;
    const aiEstimatedByCurrency = new Map<string, number>();
    for (const row of snapshot.sources.ai.estimated) aiEstimatedByCurrency.set(row.currency, (aiEstimatedByCurrency.get(row.currency) ?? 0) + row.amount);
    const aiActualByCurrency = new Map<string, number>();
    const aiUnallocatedByCurrency = new Map<string, number>();
    for (const row of snapshot.sources.ai.reconciled) {
      aiActualByCurrency.set(row.currency, (aiActualByCurrency.get(row.currency) ?? 0) + row.actualAmount);
      aiUnallocatedByCurrency.set(row.currency, (aiUnallocatedByCurrency.get(row.currency) ?? 0) + row.unallocatedAmount);
    }
    return {
      aws: displayCurrencyMap(sumByCurrency(snapshot.sources.aws.rows ?? [])),
      azure: displayCurrencyMap(sumByCurrency(snapshot.sources.azure.rows ?? [])),
      aiEstimated: displayCurrencyMap(aiEstimatedByCurrency),
      aiActual: displayCurrencyMap(aiActualByCurrency),
      aiUnallocated: displayCurrencyMap(aiUnallocatedByCurrency),
    };
  }, [snapshot]);

  const cloudRows = snapshot ? [...(snapshot.sources.aws.rows ?? []), ...(snapshot.sources.azure.rows ?? [])] : [];

  return (
    <>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1rem" }}>
        <div><h1 className="text-display">FinOps</h1><p>Platform operating-cost evidence across cloud and AI. This is not the Finance engine and does not post accounting entries.</p></div>
        <button className="btn" onClick={() => void load()}>Refresh</button>
      </div>
      {error && <ErrorState label={error} />}
      {snapshot && summary && (
        <>
          <p className="overlay-note" style={{ marginTop: 0 }}>Month-to-date evidence {snapshot.period.start} → {snapshot.period.end} · observed {when(snapshot.observedAt)}. Provider credits, discounts and refunds remain explicit rows; estimated and reconciled amounts are deliberately not merged.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))", gap: "0.75rem", margin: "0.85rem 0 1rem" }}>
            <Metric label="AWS cloud cost" value={summary.aws} note={snapshot.sources.aws.status === "live" ? (snapshot.sources.aws.estimated ? "Cost Explorer · current period estimated" : "Cost Explorer") : `source ${snapshot.sources.aws.status.replace(/_/g, " ")}`} />
            <Metric label="Azure cloud cost" value={summary.azure} note={snapshot.sources.azure.status === "live" ? "Azure Cost Management" : `source ${snapshot.sources.azure.status.replace(/_/g, " ")}`} />
            <Metric label="AI usage estimate" value={summary.aiEstimated} note="Owner metering + versioned pricing" />
            <Metric label="AI provider actual" value={summary.aiActual} note="Imported/reconciled provider statements" />
            <Metric label="AI still unallocated" value={summary.aiUnallocated} note="Managed/shared pool cost remains explicit" />
          </div>

          <h3 className="text-subhead" style={{ margin: "1rem 0 0.5rem" }}>Cost-source coverage</h3>
          <table className="data-table">
            <thead><tr><th>Source</th><th>Status</th><th>What it means</th></tr></thead>
            <tbody>
              <tr><td>AWS Cost Explorer</td><td><SourceState status={snapshot.sources.aws.status} errorCode={snapshot.sources.aws.errorCode} /></td><td>{snapshot.sources.aws.status === "live" ? "Real account billing evidence grouped by service and record type." : "AWS spend is unknown here; this is not shown as zero."}</td></tr>
              <tr><td>Azure Cost Management</td><td><SourceState status={snapshot.sources.azure.status} errorCode={snapshot.sources.azure.errorCode} /></td><td>{snapshot.sources.azure.status === "live" ? "Real Azure billing evidence grouped by service and charge type." : snapshot.sources.azure.reason ?? "Azure spend is unknown here; this is not shown as zero."}</td></tr>
              <tr><td>AI owner metering</td><td><SourceState status={snapshot.sources.ai.status} /></td><td>Estimated provider consumption from immutable AI usage attempts and pricing versions.</td></tr>
              <tr><td>AI provider statements</td><td><SourceState status={snapshot.sources.ai.status} /></td><td>Actual imported provider amounts with reconciliation outcomes; managed-pool lines remain pool-level until explicitly allocated.</td></tr>
            </tbody>
          </table>

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Cloud provider cost evidence</h3>
          {cloudRows.length === 0 ? <EmptyState label="No cloud billing rows are currently observable. Denied or unconfigured sources remain coverage gaps rather than zero cost." icon="cloud_off" /> : (
            <table className="data-table">
              <thead><tr><th>Provider</th><th>Service</th><th>Cost class</th><th>Financial class</th><th>Amount</th><th>Evidence</th></tr></thead>
              <tbody>{cloudRows.map((row, index) => (
                <tr key={`${row.provider}:${row.service}:${row.recordType ?? row.chargeType ?? row.financialClass ?? "usage"}:${row.currency}:${index}`}>
                  <td>{row.provider}</td>
                  <td>{row.service}<div className="overlay-note" style={{ marginTop: 0 }}>{row.recordType ?? row.chargeType ?? "provider usage"}</div></td>
                  <td>{row.costClass.replace(/_/g, " ")}</td>
                  <td>{(row.financialClass ?? "usage").replace(/_/g, " ")}</td>
                  <td>{money(row.amount, row.currency)}{row.estimated ? " · provider estimate" : ""}</td>
                  <td>{row.evidence.replace(/_/g, " ")}</td>
                </tr>
              ))}</tbody>
            </table>
          )}

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>AI estimated vs reconciled</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(22rem, 1fr))", gap: "0.85rem" }}>
            <div className="card"><strong>Metered estimate</strong>{snapshot.sources.ai.estimated.length === 0 ? <p className="overlay-note">No priced AI usage in this period.</p> : <table className="data-table" style={{ marginTop: "0.5rem" }}><thead><tr><th>Currency</th><th>Estimate</th><th>Attempts</th><th>Tokens</th></tr></thead><tbody>{snapshot.sources.ai.estimated.map((row) => <tr key={row.currency}><td>{row.currency}</td><td>{money(row.amount, row.currency)}</td><td>{fmt(row.attempts)}</td><td>{fmt(row.totalTokens)}</td></tr>)}</tbody></table>}</div>
            <div className="card"><strong>Provider reconciliation</strong>{snapshot.sources.ai.reconciled.length === 0 ? <p className="overlay-note">No active provider statement has been reconciled for this period.</p> : <table className="data-table" style={{ marginTop: "0.5rem" }}><thead><tr><th>Provider</th><th>Estimated / actual</th><th>Unallocated</th><th>Open lines</th></tr></thead><tbody>{snapshot.sources.ai.reconciled.map((row) => <tr key={`${row.providerKey}:${row.currency}`}><td>{row.providerKey}</td><td>{money(row.estimatedAmount, row.currency)} / {money(row.actualAmount, row.currency)}</td><td>{money(row.unallocatedAmount, row.currency)}</td><td>{row.openLines} / {row.lines}</td></tr>)}</tbody></table>}</div>
          </div>

          <div className="card" style={{ marginTop: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <strong>Allocation posture</strong>
                <p style={{ margin: "0.4rem 0 0", fontSize: "0.88rem" }}>Policy version: {snapshot.allocation.policyVersion ?? "none"} · default: {snapshot.allocation.defaultDisposition.replace(/_/g, " ")}.</p>
              </div>
              {canPolicy && <button className="btn" onClick={() => setEditingPolicy(true)}>{snapshot.allocation.activePolicy ? "Replace allocation policy…" : "Create allocation policy…"}</button>}
            </div>
            <p className="overlay-note">{snapshot.allocation.note}</p>
            {snapshot.coverage?.financialClasses?.length ? <p className="overlay-note" style={{ marginTop: "0.25rem" }}>Provider financial classes: {snapshot.coverage.financialClasses.join(", ").replace(/_/g, " ")}.</p> : null}
            {snapshot.allocation.activePolicy && <p className="overlay-note" style={{ marginBottom: 0 }}>Active version created {when(snapshot.allocation.activePolicy.createdAt)} · {snapshot.allocation.activePolicy.rules.length} rule(s) · reason: {snapshot.allocation.activePolicy.reason}</p>}
          </div>

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Governed allocation result</h3>
          {!snapshot.governedAllocation || snapshot.governedAllocation.facts.length === 0 ? (
            <EmptyState label="No shared cost facts are currently available for allocation." icon="account_tree" />
          ) : (
            <table className="data-table">
              <thead><tr><th>Cost fact</th><th>Amount</th><th>Policy rule</th><th>Attributed</th><th>Still unallocated</th></tr></thead>
              <tbody>{snapshot.governedAllocation.facts.map((fact) => (
                <tr key={fact.factId}>
                  <td><strong>{fact.service ?? fact.providerKey ?? fact.factId}</strong><div className="overlay-note" style={{ marginTop: 0 }}>{fact.source.replace(/_/g, " ")}{fact.costClass ? ` · ${fact.costClass.replace(/_/g, " ")}` : ""}{fact.financialClass ? ` · ${fact.financialClass.replace(/_/g, " ")}` : ""}{fact.estimated ? " · provider estimate" : ""}</div></td>
                  <td>{money(fact.amount, fact.currency)}</td>
                  <td>{fact.ruleId ?? "No matching rule"}</td>
                  <td>{fact.allocations.length === 0 ? "—" : fact.allocations.map((allocation) => `${allocation.dimension}:${allocation.key} ${allocation.percentage}% (${money(allocation.amount, allocation.currency)})`).join("; ")}</td>
                  <td>{money(fact.unallocatedAmount, fact.currency)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {editingPolicy && <FinOpsAllocationDialog initialRules={snapshot.allocation.activePolicy?.rules} onClose={() => setEditingPolicy(false)} onDone={() => { setEditingPolicy(false); void load(); }} />}
        </>
      )}
    </>
  );
}
