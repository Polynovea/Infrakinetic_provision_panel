"use client";

import { useEffect, useState } from "react";

import { useOperatorSession } from "../../lib/session";
import { StatusBadge } from "../../components/StatusBadge";
import { Icon } from "../../components/Icon";
import { SkeletonCard } from "../../components/Skeleton";
import { ErrorState } from "../../components/States";

interface TenantSummary {
  status: string;
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

function useFetchState<T>(path: string, request: (path: string) => Promise<Response>, extract: (body: unknown) => T) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
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
  }, [path]);
  return { data, error };
}

export default function OverviewPage() {
  const { operator, request } = useOperatorSession();
  const tenants = useFetchState<TenantSummary[]>("/management/v1/tenants", request, (b) => (b as { tenants: TenantSummary[] }).tenants);
  const engines = useFetchState<EngineSummary[]>("/management/v1/engines", request, (b) => (b as { engines: EngineSummary[] }).engines);
  const operations = useFetchState<OperationSummary[]>(
    "/management/v1/operations?limit=10",
    request,
    (b) => (b as { operations: OperationSummary[] }).operations,
  );

  const tenantCounts = tenants.data
    ? {
        total: tenants.data.length,
        active: tenants.data.filter((t) => t.status === "active").length,
        trial: tenants.data.filter((t) => t.status === "trial").length,
        suspended: tenants.data.filter((t) => t.status === "suspended").length,
      }
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

  return (
    <>
      <div className="page-header">
        <h1 className="text-display">Overview</h1>
        <p>{operator ? `Signed in as ${operator.email}.` : "Welcome."}</p>
      </div>

      <div className="card-grid">
        <a className="card metric-card" href="/tenants" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="metric-card-label">Tenant fleet</div>
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
                  active
                </span>
                <span className="metric-chip">
                  <span className="metric-chip-value" style={{ color: "var(--warning-fg)" }}>
                    {tenantCounts.trial}
                  </span>
                  trial
                </span>
                <span className="metric-chip">
                  <span className="metric-chip-value" style={{ color: "var(--danger-fg)" }}>
                    {tenantCounts.suspended}
                  </span>
                  suspended
                </span>
              </div>
            </>
          )}
        </a>

        <a className="card metric-card" href="/engine-state" style={{ textDecoration: "none", color: "inherit" }}>
          <div className="metric-card-label">Engine fleet</div>
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
                  operational
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

        {operator && (
          <div className="card metric-card">
            <div className="metric-card-label">Signed in as</div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.2rem" }}>
              <Icon name="account_circle" size="lg" style={{ color: "var(--action-primary)" }} />
              <div>
                <div style={{ fontSize: "0.95rem", fontWeight: 600 }}>{operator.email}</div>
                <div className="overlay-note" style={{ marginTop: 0 }}>
                  {operator.roles[0]?.replace(/_/g, " ") ?? "operator"}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {atRiskEngines.length > 0 && (
        <div className="card" style={{ marginTop: "1rem", borderColor: "var(--warning-border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <Icon name="warning" filled />
            <strong>Engines needing attention</strong>
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
          <strong>Recent privileged operations</strong>
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
                  {op.reason && <div className="overlay-note" style={{ marginTop: "0.1rem" }}>{op.reason}</div>}
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
