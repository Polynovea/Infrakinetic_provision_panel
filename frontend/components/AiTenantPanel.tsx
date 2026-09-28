"use client";

import { useEffect, useState } from "react";

import { StatusBadge } from "./StatusBadge";
import { ErrorState } from "./States";
import {
  type AiEnforcementFacts, EnforcementGaps, fmtCost, fmtNumber, isNotModelled, MISMATCH_LABELS, type NotModelled, NotModelledNote, when,
} from "./AiShared";

// Phase 1A.15 Slice 1 — per-tenant AI state, read-only (ai.read). Owner-
// composed live by module_ai; Governance stores nothing. Commercial usage
// (successful attempts, tokens/cost) and attempt telemetry are shown
// separately, and Migration's own AI volume is its own section — never
// folded into module_ai totals.

interface Window { since: string; totalTokens: number; estimatedCost: number; currency: string | null }

interface TenantAiState {
  moduleAi: { entitled: boolean; explicitRow: boolean; platformEngineState: string };
  rootPolicy: { source: string; policyVersion: number; allowedPlanes: string[]; commissioningMode: string; billingAnchorDay: number };
  emergency: { state: "none" | "suspended"; reason: string | null; recoveryIntent: string | null; since: string | null };
  planes: Array<{ plane: string; desired: { allowed: boolean; source: string }; effective: boolean; mismatchReason?: string }>;
  capabilities: Array<{
    capabilityKey: string; ownerEngine: string; plane: string; effective: boolean; mismatchReason?: string;
    commissioning: { mode: string; commissioned: boolean };
    featureFlag: { key: string; explicitRow: boolean; enabled: boolean } | null; providerKey: string | null; modelKey: string | null;
  }>;
  quotas: Array<{
    policyId: string; origin: string; scope: { type: string; key: string | null; plane: string | null }; period: string;
    window: { start: string; end: string }; limitType: string; hard: number; warningPct: number | null; softLimit: number | null;
    overage: { mode: string; graceActiveForWindow: boolean; graceLimit: number | null; graceExpiresAt: string | null };
    used: number | null; state: string;
  }>;
  usage: {
    commercial: { day: Window; week: Window; month: Window; billingPeriod: Window };
    telemetry: {
      attempts: { total: number; logicalRequests: number; success: number; failed: number; retries: number; timeouts: number; providerFailures: number };
      evidence: { requests: number; open: number };
      policyDenials: NotModelled;
      lastUsageAt: string | null;
    };
  };
  migrationInternal: { gatedBy: string; providerStatus: string | null; month: { requests: number; totalTokens: number; estimatedCost: number; currency: string | null } };
  credentialRefs: NotModelled;
  enforcement: AiEnforcementFacts;
  observedAt: string;
}

const section = { margin: "1rem 0 0.4rem", fontSize: "0.9rem" } as const;

