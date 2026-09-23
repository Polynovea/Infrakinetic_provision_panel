"use client";

import { useCallback, useEffect, useState } from "react";

import { StatusBadge } from "./StatusBadge";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorState } from "./States";

// Phase 1A.13 — Governance UI for credential administration (Payments
// domain only, §7.4 of PlatformRectification/Phase1A.13_Ground_Truth_and_
// Scoping_2026-09-23.md). Deliberately lives under tenant detail (see
// TenantDetailDrawer in tenants/page.tsx), mirroring IdentityPanel.tsx's own
// placement and three-tier action model (read / R2 replace / R3 rotate-
// revoke) exactly.
//
// Never renders a secret value, ciphertext, or key material — the only
// place a secret value ever appears is as something THIS OPERATOR TYPES IN
// (replace's new value, or rotate's new value at execute time), which is
// sent straight to the API and never echoed back, logged, or kept in state
// after submission. `type="password"` on every secret-value input is
// deliberate, matching §27 of the master plan ("plaintext secret must never
// be retrievable through browser or API" — this UI holds up its half of
// that by never displaying one either).

interface CredentialSecretSummary {
  kind: string;
  version: number;
  status: string;
  maskedHint: string | null;
  validFrom: string;
  validUntil: string | null;
}

interface CredentialDetail {
  tenantId: string;
  credentialId: string;
  owningEngine: string;
  provider: string;
  adapterVersion: string;
  environment: string;
  displayName: string;
  status: string;
  activatedAt: string | null;
  revokedAt: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  secrets: CredentialSecretSummary[];
}

