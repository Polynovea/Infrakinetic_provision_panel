"use client";

import { useCallback, useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { Icon } from "../../../components/Icon";
import { EmptyState, ErrorState } from "../../../components/States";
import { SkeletonTableRows } from "../../../components/Skeleton";

// 1A.10.5 — the platform-wide reconciliation view. Read-only (GET
// /management/v1/reconciliation/drift, R0) — repair happens per-tenant via
// the "Recheck" action on the tenant detail drawer (Tenants page), not from
// here. This page exists because the 1A.11 handoff condition (master plan
// §64) needs the projectionless/legacy-created population to be MEASURABLE
// platform-wide, not just discoverable one tenant at a time.

interface DriftProjectionMissing {
  tenantId: string;
  name: string;
  platformAccessState?: string;
}

interface DriftStuckOperation {
  operationId: string;
  requestedAction: string;
  targetTenantId?: string;
  targetEngine?: string;
  class: string;
  stage?: string;
  expected?: unknown;
  observed?: unknown;
}

interface DriftStaleObservation {
  tenantId: string;
  lastObservedAt: string;
  ageSeconds: number;
}

interface DriftDesiredProvisionedMismatch {
  tenantId: string;
  field: string;
  desired: string;
  provisioned: string;
}

interface ListDriftResult {
  observedAt: string;
  projectionMissing: DriftProjectionMissing[];
  stuckOperations: DriftStuckOperation[];
  staleObservations: DriftStaleObservation[];
  desiredProvisionedMismatch: DriftDesiredProvisionedMismatch[];
  registryUnavailable?: { message: string };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatAge(ageSeconds: number): string {
  const hours = Math.floor(ageSeconds / 3600);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default function ReconciliationPage() {
  const { request, operator } = useOperatorSession();
  const [drift, setDrift] = useState<ListDriftResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canRead = operator?.scopes.includes("runtime.read") ?? false;

  const load = useCallback(() => {
    setError(null);
    setLoading(true);
    return request("/management/v1/reconciliation/drift")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setError(body.message ?? body.error ?? "Could not load reconciliation drift.");
          return;
        }
        setDrift(body);
      })
      .catch(() => setError("Could not load reconciliation drift."))
      .finally(() => setLoading(false));
  }, [request]);

  useEffect(() => {
    if (!canRead) return;
    void load();
  }, [load, canRead]);

  if (!canRead) {
    return (
      <>
        <div className="page-header">
          <h1 className="text-display">Reconciliation</h1>
        </div>
        <EmptyState label="You do not have the runtime.read scope required to view reconciliation drift." icon="lock" />
      </>
    );
  }

  const totalDrift = drift
    ? drift.projectionMissing.length + drift.stuckOperations.length + drift.staleObservations.length + drift.desiredProvisionedMismatch.length
    : null;

  return (
    <>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h1 className="text-display">Reconciliation</h1>
          <p>{drift ? `Last observed ${formatDate(drift.observedAt)}` : "Desired, provisioned, and effective state drift across the platform."}</p>
        </div>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" size="sm" /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && <ErrorState label={error} />}

      {!error && drift === null && (
        <div className="card" style={{ padding: 0 }}>
          <table className="data-table">
            <tbody>
              <SkeletonTableRows columns={4} rows={4} />
            </tbody>
          </table>
        </div>
      )}

      {!error && drift !== null && (
        <>
          {drift.registryUnavailable && (
            <p className="overlay-note" style={{ marginBottom: "1rem" }}>
              The tenant registry could not be reached ({drift.registryUnavailable.message}). Ledger-derived drift below is still current;
              projection-based classes could not be computed this pass.
            </p>
          )}

          {totalDrift === 0 && (
            <EmptyState label="No drift found. Every projection and operation is reconciled." icon="task_alt" />
          )}

          {drift.projectionMissing.length > 0 && (
            <section style={{ marginBottom: "1.5rem" }}>
              <h3 className="text-subhead" style={{ marginBottom: "0.6rem" }}>
                Missing projections ({drift.projectionMissing.length})
              </h3>
              <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>
                Customer tenants Infrakinetic reports that have no Governance-owned commissioned_tenants row yet. Open the tenant on the
                Tenants page and use &ldquo;Recheck&rdquo; to create one.
              </p>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tenant</th>
                      <th>Platform access state</th>
                      <th>Tenant ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drift.projectionMissing.map((p) => (
                      <tr key={p.tenantId}>
                        <td>{p.name}</td>
                        <td>{p.platformAccessState ? <StatusBadge value={p.platformAccessState} /> : "—"}</td>
                        <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{p.tenantId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {drift.stuckOperations.length > 0 && (
            <section style={{ marginBottom: "1.5rem" }}>
              <h3 className="text-subhead" style={{ marginBottom: "0.6rem" }}>
                Stuck operations ({drift.stuckOperations.length})
              </h3>
              <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>
                Operations sitting at partially_completed, classified by cause. Tenant-scoped operations are resolved via the tenant&rsquo;s
                &ldquo;Recheck&rdquo; action.
              </p>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Class</th>
                      <th>Target tenant</th>
                      <th>Target engine</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drift.stuckOperations.map((op) => (
                      <tr key={op.operationId}>
                        <td>{op.requestedAction}</td>
                        <td>
                          <StatusBadge value={op.class} />
                        </td>
                        <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{op.targetTenantId ?? "—"}</td>
                        <td>{op.targetEngine ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {drift.staleObservations.length > 0 && (
            <section style={{ marginBottom: "1.5rem" }}>
              <h3 className="text-subhead" style={{ marginBottom: "0.6rem" }}>
                Stale observations ({drift.staleObservations.length})
              </h3>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tenant ID</th>
                      <th>Last observed</th>
                      <th>Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drift.staleObservations.map((s) => (
                      <tr key={s.tenantId}>
                        <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{s.tenantId}</td>
                        <td>{formatDate(s.lastObservedAt)}</td>
                        <td>{formatAge(s.ageSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {drift.desiredProvisionedMismatch.length > 0 && (
            <section style={{ marginBottom: "1.5rem" }}>
              <h3 className="text-subhead" style={{ marginBottom: "0.6rem" }}>
                Desired / provisioned mismatches ({drift.desiredProvisionedMismatch.length})
              </h3>
              <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>
                Surfaced only — neither system currently exposes a write path to change these fields after commissioning.
              </p>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tenant ID</th>
                      <th>Field</th>
                      <th>Desired</th>
                      <th>Provisioned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drift.desiredProvisionedMismatch.map((m, i) => (
                      <tr key={`${m.tenantId}-${m.field}-${i}`}>
                        <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{m.tenantId}</td>
                        <td>{m.field}</td>
                        <td>{m.desired}</td>
                        <td>{m.provisioned}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
