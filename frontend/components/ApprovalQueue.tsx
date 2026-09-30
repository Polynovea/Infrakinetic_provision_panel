"use client";

import { useCallback, useEffect, useState } from "react";

import { StatusBadge } from "./StatusBadge";

// Phase 1A.14 — the shared maker-checker queue for payment adapter (R3/R4)
// and global configuration restore (R4) approvals. Both bind their whole
// safe diff at request time, so execution takes nothing from the executor
// but an idempotency key; the checker's decision is made against the
// summary rendered here (master plan §58 "checker reviews safe diff").

export interface ApprovalRecord {
  approvalId: string;
  requestedAction: string;
  targetResourceType: string;
  targetResourceId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  riskClass: string;
  reason: string;
  makerOperatorId: string;
  checkerOperatorId?: string;
  requestedAt: string;
  decidedAt?: string;
  executedAt?: string;
  expiresAt: string;
  safeRequestSummary?: Record<string, unknown>;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ApprovalQueue({
  request,
  stepUp,
  operatorId,
  returnTo,
  include,
  refreshKey,
  onExecuted,
  renderSummary,
  canExecute,
}: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  stepUp: (returnTo?: string) => void;
  operatorId: string;
  returnTo: string;
  include: (approval: ApprovalRecord) => boolean;
  refreshKey?: number;
  onExecuted?: (body: Record<string, unknown>) => void;
  renderSummary?: (approval: ApprovalRecord) => React.ReactNode;
  /** Narrows who is offered Execute (AI approvals: only the maker or the checker — the owner refuses anyone else). */
  canExecute?: (approval: ApprovalRecord) => boolean;
}) {
  const [approvals, setApprovals] = useState<ApprovalRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ approvalId: string; status: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await request("/management/v1/approvals?limit=100");
      if (!res.ok) {
        setError(res.status === 403 ? "You do not have access to the approval queue." : "Could not load approvals.");
        return;
      }
      const body = await res.json();
      setApprovals((body.approvals as ApprovalRecord[]).filter(include).filter((a) => a.status === "pending" || (a.status === "approved" && !a.executedAt)));
    } catch {
      setError("Could not load approvals.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function act(approval: ApprovalRecord, action: "approve" | "reject" | "execute") {
    setBusy(approval.approvalId);
    setError(null);
    try {
      const res = await request(`/management/v1/approvals/${approval.approvalId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: action === "execute" ? JSON.stringify({ idempotencyKey: `ui-exec-${approval.approvalId}` }) : undefined,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error === "STEP_UP_REQUIRED" ? "STEP_UP_REQUIRED" : body.message ?? body.error ?? "That action failed.");
        return;
      }
      if (action === "execute") {
        setLastResult({ approvalId: approval.approvalId, status: body.operation?.status ?? "unknown" });
        onExecuted?.(body);
      }
      await load();
    } catch {
      setError("That action failed.");
    } finally {
      setBusy(null);
    }
  }

  if (approvals === null && !error) return null;

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h3 className="text-subhead" style={{ marginBottom: "0.5rem" }}>Approvals</h3>
      {error === "STEP_UP_REQUIRED" ? (
        <div>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem" }}>This decision requires a fresh sign-in confirmation.</p>
          <button className="btn btn-primary" onClick={() => stepUp(returnTo)}>Step up now</button>
        </div>
      ) : (
        error && <p style={{ color: "var(--danger-fg)", margin: 0 }} role="alert">{error}</p>
      )}
      {lastResult && (
        <p className="overlay-note">
          Execution result: <StatusBadge value={lastResult.status} />
        </p>
      )}
      {approvals && approvals.length === 0 && <p className="overlay-note">Nothing waiting.</p>}
      {approvals?.map((a) => {
        const ownRequest = a.makerOperatorId === operatorId;
        return (
          <div key={a.approvalId} style={{ borderTop: "1px solid var(--border-subtle)", padding: "0.6rem 0" }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <StatusBadge value={a.status} />
              <strong style={{ fontSize: "0.85rem" }}>{a.requestedAction}</strong>
              <span className="overlay-note" style={{ marginTop: 0 }}>Risk {a.riskClass} · requested {formatDate(a.requestedAt)} · expires {formatDate(a.expiresAt)}</span>
            </div>
            <p style={{ fontSize: "0.85rem", margin: "0.35rem 0" }}>{a.reason}</p>
            {renderSummary ? renderSummary(a) : a.safeRequestSummary && (
              <pre style={{ background: "var(--bg-field)", padding: "0.5rem", borderRadius: "6px", fontSize: "0.75rem", overflowX: "auto" }}>
                {JSON.stringify(a.safeRequestSummary, null, 2)}
              </pre>
            )}
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem" }}>
              {a.status === "pending" && !ownRequest && (
                <>
                  <button className="btn btn-primary" style={{ fontSize: "0.8rem" }} disabled={busy === a.approvalId} onClick={() => act(a, "approve")}>Approve</button>
                  <button className="btn btn-danger" style={{ fontSize: "0.8rem" }} disabled={busy === a.approvalId} onClick={() => act(a, "reject")}>Reject</button>
                </>
              )}
              {a.status === "pending" && ownRequest && (
                <span className="overlay-note" style={{ marginTop: 0 }}>Waiting on a different operator — you cannot approve your own request.</span>
              )}
              {a.status === "approved" && (canExecute ? canExecute(a) : true) && (
                <button className="btn btn-primary" style={{ fontSize: "0.8rem" }} disabled={busy === a.approvalId} onClick={() => act(a, "execute")}>
                  {busy === a.approvalId ? "Executing…" : "Execute"}
                </button>
              )}
              {a.status === "approved" && canExecute && !canExecute(a) && (
                <span className="overlay-note" style={{ marginTop: 0 }}>Approved — only the operator who requested it or the one who approved it can execute it.</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
