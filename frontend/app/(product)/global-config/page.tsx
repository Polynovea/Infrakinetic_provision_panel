"use client";

import { useCallback, useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { ErrorState } from "../../../components/States";
import { ApprovalQueue, type ApprovalRecord } from "../../../components/ApprovalQueue";

// Phase 1A.14 global configuration restore. The security sequence is unchanged:
// signed snapshot -> validated plan -> owner dry-run -> maker/checker approval ->
// owner apply -> independent observation. This page intentionally hides package
// mechanics from the primary workflow while keeping their evidence available.
interface ClassContract {
  classKey: string;
  ownerEngine: string;
  applyMode: string;
  naturalKey: string[];
  mutableFields: string[];
}

interface PackageMeta {
  packageId: string;
  classKey: string;
  provenance: string;
  purpose: string;
  status: string;
  rowCount: number;
  submittedAt: string;
  contentHash: string;
  lastDryRun: DryRun | null;
}

interface DryRun {
  applyMode: string;
  changeCount: number;
  applicable: boolean;
  blockers: Array<Record<string, unknown>>;
  diff: {
    insert: Array<Record<string, unknown>>;
    update: Array<{
      key: Record<string, unknown>;
      changedFields: string[];
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>;
    untouched: unknown[];
  };
}

interface RestoreOperation {
  restoreOperationId: string;
  packageId: string;
  classKey: string;
  status: string;
  afterSnapshotHash: string | null;
  lastObservation: { status: string; observedAt: string } | null;
  createdAt: string;
}

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

const CLASS_LABELS: Record<string, string> = {
  payment_provider_catalog: "Payment provider catalog",
  assignable_type_registry: "Assignable work types",
  document_template_categories: "Document template categories",
  event_catalog: "Platform event catalog",
  finance_coa_templates: "Finance chart templates",
  finance_coa_template_accounts: "Finance chart template accounts",
  workflow_entity_registry: "Workflow entity registry",
};

const OWNER_LABELS: Record<string, string> = {
  payments: "Payments",
  governance: "Platform Governance",
  documents: "Document Engine",
  platform_core: "Platform Core",
  finance: "Finance",
  workflow: "Workflow",
};

const classLabel = (key: string) => CLASS_LABELS[key] ?? key.replace(/_/g, " ");
const ownerLabel = (key: string) => OWNER_LABELS[key] ?? key.replace(/_/g, " ");
const purposeLabel = (value: string) =>
  value === "backup"
    ? "Protected snapshot"
    : value === "restore"
      ? "Restore plan"
      : value === "rollback"
        ? "Rollback plan"
        : value.replace(/_/g, " ");

export default function GlobalConfigPage() {
  const { request, stepUp, operator } = useOperatorSession();
  const scopes = operator?.scopes ?? [];
  const [classes, setClasses] = useState<ClassContract[] | null>(null);
  const [packages, setPackages] = useState<PackageMeta[]>([]);
  const [operations, setOperations] = useState<RestoreOperation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [authorClass, setAuthorClass] = useState<string | null>(null);
  const [rowsText, setRowsText] = useState("");
  const [reason, setReason] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, p, o] = await Promise.all([
        request("/management/v1/global-config/classes"),
        request("/management/v1/global-config/packages"),
        request("/management/v1/global-config/restore-operations"),
      ]);
      if (!c.ok) {
        setError(c.status === 403 ? "You do not have permission to view configuration restore." : "Could not load configuration areas.");
        return;
      }
      setClasses((await c.json()).classes);
      if (p.ok) setPackages((await p.json()).packages);
      if (o.ok) setOperations((await o.json()).restoreOperations);
    } catch {
      setError("Could not load configuration restore.");
    }
  }, [request]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  async function call(path: string, body?: unknown, success?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const out = await res.json();
      if (!res.ok) {
        setMessage(out.error === "STEP_UP_REQUIRED" ? "STEP_UP_REQUIRED" : (out.message ?? out.error ?? "That action failed."));
        return null;
      }
      setMessage(success ?? "Done.");
      setRefreshKey((k) => k + 1);
      return out;
    } catch {
      setMessage("That action failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function startAuthoring(classKey: string) {
    const contract = classes?.find((entry) => entry.classKey === classKey);
    if (!contract || contract.applyMode !== "supported") {
      setMessage("This configuration area supports snapshot and drift review only; its owner has not published a live restore contract.");
      return;
    }
    const latest = packages.find((pkg) => pkg.classKey === classKey && pkg.purpose === "backup");
    if (!latest) {
      setMessage("Capture a protected snapshot first. Restore plans are always prepared from a verified current-state snapshot.");
      return;
    }
    const res = await request(`/management/v1/global-config/packages/${latest.packageId}`);
    if (!res.ok) {
      setMessage("Could not open the latest protected snapshot.");
      return;
    }
    setRowsText(JSON.stringify((await res.json()).package.package.rows, null, 2));
    setAuthorClass(classKey);
  }

  function renderRestoreSummary(approval: ApprovalRecord) {
    const summary = approval.safeRequestSummary as {
      classKey?: string;
      changeCount?: number;
      updates?: Array<{ key: Record<string, unknown>; changes: Record<string, { before: unknown; after: unknown }> }>;
      inserts?: unknown[];
      untouchedCount?: number;
    } | undefined;
    if (!summary) return null;
    return (
      <div style={{ fontSize: "0.82rem" }}>
        <p style={{ margin: "0.25rem 0" }}>
          <strong>{classLabel(summary.classKey ?? "Configuration")}</strong> · {summary.changeCount ?? 0} change(s) · {summary.untouchedCount ?? 0} row(s) unchanged
        </p>
        {summary.updates?.slice(0, 8).map((update) => (
          <div key={JSON.stringify(update.key)} className="overlay-note" style={{ marginTop: "0.15rem" }}>
            {Object.values(update.key).join(" · ")}: {Object.entries(update.changes).map(([field, change]) => `${field.replace(/_/g, " ")}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`).join("; ")}
          </div>
        ))}
        {summary.inserts && summary.inserts.length > 0 && <div className="overlay-note">New rows: {summary.inserts.length}</div>}
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1 className="text-display">Configuration restore</h1>
        <p>Protected snapshots and governed restore plans for platform-wide reference configuration.</p>
      </div>

      {error && <ErrorState label={error} />}
      {message === "STEP_UP_REQUIRED" ? (
        <div className="card">
          <p style={{ margin: "0 0 0.5rem" }}>Requesting a restore requires a fresh sign-in confirmation.</p>
          <button className="btn btn-primary" onClick={() => stepUp("/global-config")}>Confirm sign-in</button>
        </div>
      ) : (
        message && <div className="card" role="status" style={{ fontSize: "0.85rem" }}>{message}</div>
      )}

      <div className="card" style={{ marginBottom: "1rem" }}>
        <strong>How restore works</strong>
        <p className="overlay-note" style={{ marginBottom: 0 }}>
          Capture a verified snapshot, prepare a restore plan only where the owning engine supports live apply, preview the exact changes, then require a second operator before execution. Omitted rows are never silently deleted.
        </p>
      </div>

      {classes && (
        <>
          <h3 className="text-subhead" style={{ margin: "0 0 0.5rem" }}>Configuration areas</h3>
          <table className="data-table">
            <thead><tr><th>Configuration area</th><th>Managed by</th><th>Restore capability</th><th /></tr></thead>
            <tbody>
              {classes.map((entry) => (
                <tr key={entry.classKey}>
                  <td>
                    <strong>{classLabel(entry.classKey)}</strong>
                    <details>
                      <summary className="overlay-note" style={{ cursor: "pointer", marginTop: "0.2rem" }}>Technical contract</summary>
                      <div className="overlay-note">{entry.classKey} · identity: {entry.naturalKey.join(", ")}</div>
                    </details>
                  </td>
                  <td>{ownerLabel(entry.ownerEngine)}</td>
                  <td>{entry.applyMode === "supported" ? "Protected restore available" : "Snapshot & drift review only"}</td>
                  <td style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    <button
                      className="btn"
                      style={{ fontSize: "0.8rem" }}
                      disabled={busy}
                      onClick={() => call(`/management/v1/global-config/${entry.classKey}/snapshots`, {}, "Protected snapshot captured and verified.")}
                    >
                      Capture snapshot
                    </button>
                    {entry.applyMode === "supported" && (
                      <button className="btn btn-primary" style={{ fontSize: "0.8rem" }} disabled={busy} onClick={() => startAuthoring(entry.classKey)}>
                        Prepare restore plan…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {authorClass && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h3 className="text-subhead">Prepare restore plan for {classLabel(authorClass)}</h3>
          <p className="field-hint">
            Advanced structured editor. It starts from the latest verified snapshot. Edit only published configuration fields. Omitting a row leaves the live row untouched.
          </p>
          <textarea rows={12} value={rowsText} onChange={(event) => setRowsText(event.target.value)} style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }} />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button className="btn btn-primary" disabled={busy} onClick={async () => {
              let rows: unknown;
              try { rows = JSON.parse(rowsText); } catch { setMessage("The structured configuration is not valid JSON."); return; }
              const out = await call(
                `/management/v1/global-config/${authorClass}/packages/authored`,
                { rows, purpose: "restore" },
                "Restore plan created and cryptographically attested.",
              );
              if (out) setAuthorClass(null);
            }}>
              Create restore plan
            </button>
            <button className="btn" onClick={() => setAuthorClass(null)}>Cancel</button>
          </div>
        </div>
      )}

      <h3 className="text-subhead" style={{ margin: "1.5rem 0 0.5rem" }}>Snapshots &amp; restore plans</h3>
      {packages.length === 0 ? <p className="overlay-note">No snapshots or restore plans yet.</p> : (
        <table className="data-table">
          <thead><tr><th>Configuration area</th><th>Type</th><th>Status</th><th>Contents</th><th>Change preview</th><th /></tr></thead>
          <tbody>
            {packages.map((pkg) => (
              <tr key={pkg.packageId}>
                <td>
                  <strong>{classLabel(pkg.classKey)}</strong>
                  <details>
                    <summary className="overlay-note" style={{ cursor: "pointer", marginTop: "0.2rem" }}>Technical evidence</summary>
                    <div className="overlay-note">{pkg.classKey} · {pkg.provenance} · {pkg.contentHash.slice(0, 12)}… · {when(pkg.submittedAt)}</div>
                  </details>
                </td>
                <td>{purposeLabel(pkg.purpose)}</td>
                <td><StatusBadge value={pkg.status} /></td>
                <td>{pkg.rowCount} row{pkg.rowCount === 1 ? "" : "s"}</td>
                <td style={{ fontSize: "0.82rem" }}>
                  {pkg.lastDryRun ? (
                    <>
                      <div>{pkg.lastDryRun.changeCount === 0 ? "No changes" : `${pkg.lastDryRun.changeCount} change${pkg.lastDryRun.changeCount === 1 ? "" : "s"}`}</div>
                      {pkg.lastDryRun.blockers.length > 0 && <div className="overlay-note">Cannot apply: {pkg.lastDryRun.blockers.length} blocker{pkg.lastDryRun.blockers.length === 1 ? "" : "s"}</div>}
                      {pkg.lastDryRun.diff.update.slice(0, 5).map((update) => (
                        <div key={JSON.stringify(update.key)} className="overlay-note" style={{ marginTop: "0.15rem" }}>
                          {Object.values(update.key).join(" · ")}: {update.changedFields.map((field) => field.replace(/_/g, " ")).join(", ")}
                        </div>
                      ))}
                    </>
                  ) : "Not previewed"}
                </td>
                <td style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  {pkg.purpose !== "backup" && ["validated", "dry_run"].includes(pkg.status) && (
                    <button
                      className="btn"
                      style={{ fontSize: "0.8rem" }}
                      disabled={busy}
                      onClick={() => call(`/management/v1/global-config/packages/${pkg.packageId}/dry-run`, {}, "Change preview refreshed.")}
                    >
                      Preview changes
                    </button>
                  )}
                  {pkg.purpose !== "backup" && pkg.status === "dry_run" && pkg.lastDryRun?.applicable && scopes.includes("global_config.restore.apply") && (
                    <>
                      <input placeholder="Why is this restore needed?" value={reason} onChange={(event) => setReason(event.target.value)} style={{ fontSize: "0.8rem" }} />
                      <button
                        className="btn btn-danger"
                        style={{ fontSize: "0.8rem" }}
                        disabled={busy || reason.trim() === ""}
                        onClick={() => call(`/management/v1/global-config/packages/${pkg.packageId}/apply/request`, { reason }, "Restore requested — a different operator must approve it.")}
                      >
                        Request restore approval…
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {operator && (
        <ApprovalQueue
          request={request}
          stepUp={stepUp}
          operatorId={operator.operatorId}
          returnTo="/global-config"
          include={(approval) => approval.requestedAction === "global-config.restore.apply"}
          refreshKey={refreshKey}
          onExecuted={() => setRefreshKey((key) => key + 1)}
          renderSummary={renderRestoreSummary}
          hideWhenEmpty
        />
      )}

      <h3 className="text-subhead" style={{ margin: "1.5rem 0 0.5rem" }}>Restore history</h3>
      {operations.length === 0 ? <p className="overlay-note">No restore has been applied yet.</p> : (
        <table className="data-table">
          <thead><tr><th>Configuration area</th><th>Status</th><th>Applied</th><th>Current-state check</th><th /></tr></thead>
          <tbody>
            {operations.map((operation) => (
              <tr key={operation.restoreOperationId}>
                <td>{classLabel(operation.classKey)}</td>
                <td><StatusBadge value={operation.status} /></td>
                <td>{when(operation.createdAt)}</td>
                <td>
                  {operation.lastObservation
                    ? <><StatusBadge value={operation.lastObservation.status === "matches" ? "healthy" : operation.lastObservation.status === "drift" ? "degraded" : "unknown"} /> {operation.lastObservation.status.replace(/_/g, " ")} · {when(operation.lastObservation.observedAt)}</>
                    : "Not verified since restore"}
                </td>
                <td style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <button
                    className="btn"
                    style={{ fontSize: "0.8rem" }}
                    disabled={busy}
                    onClick={() => call(`/management/v1/global-config/restore-operations/${operation.restoreOperationId}/observe`, {}, "Current state verified.")}
                  >
                    Verify current state
                  </button>
                  {operation.status === "completed" && (
                    <button
                      className="btn"
                      style={{ fontSize: "0.8rem" }}
                      disabled={busy}
                      onClick={() => call(`/management/v1/global-config/restore-operations/${operation.restoreOperationId}/rollback-package`, {}, "Rollback plan prepared — preview it and request approval like any other restore.")}
                    >
                      Prepare rollback plan
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
