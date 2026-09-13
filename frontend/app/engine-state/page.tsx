"use client";

// 1A.6 — the minimum safe operator surface for the engine-state vertical
// (PlatformRectification/Phase1A_Scoping_and_Implementation_Plan's own
// "governance UI panel" deliverable for this phase). Deliberately minimal,
// matching every prior 1A.x frontend milestone (1A.1's page.tsx: "no auth,
// no real functionality") — real browser-based operator login (Cognito
// Hosted UI / a session cookie) has not been built yet because
// GOVERNANCE_COGNITO_* has never been provisioned in any real environment
// (see docs/1A.2_status.md, docs/1A.6_status.md). Until that exists, an
// operator authenticates to THIS page by pasting an ID token they already
// obtained some other way — never a secret Governance itself holds, and
// never persisted anywhere by this page (kept in component state only,
// cleared on reload). This page calls ONLY the Governance backend
// (NEXT_PUBLIC_GOVERNANCE_API_BASE_URL) — it has no knowledge of
// Infrakinetic's origin, its signing key, or any assertion; Governance
// mints and sends those server-side. A direct browser call to
// Infrakinetic's /management/v1/* is structurally impossible from this
// page because it never has the material needed to construct one.

import { useState } from "react";

const GOVERNANCE_API_BASE_URL = process.env.NEXT_PUBLIC_GOVERNANCE_API_BASE_URL ?? "http://127.0.0.1:4100";

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

function riskClassFor(desired: DesiredState): "R2" | "R4" {
  return desired === "disabled" ? "R4" : "R2";
}

export default function EngineStatePanel() {
  const [token, setToken] = useState("");
  const [engineKey, setEngineKey] = useState("");
  const [desiredState, setDesiredState] = useState<DesiredState>("degraded");
  const [reason, setReason] = useState("");
  const [recoveryIntent, setRecoveryIntent] = useState("");
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [operation, setOperation] = useState<OperationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const risk = riskClassFor(desiredState);
  const needsRecoveryIntent = desiredState === "disabled";
  const canSubmit =
    token.trim() !== "" &&
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
        setError(`${body.error ?? res.status}: ${body.message ?? "request failed"}`);
        return;
      }
      setOperation(body.operation as OperationView);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        body: JSON.stringify({ idempotencyKey, reason: "operator-initiated recovery from Governance UI" }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(`${body.error ?? res.status}: ${body.message ?? "recovery failed"}`);
        return;
      }
      setOperation(body.operation as OperationView);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem 2rem", maxWidth: 720 }}>
      <h1>Platform Engine State</h1>
      <p style={{ color: "#666" }}>
        1A.6 — real-time, real-effect control of an engine&apos;s platform-wide operational state. Every change is
        idempotent, attributed, and independently verified against Infrakinetic before this panel calls it complete.
      </p>

      <fieldset style={{ marginTop: "1.5rem", border: "1px solid #ddd", padding: "1rem" }}>
        <legend>Operator token (temporary — real login pending Cognito provisioning)</legend>
        <input
          type="password"
          placeholder="Paste your Governance operator ID token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ width: "100%" }}
        />
      </fieldset>

      <fieldset style={{ marginTop: "1rem", border: "1px solid #ddd", padding: "1rem" }}>
        <legend>Engine state change</legend>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          Canonical engine or alias
          <input value={engineKey} onChange={(e) => setEngineKey(e.target.value)} placeholder="e.g. module_ai" style={{ width: "100%" }} />
        </label>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          Desired state
          <select value={desiredState} onChange={(e) => setDesiredState(e.target.value as DesiredState)} style={{ width: "100%" }}>
            <option value="operational">operational</option>
            <option value="degraded">degraded</option>
            <option value="disabled">disabled</option>
          </select>
        </label>
        <p>
          Risk classification: <strong>{risk}</strong> {risk === "R4" ? "— platform/global emergency" : "— tenant operational"}
        </p>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          Reason (required)
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "100%" }} />
        </label>
        {needsRecoveryIntent && (
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            Recovery intent (required when disabling)
            <textarea value={recoveryIntent} onChange={(e) => setRecoveryIntent(e.target.value)} style={{ width: "100%" }} />
          </label>
        )}
        {desiredState === "disabled" && (
          <label style={{ display: "block", marginBottom: "0.5rem", color: "#a00" }}>
            <input type="checkbox" checked={confirmDisable} onChange={(e) => setConfirmDisable(e.target.checked)} /> I understand
            this disables the engine platform-wide for every tenant, immediately.
          </label>
        )}
        <button onClick={submit} disabled={!canSubmit}>
          {busy ? "Submitting…" : "Submit change"}
        </button>
      </fieldset>

      {error && (
        <p style={{ color: "#a00", marginTop: "1rem" }} role="alert">
          {error}
        </p>
      )}

      {operation && (
        <fieldset style={{ marginTop: "1rem", border: "1px solid #ddd", padding: "1rem" }}>
          <legend>Operation {operation.operationId}</legend>
          <p>
            Status: <strong>{operation.status}</strong> · Risk: {operation.riskClass} · Engine: {operation.targetEngine}
          </p>
          {operation.partialFailureState !== undefined && operation.partialFailureState !== null && (
            <pre style={{ background: "#fff3f3", padding: "0.5rem", overflowX: "auto" }}>
              {JSON.stringify(operation.partialFailureState, null, 2)}
            </pre>
          )}
          {operation.result !== undefined && operation.result !== null && (
            <pre style={{ background: "#f6f6f6", padding: "0.5rem", overflowX: "auto" }}>{JSON.stringify(operation.result, null, 2)}</pre>
          )}
          <p>
            Recovery status: {operation.rollbackReference ? "recovered — rollback reference attached" : "not recovered"}
          </p>
          {!operation.rollbackReference && (
            <button onClick={recover} disabled={busy}>
              Recover to prior state
            </button>
          )}
        </fieldset>
      )}
    </main>
  );
}
