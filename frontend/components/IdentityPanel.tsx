"use client";

import { useCallback, useEffect, useState } from "react";

import { StatusBadge } from "./StatusBadge";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorState } from "./States";

// Phase 1A.12.6 — Governance UI for identity administration (§14 of
// PlatformRectification/Phase1A.12_Ground_Truth_and_Scoping_2026-09-22.md).
// Deliberately lives under tenant detail (see TenantDetailDrawer in
// tenants/page.tsx), not a separate consumer-style user portal — this
// component is the per-user drill-down that page opens.
//
// Never renders a password, temporary password, reset code, invite token
// or MFA secret — none of these routes ever return one (see
// identityAdministration.js's own header on the Infrakinetic side), so
// there is nothing here to accidentally display.

interface IdentityProvider {
  exists: boolean;
  tenantBindingMismatch?: boolean;
  enabled?: boolean;
  userStatus?: string;
  confirmed?: boolean;
  resetRequired?: boolean;
  preferredMfa?: string | null;
  mfaMethods?: unknown[];
  verifiedEmail?: boolean;
  verifiedPhone?: boolean;
}

interface IdentityDetail {
  tenantId: string;
  userId: string;
  email: string;
  displayName: string;
  appAccountStatus: string;
  roleKey: string;
  provider: IdentityProvider;
  sessions: {
    activeApplicationSessionCount: number;
    lastApplicationSessionSeenAt: string | null;
    lastApplicationSessionRevokedAt: string | null;
  };
  activity: { lastActiveAt: string | null };
  invitation: { state: string; expiresAt: string | null; lastSentAt: string } | null;
  drift: string[];
}