export function AiTenantPanel({ tenantId, request }: { tenantId: string; request: (path: string, init?: RequestInit) => Promise<Response> }) {
  const [state, setState] = useState<TenantAiState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request(`/management/v1/ai/tenants/${encodeURIComponent(tenantId)}/state`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setError("Could not load AI state."); return; }
        setState(await res.json());
      })
      .catch(() => !cancelled && setError("Could not load AI state."));
    return () => { cancelled = true; };
  }, [request, tenantId]);

  return (
    <>
      <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>AI</h3>
      {error && <ErrorState label={error} />}
      {state && (
        <>
          <EnforcementGaps facts={state.enforcement} />
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", fontSize: "0.85rem" }}>
            <span>module_ai: <StatusBadge value={state.moduleAi.entitled ? "active" : "disabled"} /> {state.moduleAi.explicitRow ? "" : "(default)"}</span>
            <span>Platform state: <StatusBadge value={state.moduleAi.platformEngineState} /></span>
            <span>Emergency: <StatusBadge value={state.emergency.state === "suspended" ? "suspended" : "active"} /></span>
            <span>Root policy: {state.rootPolicy.source === "default" ? "default (compatibility)" : `v${state.rootPolicy.policyVersion}`} · {state.rootPolicy.commissioningMode} · billing anchor day {state.rootPolicy.billingAnchorDay}</span>
            <span className="overlay-note" style={{ marginTop: 0 }}>Observed {when(state.observedAt)}</span>
          </div>

          {state.emergency.state === "suspended" && (
            <div className="card" style={{ margin: "0.5rem 0", fontSize: "0.85rem", borderColor: "var(--danger-fg)" }}>
              <strong>Tenant AI is under emergency suspension</strong> since {when(state.emergency.since)} — no AI provider call is made for this tenant.
              <div>Reason: {state.emergency.reason}</div>
              <div>Recovery intent: {state.emergency.recoveryIntent}</div>
            </div>
          )}

          <h4 style={section}>Planes</h4>
          <table className="data-table">
            <thead><tr><th>Plane</th><th>Desired (root)</th><th>Effective</th><th>Reason</th></tr></thead>
            <tbody>
              {state.planes.map((p) => (
                <tr key={p.plane}>
                  <td>{p.plane}</td>
                  <td>{p.desired.allowed ? "allowed" : "not allowed"}{p.desired.source === "default" ? " (default)" : ""}</td>
                  <td><StatusBadge value={p.effective ? "active" : "disabled"} /></td>
                  <td>{p.mismatchReason ? MISMATCH_LABELS[p.mismatchReason] ?? p.mismatchReason : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 style={section}>Capabilities</h4>
          <table className="data-table">
            <thead><tr><th>Capability</th><th>Provider / model</th><th>Commissioning</th><th>Feature flag</th><th>Effective</th><th>Reason</th></tr></thead>
            <tbody>
              {state.capabilities.map((c) => (
                <tr key={c.capabilityKey}>
                  <td style={{ fontFamily: "monospace" }}>{c.capabilityKey}</td>
                  <td>{c.providerKey ?? "—"}{c.modelKey ? ` / ${c.modelKey}` : ""}</td>
                  <td>{c.commissioning.mode === "explicit" ? (c.commissioning.commissioned ? "commissioned" : "not commissioned") : "legacy additive"}</td>
                  <td>{c.featureFlag ? `${c.featureFlag.enabled ? "on" : "off"}${c.featureFlag.explicitRow ? "" : " (default)"}` : "—"}</td>
                  <td><StatusBadge value={c.effective ? "active" : "disabled"} /></td>
                  <td>{c.mismatchReason ? MISMATCH_LABELS[c.mismatchReason] ?? c.mismatchReason : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 style={section}>Quotas</h4>
          {state.quotas.length === 0 ? (
            <p className="overlay-note">No quota policies — the runtime applies no tenant limit.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Scope</th><th>Period (UTC window)</th><th>Metric</th><th>Used / hard</th><th>Thresholds</th><th>State</th></tr></thead>
              <tbody>
                {state.quotas.map((q) => (
                  <tr key={q.policyId}>
                    <td>{q.scope.type}{q.scope.key ? `=${q.scope.key}` : ""}{q.scope.plane ? ` (${q.scope.plane})` : ""}</td>
                    <td>{q.period}<div className="overlay-note" style={{ marginTop: 0 }}>{when(q.window.start)} → {when(q.window.end)}</div></td>
                    <td>{q.limitType}</td>
                    <td>{q.used === null ? "—" : fmtNumber(q.used)} / {fmtNumber(q.hard)}</td>
                    <td style={{ fontSize: "0.8rem" }}>
                      {q.warningPct !== null ? `warn ${Math.round(q.warningPct * 100)}%` : "no warning"}
                      {q.softLimit !== null ? ` · soft ${fmtNumber(q.softLimit)}` : ""}
                      {q.overage.graceActiveForWindow ? ` · grace +${fmtNumber(q.overage.graceLimit ?? 0)} until ${when(q.overage.graceExpiresAt)}` : ""}
                    </td>
                    <td><StatusBadge value={q.state} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4 style={section}>Usage — commercial (successful attempts)</h4>
          <table className="data-table">
            <thead><tr><th>Window</th><th>Tokens</th><th>Estimated cost</th></tr></thead>
            <tbody>
              {(["day", "week", "month"] as const).map((k) => (
                <tr key={k}>
                  <td>{k === "day" ? "Today (UTC)" : k === "week" ? "This week (UTC)" : "This month (UTC)"}</td>
                  <td>{fmtNumber(state.usage.commercial[k].totalTokens)}</td>
                  <td>{fmtCost(state.usage.commercial[k].estimatedCost, state.usage.commercial[k].currency)}</td>
                </tr>
              ))}
              <tr>
                <td>Billing period (from {when(state.usage.commercial.billingPeriod.since)})</td>
                <td>{fmtNumber(state.usage.commercial.billingPeriod.totalTokens)}</td>
                <td>{fmtCost(state.usage.commercial.billingPeriod.estimatedCost, state.usage.commercial.billingPeriod.currency)}</td>
              </tr>
            </tbody>
          </table>

          <h4 style={section}>Telemetry this month (all attempts)</h4>
          <p style={{ fontSize: "0.85rem", margin: 0 }}>
            {fmtNumber(state.usage.telemetry.attempts.logicalRequests)} requests · {fmtNumber(state.usage.telemetry.attempts.total)} attempts ·{" "}
            {state.usage.telemetry.attempts.success} success · {state.usage.telemetry.attempts.failed} failed · {state.usage.telemetry.attempts.retries} retries ·{" "}
            {state.usage.telemetry.attempts.timeouts} timeouts · {state.usage.telemetry.attempts.providerFailures} provider failures ·{" "}
            {state.usage.telemetry.evidence.open} open requests · last usage {when(state.usage.telemetry.lastUsageAt)}
          </p>
          <p style={{ fontSize: "0.85rem", margin: "0.25rem 0 0" }}>Policy / quota denials: <NotModelledNote value={state.usage.telemetry.policyDenials} /></p>

          <h4 style={section}>Migration-internal AI (separate pool)</h4>
          <p style={{ fontSize: "0.85rem", margin: 0 }}>
            Gated by {state.migrationInternal.gatedBy}, not module_ai · provider {state.migrationInternal.providerStatus ?? "unregistered"} ·
            this month {fmtNumber(state.migrationInternal.month.requests)} requests, {fmtNumber(state.migrationInternal.month.totalTokens)} tokens,{" "}
            {fmtCost(state.migrationInternal.month.estimatedCost, state.migrationInternal.month.currency)}
          </p>

          <p style={{ fontSize: "0.85rem", margin: "0.75rem 0 0" }}>Credential references: <NotModelledNote value={state.credentialRefs} /></p>
        </>
      )}
    </>
  );
}
