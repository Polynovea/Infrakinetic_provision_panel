"use client";

import { useCallback, useEffect, useState } from "react";

import { useOperatorSession } from "../lib/session";
import { StatusBadge } from "./StatusBadge";
import { ErrorState } from "./States";
import {
  type AiEnforcementFacts, EnforcementGaps, fmtCost, fmtNumber, isNotModelled, MISMATCH_LABELS, type NotModelled, NotModelledNote, when,
} from "./AiShared";
import {
  AnchorDialog, CommissionDialog, GraceDialog, ModeDialog, ModelPolicyDialog, PlanesDialog, QuotaDialog, QuotaRemoveDialog,
  ResumeDialog, RevokeCredentialDialog, SuspendDialog, type ProviderChoice, type QuotaRow,
} from "./AiTenantActions";

// Phase 1A.15 — per-tenant AI state (ai.read) and the operator actions over it. Owner-composed live by
// module_ai; Governance stores nothing. Commercial usage (successful attempts, tokens/cost) and attempt
// telemetry are shown separately, and Migration's own AI volume is its own section — never folded into
// module_ai totals. Action buttons appear only for the scopes the operator holds; the backend re-checks every
// scope, step-up and the risk class, so hiding a button is convenience, not control.

interface Window { since: string; totalTokens: number; estimatedCost: number; currency: string | null }

interface CredentialRef { refId: string; providerKey: string; version: number; status: string; maskedHint: string | null; createdAt: string; revokedAt: string | null }

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
  providersModels: Array<{ providerKey: string; models: Array<{ modelKey: string }> }>;
  quotas: Array<QuotaRow & {
    policyId: string; origin: string;
    window: { start: string; end: string };
    overage: { mode: string; graceActiveForWindow: boolean; graceLimit: number | null; graceExpiresAt: string | null };
    used: number | null; state: string;
  }>;
  usage: {
    commercial: { day: Window; week: Window; month: Window; billingPeriod: Window };
    telemetry: {
      attempts: { total: number; logicalRequests: number; success: number; failed: number; retries: number; timeouts: number; providerFailures: number };
      evidence: { requests: number; open: number };
      policyDenials: number | NotModelled;
      quotaDenials?: number | NotModelled;
      denialsByReason?: Record<string, number>;
      lastUsageAt: string | null;
    };
  };
  migrationInternal: { gatedBy: string; providerStatus: string | null; month: { requests: number; totalTokens: number; estimatedCost: number; currency: string | null } };
  credentialRefs: CredentialRef[] | NotModelled;
  delegation?: { allocations: Array<{ allocationId: string; scope: { type: string; key: string | null; plane: string | null }; period: string; limitType: string; allocated: number; rootCeiling: number; effective: number; status: string }> };
  meteringExceptions?: { open: number; resolved?: number; byType: Array<{ type: string; open: number; resolved?: number }> } | NotModelled;
  enforcement: AiEnforcementFacts;
  observedAt: string;
}

type Dialog =
  | { kind: "suspend" } | { kind: "resume" } | { kind: "planes" } | { kind: "mode" } | { kind: "anchor" } | { kind: "policy" } | { kind: "quotaNew" }
  | { kind: "commission"; capabilityKey: string; plane: string; to: "commissioned" | "decommissioned" }
  | { kind: "quotaEdit" | "quotaRemove" | "grace"; quota: QuotaRow }
  | { kind: "revoke"; refId: string; hint: string | null };

const section = { margin: "1rem 0 0.4rem", fontSize: "0.9rem" } as const;
const small = { fontSize: "0.75rem", padding: "0.15rem 0.5rem" } as const;

