"use client";

import { useCallback, useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { Drawer } from "../../../components/Drawer";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { EmptyState, ErrorState } from "../../../components/States";
import { ApprovalQueue } from "../../../components/ApprovalQueue";

// Phase 1A.14 §5 — payment adapter lifecycle. Semantics stay in
// module_payments; this page drives the governed boundary:
//   R2  submit / certify / deprecate            (reason, idempotency)
//   R3  approve / retire                        (step-up, maker-checker)
//   R4  revoke                                  (step-up, maker-checker,
//       recovery plan, the owner's live impact bound into the approval)
// Nothing secret is ever shown: releases expose ids, states, hashes and
// counts only; sandbox credentials never pass through this UI.

interface Release {
  releaseId: string;
  releaseKey: string;
  displayName: string;
  vendorName: string;
  certificationStatus: string;
  approvalStatus: string;
  lifecycleStatus: string;
  catalogStatus: string | null;
  manifestHash: string;
  certificationEvidenceHash: string | null;
  submittedBy: string | null;
  approvedBy: string | null;
  liveConnectionCount: number;
  admitsNewConnections: boolean;
  runtimeRequired: boolean;
  registryAudit?: Array<{ action: string; actorId: string | null; createdAt: string }>;
}

interface Runtime {
  workerId: { pmInstance: string | null; pid: number; hostname: string };
  registryEpoch: string | null;
  loadedCustomAdapters: string[];
  lastReconciledAt: string | null;
  lastSyncError: string | null;
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
const key = (prefix: string) => `ui-${prefix}-${Date.now()}`;

function parseJson(text: string, field: string): unknown {
  if (text.trim() === "") return undefined;
  try { return JSON.parse(text); } catch { throw new Error(`${field} is not valid JSON.`); }
}

export default function PaymentAdaptersPage() {
  const { request, stepUp, operator } = useOperatorSession();
  const scopes = operator?.scopes ?? [];
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Release | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, rt] = await Promise.all([request("/management/v1/payment-adapters"), request("/management/v1/payment-adapters/runtime")]);
      if (!list.ok) { setError("Could not load payment adapters."); return; }
      setReleases((await list.json()).releases);
      if (rt.ok) setRuntime((await rt.json()).runtime);
    } catch {
      setError("Could not load payment adapters.");
    }
  }, [request]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1rem" }}>
        <div>
          <h1 className="text-display">Payment extensions</h1>
          <p>Custom payment-provider extensions: certification, approval, lifecycle and runtime readiness. Built-in payment providers are managed elsewhere.</p>
        </div>
        {scopes.includes("payments.adapters.submit") && (
          <button className="btn btn-primary" onClick={() => setShowSubmit(true)}>Submit adapter</button>
        )}
      </div>

      {runtime && releases && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
            <RuntimeMetric label="Custom releases" value={String(releases.length)} />
            <RuntimeMetric label="Runtime loaded" value={String(runtime.loadedCustomAdapters.length)} />
            <RuntimeMetric label="Runtime sync" value={runtime.lastSyncError ? "Needs attention" : runtime.lastReconciledAt ? "Synchronized" : "Not observed"} />
            <RuntimeMetric label="Last reconciliation" value={when(runtime.lastReconciledAt)} />
          </div>
          {runtime.lastSyncError && (
            <div className="card" style={{ marginBottom: "1rem", borderColor: "var(--danger-border)" }}>
              <strong>Runtime synchronization issue</strong>
              <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>{runtime.lastSyncError}</p>
            </div>
          )}
        </>
      )}

      {error && <ErrorState label={error} />}
      {releases && releases.length === 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <EmptyState label="No custom payment adapter releases are installed." icon="payments" />
          <p className="overlay-note" style={{ textAlign: "center", marginBottom: 0 }}>This catalog is only for governed custom payment-provider extensions. Built-in payment providers and tenant payment credentials are not represented as custom adapter releases here.</p>
        </div>
      )}
      {releases && releases.length > 0 && (
        <table className="data-table">
          <thead>
            <tr><th>Release</th><th>Vendor</th><th>Certification</th><th>Approval</th><th>Lifecycle</th><th>Live connections</th><th>New connections</th></tr>
          </thead>
          <tbody>
            {releases.map((r) => (
              <tr key={r.releaseId} onClick={() => setSelected(r)} style={{ cursor: "pointer" }}>
                <td style={{ fontFamily: "monospace" }}>{r.releaseKey}</td>
                <td>{r.vendorName}</td>
                <td><StatusBadge value={r.certificationStatus} /></td>
                <td><StatusBadge value={r.approvalStatus} /></td>
                <td><StatusBadge value={r.lifecycleStatus} /></td>
                <td>{r.liveConnectionCount}</td>
                <td>{r.admitsNewConnections ? "admitted" : "not admitted"}</td>
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
          returnTo="/payment-adapters"
          include={(a) => a.requestedAction.startsWith("payment.adapter.")}
          refreshKey={refreshKey}
          onExecuted={() => setRefreshKey((k) => k + 1)}
                      hideWhenEmpty
/>
      )}

      {selected && (
        <ReleaseDrawer
          releaseId={selected.releaseId}
          scopes={scopes}
          request={request}
          stepUp={stepUp}
          onClose={() => setSelected(null)}
          onChanged={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {showSubmit && <SubmitDrawer request={request} onClose={() => setShowSubmit(false)} onChanged={() => setRefreshKey((k) => k + 1)} />}
    </>
  );
}

function RuntimeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: "0.85rem 1rem" }}>
      <div className="overlay-note" style={{ marginTop: 0 }}>{label}</div>
      <div style={{ fontSize: "1.1rem", fontWeight: 650, marginTop: "0.2rem" }}>{value}</div>
    </div>
  );
}

