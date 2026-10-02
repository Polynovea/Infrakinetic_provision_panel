"use client";

import { useEffect, useState } from "react";

import { useOperatorSession } from "../../lib/session";
import { StatusBadge } from "../../components/StatusBadge";
import { Icon } from "../../components/Icon";
import { SkeletonCard } from "../../components/Skeleton";
import { ErrorState } from "../../components/States";

interface TenantSummary {
  tenant_kind: "customer" | "platform";
  status: string;
  platform_access_state?: "active" | "suspended" | "decommissioned";
}

interface DriftSummary {
  projectionMissing: unknown[];
  stuckOperations: unknown[];
  staleObservations: unknown[];
  desiredProvisionedMismatch: unknown[];
  lifecycleMismatch?: unknown[];
}

interface EngineSummary {
  engineKey: string;
  label: string;
  state: "operational" | "degraded" | "disabled" | "unknown";
}

interface OperationSummary {
  operationId: string;
  requestedAction: string;
  targetTenantId?: string;
  targetEngine: string;
  riskClass: string;
  status: string;
  reason?: string;
  requestedAt: string;
}

function humanizeAction(action: string): string {
  const map: Record<string, string> = {
    "platform.engine-state.set": "Platform state changed",
  };
  return map[action] ?? action.replace(/[._-]/g, " ");
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSeconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSeconds < 60) return "just now";
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function useFetchState<T>(path: string, request: (path: string) => Promise<Response>, extract: (body: unknown) => T, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setData(null);
      setError(null);
      return () => { cancelled = true; };
    }
    setError(null);
    request(path)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError("Could not load this data.");
          return;
        }
        const body = await res.json();
        setData(extract(body));
      })
      .catch(() => !cancelled && setError("Could not load this data."));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled]);
  return { data, error };
}