interface CredentialAdminCommandReceipt {
  idempotencyKey: string;
  action: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

interface ApprovalRecord {
  approvalId: string;
  requestedAction: string;
  targetResourceId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  reason: string;
  makerOperatorId: string;
  checkerOperatorId?: string;
  requestedAt: string;
  expiresAt: string;
}

const SECRET_KINDS = ["api_key_id", "api_key_secret", "webhook_secret"] as const;
type SecretKind = (typeof SECRET_KINDS)[number];
type R3ActionKey = "rotate" | "revoke";

const R3_ACTION_LABEL: Record<R3ActionKey, string> = {
  rotate: "Rotate webhook secret",
  revoke: "Revoke credential",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

export function CredentialPanel({
  tenantId,
  credentialId,
  displayName,
  request,
  stepUp,
  operatorId,
  operatorScopes,
  onClose,
  onMutated,
}: {
  tenantId: string;
  credentialId: string;
  displayName: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  stepUp: (returnTo?: string) => void;
  operatorId: string;
  operatorScopes: readonly string[];
  onClose: () => void;
  onMutated: () => void;
}) {
  const [credential, setCredential] = useState<CredentialDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [history, setHistory] = useState<CredentialAdminCommandReceipt[] | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRecord[] | null>(null);

  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const [showReplace, setShowReplace] = useState(false);
  const [replaceKind, setReplaceKind] = useState<SecretKind>("api_key_secret");
  const [replaceValue, setReplaceValue] = useState("");
  const [replaceReason, setReplaceReason] = useState("");
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);

  const [pendingR3, setPendingR3] = useState<R3ActionKey | null>(null);
  const [r3Reason, setR3Reason] = useState("");
  const [r3Busy, setR3Busy] = useState(false);
  const [r3Error, setR3Error] = useState<string | null>(null);

  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [executeBusy, setExecuteBusy] = useState<string | null>(null);
  const [approvalActionError, setApprovalActionError] = useState<string | null>(null);
  const [rotateExecuteValue, setRotateExecuteValue] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setError(null);
    return request(`/management/v1/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setError(body.message ?? "Could not load this credential.");
          return;
        }
        setCredential(body.credential);
      })
      .catch(() => setError("Could not load this credential."));
  }, [request, tenantId, credentialId]);

  const loadHistory = useCallback(() => {
    request(`/management/v1/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/history`)
      .then(async (res) => {
        const body = await res.json();
        if (res.ok) setHistory(body.history);
      })
      .catch(() => {});
  }, [request, tenantId, credentialId]);

  const loadApprovals = useCallback(() => {
    request(`/management/v1/approvals?tenantId=${encodeURIComponent(tenantId)}&limit=50`)
      .then(async (res) => {
        const body = await res.json();
        if (res.ok) {
          setApprovals((body.approvals as ApprovalRecord[]).filter((a) => a.targetResourceId === credentialId));
        }
      })
      .catch(() => {});
  }, [request, tenantId, credentialId]);

  useEffect(() => {
    load();
    loadHistory();
    loadApprovals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  function refreshAll() {
    setRefreshKey((k) => k + 1);
    onMutated();
  }

  async function runTest() {
    setTestBusy(true);
    setTestError(null);
    setTestResult(null);
    try {
      const res = await request(`/management/v1/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/test`, {
        method: "POST",
      });
      const body = (await res.json()) as ApiErrorBody & { validationStatus?: string };
      if (!res.ok) {
        setTestError(body.message ?? body.error ?? "The test failed.");
        return;
      }
      setTestResult(body.validationStatus ?? null);
      refreshAll();
    } catch {
      setTestError("The test failed.");
    } finally {
      setTestBusy(false);
    }
  }

  async function submitReplace() {
    if (replaceValue.trim() === "" || replaceReason.trim() === "") {
      setReplaceError("A new value and a reason are required.");
      return;
    }
    setReplaceBusy(true);
    setReplaceError(null);
    try {
      const res = await request(`/management/v1/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/replace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secretKind: replaceKind, secretValue: replaceValue, reason: replaceReason, idempotencyKey: crypto.randomUUID() }),
      });
      const body = (await res.json()) as ApiErrorBody;
      if (!res.ok) {
        setReplaceError(body.message ?? body.error ?? "The request failed.");
        return;
      }
      setShowReplace(false);
      setReplaceValue("");
      setReplaceReason("");
      refreshAll();
    } catch {
      setReplaceError("The request failed.");
    } finally {
      setReplaceBusy(false);
    }
  }

  async function submitR3Request(actionKey: R3ActionKey) {
    if (r3Reason.trim() === "") {
      setR3Error("A reason is required.");
      return;
    }
    setR3Busy(true);
    setR3Error(null);
    try {
      const res = await request(
        `/management/v1/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/${actionKey}/request`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: r3Reason }) },
      );
      const body = (await res.json()) as ApiErrorBody;
      if (!res.ok) {
        if (body.error === "STEP_UP_REQUIRED") {
          setR3Error("STEP_UP_REQUIRED");
          return;
        }
        setR3Error(body.message ?? body.error ?? "The request failed.");
        return;
      }
      setPendingR3(null);
      setR3Reason("");
      loadApprovals();
    } catch {
      setR3Error("The request failed.");
    } finally {
      setR3Busy(false);
    }
  }

  async function decideApproval(approvalId: string, decision: "approve" | "reject") {
    setDecisionBusy(approvalId);
    setApprovalActionError(null);
    try {
      const res = await request(`/management/v1/approvals/${approvalId}/${decision}`, { method: "POST" });
      const body = (await res.json()) as ApiErrorBody;
      if (!res.ok) {
        setApprovalActionError(body.message ?? body.error ?? "The decision failed.");
        return;
      }
      loadApprovals();
    } catch {
      setApprovalActionError("The decision failed.");
    } finally {
      setDecisionBusy(null);
    }
  }

  // Rotate needs the actual new secret value at execute time (never at
  // request time — see credentialApprovalOperation.ts's header). Revoke
  // needs nothing extra.
  async function executeApproval(approval: ApprovalRecord) {
    const isRotate = approval.requestedAction === "credential.rotate";
    const secretValue = rotateExecuteValue[approval.approvalId] ?? "";
    if (isRotate && secretValue.trim() === "") {
      setApprovalActionError("Enter the new webhook secret value before executing this rotation.");
      return;
    }
    setExecuteBusy(approval.approvalId);
    setApprovalActionError(null);
    try {
      const res = await request(`/management/v1/approvals/${approval.approvalId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), ...(isRotate ? { secretValue } : {}) }),
      });
      const body = (await res.json()) as ApiErrorBody;
      if (!res.ok) {
        if (body.error === "STEP_UP_REQUIRED") {
          setApprovalActionError("STEP_UP_REQUIRED");
          return;
        }
        setApprovalActionError(body.message ?? body.error ?? "Execution failed.");
        return;
      }
      setRotateExecuteValue((prev) => {
        const next = { ...prev };
        delete next[approval.approvalId];
        return next;
      });
      refreshAll();
    } catch {
      setApprovalActionError("Execution failed.");
    } finally {
      setExecuteBusy(null);
    }
  }

  const canSubmit = operatorScopes.includes("credentials.submit");
  const canRotate = operatorScopes.includes("credentials.rotate");
  const canRevoke = operatorScopes.includes("credentials.revoke");
  const returnTo = `/tenants?tenant=${encodeURIComponent(tenantId)}`;

  return (
    <div className="card" style={{ marginTop: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
        <h3 className="text-subhead" style={{ margin: 0 }}>
          Credential — {displayName}
        </h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close credential panel">
          <Icon name="close" size="sm" />
        </button>
      </div>

      {error && <ErrorState label={error} />}
      {!error && !credential && <p className="overlay-note">Loading…</p>}

      {!error && credential && (
        <>
          <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem", fontSize: "0.88rem", marginBottom: "1rem" }}>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Provider</dt>
              <dd style={{ margin: 0 }}>
                {credential.provider} · {credential.environment}
              </dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Status</dt>
              <dd style={{ margin: 0 }}>
                <StatusBadge value={credential.status} />
              </dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Last tested</dt>
              <dd style={{ margin: 0 }}>{formatDate(credential.lastTestedAt)}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Last error</dt>
              <dd style={{ margin: 0 }}>{credential.lastError ?? "—"}</dd>
            </div>
          </dl>

          <div style={{ marginBottom: "1rem" }}>
            <strong style={{ fontSize: "0.85rem" }}>Secrets</strong>
            <table className="data-table" style={{ marginTop: "0.4rem" }}>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Hint</th>
                  <th>Valid until</th>
                </tr>
              </thead>
              <tbody>
                {credential.secrets.map((s) => (
                  <tr key={`${s.kind}-${s.version}`}>
                    <td>{s.kind}</td>
                    <td>{s.version}</td>
                    <td>
                      <StatusBadge value={s.status} />
                    </td>
                    <td>{s.maskedHint ?? "—"}</td>
                    <td>{formatDate(s.validUntil)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
            <button className="btn" disabled={testBusy} onClick={runTest}>
              {testBusy ? "Testing…" : "Test connection"}
            </button>
            {canSubmit && (
              <button className="btn" onClick={() => setShowReplace(true)}>
                Replace a secret
              </button>
            )}
          </div>
          {testResult && <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>Validation result: <StatusBadge value={testResult} /></p>}
          {testError && <ErrorState label={testError} />}

          {(canRotate || canRevoke) && (
            <div className="card" style={{ marginBottom: "1rem" }}>
              <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>Sensitive (R3) actions</h4>
              <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>
                Requires a fresh sign-in confirmation and a separate operator&apos;s approval before execution.
              </p>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {canRotate && (
                  <button className="btn btn-danger" onClick={() => setPendingR3("rotate")}>
                    {R3_ACTION_LABEL.rotate}
                  </button>
                )}
                {canRevoke && (
                  <button className="btn btn-danger" onClick={() => setPendingR3("revoke")}>
                    {R3_ACTION_LABEL.revoke}
                  </button>
                )}
              </div>

              {approvals && approvals.length > 0 && (
                <div style={{ marginTop: "0.75rem" }}>
                  <strong style={{ fontSize: "0.82rem" }}>Approval requests</strong>
                  {approvalActionError === "STEP_UP_REQUIRED" ? (
                    <div className="card" style={{ marginTop: "0.4rem" }}>
                      <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem" }}>This action requires a fresh sign-in confirmation.</p>
                      <button className="btn btn-primary" onClick={() => stepUp(returnTo)}>
                        Step up now
                      </button>
                    </div>
                  ) : (
                    approvalActionError && <ErrorState label={approvalActionError} />
                  )}
                  <ul style={{ listStyle: "none", margin: "0.4rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    {approvals.map((a) => {
                      const isMaker = a.makerOperatorId === operatorId;
                      const isRotate = a.requestedAction === "credential.rotate";
                      return (
                        <li key={a.approvalId} className="card" style={{ padding: "0.6rem 0.75rem" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                            <span style={{ fontSize: "0.85rem" }}>{a.requestedAction}</span>
                            <StatusBadge value={a.status} />
                          </div>
                          <p className="overlay-note" style={{ margin: "0.3rem 0" }}>
                            {a.reason} — requested {formatDate(a.requestedAt)}
                          </p>
                          {a.status === "pending" && !isMaker && (
                            <div style={{ display: "flex", gap: "0.4rem" }}>
                              <button className="btn btn-primary" style={{ fontSize: "0.8rem" }} disabled={decisionBusy === a.approvalId} onClick={() => decideApproval(a.approvalId, "approve")}>
                                Approve
                              </button>
                              <button className="btn btn-danger" style={{ fontSize: "0.8rem" }} disabled={decisionBusy === a.approvalId} onClick={() => decideApproval(a.approvalId, "reject")}>
                                Reject
                              </button>
                            </div>
                          )}
                          {a.status === "pending" && isMaker && (
                            <p className="overlay-note" style={{ margin: 0 }}>
                              Waiting on a different operator to decide — you cannot approve your own request.
                            </p>
                          )}
                          {a.status === "approved" && ((isRotate && canRotate) || (!isRotate && canRevoke)) && (
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                              {isRotate && (
                                <input
                                  type="password"
                                  placeholder="New webhook secret value"
                                  value={rotateExecuteValue[a.approvalId] ?? ""}
                                  onChange={(e) => setRotateExecuteValue((prev) => ({ ...prev, [a.approvalId]: e.target.value }))}
                                />
                              )}
                              <button className="btn btn-primary" style={{ fontSize: "0.8rem", alignSelf: "flex-start" }} disabled={executeBusy === a.approvalId} onClick={() => executeApproval(a)}>
                                {executeBusy === a.approvalId ? "Executing…" : "Execute"}
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}

          {history && history.length > 0 && (
            <div>
              <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>Recent credential commands</h4>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: "0.82rem" }}>
                {history.slice(0, 10).map((h) => (
                  <li key={h.idempotencyKey} style={{ display: "flex", justifyContent: "space-between", padding: "0.3rem 0", borderBottom: "1px solid var(--border-color)" }}>
                    <span>{h.action}</span>
                    <span style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                      <StatusBadge value={h.status} />
                      {formatDate(h.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {showReplace && (
        <ConfirmDialog
          title={`Replace a secret for ${displayName}?`}
          busy={replaceBusy}
          confirmLabel="Replace"
          onCancel={() => {
            setShowReplace(false);
            setReplaceValue("");
            setReplaceReason("");
            setReplaceError(null);
          }}
          onConfirm={submitReplace}
        >
          <div className="field">
            <label>Secret kind</label>
            <select value={replaceKind} onChange={(e) => setReplaceKind(e.target.value as SecretKind)}>
              {SECRET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>New value</label>
            <input type="password" value={replaceValue} onChange={(e) => setReplaceValue(e.target.value)} placeholder="Required" autoComplete="off" />
          </div>
          <div className="field">
            <label>Reason</label>
            <textarea value={replaceReason} onChange={(e) => setReplaceReason(e.target.value)} rows={2} placeholder="Required" />
          </div>
          {replaceError && <ErrorState label={replaceError} />}
        </ConfirmDialog>
      )}

      {pendingR3 && (
        <ConfirmDialog
          title={`Request: ${R3_ACTION_LABEL[pendingR3]} for ${displayName}?`}
          description={
            pendingR3 === "rotate"
              ? "This submits an approval request. A different operator must approve it before you (or anyone with the rotate scope) can execute it and supply the new secret value."
              : "This submits an approval request. A different operator must approve it before it can be executed. Revoking disables every secret on this credential — there is no automatic replacement."
          }
          danger
          busy={r3Busy}
          confirmLabel="Submit request"
          onCancel={() => {
            setPendingR3(null);
            setR3Reason("");
            setR3Error(null);
          }}
          onConfirm={() => submitR3Request(pendingR3)}
        >
          <div className="field">
            <label>Reason</label>
            <textarea value={r3Reason} onChange={(e) => setR3Reason(e.target.value)} rows={2} placeholder="Required" />
          </div>
          {r3Error === "STEP_UP_REQUIRED" ? (
            <div style={{ marginTop: "0.5rem" }}>
              <p style={{ fontSize: "0.85rem", margin: "0 0 0.5rem" }}>This requires a fresh sign-in confirmation first.</p>
              <button className="btn btn-primary" onClick={() => stepUp(returnTo)} type="button">
                Step up now
              </button>
            </div>
          ) : (
            r3Error && <ErrorState label={r3Error} />
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
