"use client";

import { useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { Icon } from "../../../components/Icon";
import { Drawer } from "../../../components/Drawer";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { EmptyState, ErrorState } from "../../../components/States";
import { SkeletonCard } from "../../../components/Skeleton";

type DesiredState = "operational" | "degraded" | "disabled";

interface EngineCatalogEntry {
  engineKey: string;
  label: string;
  aliases: readonly string[];
  state: DesiredState | "unknown";
  reason: string | null;
}

interface OperationView {
  operationId: string;
  status: string;
  riskClass: string;
  targetEngine: string;
  reason?: string;
  partialFailureState?: unknown;
  rollbackReference?: unknown;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function PlatformPage() {
  const { request } = useOperatorSession();
  const [engines, setEngines] = useState<EngineCatalogEntry[] | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EngineCatalogEntry | null>(null);

  async function loadEngines() {
    setLoadError(null);
    try {
      const res = await request("/management/v1/engines");
      if (!res.ok) {
        setLoadError("Could not load the engine catalog.");
        return;
      }
      const body = await res.json();
      setEngines(body.engines);
      setObservedAt(body.observedAt);
      // Keep an open drawer showing the freshest server truth rather than
      // whatever it was pointed at before this reload (e.g. after a
      // completed change or recovery) — never a locally-guessed patch.
      setSelected((prev) => (prev ? (body.engines as EngineCatalogEntry[]).find((e) => e.engineKey === prev.engineKey) ?? prev : prev));
    } catch {
      setLoadError("Could not load the engine catalog.");
    }
  }

  useEffect(() => {
    void loadEngines();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  return (
    <>
      <div className="page-header">
        <h1 className="text-display">Platform</h1>
        <p>{observedAt ? `Last observed ${formatDate(observedAt)}` : "The engine fleet and its current platform state."}</p>
      </div>

      {loadError && <ErrorState label={loadError} />}
      {!loadError && engines === null && (
        <div className="card-grid">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}
      {!loadError && engines !== null && engines.length === 0 && <EmptyState label="No engines found." icon="dns" />}
      {!loadError && engines !== null && engines.length > 0 && (
        <div className="card-grid">
          {engines.map((engine) => (
            <button
              key={engine.engineKey}
              className="card"
              onClick={() => setSelected(engine)}
              style={{ textAlign: "left", cursor: "pointer", border: engine.state === "operational" ? undefined : "1px solid var(--warning-border)" }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", minWidth: 0 }}>
                  <Icon name="dns" style={{ color: "var(--action-primary)" }} />
                  <span
                    title={engine.label}
                    style={{ fontWeight: 600, fontSize: "0.95rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {engine.label}
                  </span>
                </div>
                <StatusBadge value={engine.state} />
              </div>
              {engine.reason && (
                <div className="overlay-note" style={{ marginTop: "0.5rem" }}>
                  {engine.reason}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <EngineDetailDrawer
          engine={selected}
          request={request}
          onClose={() => setSelected(null)}
          onChanged={loadEngines}
        />
      )}
    </>
  );
}

function EngineDetailDrawer({
  engine,
  request,
  onClose,
  onChanged,
}: {
  engine: EngineCatalogEntry;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  /** Re-fetches the engine catalog from the server — called after any
   * completed change or recovery, so the list and this drawer always show
   * independently-observed server truth, never a client-guessed patch. */
  onChanged: () => void | Promise<void>;
}) {
  const [desiredState, setDesiredState] = useState<DesiredState>(engine.state === "unknown" ? "operational" : engine.state);
  const [reason, setReason] = useState("");
  const [recoveryIntent, setRecoveryIntent] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [operation, setOperation] = useState<OperationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const riskClass = desiredState === "disabled" ? "R4" : "R2";
  const needsRecoveryIntent = desiredState === "disabled";
  const noChange = desiredState === engine.state;
  const canAttempt = !noChange && reason.trim() !== "" && (!needsRecoveryIntent || recoveryIntent.trim() !== "") && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const idempotencyKey = `ui-${engine.engineKey}-${desiredState}-${Date.now()}`;
      const res = await request(`/management/v1/engine-state/${encodeURIComponent(engine.engineKey)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          desiredState,
          reason,
          recoveryIntent: needsRecoveryIntent ? recoveryIntent : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? "That change could not be completed.");
        return;
      }
      const op = body.operation as OperationView;
      setOperation(op);
      if (op.status === "completed") {
        void onChanged();
      }
    } catch {
      setError("That change could not be completed.");
    } finally {
      setBusy(false);
      setShowConfirm(false);
    }
  }

  async function recover() {
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      const idempotencyKey = `ui-recover-${operation.operationId}-${Date.now()}`;
      const res = await request(`/management/v1/operations/${operation.operationId}/recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey, reason: "Operator-initiated recovery." }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? "Recovery could not be completed.");
        return;
      }
      const op = body.operation as OperationView;
      setOperation(op);
      if (op.status === "completed") {
        void onChanged();
      }
    } catch {
      setError("Recovery could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  function handleApplyClick() {
    if (desiredState === "disabled") {
      setShowConfirm(true);
      return;
    }
    void submit();
  }

  return (
    <>
    <Drawer title={engine.label} subtitle={`Current platform state: ${engine.state}`} onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "1rem" }}>
        <StatusBadge value={engine.state} />
        {engine.reason && <span className="overlay-note" style={{ marginTop: 0 }}>{engine.reason}</span>}
      </div>

      {!operation && (
        <div className="card">
          <h3 className="text-subhead" style={{ marginBottom: "0.75rem" }}>
            Change platform state
          </h3>
          <div className="field">
            <label>Desired state</label>
            <select value={desiredState} onChange={(e) => setDesiredState(e.target.value as DesiredState)}>
              <option value="operational">Operational</option>
              <option value="degraded">Degraded</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          <p className="field-hint">
            Risk classification: <strong>{riskClass}</strong>
            {desiredState === "disabled" && " — this takes the engine offline platform-wide, for every tenant, immediately."}
          </p>
          <div className="field">
            <label>Reason</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why is this change needed?" />
          </div>
          {needsRecoveryIntent && (
            <div className="field">
              <label>Recovery plan</label>
              <textarea
                value={recoveryIntent}
                onChange={(e) => setRecoveryIntent(e.target.value)}
                rows={2}
                placeholder="How and when will this be restored?"
              />
            </div>
          )}
          <button className={`btn ${desiredState === "disabled" ? "btn-danger" : "btn-primary"}`} onClick={handleApplyClick} disabled={!canAttempt}>
            Apply change
          </button>
          {noChange && <p className="overlay-note">Select a different state to make a change.</p>}
        </div>
      )}

      {error && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <p style={{ color: "var(--danger-fg)", margin: 0 }} role="alert">
            {error}
          </p>
        </div>
      )}

      {operation && (
        <div className="card" style={{ marginTop: operation && !error ? 0 : "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <StatusBadge value={operation.status} />
              <span className="overlay-note" style={{ marginTop: 0 }}>Risk {operation.riskClass}</span>
            </div>
            {!operation.rollbackReference && (
              <button className="btn" onClick={recover} disabled={busy}>
                Recover previous state
              </button>
            )}
          </div>
          {Boolean(operation.rollbackReference) && <p className="overlay-note">Recovered.</p>}
          {operation.partialFailureState !== undefined && operation.partialFailureState !== null && (
            <pre style={{ background: "var(--danger-bg)", padding: "0.6rem", overflowX: "auto", borderRadius: "6px", fontSize: "0.8rem", marginTop: "0.6rem" }}>
              {JSON.stringify(operation.partialFailureState, null, 2)}
            </pre>
          )}
        </div>
      )}

      <div className="card" style={{ marginTop: "1rem" }}>
        <button
          className="btn"
          style={{ border: "none", background: "transparent", padding: 0, fontSize: "0.82rem", color: "var(--text-muted)" }}
          onClick={() => setShowTechnical((v) => !v)}
        >
          <Icon name={showTechnical ? "expand_less" : "expand_more"} size="sm" /> Technical details
        </button>
        {showTechnical && (
          <dl style={{ marginTop: "0.6rem", fontSize: "0.85rem" }}>
            <dt style={{ color: "var(--text-muted)" }}>Canonical engine key</dt>
            <dd style={{ margin: "0.1rem 0 0.6rem", fontFamily: "monospace" }}>{engine.engineKey}</dd>
            {engine.aliases.length > 0 && (
              <>
                <dt style={{ color: "var(--text-muted)" }}>Aliases</dt>
                <dd style={{ margin: "0.1rem 0", fontFamily: "monospace" }}>{engine.aliases.join(", ")}</dd>
              </>
            )}
          </dl>
        )}
      </div>

    </Drawer>
    {showConfirm && (
      <ConfirmDialog
        title={`Disable ${engine.label}?`}
        description="This takes the engine offline platform-wide, for every tenant, immediately. It stays disabled until this operator or another operator changes it back."
        confirmLabel="Disable engine"
        danger
        busy={busy}
        onConfirm={submit}
        onCancel={() => setShowConfirm(false)}
      />
    )}
    </>
  );
}
