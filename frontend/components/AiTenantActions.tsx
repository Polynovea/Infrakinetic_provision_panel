"use client";

import { useState } from "react";

import { useOperatorSession } from "../lib/session";
import { ActionDialog, quotaPolicyKey } from "./AiActions";
import { fmtNumber } from "./AiShared";

// Phase 1A.15 final closure — per-tenant AI operator actions. Each dialog is a thin form over ONE contract
// route; the backend enforces scope, step-up, risk class and the strict request schema, and the owner
// validates and executes. The buttons that open these dialogs are only shown when the operator holds the
// route's scope (see AiTenantPanel), but that is convenience — the backend is the control.
//
//   suspend                       R4  fresh step-up, recovery intent            ai.emergency_suspend
//   resume                        R3  request -> a different operator approves   ai.emergency_suspend
//   planes / commission / mode    R2                                            ai.entitlement.write
//   quota set/remove/grace, anchor R2                                           ai.quota.write
//   tenant model policy           R2                                            ai.provider_policy.write
//   revoke a BYOAI credential     R2  no fields at all                          credentials.revoke

const BASE = (tenantId: string) => `/management/v1/ai/tenants/${encodeURIComponent(tenantId)}`;
export const AI_PLANES = ["embedded_managed", "extended"] as const;
const MODES = ["legacy_additive", "explicit"] as const;
const SCOPE_TYPES = ["tenant", "ai_plane", "engine", "capability", "user", "provider", "model"] as const;
const PERIODS = ["daily", "weekly", "monthly", "billing_period"] as const;
const LIMIT_TYPES = ["tokens", "requests", "cost", "units"] as const;

interface Common { tenantId: string; onClose: () => void; onDone: () => void }

export interface QuotaRow {
  policyKey?: string;
  scope: { type: string; key: string | null; plane: string | null };
  period: string;
  limitType: string;
  hard: number;
  warningPct: number | null;
  softLimit: number | null;
  enabled: boolean;
  overage: { graceActiveForWindow: boolean; graceLimit: number | null };
}