function ReleaseDrawer({
  releaseId, scopes, request, stepUp, onClose, onChanged,
}: {
  releaseId: string;
  scopes: readonly string[];
  request: (path: string, init?: RequestInit) => Promise<Response>;
  stepUp: (returnTo?: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [release, setRelease] = useState<Release | null>(null);
  const [impact, setImpact] = useState<{ affectedConnectionCount: number; affectedTenantCount: number; byEnvironment: { test: number; live: number } } | null>(null);
  const [reason, setReason] = useState("");
  const [recoveryIntent, setRecoveryIntent] = useState("");
  const [fixtures, setFixtures] = useState("");
  const [vectors, setVectors] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const load = useCallback(async () => {
    const [d, i] = await Promise.all([
      request(`/management/v1/payment-adapters/${releaseId}`),
      request(`/management/v1/payment-adapters/${releaseId}/revoke-impact`),
    ]);
    if (d.ok) setRelease((await d.json()).release);
    if (i.ok) setImpact((await i.json()).impact);
  }, [request, releaseId]);

  useEffect(() => { void load(); }, [load]);

  async function post(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) { setMessage(out.error === "STEP_UP_REQUIRED" ? "STEP_UP_REQUIRED" : out.message ?? out.error ?? "That action failed."); return; }
      setMessage(out.approval ? "Approval requested — a different operator must approve it." : `Operation ${out.operation?.status ?? "submitted"}.`);
      onChanged();
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "That action failed.");
    } finally {
      setBusy(false);
      setConfirmRevoke(false);
    }
  }

  const base = `/management/v1/payment-adapters/${releaseId}`;
  const reasonOk = reason.trim() !== "";

  return (
    <>
      <Drawer title={release?.releaseKey ?? "Adapter release"} subtitle={release?.displayName} onClose={onClose}>
        {release && (
          <div className="card">
            <dl style={{ fontSize: "0.85rem", margin: 0 }}>
              <dt className="overlay-note">States</dt>
              <dd style={{ margin: "0.2rem 0 0.6rem", display: "flex", gap: "0.4rem" }}>
                <StatusBadge value={release.certificationStatus} /><StatusBadge value={release.approvalStatus} /><StatusBadge value={release.lifecycleStatus} />
              </dd>
              <dt className="overlay-note">Manifest hash</dt><dd style={{ fontFamily: "monospace", margin: "0.1rem 0 0.6rem", wordBreak: "break-all" }}>{release.manifestHash}</dd>
              <dt className="overlay-note">Submitted by / approved by</dt><dd style={{ margin: "0.1rem 0 0.6rem" }}>{release.submittedBy ?? "—"} / {release.approvedBy ?? "—"}</dd>
              <dt className="overlay-note">Runtime</dt>
              <dd style={{ margin: "0.1rem 0 0.6rem" }}>
                {release.runtimeRequired ? "Required at runtime" : "Not required at runtime"} · {release.admitsNewConnections ? "admits new connections" : "does not admit new connections"}
              </dd>
            </dl>
            {release.registryAudit && release.registryAudit.length > 0 && (
              <p className="overlay-note">Audit: {release.registryAudit.map((a) => `${a.action} ${when(a.createdAt)}`).join(" → ")}</p>
            )}
          </div>
        )}

        <div className="card" style={{ marginTop: "1rem" }}>
          <div className="field">
            <label>Reason</label>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this change needed?" />
          </div>

          {scopes.includes("payments.adapters.certify") && release?.approvalStatus === "submitted" && (
            <>
              <div className="field"><label>Certification fixtures (JSON)</label><textarea rows={3} value={fixtures} onChange={(e) => setFixtures(e.target.value)} /></div>
              <div className="field"><label>Signature vectors (JSON)</label><textarea rows={3} value={vectors} onChange={(e) => setVectors(e.target.value)} /></div>
              <p className="field-hint">Sandbox credentials are resolved by Payments itself — never enter them here.</p>
              <button className="btn" disabled={!reasonOk || busy} onClick={() => {
                try { void post(`${base}/certify`, { idempotencyKey: key("certify"), reason, fixtures: parseJson(fixtures, "Fixtures"), signatureVectors: parseJson(vectors, "Signature vectors") }); }
                catch (err) { setMessage((err as Error).message); }
              }}>Certify in sandbox (R2)</button>
            </>
          )}

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
            {scopes.includes("payments.adapters.approve") && release?.certificationStatus === "certified" && release.approvalStatus === "submitted" && (
              <button className="btn btn-primary" disabled={!reasonOk || busy} onClick={() => post(`${base}/approve/request`, { reason })}>Request approval…</button>
            )}
            {scopes.includes("payments.adapters.revoke") && release?.lifecycleStatus === "active" && (
              <button className="btn" disabled={!reasonOk || busy} onClick={() => post(`${base}/deprecate`, { idempotencyKey: key("deprecate"), reason })}>Deprecate (R2)</button>
            )}
            {scopes.includes("payments.adapters.revoke") && ["active", "deprecated"].includes(release?.lifecycleStatus ?? "") && (
              <button className="btn" disabled={!reasonOk || busy} onClick={() => post(`${base}/retire/request`, { reason })}>Request retirement…</button>
            )}
          </div>

          {scopes.includes("payments.adapters.revoke") && ["active", "deprecated", "retired"].includes(release?.lifecycleStatus ?? "") && (
            <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border-subtle)", paddingTop: "0.75rem" }}>
              <p style={{ fontSize: "0.85rem", margin: "0 0 0.5rem" }}>
                Revocation disables every connection on this extension across the fleet and requires a recovery plan plus a second operator.
                {impact && <> Current impact: <strong>{impact.affectedConnectionCount}</strong> connections in <strong>{impact.affectedTenantCount}</strong> tenants (test {impact.byEnvironment.test}, live {impact.byEnvironment.live}). The approval binds this count; execution is refused if it changes.</>}
              </p>
              <div className="field"><label>Recovery plan</label><textarea rows={2} value={recoveryIntent} onChange={(e) => setRecoveryIntent(e.target.value)} placeholder="How will affected tenants be restored?" /></div>
              <button className="btn btn-danger" disabled={!reasonOk || recoveryIntent.trim() === "" || busy} onClick={() => setConfirmRevoke(true)}>Request revocation…</button>
            </div>
          )}

          {message === "STEP_UP_REQUIRED" ? (
            <div style={{ marginTop: "0.75rem" }}>
              <p style={{ fontSize: "0.85rem", margin: "0 0 0.5rem" }}>This request requires a fresh sign-in confirmation.</p>
              <button className="btn btn-primary" onClick={() => stepUp("/payment-adapters")}>Step up now</button>
            </div>
          ) : (
            message && <p className="overlay-note" role="status">{message}</p>
          )}
        </div>
      </Drawer>
      {confirmRevoke && (
        <ConfirmDialog
          title="Request a global adapter revoke?"
          description={`This asks a second operator to approve revoking ${release?.releaseKey}. Once executed, ${impact?.affectedConnectionCount ?? "all"} connections are revoked immediately for every tenant using it.`}
          confirmLabel="Request revoke"
          danger
          busy={busy}
          onConfirm={() => post(`${base}/revoke/request`, { reason, recoveryIntent })}
          onCancel={() => setConfirmRevoke(false)}
        />
      )}
    </>
  );
}

