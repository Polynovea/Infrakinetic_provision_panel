"use client";

import { useCallback, useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { EmptyState, ErrorState } from "../../../components/States";
import { ApprovalQueue } from "../../../components/ApprovalQueue";
import {
  type AiEnforcementFacts, EnforcementGaps, fmtCost, fmtNumber, isNotModelled, type NotModelled, NotModelledNote, when,
} from "../../../components/AiShared";
import {
  AiApprovalSummary, ModelCertificationDialog, ModelLifecycleDialog, ProviderStateDialog, ResolveMeteringDialog, ResolveReconciliationDialog,
} from "../../../components/AiFleetActions";
import {
  ManagedCredentialAddDialog, ManagedCredentialRotateDialog, ManagedCredentialStatusDialog, ManagedPoolSourceDialog,
} from "../../../components/AiManagedCredentialActions";

// Phase 1A.15 — fleet AI operator view (ai.read) and the fleet-level actions over it. module_ai composes every
// figure live; Governance stores none of it. Migration-internal volume comes from Migration's own usage table
// and is shown as its own plane, never merged into module_ai totals. Action buttons appear only for the scopes
// the operator holds; the backend re-checks scope, step-up and risk class on every call.

interface Windowed { day: number; week: number; month: number }
interface Plane { plane: string; source: string; gatedBy?: string; tokens: Windowed; requests: Windowed; estimatedCost: Windowed }
interface Provider {
  providerKey: string; displayName: string; status: string; governedVia: string; plane: string; credentialSource: string;
  adapterRegistered: boolean | null; enforcement: { statusEnforced: string; moduleAiGated: boolean };
  models: Array<{ modelKey: string; lifecycle: string; certification: string }>;
}
interface CatalogModel { modelId?: string; modelKey: string; lifecycle: string; certification: string; certificationEvidenceRef?: string | null; lifecycleChangedAt?: string | null; certificationChangedAt?: string | null }
interface Catalog {
  providers: Array<{ providerKey: string; models: CatalogModel[] }>;
  legacyKillSwitches: Array<{ libraryKey: string; enabled: boolean; updatedAt: string }>;
}
interface MeteringSummary { open: number; resolved?: number; byType: Array<{ type: string; open: number }> }
interface CredentialUsage { attempts: number; requests: number; successes: number; failures: number; rateLimited: number; totalTokens: number; estimatedCost: number; currency: string | null; lastAttemptAt: string | null; lastSuccessAt: string | null }
interface ManagedCredential {
  credentialId: string; version: number | null; poolKey: string; label: string; status: string; source: string; maskedHint: string; credentialTag: string;
  createdAt: string | null; supersededAt: string | null; revokedAt: string | null; sharedWithPools: string[]; usage30d: CredentialUsage;
}
interface ManagedPool {
  poolKey: string; providerKey: string; displayName: string; workloadLabel: string; runtimeSource: string; legacyEnvVars: string[];
  minimumActiveCredentials: number; providerStatus: string; credentialReady: boolean; runtimeReady: boolean; selectedCredentialCount: number;
  environmentCredentials: ManagedCredential[]; managedCredentials: ManagedCredential[]; updatedAt: string;
}
interface ManagedInventory { contractVersion: string; keyringPosture: string; pools: ManagedPool[]; observedAt: string; source: string; freshness: string }
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
  meteringExceptions: MeteringSummary | NotModelled;
  reconciliation?: { byOutcome: Array<{ outcome: string; lines: number; open: number }>; openExceptions: number };
  reconciliationExceptions?: NotModelled;
  enforcement: AiEnforcementFacts;
  observedAt: string;
}
interface MeteringException {
  exceptionId: string; tenantId: string; type: string; capabilityKey: string | null; providerKey: string | null;
  observedAttempts: number; expectedAttempts: number | null; firstObservedAt: string; lastObservedAt: string;
}
interface ReconStatement { statementId: string; providerKey: string; sourceKind: string; currency: string; periodStart: string; periodEnd: string; lineCount: number; totalAmount: number; importedBy: string; importedAt: string; status: string }
interface TenantDirectoryEntry { id: string; name: string; slug: string }
interface ReconLine {
  reconciliationId: string; providerKey: string; modelKey: string | null; serviceDay: string; currency: string; outcome: string;
  estimatedAmount: number | null; actualAmount: number | null; variance: number | null; tenantId: string | null; poolLevel: boolean; reason: string | null; resolutionState: string;
}

