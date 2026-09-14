"use client";

import { useState } from "react";

import { GOVERNANCE_API_BASE_URL, useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";

type DesiredState = "operational" | "degraded" | "disabled";

interface OperationView {
  operationId: string;
  status: string;
  riskClass: string;
  targetEngine: string;
  reason?: string;
  beforeStateSafeSnapshot?: unknown;
  afterStateSafeSnapshot?: unknown;
  result?: unknown;
  partialFailureState?: unknown;
  rollbackReference?: unknown;
}

export default function PlatformPage() {
  const { token } = useOperatorSession();
  const [engineKey, setEngineKey] = useState("");
  const [desiredState, setDesiredState] = useState<DesiredState>("degraded");
  const [reason, setReason] = useState("");
  const [recoveryIntent, setRecoveryIntent] = useState("");
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [operation, setOperation] = useState<OperationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsRecoveryIntent = desiredState === "disabled";
  const canSubmit =
    engineKey.trim() !== "" &&
    reason.trim() !== "" &&
    (!needsRecoveryIntent || recoveryIntent.trim() !== "") &&
    (desiredState !== "disabled" || confirmDisable) &&
    !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const idempotencyKey = `ui-${engineKey}-${desiredState}-${Date.now()}`;
      const res = await fetch(`${GOVERNANCE_API_BASE_URL}/management/v1/engine-state/${encodeURIComponent(engineKey)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
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
      setOperation(body.operation as OperationView);
    } catch {
      setError("That change could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function recover() {
    if (!operation) return;
    setBusy(true);
    setError(null);
    try {
      const idempotencyKey = `ui-recover-${operation.operationId}-${Date.now()}`;
      const res = await fetch(`${GOVERNANCE_API_BASE_URL}/management/v1/operations/${operation.operationId}/recover`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey, reason: "Operator-initiated recovery." }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? "Recovery could not be completed.");
        return;
      }
      setOperation(body.operation as OperationView);
    } catch {
      setError("Recovery could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Platform</h1>
        <p>Change an engine&apos;s platform-wide operational state.</p>
      </div>

      <div className="card">
        <div className="field">
          <label>Engine</label>
          <input value={engineKey} onChange={(e) => setEngineKey(e.target.value)} placeholder="Engine key" />
        </div>
        <div className="field">
          <label>Desired state</label>
          <select value={desiredState} onChange={(e) => setDesiredState(e.target.value as DesiredState)}>
            <option value="operational">Operational</option>
            <option value="degraded">Degraded</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
        <p className="field-hint">
          Risk classification: <strong>{desiredState === "disabled" ? "R4" : "R2"}</strong>
        </p>
        <div className="field">
          <label>Reason</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </div>
        {needsRecoveryIntent && (
          <div className="field">
            <label>Recovery plan</label>
            <textarea value={recoveryIntent} onChange={(e) => setRecoveryIntent(e.target.value)} rows={2} />
          </div>
        )}
        {desiredState === "disabled" && (
          <div className="field">
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
              <input type="checkbox" checked={confirmDisable} onChange={(e) => setConfirmDisable(e.target.checked)} />
              This disables the engine platform-wide for every tenant, immediately.
            </label>
          </div>
        )}
        <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
          {busy ? "Submitting…" : "Submit change"}
        </button>
      </div>

      {error && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <p style={{ color: "var(--color-danger)", margin: 0 }} role="alert">
            {error}
          </p>
        </div>
      )}

      {operation && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <strong>{operation.targetEngine}</strong>
              <StatusBadge value={operation.status} />
            </div>
            {!operation.rollbackReference && (
              <button className="btn" onClick={recover} disabled={busy}>
                Recover previous state
              </button>
            )}
          </div>
          {Boolean(operation.rollbackReference) && <p className="overlay-note">Recovered.</p>}
          {operation.partialFailureState !== undefined && operation.partialFailureState !== null && (
            <pre style={{ background: "var(--color-danger-bg)", padding: "0.6rem", overflowX: "auto", borderRadius: "6px", fontSize: "0.8rem" }}>
              {JSON.stringify(operation.partialFailureState, null, 2)}
            </pre>
          )}
        </div>
      )}
    </>
  );
}
