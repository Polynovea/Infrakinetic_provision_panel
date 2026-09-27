"use client";

import { useCallback, useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { EmptyState, ErrorState } from "../../../components/States";
import {
  type AiEnforcementFacts, EnforcementGaps, fmtCost, fmtNumber, type NotModelled, NotModelledNote, when,
} from "../../../components/AiShared";

// Phase 1A.15 Slice 1 — fleet AI operator view (ai.read, read-only).
// module_ai composes every figure live; Governance stores none of it.
// Migration-internal volume comes from Migration's own usage table and is
// shown as its own plane, never merged into module_ai totals.

interface Windowed { day: number; week: number; month: number }
interface Plane { plane: string; source: string; gatedBy?: string; tokens: Windowed; requests: Windowed; estimatedCost: Windowed }
interface Model { modelKey: string; lifecycle: string; certification: string }
interface Provider {
  providerKey: string; displayName: string; status: string; governedVia: string; plane: string; credentialSource: string;
  adapterRegistered: boolean | null; enforcement: { statusEnforced: string; moduleAiGated: boolean }; models: Model[];
}
interface Fleet {
  windows: { day: string; week: string; month: string };
  planes: Plane[];
  top: {
    tenants: Array<{ tenantId: string; totalTokens: number; estimatedCost: number }>;
    capabilities: Array<{ capabilityKey: string; totalTokens: number }>;
    models: Array<{ providerKey: string; modelKey: string | null; totalTokens: number }>;
  };
  providerHealth7d: Array<{ providerKey: string; attempts: number; failures: number; rateLimited: number }>;
  providers: Provider[];
  entitlement: { moduleAiEntitledTenants: number; moduleAiExplicitlyDisabled: number };
  quotaRisk: Array<{ tenantId: string; policyId: string; period: string; limitType: string; hard: number; used: number; state: string }>;
  meteringExceptions: NotModelled;
  reconciliationExceptions: NotModelled;
  enforcement: AiEnforcementFacts;
  observedAt: string;
}
interface Catalog { legacyKillSwitches: Array<{ libraryKey: string; enabled: boolean; updatedAt: string }> }

const PLANE_LABELS: Record<string, string> = {
  embedded_managed: "Embedded (managed)",
  extended: "Extended / BYOAI",
  migration_internal: "Migration-internal",
};

export default function AiFleetPage() {
  const { request } = useOperatorSession();
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [f, c] = await Promise.all([request("/management/v1/ai/fleet/summary"), request("/management/v1/ai/catalog")]);
      if (!f.ok) { setError(f.status === 403 ? "You need the ai.read scope to view AI state." : "Could not load fleet AI state."); return; }
      setFleet(await f.json());
      if (c.ok) setCatalog(await c.json());
    } catch {
      setError("Could not load fleet AI state.");
    }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="page-header">
        <h1 className="text-display">AI</h1>
        <p>Fleet AI usage, provider/model posture and quota risk, read live from module_ai.</p>
      </div>

      {error && <ErrorState label={error} />}
      {fleet && (
        <>
          <EnforcementGaps facts={fleet.enforcement} />
          <p className="overlay-note" style={{ marginTop: 0 }}>
            Observed {when(fleet.observedAt)} · module_ai entitled tenants: {fleet.entitlement.moduleAiEntitledTenants}
            {fleet.entitlement.moduleAiExplicitlyDisabled ? ` · explicitly disabled: ${fleet.entitlement.moduleAiExplicitlyDisabled}` : ""}
          </p>

          <h3 className="text-subhead" style={{ margin: "1rem 0 0.5rem" }}>Usage by plane (successful attempts, UTC windows)</h3>
          <table className="data-table">
            <thead><tr><th>Plane</th><th>Source</th><th>Tokens today / week / month</th><th>Requests month</th><th>Estimated cost month</th></tr></thead>
            <tbody>
              {fleet.planes.map((p) => (
                <tr key={p.plane}>
                  <td>{PLANE_LABELS[p.plane] ?? p.plane}</td>
                  <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{p.source}{p.gatedBy ? ` · gated by ${p.gatedBy}` : ""}</td>
                  <td>{fmtNumber(p.tokens.day)} / {fmtNumber(p.tokens.week)} / {fmtNumber(p.tokens.month)}</td>
                  <td>{fmtNumber(p.requests.month)}</td>
                  <td>{fmtCost(p.estimatedCost.month)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="overlay-note">Estimated cost uses versioned pricing; reconciled provider cost: <NotModelledNote value={fleet.reconciliationExceptions} /></p>

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Providers and models</h3>
          <table className="data-table">
            <thead><tr><th>Provider</th><th>Status</th><th>Executor</th><th>Plane</th><th>Credentials</th><th>Models (lifecycle · certification)</th></tr></thead>
            <tbody>
              {fleet.providers.map((p) => (
                <tr key={p.providerKey}>
                  <td><span style={{ fontFamily: "monospace" }}>{p.providerKey}</span><div className="overlay-note" style={{ marginTop: 0 }}>{p.displayName}</div></td>
                  <td>
                    <StatusBadge value={p.status} />
                    <div className="overlay-note" style={{ marginTop: 0 }}>enforced: {p.enforcement.statusEnforced.replace("_", " ")}</div>
                  </td>
                  <td>{p.governedVia === "migration_internal_direct" ? "Migration (own pool)" : p.adapterRegistered ? "AI execution service" : "no adapter"}</td>
                  <td>{PLANE_LABELS[p.plane] ?? p.plane}</td>
                  <td>{p.credentialSource}</td>
                  <td>
                    {p.models.map((m) => (
                      <div key={m.modelKey} style={{ fontSize: "0.8rem" }}>
                        {m.modelKey} · <StatusBadge value={m.lifecycle} /> · <StatusBadge value={m.certification} />
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Quota risk (≥ 80% of a hard limit)</h3>
          {fleet.quotaRisk.length === 0 ? (
            <EmptyState label="No tenant is at or above 80% of a hard AI quota." icon="speed" />
          ) : (
            <table className="data-table">
              <thead><tr><th>Tenant</th><th>Period</th><th>Metric</th><th>Used / hard</th><th>State</th></tr></thead>
              <tbody>
                {fleet.quotaRisk.map((q) => (
                  <tr key={q.policyId}>
                    <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{q.tenantId}</td>
                    <td>{q.period}</td><td>{q.limitType}</td>
                    <td>{fmtNumber(q.used)} / {fmtNumber(q.hard)}</td>
                    <td><StatusBadge value={q.state} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Top this month</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))", gap: "1rem" }}>
            <TopList title="Tenants" rows={fleet.top.tenants.map((t) => [t.tenantId, t.totalTokens])} mono />
            <TopList title="Capabilities" rows={fleet.top.capabilities.map((c) => [c.capabilityKey, c.totalTokens])} mono />
            <TopList title="Models" rows={fleet.top.models.map((m) => [`${m.providerKey}/${m.modelKey ?? "?"}`, m.totalTokens])} mono />
          </div>

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Provider health (7 days, all attempts)</h3>
          {fleet.providerHealth7d.length === 0 ? (
            <EmptyState label="No provider attempts in the last 7 days." icon="monitor_heart" />
          ) : (
            <table className="data-table">
              <thead><tr><th>Provider</th><th>Attempts</th><th>Failures</th><th>Rate limited</th></tr></thead>
              <tbody>
                {fleet.providerHealth7d.map((h) => (
                  <tr key={h.providerKey}><td>{h.providerKey}</td><td>{h.attempts}</td><td>{h.failures}</td><td>{h.rateLimited}</td></tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Exceptions</h3>
          <p style={{ fontSize: "0.85rem", margin: 0 }}>Metering: <NotModelledNote value={fleet.meteringExceptions} /> · Reconciliation: <NotModelledNote value={fleet.reconciliationExceptions} /></p>

          {catalog && catalog.legacyKillSwitches.length > 0 && (
            <>
              <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Legacy AI kill switches</h3>
              <p className="overlay-note" style={{ marginTop: 0 }}>Still toggled by the legacy /admin/ai-libraries route (instrumented; retirement pending in 1A.15). Read-only here.</p>
              <table className="data-table">
                <thead><tr><th>Library</th><th>State</th><th>Updated</th></tr></thead>
                <tbody>
                  {catalog.legacyKillSwitches.map((l) => (
                    <tr key={l.libraryKey}><td>{l.libraryKey}</td><td><StatusBadge value={l.enabled ? "active" : "disabled"} /></td><td>{when(l.updatedAt)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </>
  );
}

function TopList({ title, rows, mono = false }: { title: string; rows: Array<[string, number]>; mono?: boolean }) {
  return (
    <div className="card" style={{ fontSize: "0.85rem" }}>
      <strong>{title}</strong>
      {rows.length === 0 ? (
        <p className="overlay-note">No usage this month.</p>
      ) : (
        <ol style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem" }}>
          {rows.map(([label, tokens]) => (
            <li key={label}><span style={mono ? { fontFamily: "monospace", fontSize: "0.8rem" } : undefined}>{label}</span> — {fmtNumber(tokens)} tokens</li>
          ))}
        </ol>
      )}
    </div>
  );
}