type Dialog =
  | { kind: "provider"; providerKey: string; status: string }
  | { kind: "lifecycle" | "certification"; modelId: string; label: string; current: string }
  | { kind: "metering"; exceptionId: string; type: string }
  | { kind: "recon"; reconciliationId: string; outcome: string }
  | { kind: "managed-add"; poolKey: string; workloadLabel: string }
  | { kind: "managed-rotate"; poolKey: string; credentialId: string; label: string }
  | { kind: "managed-status"; poolKey: string; credentialId: string; label: string; current: string }
  | { kind: "managed-source"; poolKey: string; current: string; managedReady: boolean };

const PLANE_LABELS: Record<string, string> = {
  embedded_managed: "Embedded (managed)",
  extended: "Extended / BYOAI",
  migration_internal: "Migration-internal",
};

const small = { fontSize: "0.75rem", padding: "0.15rem 0.5rem" } as const;
const heading = { margin: "1.25rem 0 0.5rem" } as const;

export default function AiFleetPage() {
  const { request, stepUp, operator } = useOperatorSession();
  const scopes = operator?.scopes ?? [];
  const canPolicy = scopes.includes("ai.provider_policy.write");
  const canMetering = scopes.includes("ai.quota.write");
  const canRecon = scopes.includes("finops.policy.write");
  const canManageCredentials = scopes.includes("ai.credentials.manage");
  const canSeeApprovals = scopes.includes("identity.read") && (canPolicy || canManageCredentials || scopes.includes("ai.emergency_suspend"));

  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [managed, setManaged] = useState<ManagedInventory | null | "unavailable">(null);
  const [metering, setMetering] = useState<MeteringException[] | null | "unavailable">(null);
  const [recon, setRecon] = useState<{ statements: ReconStatement[]; lines: ReconLine[] } | null | "unavailable">(null);
  const [tenantDirectory, setTenantDirectory] = useState<Record<string, TenantDirectoryEntry>>({});
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [f, c, k, m, r, t] = await Promise.all([
        request("/management/v1/ai/fleet/summary"),
        request("/management/v1/ai/catalog"),
        request("/management/v1/ai/managed-credentials"),
        request("/management/v1/ai/metering-exceptions?state=open&limit=50"),
        request("/management/v1/ai/reconciliation?state=open&limit=50"),
        request("/management/v1/tenants"),
      ]);
      if (!f.ok) { setError(f.status === 403 ? "You need the ai.read scope to view AI state." : "Could not load fleet AI state."); return; }
      setFleet(await f.json());
      if (c.ok) setCatalog(await c.json());
      setManaged(k.ok ? ((await k.json()) as ManagedInventory) : "unavailable");
      // An owner build without these routes answers 404 (surfaced by Governance as an upstream error): say so, don't imply "none".
      setMetering(m.ok ? ((await m.json()).exceptions as MeteringException[]) : "unavailable");
      setRecon(r.ok ? ((await r.json()) as { statements: ReconStatement[]; lines: ReconLine[] }) : "unavailable");
      if (t.ok) {
        const tenantBody = await t.json() as { tenants?: TenantDirectoryEntry[] };
        setTenantDirectory(Object.fromEntries((tenantBody.tenants ?? []).map((tenant) => [tenant.id, tenant])));
      }
    } catch {
      setError("Could not load fleet AI state.");
    }
  }, [request]);

  useEffect(() => { void load(); }, [load, refresh]);

  const close = () => setDialog(null);
  const done = () => setRefresh((n) => n + 1);
  const catalogModels = (providerKey: string) => catalog?.providers.find((p) => p.providerKey === providerKey)?.models ?? [];
  const tenantDisplay = (tenantId: string | null | undefined) => {
    if (!tenantId) return "—";
    const tenant = tenantDirectory[tenantId];
    return tenant ? `${tenant.name} (${tenant.slug})` : `${tenantId.slice(0, 8)}…`;
  };

  return (
    <>
      <div className="page-header">
        <h1 className="text-display">AI operations</h1>
        <p>Fleet AI consumption, runtime credentials, provider/model controls, exceptions and quota risk.</p>
      </div>

      {error && <ErrorState label={error} />}
      {fleet && (
        <>
          <EnforcementGaps facts={fleet.enforcement} />
          <p className="overlay-note" style={{ marginTop: 0 }}>
            Observed {when(fleet.observedAt)} · module_ai entitled tenants: {fleet.entitlement.moduleAiEntitledTenants}
            {fleet.entitlement.moduleAiExplicitlyDisabled ? ` · explicitly disabled: ${fleet.entitlement.moduleAiExplicitlyDisabled}` : ""}
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "0.75rem", margin: "0.85rem 0 1rem" }}>
            <MetricCard label="Tokens today" value={fmtNumber(fleet.planes.reduce((n, p) => n + p.tokens.day, 0))} />
            <MetricCard label="Tokens this month" value={fmtNumber(fleet.planes.reduce((n, p) => n + p.tokens.month, 0))} />
            <MetricCard label="Requests this month" value={fmtNumber(fleet.planes.reduce((n, p) => n + p.requests.month, 0))} />
            <MetricCard label="Estimated AI cost" value={fmtCost(fleet.planes.reduce((n, p) => n + p.estimatedCost.month, 0))} />
          </div>

          <h3 className="text-subhead" style={{ margin: "1rem 0 0.5rem" }}>AI usage modes (successful attempts, UTC windows)</h3>
          <table className="data-table">
            <thead><tr><th>Mode</th><th>Metering source</th><th>Tokens today / week / month</th><th>Requests month</th><th>Estimated cost month</th></tr></thead>
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
          <p className="overlay-note">
            Estimated cost uses versioned pricing; reconciled provider cost:{" "}
            {fleet.reconciliation
              ? `${fleet.reconciliation.openExceptions} open reconciliation exception(s)`
              : fleet.reconciliationExceptions ? <NotModelledNote value={fleet.reconciliationExceptions} /> : "—"}
          </p>

          <h3 className="text-subhead" style={heading}>Runtime credential pools</h3>
          <p className="overlay-note" style={{ marginTop: 0 }}>
            Provider policy and runtime readiness are separate facts. A provider can be policy-active while its runtime has no usable credential; this view reports both instead of treating “active” as “working”.
          </p>
          {managed === "unavailable" && <ErrorState label="Managed credential inventory is not available from the owner build." />}
          {managed && managed !== "unavailable" && (
            <div style={{ display: "grid", gap: "0.85rem" }}>
              {managed.pools.map((pool) => {
                const activeManaged = pool.managedCredentials.filter((c) => c.status === "active").length;
                const managedReady = activeManaged >= pool.minimumActiveCredentials;
                const allCredentials = [...pool.environmentCredentials, ...pool.managedCredentials];
                const overlaps = allCredentials.filter((c) => c.sharedWithPools.length > 0);
                return (
                  <div className="card" key={pool.poolKey} style={{ padding: "1rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div>
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                          <strong>{pool.displayName}</strong>
                          <StatusBadge value={pool.runtimeReady ? "runtime ready" : "runtime unavailable"} />
                          <StatusBadge value={`policy ${pool.providerStatus}`} />
                        </div>
                        <div className="overlay-note" style={{ marginTop: "0.2rem" }}>{pool.workloadLabel} · pool <span style={{ fontFamily: "monospace" }}>{pool.poolKey}</span></div>
                      </div>
                      {canManageCredentials && (
                        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                          <button className="btn" style={small} onClick={() => setDialog({ kind: "managed-add", poolKey: pool.poolKey, workloadLabel: pool.workloadLabel })}>Add key…</button>
                          <button className="btn" style={small} disabled={pool.runtimeSource === "environment" && !managedReady} onClick={() => setDialog({ kind: "managed-source", poolKey: pool.poolKey, current: pool.runtimeSource, managedReady })}>
                            {pool.runtimeSource === "environment" ? "Move runtime to managed pool…" : "Change runtime source…"}
                          </button>
                        </div>
                      )}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))", gap: "0.6rem", marginTop: "0.8rem" }}>
                      <MiniFact label="Runtime source" value={pool.runtimeSource === "managed_db" ? "Managed encrypted pool" : "Legacy environment pool"} />
                      <MiniFact label="Selected now" value={`${pool.selectedCredentialCount} credential${pool.selectedCredentialCount === 1 ? "" : "s"}`} />
                      <MiniFact label="Managed readiness" value={`${activeManaged}/${pool.minimumActiveCredentials} active required`} />
                      <MiniFact label="Credential posture" value={pool.credentialReady ? "Ready" : "No usable credential"} />
                    </div>
                    {overlaps.length > 0 && (
                      <p style={{ margin: "0.75rem 0 0", fontSize: "0.82rem" }}>
                        <strong>Shared-key overlap:</strong> {overlaps.map((c) => `${c.maskedHint} is also present in ${c.sharedWithPools.join(", ")}`).join("; ")}. This is visible intentionally so workload pools are not mistaken for independent credentials.
                      </p>
                    )}
                    {allCredentials.length === 0 ? (
                      <p className="overlay-note">No credential is configured for this pool.</p>
                    ) : (
                      <table className="data-table" style={{ marginTop: "0.75rem" }}>
                        <thead><tr><th>Credential</th><th>Source</th><th>State</th><th>30-day use</th><th>Last success</th>{canManageCredentials && <th />}</tr></thead>
                        <tbody>
                          {allCredentials.map((credential) => (
                            <tr key={`${pool.poolKey}:${credential.credentialId}`}>
                              <td><strong>{credential.label}</strong><div className="overlay-note" style={{ marginTop: 0 }}>{credential.maskedHint} · tag {credential.credentialTag.slice(0, 8)}…{credential.version ? ` · v${credential.version}` : ""}</div></td>
                              <td>{credential.source === "managed_db" ? "Managed encrypted" : "Legacy environment"}</td>
                              <td><StatusBadge value={credential.status} /></td>
                              <td>{fmtNumber(credential.usage30d.requests)} requests · {fmtNumber(credential.usage30d.totalTokens)} tokens{credential.usage30d.rateLimited ? ` · ${credential.usage30d.rateLimited} rate-limited` : ""}</td>
                              <td>{credential.usage30d.lastSuccessAt ? when(credential.usage30d.lastSuccessAt) : "No recorded success"}</td>
                              {canManageCredentials && <td>{credential.source === "managed_db" && credential.version !== null ? <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}><button className="btn" style={small} onClick={() => setDialog({ kind: "managed-rotate", poolKey: pool.poolKey, credentialId: credential.credentialId, label: credential.label })}>Rotate…</button><button className="btn" style={small} onClick={() => setDialog({ kind: "managed-status", poolKey: pool.poolKey, credentialId: credential.credentialId, label: credential.label, current: credential.status })}>State…</button></div> : <span className="overlay-note">Managed actions begin after staging a managed key.</span>}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {pool.legacyEnvVars.length > 0 && <p className="overlay-note">Legacy configuration source: {pool.legacyEnvVars.join(", ")}. Variable names are shown for operational traceability; values are never returned.</p>}
                  </div>
                );
              })}
              <p className="overlay-note" style={{ marginTop: 0 }}>Credential inventory observed {when(managed.observedAt)} · posture: {managed.keyringPosture.replace(/_/g, " ")}</p>
            </div>
          )}

          <h3 className="text-subhead" style={heading}>Providers and models</h3>
          <table className="data-table">
            <thead><tr><th>Provider</th><th>Status</th><th>Executor</th><th>Plane</th><th>Credentials</th><th>Models (lifecycle · certification)</th>{canPolicy && <th />}</tr></thead>
            <tbody>
              {fleet.providers.map((p) => {
                const detailed = catalogModels(p.providerKey);
                return (
                  <tr key={p.providerKey}>
                    <td><strong>{p.displayName}</strong><div className="overlay-note" style={{ marginTop: 0 }}>{p.providerKey}</div></td>
                    <td>
                      <StatusBadge value={p.status} />
                      <div className="overlay-note" style={{ marginTop: 0 }}>enforced: {p.enforcement.statusEnforced.replace("_", " ")}</div>
                    </td>
                    <td>{p.governedVia === "migration_internal_direct" ? "Migration (own pool)" : p.adapterRegistered ? "AI execution service" : "no adapter"}</td>
                    <td>{PLANE_LABELS[p.plane] ?? p.plane}</td>
                    <td>{p.credentialSource}</td>
                    <td>
                      {p.models.map((m) => {
                        const detail = detailed.find((d) => d.modelKey === m.modelKey);
                        return (
                          <div key={m.modelKey} style={{ fontSize: "0.8rem", marginBottom: "0.2rem" }}>
                            {m.modelKey} · <StatusBadge value={m.lifecycle} /> · <StatusBadge value={m.certification} />
                            {detail?.certificationEvidenceRef && <span className="overlay-note" style={{ marginTop: 0 }}> evidence {detail.certificationEvidenceRef}</span>}
                            {canPolicy && detail?.modelId && (
                              <>
                                {" "}
                                <button className="btn" style={small} disabled={m.lifecycle === "retired"} onClick={() => setDialog({ kind: "lifecycle", modelId: detail.modelId as string, label: `${p.providerKey}/${m.modelKey}`, current: m.lifecycle })}>Lifecycle…</button>{" "}
                                <button className="btn" style={small} onClick={() => setDialog({ kind: "certification", modelId: detail.modelId as string, label: `${p.providerKey}/${m.modelKey}`, current: m.certification })}>Certify…</button>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </td>
                    {canPolicy && (
                      <td>{p.governedVia !== "migration_internal_direct" && <button className="btn" style={small} onClick={() => setDialog({ kind: "provider", providerKey: p.providerKey, status: p.status })}>Change status…</button>}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {canPolicy && <p className="overlay-note">Migration-internal providers are governed by module_migration and are not changed from here.</p>}

          <h3 className="text-subhead" style={heading}>Quota risk (≥ 80% of a hard limit)</h3>
          {fleet.quotaRisk.length === 0 ? (
            <EmptyState label="No tenant is at or above 80% of a hard AI quota." icon="speed" />
          ) : (
            <table className="data-table">
              <thead><tr><th>Tenant</th><th>Period</th><th>Metric</th><th>Used / hard</th><th>State</th></tr></thead>
              <tbody>
                {fleet.quotaRisk.map((q) => (
                  <tr key={q.policyId}>
                    <td title={q.tenantId}>{tenantDisplay(q.tenantId)}</td>
                    <td>{q.period}</td><td>{q.limitType}</td>
                    <td>{fmtNumber(q.used)} / {fmtNumber(q.hard)}</td>
                    <td><StatusBadge value={q.state} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="text-subhead" style={heading}>Top this month</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))", gap: "1rem" }}>
            <TopList title="Tenants" rows={fleet.top.tenants.map((t) => [tenantDisplay(t.tenantId), t.totalTokens])} />
            <TopList title="Capabilities" rows={fleet.top.capabilities.map((c) => [c.capabilityKey, c.totalTokens])} mono />
            <TopList title="Models" rows={fleet.top.models.map((m) => [`${m.providerKey}/${m.modelKey ?? "?"}`, m.totalTokens])} mono />
          </div>

          <h3 className="text-subhead" style={heading}>Provider attempt outcomes (7 days)</h3>
          <p className="overlay-note" style={{ marginTop: 0 }}>This is request-outcome telemetry, not a synthetic uptime score. Credential-level evidence is shown in Runtime credential pools above.</p>
          {fleet.providerHealth7d.length === 0 ? (
            <EmptyState label="No provider attempts in the last 7 days." icon="monitor_heart" />
          ) : (
            <table className="data-table">
              <thead><tr><th>Provider</th><th>Attempts</th><th>Failure rate</th><th>Rate-limit rate</th><th>Operational signal</th></tr></thead>
              <tbody>
                {fleet.providerHealth7d.map((health) => {
                  const failurePct = health.attempts > 0 ? (health.failures / health.attempts) * 100 : 0;
                  const rateLimitPct = health.attempts > 0 ? (health.rateLimited / health.attempts) * 100 : 0;
                  const provider = fleet.providers.find((entry) => entry.providerKey === health.providerKey);
                  return (
                    <tr key={health.providerKey}>
                      <td><strong>{provider?.displayName ?? health.providerKey}</strong><div className="overlay-note" style={{ marginTop: 0 }}>{health.providerKey}</div></td>
                      <td>{fmtNumber(health.attempts)}</td>
                      <td>{health.failures} · {failurePct.toFixed(1)}%</td>
                      <td>{health.rateLimited} · {rateLimitPct.toFixed(1)}%</td>
                      <td>{health.failures === 0 && health.rateLimited === 0 ? <StatusBadge value="no recorded errors" /> : <StatusBadge value="attention" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <h3 className="text-subhead" style={heading}>Metering exceptions</h3>
          <p style={{ fontSize: "0.85rem", margin: "0 0 0.4rem" }}>
            {isNotModelled(fleet.meteringExceptions)
              ? <NotModelledNote value={fleet.meteringExceptions} />
              : `${fleet.meteringExceptions.open} open${fleet.meteringExceptions.byType.length ? ` (${fleet.meteringExceptions.byType.map((t) => `${t.type.replace(/_/g, " ")} ${t.open}`).join(", ")})` : ""}`}
          </p>
          {metering === "unavailable" && <p className="overlay-note">The owner did not return the exception list (it may not be on the new contract yet).</p>}
          {Array.isArray(metering) && metering.length === 0 && <EmptyState label="No open metering exceptions." icon="task_alt" />}
          {Array.isArray(metering) && metering.length > 0 && (
            <table className="data-table">
              <thead><tr><th>Tenant</th><th>Type</th><th>Capability</th><th>Provider</th><th>Attempts (seen / expected)</th><th>Observed</th>{canMetering && <th />}</tr></thead>
              <tbody>
                {metering.map((e) => (
                  <tr key={e.exceptionId}>
                    <td title={e.tenantId}>{tenantDisplay(e.tenantId)}</td>
                    <td>{e.type.replace(/_/g, " ")}</td><td>{e.capabilityKey ?? "—"}</td><td>{e.providerKey ?? "—"}</td>
                    <td>{e.observedAttempts} / {e.expectedAttempts ?? "?"}</td>
                    <td>{when(e.firstObservedAt)} → {when(e.lastObservedAt)}</td>
                    {canMetering && <td><button className="btn" style={small} onClick={() => setDialog({ kind: "metering", exceptionId: e.exceptionId, type: e.type })}>Resolve…</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 className="text-subhead" style={heading}>Provider-cost reconciliation</h3>
          <p className="overlay-note" style={{ marginTop: 0 }}>Provider statements are ingested by the platform team through the owner&apos;s own job — there is no upload here. Exceptions are variances between a statement line and Governance-visible usage.</p>
          {recon === "unavailable" && <p className="overlay-note">The owner did not return reconciliation data (it may not be on the new contract yet).</p>}
          {recon && recon !== "unavailable" && (
            <>
              {recon.statements.length > 0 && (
                <table className="data-table">
                  <thead><tr><th>Provider</th><th>Source</th><th>Period</th><th>Lines</th><th>Total</th><th>Imported</th></tr></thead>
                  <tbody>
                    {recon.statements.map((s) => (
                      <tr key={s.statementId}>
                        <td>{s.providerKey}</td><td>{s.sourceKind.replace(/_/g, " ")}{s.status !== "active" ? ` (${s.status})` : ""}</td>
                        <td>{s.periodStart} → {s.periodEnd}</td><td>{s.lineCount}</td><td>{s.totalAmount.toFixed(2)} {s.currency}</td>
                        <td>{when(s.importedAt)} by {s.importedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {recon.lines.length === 0 ? (
                <EmptyState label="No open reconciliation exceptions." icon="task_alt" />
              ) : (
                <table className="data-table" style={{ marginTop: "0.5rem" }}>
                  <thead><tr><th>Outcome</th><th>Provider / model</th><th>Service day</th><th>Estimated / actual</th><th>Variance</th><th>Scope</th><th>Reason</th>{canRecon && <th />}</tr></thead>
                  <tbody>
                    {recon.lines.map((l) => (
                      <tr key={l.reconciliationId}>
                        <td><StatusBadge value={l.outcome.replace(/_/g, " ")} /></td>
                        <td>{l.providerKey}{l.modelKey ? ` / ${l.modelKey}` : ""}</td>
                        <td>{l.serviceDay}</td>
                        <td>{l.estimatedAmount === null ? "—" : l.estimatedAmount.toFixed(4)} / {l.actualAmount === null ? "—" : l.actualAmount.toFixed(4)} {l.currency}</td>
                        <td>{l.variance === null ? "—" : l.variance.toFixed(4)}</td>
                        <td>{l.poolLevel ? "Managed pool" : <span title={l.tenantId ?? undefined}>{tenantDisplay(l.tenantId)}</span>}</td>
                        <td style={{ fontSize: "0.8rem" }}>{l.reason ?? "—"}</td>
                        {canRecon && <td><button className="btn" style={small} onClick={() => setDialog({ kind: "recon", reconciliationId: l.reconciliationId, outcome: l.outcome })}>Resolve…</button></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {catalog && catalog.legacyKillSwitches.length > 0 && (
            <>
              <h3 className="text-subhead" style={heading}>Legacy AI kill switches</h3>
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

          {canSeeApprovals && operator && (
            <ApprovalQueue
              request={request}
              stepUp={stepUp}
              operatorId={operator.operatorId}
              returnTo="/ai"
              include={(a) => a.requestedAction.startsWith("ai.")}
              refreshKey={refresh}
              onExecuted={done}
              renderSummary={(a) => <AiApprovalSummary approval={a} />}
              hideWhenEmpty
              canExecute={(a) => a.makerOperatorId === operator.operatorId || a.checkerOperatorId === operator.operatorId}
            />
          )}

          {dialog?.kind === "provider" && <ProviderStateDialog providerKey={dialog.providerKey} current={dialog.status} onClose={close} onDone={done} />}
          {dialog?.kind === "lifecycle" && <ModelLifecycleDialog modelId={dialog.modelId} label={dialog.label} current={dialog.current} onClose={close} onDone={done} />}
          {dialog?.kind === "certification" && <ModelCertificationDialog modelId={dialog.modelId} label={dialog.label} current={dialog.current} onClose={close} onDone={done} />}
          {dialog?.kind === "metering" && <ResolveMeteringDialog exceptionId={dialog.exceptionId} type={dialog.type} onClose={close} onDone={done} />}
          {dialog?.kind === "recon" && <ResolveReconciliationDialog reconciliationId={dialog.reconciliationId} outcome={dialog.outcome} onClose={close} onDone={done} />}
          {dialog?.kind === "managed-add" && <ManagedCredentialAddDialog poolKey={dialog.poolKey} workloadLabel={dialog.workloadLabel} onClose={close} onDone={done} />}
          {dialog?.kind === "managed-rotate" && <ManagedCredentialRotateDialog poolKey={dialog.poolKey} credentialId={dialog.credentialId} label={dialog.label} onClose={close} onDone={done} />}
          {dialog?.kind === "managed-status" && <ManagedCredentialStatusDialog poolKey={dialog.poolKey} credentialId={dialog.credentialId} label={dialog.label} current={dialog.current} onClose={close} onDone={done} />}
          {dialog?.kind === "managed-source" && <ManagedPoolSourceDialog poolKey={dialog.poolKey} current={dialog.current} managedReady={dialog.managedReady} onClose={close} onDone={done} />}
        </>
      )}
    </>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return <div className="card" style={{ padding: "0.85rem 1rem" }}><div className="overlay-note" style={{ marginTop: 0 }}>{label}</div><div style={{ fontSize: "1.45rem", fontWeight: 650, marginTop: "0.2rem" }}>{value}</div></div>;
}

function MiniFact({ label, value }: { label: string; value: string }) {
  return <div><div className="overlay-note" style={{ marginTop: 0 }}>{label}</div><div style={{ fontSize: "0.88rem", marginTop: "0.15rem" }}>{value}</div></div>;
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