interface IdentityAdminCommandReceipt {
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

type R2Action = "recovery" | "suspend" | "restore" | "global-signout" | "sessions/revoke";
type R3ActionKey = "force-reset" | "mfa-reset";

const R2_ACTION_LABEL: Record<R2Action, string> = {
  recovery: "Initiate password recovery",
  suspend: "Suspend",
  restore: "Restore",
  "global-signout": "Global sign-out",
  "sessions/revoke": "Revoke application sessions",
};

const R3_ACTION_LABEL: Record<R3ActionKey, string> = {
  "force-reset": "Force password reset",
  "mfa-reset": "Reset MFA",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

export function IdentityPanel({
  tenantId,
  userId,
  displayName,
  request,
  stepUp,
  operatorId,
  operatorScopes,
  onClose,
  onMutated,
}: {
  tenantId: string;
  userId: string;
  displayName: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  stepUp: (returnTo?: string) => void;
  operatorId: string;
  operatorScopes: readonly string[];
  onClose: () => void;
  onMutated: () => void;
}) {
  const [identity, setIdentity] = useState<IdentityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [history, setHistory] = useState<IdentityAdminCommandReceipt[] | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRecord[] | null>(null);

  const [pendingR2, setPendingR2] = useState<R2Action | null>(null);
  const [r2Reason, setR2Reason] = useState("");
  const [r2Busy, setR2Busy] = useState(false);
  const [r2Error, setR2Error] = useState<string | null>(null);

  const [pendingR3, setPendingR3] = useState<R3ActionKey | null>(null);
  const [r3Reason, setR3Reason] = useState("");
  const [r3Busy, setR3Busy] = useState(false);
  const [r3Error, setR3Error] = useState<string | null>(null);

  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [executeBusy, setExecuteBusy] = useState<string | null>(null);
  const [approvalActionError, setApprovalActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    return request(`/management/v1/tenants/${encodeURIComponent(tenantId)}/identities/${encodeURIComponent(userId)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setError(body.message ?? "Could not load this identity.");
          return;
        }
        setIdentity(body.identity);
      })
      .catch(() => setError("Could not load this identity."));
  }, [request, tenantId, userId]);

  const loadHistory = useCallback(() => {
    request(`/management/v1/tenants/${encodeURIComponent(tenantId)}/identities/${encodeURIComponent(userId)}/history`)
      .then(async (res) => {
        const body = await res.json();
        if (res.ok) setHistory(body.history);
      })
      .catch(() => {});
  }, [request, tenantId, userId]);

  const loadApprovals = useCallback(() => {
    request(`/management/v1/approvals?tenantId=${encodeURIComponent(tenantId)}&limit=50`)
      .then(async (res) => {
        const body = await res.json();
        if (res.ok) {
          setApprovals((body.approvals as ApprovalRecord[]).filter((a) => a.targetResourceId === userId));
        }
      })
      .catch(() => {});
  }, [request, tenantId, userId]);

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

  async function runR2Action(action: R2Action) {
    if (r2Reason.trim() === "") {
      setR2Error("A reason is required.");
      return;
    }
    setR2Busy(true);
    setR2Error(null);
    try {
      const res = await request(`/management/v1/tenants/${encodeURIComponent(tenantId)}/identities/${encodeURIComponent(userId)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: r2Reason, idempotencyKey: crypto.randomUUID() }),
      });
      const body = (await res.json()) as ApiErrorBody;
      if (!res.ok) {
        setR2Error(body.message ?? body.error ?? "The request failed.");
        return;
      }
      setPendingR2(null);
      setR2Reason("");
      refreshAll();
    } catch {
      setR2Error("The request failed.");
    } finally {
      setR2Busy(false);
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
        `/management/v1/tenants/${encodeURIComponent(tenantId)}/identities/${encodeURIComponent(userId)}/${actionKey}/request`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: r3Reason }),
        },
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

  async function executeApproval(approvalId: string) {
    setExecuteBusy(approvalId);
    setApprovalActionError(null);
    try {
      const res = await request(`/management/v1/approvals/${approvalId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
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
      refreshAll();
    } catch {
      setApprovalActionError("Execution failed.");
    } finally {
      setExecuteBusy(null);
    }
  }

  const canRecover = operatorScopes.includes("identity.recovery");
  const canDisable = operatorScopes.includes("identity.disable");
  const canForceReset = operatorScopes.includes("identity.recovery");
  const canMfaReset = operatorScopes.includes("identity.mfa_reset");
  const returnTo = `/tenants?tenant=${encodeURIComponent(tenantId)}`;

  return (
    <div className="card" style={{ marginTop: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
        <h3 className="text-subhead" style={{ margin: 0 }}>
          Identity — {displayName}
        </h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close identity panel">
          <Icon name="close" size="sm" />
        </button>
      </div>

      {error && <ErrorState label={error} />}
      {!error && !identity && <p className="overlay-note">Loading…</p>}

      {!error && identity && (
        <>
          {identity.drift.length > 0 && (
            <div className="card" style={{ marginBottom: "0.75rem", borderColor: "var(--warning-fg)" }}>
              <strong style={{ fontSize: "0.85rem" }}>Drift detected:</strong>{" "}
              {identity.drift.map((d) => (
                <span key={d} style={{ marginRight: "0.4rem" }}>
                  <StatusBadge value={d} />
                </span>
              ))}
              <p className="overlay-note" style={{ margin: "0.4rem 0 0" }}>
                Not auto-healed. Investigate before acting on this identity.
              </p>
            </div>
          )}

          <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem", fontSize: "0.88rem", marginBottom: "1rem" }}>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>App account</dt>
              <dd style={{ margin: 0 }}>
                <StatusBadge value={identity.appAccountStatus} />
              </dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Provider (Cognito)</dt>
              <dd style={{ margin: 0 }}>
                {identity.provider.tenantBindingMismatch ? (
                  <StatusBadge value="COGNITO_TENANT_BINDING_MISMATCH" />
                ) : identity.provider.exists ? (
                  <>
                    <StatusBadge value={identity.provider.enabled ? "active" : "disabled"} />{" "}
                    {identity.provider.userStatus && <StatusBadge value={identity.provider.userStatus} />}
                  </>
                ) : (
                  <StatusBadge value="COGNITO_IDENTITY_MISSING" />
                )}
              </dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Verified channels</dt>
              <dd style={{ margin: 0 }}>
                {identity.provider.verifiedEmail ? "Email ✓" : "Email ✗"} · {identity.provider.verifiedPhone ? "Phone ✓" : "Phone ✗"}
              </dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>MFA</dt>
              <dd style={{ margin: 0 }}>{identity.provider.preferredMfa ?? "Not enrolled"}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Active app sessions</dt>
              <dd style={{ margin: 0 }}>{identity.sessions.activeApplicationSessionCount}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Last active</dt>
              <dd style={{ margin: 0 }}>{formatDate(identity.activity.lastActiveAt)}</dd>
            </div>
            {identity.invitation && (
              <div>
                <dt style={{ color: "var(--text-muted)" }}>Invitation</dt>
                <dd style={{ margin: 0 }}>
                  <StatusBadge value={identity.invitation.state} /> expires {formatDate(identity.invitation.expiresAt)}
                </dd>
              </div>
            )}
          </dl>

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
            {canRecover && (
              <button className="btn" onClick={() => setPendingR2("recovery")}>
                {R2_ACTION_LABEL.recovery}
              </button>
            )}
            {canDisable && identity.appAccountStatus === "active" && (
              <button className="btn btn-danger" onClick={() => setPendingR2("suspend")}>
                {R2_ACTION_LABEL.suspend}
              </button>
            )}
            {canDisable && identity.appAccountStatus !== "active" && (
              <button className="btn btn-primary" onClick={() => setPendingR2("restore")}>
                {R2_ACTION_LABEL.restore}
              </button>
            )}
            {canDisable && (
              <button className="btn" onClick={() => setPendingR2("global-signout")}>
                {R2_ACTION_LABEL["global-signout"]}
              </button>
            )}
            {canDisable && (
              <button className="btn" onClick={() => setPendingR2("sessions/revoke")}>
                {R2_ACTION_LABEL["sessions/revoke"]}
              </button>
            )}
          </div>

          {(canForceReset || canMfaReset) && (
            <div className="card" style={{ marginBottom: "1rem" }}>
              <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>Sensitive (R3) actions</h4>
              <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>
                Requires a fresh sign-in confirmation and a separate operator&apos;s approval before execution.
              </p>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {canForceReset && (
                  <button className="btn btn-danger" onClick={() => setPendingR3("force-reset")}>
                    {R3_ACTION_LABEL["force-reset"]}
                  </button>
                )}
                {canMfaReset && (
                  <button className="btn btn-danger" onClick={() => setPendingR3("mfa-reset")}>
                    {R3_ACTION_LABEL["mfa-reset"]}
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
                              <button
                                className="btn btn-primary"
                                style={{ fontSize: "0.8rem" }}
                                disabled={decisionBusy === a.approvalId}
                                onClick={() => decideApproval(a.approvalId, "approve")}
                              >
                                Approve
                              </button>
                              <button
                                className="btn btn-danger"
                                style={{ fontSize: "0.8rem" }}
                                disabled={decisionBusy === a.approvalId}
                                onClick={() => decideApproval(a.approvalId, "reject")}
                              >
                                Reject
                              </button>
                            </div>
                          )}
                          {a.status === "pending" && isMaker && (
                            <p className="overlay-note" style={{ margin: 0 }}>
                              Waiting on a different operator to decide — you cannot approve your own request.
                            </p>
                          )}
                          {a.status === "approved" && (canForceReset || canMfaReset) && (
                            <button
                              className="btn btn-primary"
                              style={{ fontSize: "0.8rem" }}
                              disabled={executeBusy === a.approvalId}
                              onClick={() => executeApproval(a.approvalId)}
                            >
                              {executeBusy === a.approvalId ? "Executing…" : "Execute"}
                            </button>
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
              <h4 style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>Recent identity commands</h4>
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

      {pendingR2 && (
        <ConfirmDialog
          title={`${R2_ACTION_LABEL[pendingR2]} for ${displayName}?`}
          danger={pendingR2 === "suspend"}
          busy={r2Busy}
          onCancel={() => {
            setPendingR2(null);
            setR2Reason("");
            setR2Error(null);
          }}
          onConfirm={() => runR2Action(pendingR2)}
        >
          <div className="field">
            <label>Reason</label>
            <textarea value={r2Reason} onChange={(e) => setR2Reason(e.target.value)} rows={2} placeholder="Required" />
          </div>
          {r2Error && <ErrorState label={r2Error} />}
        </ConfirmDialog>
      )}

      {pendingR3 && (
        <ConfirmDialog
          title={`Request: ${R3_ACTION_LABEL[pendingR3]} for ${displayName}?`}
          description="This submits an approval request. A different operator must approve it before it can be executed."
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