function SubmitDrawer({ request, onClose, onChanged }: { request: (path: string, init?: RequestInit) => Promise<Response>; onClose: () => void; onChanged: () => void }) {
  const [form, setForm] = useState({ reason: "", manifest: "", manifestSignature: "", vendorPublicKey: "", vendorName: "", fixtures: "", signatureVectors: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const body = {
        idempotencyKey: key("submit"), reason: form.reason, manifest: parseJson(form.manifest, "Manifest"), manifestSignature: form.manifestSignature.trim(),
        vendorPublicKey: form.vendorPublicKey, vendorName: form.vendorName, fixtures: parseJson(form.fixtures, "Fixtures"), signatureVectors: parseJson(form.signatureVectors, "Signature vectors"),
      };
      const res = await request("/management/v1/payment-adapters", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json();
      if (!res.ok) { setMessage(out.message ?? out.error ?? "Submission failed."); return; }
      setMessage(`Operation ${out.operation?.status}.`);
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer title="Submit adapter release" subtitle="R2 — creates an inactive, uncertified release" onClose={onClose}>
      <div className="card">
        {(["vendorName", "manifestSignature"] as const).map((k) => (
          <div className="field" key={k}><label>{k === "vendorName" ? "Vendor name" : "Manifest signature (base64)"}</label><input value={form[k]} onChange={set(k)} /></div>
        ))}
        {(["manifest", "vendorPublicKey", "fixtures", "signatureVectors"] as const).map((k) => (
          <div className="field" key={k}><label>{{ manifest: "Manifest (JSON)", vendorPublicKey: "Vendor public key (PEM)", fixtures: "Fixtures (JSON)", signatureVectors: "Signature vectors (JSON)" }[k]}</label><textarea rows={4} value={form[k]} onChange={set(k)} /></div>
        ))}
        <div className="field"><label>Reason</label><textarea rows={2} value={form.reason} onChange={set("reason")} /></div>
        <button className="btn btn-primary" disabled={busy || form.reason.trim() === ""} onClick={submit}>Submit</button>
        {message && <p className="overlay-note" role="status">{message}</p>}
      </div>
    </Drawer>
  );
}