export function SuspendDialog({ tenantId, onClose, onDone }: Common) {
  const [recoveryIntent, setRecoveryIntent] = useState("");
  return (
    <ActionDialog
      title="Emergency-suspend this tenant's AI?"
      description="No AI provider call will be made for this tenant until it is resumed. Resuming needs a second operator's approval."
      confirmLabel="Suspend AI"
      danger
      canSubmit={recoveryIntent.trim() !== ""}
      build={(reason, idempotencyKey) => ({ method: "POST", path: `${BASE(tenantId)}/suspend`, body: { idempotencyKey, reason, recoveryIntent: recoveryIntent.trim() } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field">
        <label>Recovery intent</label>
        <textarea rows={2} value={recoveryIntent} onChange={(e) => setRecoveryIntent(e.target.value)} placeholder="How and when will AI be restored for this tenant?" />
      </div>
    </ActionDialog>
  );
}

export function ResumeDialog({ tenantId, onClose, onDone }: Common) {
  return (
    <ActionDialog
      title="Request to resume this tenant's AI"
      description="Resume is a maker-checker action: this creates an approval for a different operator to decide, then execute. The approval binds the suspension you are looking at; execution is refused if it has changed."
      confirmLabel="Request resume"
      build={(reason) => ({ method: "POST", path: `${BASE(tenantId)}/resume/request`, body: { reason } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function PlanesDialog({ tenantId, current, onClose, onDone }: Common & { current: string[] }) {
  const [selected, setSelected] = useState<string[]>(current);
  const changed = [...selected].sort().join() !== [...current].sort().join();
  return (
    <ActionDialog
      title="Allowed AI planes"
      description="The root ceiling of which planes this tenant may use. A plane also needs a commissioned capability to be effective."
      confirmLabel="Set planes"
      canSubmit={selected.length > 0 && changed}
      build={(reason, idempotencyKey) => ({ method: "PUT", path: `${BASE(tenantId)}/planes`, body: { idempotencyKey, reason, planes: AI_PLANES.filter((p) => selected.includes(p)) } })}
      onClose={onClose}
      onDone={onDone}
    >
      {AI_PLANES.map((plane) => (
        <label key={plane} style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.9rem" }}>
          <input type="checkbox" checked={selected.includes(plane)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, plane] : s.filter((p) => p !== plane)))} />
          {plane}
        </label>
      ))}
      {selected.length === 0 && <p className="field-hint">At least one plane is required.</p>}
    </ActionDialog>
  );
}

interface ModeChange { capabilityKey: string; plane: string; before: { effective: boolean }; after: { effective: boolean; mismatchReason?: string } }
interface ModePreview { currentMode: string; targetMode: string; changes: ModeChange[]; losing: number; gaining: number; diffHash: string }

export function ModeDialog({ tenantId, current, onClose, onDone }: Common & { current: string }) {
  const { request } = useOperatorSession();
  const [mode, setMode] = useState<string>(current === "explicit" ? "legacy_additive" : "explicit");
  const [preview, setPreview] = useState<ModePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runPreview() {
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await request(`${BASE(tenantId)}/commissioning-mode/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      const out = await res.json();
      if (!res.ok) { setError(out.message ?? out.error ?? "Preview failed."); return; }
      setPreview(out as ModePreview);
    } catch {
      setError("Preview failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <ActionDialog
      title="Commissioning mode"
      description="Explicit mode requires a commissioned row for a capability to run; legacy-additive lets the tenant feature flag alone decide. Preview the exact effect first — the apply is bound to that preview and is refused if the diff has since changed."
      confirmLabel="Apply mode"
      canSubmit={preview !== null && preview.targetMode === mode}
      build={(reason, idempotencyKey) => ({ method: "PUT", path: `${BASE(tenantId)}/commissioning-mode`, body: { idempotencyKey, reason, mode, expectedDiffHash: preview?.diffHash } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field">
        <label>Target mode (currently {current})</label>
        <select value={mode} onChange={(e) => { setMode(e.target.value); setPreview(null); }}>
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <button className="btn" onClick={runPreview} disabled={loading || mode === current}>{loading ? "Previewing…" : "Preview effect"}</button>
      {error && <p role="alert" style={{ color: "var(--danger-fg)", fontSize: "0.85rem", margin: 0 }}>{error}</p>}
      {preview && (
        <div style={{ fontSize: "0.85rem" }}>
          <strong>{preview.losing}</strong> capability(ies) lose access, <strong>{preview.gaining}</strong> gain access.
          {preview.changes.length > 0 && (
            <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.2rem" }}>
              {preview.changes.map((c) => (
                <li key={`${c.capabilityKey}/${c.plane}`}><span style={{ fontFamily: "monospace" }}>{c.capabilityKey}</span> ({c.plane}): {c.before.effective ? "effective" : "not effective"} → {c.after.effective ? "effective" : `not effective${c.after.mismatchReason ? ` (${c.after.mismatchReason})` : ""}`}</li>
              ))}
            </ul>
          )}
          <p className="field-hint" style={{ wordBreak: "break-all" }}>Bound to diff {preview.diffHash.slice(0, 16)}…</p>
        </div>
      )}
    </ActionDialog>
  );
}

export function AnchorDialog({ tenantId, current, onClose, onDone }: Common & { current: number }) {
  const [day, setDay] = useState(String(current));
  const parsed = Number(day);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 28 && parsed !== current;
  return (
    <ActionDialog
      title="Billing anchor day"
      description="The day of the month a billing-period quota window starts. 1–28 so every month has it."
      confirmLabel="Set anchor"
      canSubmit={valid}
      build={(reason, idempotencyKey) => ({ method: "PUT", path: `${BASE(tenantId)}/billing-anchor`, body: { idempotencyKey, reason, billingAnchorDay: parsed } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>Day of month</label><input type="number" min={1} max={28} value={day} onChange={(e) => setDay(e.target.value)} /></div>
    </ActionDialog>
  );
}

export function CommissionDialog({ tenantId, capabilityKey, plane, to, mode, onClose, onDone }: Common & { capabilityKey: string; plane: string; to: "commissioned" | "decommissioned"; mode: string }) {
  return (
    <ActionDialog
      title={`${to === "commissioned" ? "Commission" : "Decommission"} ${capabilityKey}`}
      description={mode === "explicit"
        ? "This tenant is in explicit mode: the change takes effect immediately."
        : "This tenant is in legacy-additive mode: the change is recorded now but only takes effect once the tenant is switched to explicit mode."}
      confirmLabel={to === "commissioned" ? "Commission" : "Decommission"}
      danger={to === "decommissioned" && mode === "explicit"}
      build={(reason, idempotencyKey) => ({ method: "PUT", path: `${BASE(tenantId)}/capabilities/${encodeURIComponent(capabilityKey)}`, body: { idempotencyKey, reason, plane, state: to } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

const optionalNumber = (text: string): number | null | "invalid" => {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
};

export function QuotaDialog({ tenantId, existing, onClose, onDone }: Common & { existing?: QuotaRow }) {
  const [scopeType, setScopeType] = useState(existing?.scope.type ?? "tenant");
  const [scopeKey, setScopeKey] = useState(existing?.scope.key ?? "");
  const [aiPlane, setAiPlane] = useState(existing?.scope.plane ?? "");
  const [period, setPeriod] = useState(existing?.period ?? "monthly");
  const [limitType, setLimitType] = useState(existing?.limitType ?? "requests");
  const [usageUnit, setUsageUnit] = useState("");
  const [hard, setHard] = useState(existing ? String(existing.hard) : "");
  const [soft, setSoft] = useState(existing?.softLimit != null ? String(existing.softLimit) : "");
  const [warnPct, setWarnPct] = useState(existing?.warningPct != null ? String(Math.round(existing.warningPct * 100)) : "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);

  const hardValue = optionalNumber(hard);
  const softValue = optionalNumber(soft);
  const warnValue = optionalNumber(warnPct);
  const warnFraction = typeof warnValue === "number" ? warnValue / 100 : warnValue;
  const policy = { scopeType, scopeKey: scopeKey.trim() === "" ? null : scopeKey.trim(), aiPlane: aiPlane === "" ? null : aiPlane, period, limitType, usageUnit: limitType === "units" && usageUnit.trim() !== "" ? usageUnit.trim() : null };
  // An existing row is addressed by the key the owner reported; a new one by the derived key (the owner refuses a mismatch).
  const policyKey = existing?.policyKey ?? quotaPolicyKey(policy);
  const editingUnits = Boolean(existing && existing.limitType === "units");
  const valid = policyKey !== null && !editingUnits && typeof hardValue === "number" && softValue !== "invalid" && warnValue !== "invalid"
    && (warnFraction === null || (typeof warnFraction === "number" && warnFraction > 0 && warnFraction < 1))
    && (limitType !== "units" || policy.usageUnit !== null)
    && (scopeType === "tenant" || scopeKey.trim() !== "" || scopeType === "ai_plane");

  return (
    <ActionDialog
      title={existing ? "Edit quota limits" : "Add a quota policy"}
      description="A hard limit refuses requests once reached in the window. The warning and soft thresholds only change the reported state. Identity fields of an existing policy cannot be edited — remove it and add a new one."
      confirmLabel={existing ? "Save limits" : "Add quota"}
      canSubmit={valid}
      build={(reason, idempotencyKey) => ({
        method: "PUT",
        path: `${BASE(tenantId)}/quotas/${encodeURIComponent(policyKey as string)}`,
        body: { idempotencyKey, reason, policy: { ...policy, hardLimit: hardValue, softLimit: softValue, warningPct: warnFraction, enabled } },
      })}
      onClose={onClose}
      onDone={onDone}
    >
      {editingUnits && <p className="field-hint">Units-based policies carry a unit this view does not show; they are managed owner-side.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
        <div className="field"><label>Scope</label>
          <select value={scopeType} onChange={(e) => setScopeType(e.target.value)} disabled={Boolean(existing)}>{SCOPE_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div className="field"><label>Scope key</label><input value={scopeKey} onChange={(e) => setScopeKey(e.target.value)} disabled={Boolean(existing) || scopeType === "tenant"} placeholder={scopeType === "tenant" ? "(whole tenant)" : "e.g. capability or provider key"} /></div>
        <div className="field"><label>Plane</label>
          <select value={aiPlane} onChange={(e) => setAiPlane(e.target.value)} disabled={Boolean(existing)}><option value="">any</option>{AI_PLANES.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
        <div className="field"><label>Period</label>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} disabled={Boolean(existing)}>{PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
        <div className="field"><label>Metric</label>
          <select value={limitType} onChange={(e) => setLimitType(e.target.value)} disabled={Boolean(existing)}>{LIMIT_TYPES.map((l) => <option key={l} value={l}>{l}</option>)}</select></div>
        {limitType === "units" && !existing && <div className="field"><label>Unit</label><input value={usageUnit} onChange={(e) => setUsageUnit(e.target.value)} /></div>}
        <div className="field"><label>Hard limit</label><input type="number" min={0} value={hard} onChange={(e) => setHard(e.target.value)} /></div>
        <div className="field"><label>Soft limit (optional)</label><input type="number" min={0} value={soft} onChange={(e) => setSoft(e.target.value)} /></div>
        <div className="field"><label>Warn at % (optional)</label><input type="number" min={1} max={99} value={warnPct} onChange={(e) => setWarnPct(e.target.value)} /></div>
      </div>
      <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", fontSize: "0.9rem" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enforced
      </label>
      {policyKey === null && <p className="field-hint">These identity fields cannot form a valid policy address.</p>}
    </ActionDialog>
  );
}

export function QuotaRemoveDialog({ tenantId, quota, onClose, onDone }: Common & { quota: QuotaRow }) {
  return (
    <ActionDialog
      title="Remove this quota policy?"
      description={`The ${quota.period} ${quota.limitType} limit of ${fmtNumber(quota.hard)} (${quota.scope.type}${quota.scope.key ? `=${quota.scope.key}` : ""}) stops applying immediately${quota.overage.graceActiveForWindow ? ", including its active grace" : ""}.`}
      confirmLabel="Remove quota"
      danger
      build={(reason, idempotencyKey) => ({ method: "DELETE", path: `${BASE(tenantId)}/quotas/${encodeURIComponent(quota.policyKey as string)}`, body: { idempotencyKey, reason } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function GraceDialog({ tenantId, quota, onClose, onDone }: Common & { quota: QuotaRow }) {
  const [limit, setLimit] = useState("");
  const [expires, setExpires] = useState("");
  const limitValue = Number(limit);
  const expiresAt = expires === "" ? null : new Date(expires);
  const valid = limit.trim() !== "" && Number.isFinite(limitValue) && limitValue > 0 && limitValue <= quota.hard && expiresAt !== null && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > Date.now();
  return (
    <ActionDialog
      title="Grant temporary grace"
      description={`Lets this window run past the hard limit of ${fmtNumber(quota.hard)} by up to the grace amount. The grace can be no larger than the hard limit and ends within 31 days.`}
      confirmLabel="Grant grace"
      canSubmit={valid}
      build={(reason, idempotencyKey) => ({ method: "POST", path: `${BASE(tenantId)}/quotas/${encodeURIComponent(quota.policyKey as string)}/grace`, body: { idempotencyKey, reason, graceLimit: limitValue, expiresAt: (expiresAt as Date).toISOString() } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>Extra allowance (same unit as the limit)</label><input type="number" min={0} value={limit} onChange={(e) => setLimit(e.target.value)} /></div>
      <div className="field"><label>Grace ends</label><input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
    </ActionDialog>
  );
}

export interface ProviderChoice { providerKey: string; models: Array<{ modelKey: string }> }

export function ModelPolicyDialog({ tenantId, providers, onClose, onDone }: Common & { providers: ProviderChoice[] }) {
  const [providerKey, setProviderKey] = useState(providers[0]?.providerKey ?? "");
  const [modelKey, setModelKey] = useState("");
  const [decision, setDecision] = useState<"deny" | "allow">("deny");
  const models = providers.find((p) => p.providerKey === providerKey)?.models ?? [];
  return (
    <ActionDialog
      title="Tenant provider / model policy"
      description="A deny blocks this provider (or one model) for this tenant only. An allow never overrides a global restriction — it only lifts an earlier tenant deny."
      confirmLabel={decision === "deny" ? "Deny" : "Allow"}
      danger={decision === "deny"}
      canSubmit={providerKey !== ""}
      build={(reason, idempotencyKey) => ({ method: "PUT", path: `${BASE(tenantId)}/model-policy`, body: { idempotencyKey, reason, providerKey, modelKey: modelKey === "" ? null : modelKey, decision } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>Provider</label>
        <select value={providerKey} onChange={(e) => { setProviderKey(e.target.value); setModelKey(""); }}>{providers.map((p) => <option key={p.providerKey} value={p.providerKey}>{p.providerKey}</option>)}</select></div>
      <div className="field"><label>Model</label>
        <select value={modelKey} onChange={(e) => setModelKey(e.target.value)}><option value="">whole provider</option>{models.map((m) => <option key={m.modelKey} value={m.modelKey}>{m.modelKey}</option>)}</select></div>
      <div className="field"><label>Decision</label>
        <select value={decision} onChange={(e) => setDecision(e.target.value as "deny" | "allow")}><option value="deny">deny</option><option value="allow">allow</option></select></div>
    </ActionDialog>
  );
}

export function RevokeCredentialDialog({ tenantId, refId, hint, onClose, onDone }: Common & { refId: string; hint: string | null }) {
  return (
    <ActionDialog
      title="Revoke this tenant credential?"
      description={`The tenant's BYOAI credential ${hint ?? refId} stops working immediately and cannot be re-enabled. The tenant can submit a replacement themselves. This never displays or handles the key itself.`}
      confirmLabel="Revoke credential"
      danger
      build={(reason, idempotencyKey) => ({ method: "POST", path: `${BASE(tenantId)}/credentials/${encodeURIComponent(refId)}/revoke`, body: { idempotencyKey, reason } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
