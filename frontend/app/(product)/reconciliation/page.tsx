"use client";

import { useCallback, useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { Icon } from "../../../components/Icon";
import { EmptyState, ErrorState } from "../../../components/States";
import { SkeletonTableRows } from "../../../components/Skeleton";
import { ConfirmDialog } from "../../../components/ConfirmDialog";

// Audit remediation H3 — the governed operator action for resuming a
// partially-completed commission via POST /tenants/commission-requests/:id/
// repair. The approved commission's stored fields are fetched and shown
// read-only (a repair finishes that commission, it can never repurpose it);
// the operator supplies only what Governance deliberately never stored (the
// initial admin, 0006) and a reason. One idempotency key per dialog, so a
// double-submit or retry replays rather than issuing a second repair.
interface CommissionRequestSummary {
  commissionRequestId: string;
  tenantId: string | null;
  lifecycleState: string;
  repairable: boolean;
  desiredName: string;
  desiredSlug: string | null;
  desiredPlan: string;
  accountType: "demo" | "live";
}

function isCommissionRepairCandidate(op: DriftStuckOperation): boolean {
  return op.requestedAction === "tenant.commission" && op.targetResourceType === "commission_request" && Boolean(op.targetResourceId);
}

function RepairCommissionDialog({
  commissionRequestId,
  request,
  onClose,
  onRepaired,
}: {
  commissionRequestId: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onRepaired: () => void;
}) {
  const [summary, setSummary] = useState<CommissionRequestSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sendInvite, setSendInvite] = useState(true);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ status: string; warnings: { stage: string; message: string }[] } | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let cancelled = false;
    request(`/management/v1/tenants/commission-requests/${encodeURIComponent(commissionRequestId)}`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(body.message ?? body.error ?? "Could not load this commission request.");
          return;
        }
        setSummary(body.commissionRequest);
      })
      .catch(() => !cancelled && setLoadError("Could not load this commission request."));
    return () => {
      cancelled = true;
    };
  }, [request, commissionRequestId]);

  async function submit() {
    if (!summary) return;
    if (reason.trim() === "") {
      setError("A reason is required.");
      return;
    }
    if (sendInvite && (adminName.trim() === "" || adminEmail.trim() === "")) {
      setError("Administrator name and email are required to send the invite.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hasAdmin = adminName.trim() !== "" && adminEmail.trim() !== "";
      const res = await request(`/management/v1/tenants/commission-requests/${encodeURIComponent(commissionRequestId)}/repair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          reason,
          name: summary.desiredName,
          slug: summary.desiredSlug ?? undefined,
          plan: summary.desiredPlan,
          accountType: summary.accountType,
          sendInvite,
          initialAdmin: sendInvite || hasAdmin ? { name: adminName, email: adminEmail } : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? "The repair request failed.");
        return;
      }
      setOutcome({ status: body.operation.status, warnings: body.operation.result?.warnings ?? [] });
      onRepaired();
    } catch {
      setError("The repair request failed.");
    } finally {
      setBusy(false);
    }
  }

  if (outcome) {
    return (
      <ConfirmDialog title="Commission repair submitted" confirmLabel="Done" onConfirm={onClose} onCancel={onClose}>
        <p style={{ display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.9rem" }}>
          Outcome <StatusBadge value={outcome.status} />
        </p>
        {outcome.warnings.length > 0 && (
          <ul style={{ fontSize: "0.85rem", paddingLeft: "1.2rem" }}>
            {outcome.warnings.map((w, i) => (
              <li key={i}>
                <strong>{w.stage}:</strong> {w.message}
              </li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
    );
  }

  const repairable = summary?.repairable ?? false;
  return (
    <ConfirmDialog
      title="Repair commission?"
      description="Resumes this approved commission at Infrakinetic from its durable stage checkpoints, under the same commission request. It never creates a second tenant and never changes what was approved."
      confirmLabel="Repair commission"
      busy={busy || !summary || !repairable}
      onCancel={onClose}
      onConfirm={() => void submit()}
    >
      {loadError && <ErrorState label={loadError} />}
      {!loadError && !summary && <p className="overlay-note">Loading commission request…</p>}
      {summary && (
        <>
          <dl style={{ fontSize: "0.85rem", margin: "0.75rem 0" }}>
            <dt style={{ color: "var(--text-muted)" }}>Commission request</dt>
            <dd style={{ margin: "0 0 0.4rem", fontFamily: "monospace", fontSize: "0.8rem" }}>{summary.commissionRequestId}</dd>
            <dt style={{ color: "var(--text-muted)" }}>Tenant</dt>
            <dd style={{ margin: "0 0 0.4rem" }}>
              {summary.desiredName}
              {summary.desiredSlug ? ` (${summary.desiredSlug})` : ""}
              {summary.tenantId && (
                <div style={{ fontFamily: "monospace", fontSize: "0.8rem", color: "var(--text-muted)" }}>{summary.tenantId}</div>
              )}
            </dd>
            <dt style={{ color: "var(--text-muted)" }}>Legacy bootstrap profile</dt>
            <dd style={{ margin: "0 0 0.4rem" }}>
              {summary.desiredPlan} ({summary.accountType})
            </dd>
            <dt style={{ color: "var(--text-muted)" }}>Governance lifecycle</dt>
            <dd style={{ margin: 0 }}>
              <StatusBadge value={summary.lifecycleState} />
            </dd>
          </dl>
          {!repairable && (
            <p className="overlay-note">Only a commission still in provisioning can be repaired; this one is {summary.lifecycleState}.</p>
          )}
          {repairable && (
            <>
              <div className="field">
                <label>
                  <input type="checkbox" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} /> Send the administrator invite
                </label>
                <p className="field-hint">Governance never stores the initial administrator&rsquo;s details, so re-enter them to (re)send the invite.</p>
              </div>
              <div className="field">
                <label>Admin name{sendInvite ? "" : " (optional)"}</label>
                <input value={adminName} onChange={(e) => setAdminName(e.target.value)} />
              </div>
              <div className="field">
                <label>Admin email{sendInvite ? "" : " (optional)"}</label>
                <input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
              </div>
              <div className="field">
                <label>Reason</label>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Required" />
              </div>
            </>
          )}
          {error && <ErrorState label={error} />}
        </>
      )}
    </ConfirmDialog>
  );
}

// 1A.10.5 — the platform-wide reconciliation view. Read-only (GET
// /management/v1/reconciliation/drift, R0) — repair happens per-tenant via
// the "Recheck" action on the tenant detail drawer (Tenants page); the one
// mutation reachable here is the governed commission Repair (audit H3),
// because a partial commission may not have a tenant to open. This page exists because the 1A.11 handoff condition (master plan
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
  /** Absent from an older backend build. */
  targetResourceType?: string;
  targetResourceId?: string;
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

// Audit remediation M3 — desired lifecycle vs freshly observed owner state.
interface DriftLifecycleMismatch {
  tenantId: string;
  projectionLifecycleState: string;
  observedPlatformAccessState: string;
}

interface ListDriftResult {
  observedAt: string;
  projectionMissing: DriftProjectionMissing[];
  stuckOperations: DriftStuckOperation[];
  staleObservations: DriftStaleObservation[];
  desiredProvisionedMismatch: DriftDesiredProvisionedMismatch[];
  /** Absent from an older backend build; treated as empty. */
  lifecycleMismatch?: DriftLifecycleMismatch[];
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
  const canCommission = operator?.scopes.includes("tenants.commission") ?? false;
  const [repairTarget, setRepairTarget] = useState<string | null>(null);

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
    ? drift.projectionMissing.length +
      drift.stuckOperations.length +
      drift.staleObservations.length +
      drift.desiredProvisionedMismatch.length +
      (drift.lifecycleMismatch?.length ?? 0)
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
                Operations left partially_completed, or stranded in submitted/accepted/running long past their start, classified by cause.
                They are resolved from the owner&rsquo;s durable receipt via the tenant&rsquo;s &ldquo;Recheck&rdquo; action — never by resending.
              </p>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Class</th>
                      <th>Target tenant</th>
                      <th>Target engine</th>
                      <th>Commission request</th>
                      <th></th>
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
                        <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>
                          {isCommissionRepairCandidate(op) ? op.targetResourceId : "—"}
                        </td>
                        <td>
                          {canCommission && isCommissionRepairCandidate(op) && (
                            <button className="btn" style={{ fontSize: "0.8rem" }} onClick={() => setRepairTarget(op.targetResourceId ?? null)}>
                              <Icon name="build" size="sm" /> Repair
                            </button>
                          )}
                        </td>
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

          {(drift.lifecycleMismatch?.length ?? 0) > 0 && (
            <section style={{ marginBottom: "1.5rem" }}>
              <h3 className="text-subhead" style={{ marginBottom: "0.6rem" }}>
                Lifecycle drift ({drift.lifecycleMismatch?.length})
              </h3>
              <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>
                Governance&rsquo;s desired lifecycle disagrees with Infrakinetic&rsquo;s live access state. Surfaced only: owner truth is not
                rewritten into desired state automatically — converge it with a lifecycle request or a commission repair.
              </p>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tenant ID</th>
                      <th>Desired (Governance)</th>
                      <th>Observed (Infrakinetic)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drift.lifecycleMismatch?.map((m) => (
                      <tr key={m.tenantId}>
                        <td style={{ fontFamily: "monospace", fontSize: "0.8rem" }}>{m.tenantId}</td>
                        <td>
                          <StatusBadge value={m.projectionLifecycleState} />
                        </td>
                        <td>
                          <StatusBadge value={m.observedPlatformAccessState} />
                        </td>
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

      {repairTarget && (
        <RepairCommissionDialog
          commissionRequestId={repairTarget}
          request={request}
          onClose={() => setRepairTarget(null)}
          onRepaired={() => void load()}
        />
      )}
    </>
  );
}