export function AiTenantPanel({ tenantId, request }: { tenantId: string; request: (path: string, init?: RequestInit) => Promise<Response> }) {
  const { operator } = useOperatorSession();
  const scopes = operator?.scopes ?? [];
  const canEntitle = scopes.includes("ai.entitlement.write");
  const canQuota = scopes.includes("ai.quota.write");
  const canSuspend = scopes.includes("ai.emergency_suspend");
  const canPolicy = scopes.includes("ai.provider_policy.write");
  const canRevoke = scopes.includes("credentials.revoke");

  const [state, setState] = useState<TenantAiState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(async (isCancelled: () => boolean) => {
    try {
      const res = await request(`/management/v1/ai/tenants/${encodeURIComponent(tenantId)}/state`);
      if (isCancelled()) return;
      if (!res.ok) { setError("Could not load AI state."); return; }
      setError(null);
      setState(await res.json());
    } catch {
      if (!isCancelled()) setError("Could not load AI state.");
    }
  }, [request, tenantId]);

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => { cancelled = true; };
  }, [load, refresh]);

  const close = () => setDialog(null);
  const done = () => setRefresh((n) => n + 1);
  const providers: ProviderChoice[] = state?.providersModels ?? [];
  const credentials = state && Array.isArray(state.credentialRefs) ? state.credentialRefs : null;

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
            <span>Emergency stop: <StatusBadge value={state.emergency.state === "suspended" ? "active" : "not active"} /></span>
            <span>Root policy: {state.rootPolicy.source === "default" ? "default (compatibility)" : `v${state.rootPolicy.policyVersion}`} · {state.rootPolicy.commissioningMode} · billing anchor day {state.rootPolicy.billingAnchorDay}</span>
            <span className="overlay-note" style={{ marginTop: 0 }}>Observed {when(state.observedAt)}</span>
          </div>

          {(canSuspend || canEntitle || canQuota || canPolicy) && (
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", margin: "0.6rem 0" }} aria-label="AI operator actions">
              {canSuspend && state.emergency.state === "none" && <button className="btn btn-danger" style={small} onClick={() => setDialog({ kind: "suspend" })}>Emergency stop AI…</button>}
              {canSuspend && state.emergency.state === "suspended" && <button className="btn btn-primary" style={small} onClick={() => setDialog({ kind: "resume" })}>Request AI restoration…</button>}
              {canEntitle && <button className="btn" style={small} onClick={() => setDialog({ kind: "planes" })}>Planes</button>}
              {canEntitle && <button className="btn" style={small} onClick={() => setDialog({ kind: "mode" })}>Commissioning mode</button>}
              {canQuota && <button className="btn" style={small} onClick={() => setDialog({ kind: "anchor" })}>Billing anchor</button>}
              {canQuota && <button className="btn" style={small} onClick={() => setDialog({ kind: "quotaNew" })}>Add quota</button>}
              {canPolicy && <button className="btn" style={small} onClick={() => setDialog({ kind: "policy" })}>Provider / model policy</button>}
            </div>
          )}

          {state.emergency.state === "suspended" && (
            <div className="card" style={{ margin: "0.5rem 0", fontSize: "0.85rem", borderColor: "var(--danger-fg)" }}>
              <strong>Tenant AI is under emergency suspension</strong> since {when(state.emergency.since)} — no AI provider call is made for this tenant.
              <div>Reason: {state.emergency.reason}</div>
              <div>Recovery intent: {state.emergency.recoveryIntent}</div>
            </div>
          )}

          <h4 style={section}>AI access modes</h4>
          <table className="data-table">
            <thead><tr><th>Mode</th><th>Allowed by policy</th><th>Available</th><th>Reason</th></tr></thead>
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
            <thead><tr><th>Capability</th><th>Provider / model</th><th>Commissioning</th><th>Feature flag</th><th>Effective</th><th>Reason</th>{canEntitle && <th />}</tr></thead>
            <tbody>
              {state.capabilities.map((c) => {
                const commissioned = c.commissioning.commissioned;
                return (
                  <tr key={`${c.capabilityKey}/${c.plane}`}>
                    <td style={{ fontFamily: "monospace" }}>{c.capabilityKey}</td>
                    <td>{c.providerKey ?? "—"}{c.modelKey ? ` / ${c.modelKey}` : ""}</td>
                    <td>{c.commissioning.mode === "explicit" ? (commissioned ? "commissioned" : "not commissioned") : "legacy additive"}</td>
                    <td>{c.featureFlag ? `${c.featureFlag.enabled ? "on" : "off"}${c.featureFlag.explicitRow ? "" : " (default)"}` : "—"}</td>
                    <td><StatusBadge value={c.effective ? "active" : "disabled"} /></td>
                    <td>{c.mismatchReason ? MISMATCH_LABELS[c.mismatchReason] ?? c.mismatchReason : "—"}</td>
                    {canEntitle && (
                      <td>
                        <button className="btn" style={small} onClick={() => setDialog({ kind: "commission", capabilityKey: c.capabilityKey, plane: c.plane, to: c.commissioning.mode === "explicit" && commissioned ? "decommissioned" : "commissioned" })}>
                          {c.commissioning.mode === "explicit" && commissioned ? "Decommission" : "Commission"}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>

          <h4 style={section}>Quotas</h4>
          {state.quotas.length === 0 ? (
            <p className="overlay-note">No quota policies — the runtime applies no tenant limit.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Scope</th><th>Period (UTC window)</th><th>Metric</th><th>Used / hard</th><th>Thresholds</th><th>State</th>{canQuota && <th />}</tr></thead>
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
                    {canQuota && (
                      <td style={{ whiteSpace: "nowrap" }}>
                        {q.origin === "root" && q.policyKey ? (
                          <>
                            <button className="btn" style={small} onClick={() => setDialog({ kind: "quotaEdit", quota: q })}>Edit</button>{" "}
                            <button className="btn" style={small} onClick={() => setDialog({ kind: "grace", quota: q })}>Grace</button>{" "}
                            <button className="btn btn-danger" style={small} onClick={() => setDialog({ kind: "quotaRemove", quota: q })}>Remove</button>
                          </>
                        ) : (
                          <span className="overlay-note" style={{ marginTop: 0 }}>{q.origin === "root" ? "not addressable" : "Technology-owned"}</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {state.delegation && state.delegation.allocations.length > 0 && (
            <>
              <h4 style={section}>Delegated allocations (read-only)</h4>
              <table className="data-table">
                <thead><tr><th>Scope</th><th>Period</th><th>Metric</th><th>Allocated</th><th>Root ceiling</th><th>Effective</th><th>Status</th></tr></thead>
                <tbody>
                  {state.delegation.allocations.map((a) => (
                    <tr key={a.allocationId}>
                      <td>{a.scope.type}{a.scope.key ? `=${a.scope.key}` : ""}{a.scope.plane ? ` (${a.scope.plane})` : ""}</td>
                      <td>{a.period}</td><td>{a.limitType}</td>
                      <td>{fmtNumber(a.allocated)}</td><td>{fmtNumber(a.rootCeiling)}</td><td><strong>{fmtNumber(a.effective)}</strong></td>
                      <td><StatusBadge value={a.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="overlay-note">The effective limit is the smaller of the allocation and the root ceiling; allocations are managed by the tenant&apos;s Technology plane, not from here.</p>
            </>
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
          <p style={{ fontSize: "0.85rem", margin: "0.25rem 0 0" }}>
            Policy denials: {isNotModelled(state.usage.telemetry.policyDenials) ? <NotModelledNote value={state.usage.telemetry.policyDenials} /> : fmtNumber(state.usage.telemetry.policyDenials)}
            {" · "}quota denials: {state.usage.telemetry.quotaDenials === undefined ? "—" : isNotModelled(state.usage.telemetry.quotaDenials) ? <NotModelledNote value={state.usage.telemetry.quotaDenials} /> : fmtNumber(state.usage.telemetry.quotaDenials)}
            {state.usage.telemetry.denialsByReason && Object.keys(state.usage.telemetry.denialsByReason).length > 0 && (
              <span className="overlay-note" style={{ marginTop: 0 }}> ({Object.entries(state.usage.telemetry.denialsByReason).map(([reason, n]) => `${reason.replace(/_/g, " ")} ${n}`).join(" · ")})</span>
            )}
          </p>

          <h4 style={section}>Migration-internal AI (separate pool)</h4>
          <p style={{ fontSize: "0.85rem", margin: 0 }}>
            Gated by {state.migrationInternal.gatedBy}, not module_ai · provider {state.migrationInternal.providerStatus ?? "unregistered"} ·
            this month {fmtNumber(state.migrationInternal.month.requests)} requests, {fmtNumber(state.migrationInternal.month.totalTokens)} tokens,{" "}
            {fmtCost(state.migrationInternal.month.estimatedCost, state.migrationInternal.month.currency)}
          </p>

          <h4 style={section}>Metering exceptions</h4>
          <p style={{ fontSize: "0.85rem", margin: 0 }}>
            {state.meteringExceptions === undefined || isNotModelled(state.meteringExceptions)
              ? <NotModelledNote value={state.meteringExceptions ?? { notModelled: true, slice: 3 }} />
              : `${state.meteringExceptions.open} open${state.meteringExceptions.resolved !== undefined ? ` · ${state.meteringExceptions.resolved} resolved` : ""}${state.meteringExceptions.byType.length ? ` (${state.meteringExceptions.byType.map((t) => `${t.type.replace(/_/g, " ")} ${t.open}`).join(", ")})` : ""}`}
          </p>

          <h4 style={section}>Credential references (BYOAI — safe metadata only)</h4>
          {credentials === null ? (
            <p style={{ fontSize: "0.85rem", margin: 0 }}><NotModelledNote value={state.credentialRefs as NotModelled} /></p>
          ) : credentials.length === 0 ? (
            <p className="overlay-note">This tenant has not supplied any AI provider credential.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Reference</th><th>Provider</th><th>Version</th><th>Status</th><th>Hint</th><th>Created</th><th>Revoked</th>{canRevoke && <th />}</tr></thead>
              <tbody>
                {credentials.map((c) => (
                  <tr key={c.refId}>
                    <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{c.refId}</td>
                    <td>{c.providerKey}</td><td>{c.version}</td>
                    <td><StatusBadge value={c.status === "revoked" ? "revoked" : "active"} /></td>
                    <td style={{ fontFamily: "monospace" }}>{c.maskedHint ?? "—"}</td>
                    <td>{when(c.createdAt)}</td><td>{when(c.revokedAt)}</td>
                    {canRevoke && (
                      <td>{c.status !== "revoked" && <button className="btn btn-danger" style={small} onClick={() => setDialog({ kind: "revoke", refId: c.refId, hint: c.maskedHint })}>Revoke</button>}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="overlay-note">Governance can show this metadata and revoke a credential. Keys are submitted, rotated and used only by the tenant and the owner runtime — never through this console.</p>

          {dialog?.kind === "suspend" && <SuspendDialog tenantId={tenantId} onClose={close} onDone={done} />}
          {dialog?.kind === "resume" && <ResumeDialog tenantId={tenantId} onClose={close} onDone={done} />}
          {dialog?.kind === "planes" && <PlanesDialog tenantId={tenantId} current={state.rootPolicy.allowedPlanes} onClose={close} onDone={done} />}
          {dialog?.kind === "mode" && <ModeDialog tenantId={tenantId} current={state.rootPolicy.commissioningMode} onClose={close} onDone={done} />}
          {dialog?.kind === "anchor" && <AnchorDialog tenantId={tenantId} current={state.rootPolicy.billingAnchorDay} onClose={close} onDone={done} />}
          {dialog?.kind === "policy" && <ModelPolicyDialog tenantId={tenantId} providers={providers} onClose={close} onDone={done} />}
          {dialog?.kind === "commission" && <CommissionDialog tenantId={tenantId} capabilityKey={dialog.capabilityKey} plane={dialog.plane} to={dialog.to} mode={state.rootPolicy.commissioningMode} onClose={close} onDone={done} />}
          {dialog?.kind === "quotaNew" && <QuotaDialog tenantId={tenantId} onClose={close} onDone={done} />}
          {dialog?.kind === "quotaEdit" && <QuotaDialog tenantId={tenantId} existing={dialog.quota} onClose={close} onDone={done} />}
          {dialog?.kind === "quotaRemove" && <QuotaRemoveDialog tenantId={tenantId} quota={dialog.quota} onClose={close} onDone={done} />}
          {dialog?.kind === "grace" && <GraceDialog tenantId={tenantId} quota={dialog.quota} onClose={close} onDone={done} />}
          {dialog?.kind === "revoke" && <RevokeCredentialDialog tenantId={tenantId} refId={dialog.refId} hint={dialog.hint} onClose={close} onDone={done} />}
        </>
      )}
    </>
  );
}