export default function OverviewPage() {
  const { operator, request } = useOperatorSession();
  const canReadRuntime = operator?.scopes.includes("runtime.read") ?? false;
  const tenants = useFetchState<TenantSummary[]>("/management/v1/tenants", request, (b) => (b as { tenants: TenantSummary[] }).tenants);
  const engines = useFetchState<EngineSummary[]>("/management/v1/engines", request, (b) => (b as { engines: EngineSummary[] }).engines);
  const operations = useFetchState<OperationSummary[]>(
    "/management/v1/operations?limit=6",
    request,
    (b) => (b as { operations: OperationSummary[] }).operations,
  );
  const drift = useFetchState<DriftSummary>(
    "/management/v1/reconciliation/drift",
    request,
    (b) => b as DriftSummary,
    canReadRuntime,
  );

  const tenantCounts = tenants.data
    ? (() => {
        const customers = tenants.data.filter((t) => t.tenant_kind === "customer");
        const access = (t: TenantSummary) => t.platform_access_state ?? "active";
        const live = customers.filter((t) => access(t) !== "decommissioned");
        return {
          total: live.length,
          active: live.filter((t) => access(t) === "active").length,
          suspended: live.filter((t) => access(t) === "suspended").length,
          archived: customers.filter((t) => access(t) === "decommissioned").length,
        };
      })()
    : null;

  const engineCounts = engines.data
    ? {
        total: engines.data.length,
        operational: engines.data.filter((e) => e.state === "operational").length,
        degraded: engines.data.filter((e) => e.state === "degraded").length,
        disabled: engines.data.filter((e) => e.state === "disabled").length,
        unknown: engines.data.filter((e) => e.state === "unknown").length,
      }
    : null;

  const atRiskEngines = engines.data?.filter((e) => e.state !== "operational") ?? [];
  const driftCounts = drift.data
    ? {
        total: drift.data.projectionMissing.length + drift.data.stuckOperations.length + drift.data.staleObservations.length + drift.data.desiredProvisionedMismatch.length + (drift.data.lifecycleMismatch?.length ?? 0),
        stuck: drift.data.stuckOperations.length,
        stale: drift.data.staleObservations.length,
        lifecycle: drift.data.lifecycleMismatch?.length ?? 0,
        missing: drift.data.projectionMissing.length,
      }
    : null;

  return (
    <>
      <div className="page-header">
        <h1 className="text-display">Overview</h1>
        <p>Fleet health, operating controls and items that need attention.</p>
      </div>

      <div className="card-grid">
        <a className="card metric-card" href="/tenants" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="metric-card-label">Customer tenants</div>
          {tenants.error ? (
            <ErrorState label={tenants.error} />
          ) : !tenantCounts ? (
            <SkeletonCard />
          ) : (
            <>
              <div className="metric-card-value">{tenantCounts.total}</div>
              <div className="metric-row">
                <span className="metric-chip">
                  <span className="metric-chip-value" style={{ color: "var(--success-fg)" }}>
                    {tenantCounts.active}
                  </span>
                  access active
                </span>
                <span className="metric-chip">
                  <span className="metric-chip-value" style={{ color: "var(--danger-fg)" }}>
                    {tenantCounts.suspended}
                  </span>
                  access suspended
                </span>
              </div>
              {tenantCounts.archived > 0 && <div className="overlay-note" style={{ marginTop: "0.45rem" }}>{tenantCounts.archived} decommissioned customer tenant{tenantCounts.archived === 1 ? "" : "s"} archived from the live fleet.</div>}
            </>
          )}
        </a>

        <a className="card metric-card" href="/engine-state" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="metric-card-label">Engine control policy</div>
          {engines.error ? (
            <ErrorState label={engines.error} />
          ) : !engineCounts ? (
            <SkeletonCard />
          ) : (
            <>
              <div className="metric-card-value">{engineCounts.total}</div>
              <div className="metric-row">
                <span className="metric-chip">
                  <span className="metric-chip-value" style={{ color: "var(--success-fg)" }}>
                    {engineCounts.operational}
                  </span>
                  enabled normally
                </span>
                {engineCounts.degraded > 0 && (
                  <span className="metric-chip">
                    <span className="metric-chip-value" style={{ color: "var(--warning-fg)" }}>
                      {engineCounts.degraded}
                    </span>
                    degraded
                  </span>
                )}
                {engineCounts.disabled > 0 && (
                  <span className="metric-chip">
                    <span className="metric-chip-value" style={{ color: "var(--danger-fg)" }}>
                      {engineCounts.disabled}
                    </span>
                    disabled
                  </span>
                )}
                {engineCounts.unknown > 0 && (
                  <span className="metric-chip">
                    <span className="metric-chip-value" style={{ color: "var(--warning-fg)" }}>
                      {engineCounts.unknown}
                    </span>
                    unknown
                  </span>
                )}
              </div>
            </>
          )}
        </a>

        {canReadRuntime && (
          <a className="card metric-card" href="/reconciliation" style={{ textDecoration: "none", color: "inherit" }}>
            <div className="metric-card-label">Needs attention</div>
            {drift.error ? <ErrorState label="Could not load tenant health." /> : !driftCounts ? <SkeletonCard /> : (
              <>
                <div className="metric-card-value">{driftCounts.total}</div>
                <div className="metric-row">
                  {driftCounts.stuck > 0 && <span className="metric-chip"><span className="metric-chip-value" style={{ color: "var(--danger-fg)" }}>{driftCounts.stuck}</span> stuck</span>}
                  {driftCounts.stale > 0 && <span className="metric-chip"><span className="metric-chip-value" style={{ color: "var(--warning-fg)" }}>{driftCounts.stale}</span> stale</span>}
                  {driftCounts.lifecycle > 0 && <span className="metric-chip"><span className="metric-chip-value" style={{ color: "var(--warning-fg)" }}>{driftCounts.lifecycle}</span> lifecycle drift</span>}
                  {driftCounts.missing > 0 && <span className="metric-chip"><span className="metric-chip-value">{driftCounts.missing}</span> missing projection</span>}
                  {driftCounts.total === 0 && <span className="metric-chip"><span className="metric-chip-value" style={{ color: "var(--success-fg)" }}>0</span> tenant-control issues</span>}
                </div>
              </>
            )}
          </a>
        )}
      </div>

      {atRiskEngines.length > 0 && (
        <div className="card" style={{ marginTop: "1rem", borderColor: "var(--warning-border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <Icon name="warning" filled />
            <strong>Engine controls outside normal policy</strong>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {atRiskEngines.map((e) => (
              <a
                key={e.engineKey}
                href="/engine-state"
                style={{ display: "flex", justifyContent: "space-between", textDecoration: "none", color: "inherit", fontSize: "0.88rem" }}
              >
                <span>{e.label}</span>
                <StatusBadge value={e.state} />
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
          <strong>Recent control activity</strong>
        </div>
        {operations.error && <ErrorState label={operations.error} />}
        {!operations.error && operations.data === null && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div className="skeleton skeleton-line" style={{ width: "90%" }} />
            <div className="skeleton skeleton-line" style={{ width: "75%" }} />
            <div className="skeleton skeleton-line" style={{ width: "82%" }} />
          </div>
        )}
        {!operations.error && operations.data !== null && operations.data.length === 0 && (
          <p className="overlay-note" style={{ margin: 0 }}>
            No privileged operations recorded yet.
          </p>
        )}
        {!operations.error && operations.data !== null && operations.data.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
            {operations.data.map((op) => (
              <div key={op.operationId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", fontSize: "0.88rem" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {humanizeAction(op.requestedAction)} <span style={{ color: "var(--text-muted)" }}>&middot; {op.targetEngine}</span>
                  </div>
                  {op.reason && <div className="overlay-note" style={{ marginTop: "0.1rem" }} title={op.reason}>Reason recorded · open the relevant control for details</div>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
                  <StatusBadge value={op.status} />
                  <span className="overlay-note" style={{ marginTop: 0 }}>
                    {relativeTime(op.requestedAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
