"use client";

import { useCallback, useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { ErrorState } from "../../../components/States";
import { ApprovalQueue, type ApprovalRecord } from "../../../components/ApprovalQueue";

// Phase 1A.14 §8 — global configuration backup/restore. The sequence is
// fixed: snapshot or author a package -> validated (contract version, hash,
// signature) -> owner dry-run against live state -> R4 approval request
// (fresh step-up; the checker sees the field-level diff) -> execution by
// any operator holding apply -> owner-verified after-state -> observe.
// Rollback is a new package built from the stored before-snapshot, through
// the same gate. Only classes whose owner published an apply contract can
// be applied; the rest can be snapshotted and dry-run to surface drift.

interface ClassContract { classKey: string; ownerEngine: string; applyMode: string; naturalKey: string[]; mutableFields: string[] }
interface PackageMeta { packageId: string; classKey: string; provenance: string; purpose: string; status: string; rowCount: number; submittedAt: string; contentHash: string; lastDryRun: DryRun | null }
interface DryRun {
  applyMode: string; changeCount: number; applicable: boolean; blockers: Array<Record<string, unknown>>;
  diff: { insert: Array<Record<string, unknown>>; update: Array<{ key: Record<string, unknown>; changedFields: string[]; before: Record<string, unknown>; after: Record<string, unknown> }>; untouched: unknown[] };
}
interface RestoreOperation { restoreOperationId: string; packageId: string; classKey: string; status: string; afterSnapshotHash: string | null; lastObservation: { status: string; observedAt: string } | null; createdAt: string }

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

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
    try {
      const [c, p, o] = await Promise.all([
        request("/management/v1/global-config/classes"),
        request("/management/v1/global-config/packages"),
        request("/management/v1/global-config/restore-operations"),
      ]);
      if (!c.ok) { setError(c.status === 403 ? "You need the global_config.restore scope." : "Could not load global configuration classes."); return; }
      setClasses((await c.json()).classes);
      if (p.ok) setPackages((await p.json()).packages);
      if (o.ok) setOperations((await o.json()).restoreOperations);
    } catch {
      setError("Could not load global configuration.");
    }
  }, [request]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  async function call(path: string, body?: unknown, success?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const out = await res.json();
      if (!res.ok) { setMessage(out.error === "STEP_UP_REQUIRED" ? "STEP_UP_REQUIRED" : `${out.error}: ${out.message ?? ""}`); return null; }
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
    const latest = packages.find((p) => p.classKey === classKey && p.purpose === "backup");
    if (!latest) { setMessage("Capture a snapshot of this class first — it becomes the editable starting point."); return; }
    const res = await request(`/management/v1/global-config/packages/${latest.packageId}`);
    if (!res.ok) return;
    setRowsText(JSON.stringify((await res.json()).package.package.rows, null, 2));
    setAuthorClass(classKey);
  }

  function renderRestoreSummary(a: ApprovalRecord) {
    const s = a.safeRequestSummary as { classKey?: string; purpose?: string; changeCount?: number; inserts?: unknown[]; updates?: Array<{ key: Record<string, unknown>; changes: Record<string, { before: unknown; after: unknown }> }>; untouchedCount?: number } | undefined;
    if (!s) return null;
    return (
      <div style={{ fontSize: "0.8rem" }}>
        <p style={{ margin: "0.2rem 0" }}><strong>{s.classKey}</strong> · {s.purpose} · {s.changeCount} change(s) · {s.untouchedCount} row(s) untouched</p>
        {s.updates?.map((u) => (
          <div key={JSON.stringify(u.key)} style={{ fontFamily: "monospace" }}>
            {Object.values(u.key).join("@")}: {Object.entries(u.changes).map(([f, c]) => `${f}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join("; ")}
          </div>
        ))}
        {s.inserts && s.inserts.length > 0 && <div>Inserts: {s.inserts.length}</div>}
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1 className="text-display">Global configuration</h1>
        <p>Backup, dry-run and governed restore of the seven platform-global configuration classes.</p>
      </div>
      {error && <ErrorState label={error} />}
      {message === "STEP_UP_REQUIRED" ? (
        <div className="card"><p style={{ margin: "0 0 0.5rem" }}>Requesting a restore requires a fresh sign-in confirmation.</p><button className="btn btn-primary" onClick={() => stepUp("/global-config")}>Step up now</button></div>
      ) : (
        message && <div className="card" role="status" style={{ fontSize: "0.85rem" }}>{message}</div>
      )}

      {classes && (
        <table className="data-table" style={{ marginTop: "1rem" }}>
          <thead><tr><th>Class</th><th>Owner</th><th>Apply</th><th /></tr></thead>
          <tbody>
            {classes.map((c) => (
              <tr key={c.classKey}>
                <td style={{ fontFamily: "monospace" }}>{c.classKey}</td>
                <td>{c.ownerEngine}</td>
                <td>{c.applyMode === "supported" ? "Owner apply published" : "Snapshot / dry-run only"}</td>
                <td style={{ display: "flex", gap: "0.4rem" }}>
                  <button className="btn" style={{ fontSize: "0.8rem" }} disabled={busy} onClick={() => call(`/management/v1/global-config/${c.classKey}/snapshots`, {}, "Snapshot captured and verified.")}>Capture snapshot</button>
                  <button className="btn" style={{ fontSize: "0.8rem" }} disabled={busy} onClick={() => startAuthoring(c.classKey)}>Author package</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {authorClass && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <h3 className="text-subhead">Author a {authorClass} package</h3>
          <p className="field-hint">Edit rows (contract fields only). Rows you remove are left untouched on apply — a restore never deletes.</p>
          <textarea rows={12} value={rowsText} onChange={(e) => setRowsText(e.target.value)} style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }} />
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button className="btn btn-primary" disabled={busy} onClick={async () => {
              let rows: unknown;
              try { rows = JSON.parse(rowsText); } catch { setMessage("Rows are not valid JSON."); return; }
              const out = await call(`/management/v1/global-config/${authorClass}/packages/authored`, { rows, purpose: "restore" }, "Package authored and attested.");
              if (out) setAuthorClass(null);
            }}>Create package</button>
            <button className="btn" onClick={() => setAuthorClass(null)}>Cancel</button>
          </div>
        </div>
      )}

      <h3 className="text-subhead" style={{ margin: "1.5rem 0 0.5rem" }}>Packages</h3>
      {packages.length === 0 ? <p className="overlay-note">No packages yet.</p> : (
        <table className="data-table">
          <thead><tr><th>Class</th><th>Purpose</th><th>Provenance</th><th>Status</th><th>Rows</th><th>Dry-run</th><th /></tr></thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.packageId}>
                <td style={{ fontFamily: "monospace" }}>{p.classKey}</td>
                <td>{p.purpose}</td>
                <td>{p.provenance}</td>
                <td><StatusBadge value={p.status} /></td>
                <td>{p.rowCount}</td>
                <td style={{ fontSize: "0.8rem" }}>
                  {p.lastDryRun ? (
                    <>
                      {p.lastDryRun.changeCount} change(s){p.lastDryRun.blockers.length ? ` · blocked: ${p.lastDryRun.blockers.map((b) => String(b.code)).join(", ")}` : ""}
                      {p.lastDryRun.diff.update.map((u) => (
                        <div key={JSON.stringify(u.key)} style={{ fontFamily: "monospace" }}>{Object.values(u.key).join("@")}: {u.changedFields.join(", ")}</div>
                      ))}
                    </>
                  ) : "—"}
                </td>
                <td style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  {p.purpose !== "backup" && ["validated", "dry_run"].includes(p.status) && (
                    <button className="btn" style={{ fontSize: "0.8rem" }} disabled={busy} onClick={() => call(`/management/v1/global-config/packages/${p.packageId}/dry-run`, {}, "Dry-run complete.")}>Dry-run</button>
                  )}
                  {p.purpose !== "backup" && p.status === "dry_run" && p.lastDryRun?.applicable && scopes.includes("global_config.restore.apply") && (
                    <>
                      <input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ fontSize: "0.8rem" }} />
                      <button className="btn btn-danger" style={{ fontSize: "0.8rem" }} disabled={busy || reason.trim() === ""} onClick={() => call(`/management/v1/global-config/packages/${p.packageId}/apply/request`, { reason }, "Restore requested — a different operator must approve it.")}>Request apply (R4)</button>
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
          include={(a) => a.requestedAction === "global-config.restore.apply"}
          refreshKey={refreshKey}
          onExecuted={() => setRefreshKey((k) => k + 1)}
          renderSummary={renderRestoreSummary}
        />
      )}

      <h3 className="text-subhead" style={{ margin: "1.5rem 0 0.5rem" }}>Restore operations</h3>
      {operations.length === 0 ? <p className="overlay-note">No restores applied.</p> : (
        <table className="data-table">
          <thead><tr><th>Class</th><th>Status</th><th>Applied</th><th>Effective state</th><th /></tr></thead>
          <tbody>
            {operations.map((o) => (
              <tr key={o.restoreOperationId}>
                <td style={{ fontFamily: "monospace" }}>{o.classKey}</td>
                <td><StatusBadge value={o.status} /></td>
                <td>{when(o.createdAt)}</td>
                <td>{o.lastObservation ? <><StatusBadge value={o.lastObservation.status === "matches" ? "healthy" : o.lastObservation.status === "drift" ? "degraded" : "unknown"} /> {o.lastObservation.status} · {when(o.lastObservation.observedAt)}</> : "Not observed yet"}</td>
                <td style={{ display: "flex", gap: "0.4rem" }}>
                  <button className="btn" style={{ fontSize: "0.8rem" }} disabled={busy} onClick={() => call(`/management/v1/global-config/restore-operations/${o.restoreOperationId}/observe`, {}, "Observed.")}>Observe</button>
                  {o.status === "completed" && (
                    <button className="btn" style={{ fontSize: "0.8rem" }} disabled={busy} onClick={() => call(`/management/v1/global-config/restore-operations/${o.restoreOperationId}/rollback-package`, {}, "Rollback package created — dry-run and request it like any restore.")}>Create rollback package</button>
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
