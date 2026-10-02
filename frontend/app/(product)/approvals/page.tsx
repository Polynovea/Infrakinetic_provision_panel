"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { EmptyState, ErrorState } from "../../../components/States";
import { Icon } from "../../../components/Icon";
import type { ApprovalRecord } from "../../../components/ApprovalQueue";

interface ApprovalWithTenant extends ApprovalRecord {
  targetTenantId?: string;
}
interface TenantSummary { id: string; name: string; slug: string }

const ACTION_LABELS: Record<string, string> = {
  "ai.tenant.emergency.resume": "Restore tenant AI after an emergency stop",
  "ai.model.lifecycle.set": "Change AI model lifecycle",
  "ai.model.certification.set": "Change AI model certification",
  "ai.managed-credential.pool-source.set": "Change an AI runtime credential source",
  "payment.adapter.approve": "Approve a payment extension release",
  "payment.adapter.retire": "Retire a payment extension release",
  "payment.adapter.revoke": "Revoke a payment extension release",
  "global-config.restore.apply": "Apply a configuration restore",
  "credential.rotate": "Rotate a tenant credential",
  "credential.revoke": "Revoke a tenant credential",
  "identity.force_reset": "Force an identity reset",
  "identity.mfa_reset": "Reset identity MFA",
};

function titleFor(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function owningHref(approval: ApprovalWithTenant): string {
  if (approval.requestedAction.startsWith("ai.")) return "/ai";
  if (approval.requestedAction.startsWith("payment.adapter.")) return "/payment-adapters";
  if (approval.requestedAction.startsWith("global-config.")) return "/global-config";
  if ((approval.requestedAction.startsWith("identity.") || approval.requestedAction.startsWith("credential.")) && approval.targetTenantId) {
    return `/tenants?tenant=${encodeURIComponent(approval.targetTenantId)}`;
  }
  return "/";
}

function owningLabel(approval: ApprovalWithTenant): string {
  if (approval.requestedAction.startsWith("ai.")) return "Open AI operations";
  if (approval.requestedAction.startsWith("payment.adapter.")) return "Open Payment extensions";
  if (approval.requestedAction.startsWith("global-config.")) return "Open Configuration restore";
  if (approval.requestedAction.startsWith("identity.") || approval.requestedAction.startsWith("credential.")) return "Open tenant";
  return "Open related control";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Summary({ value }: { value?: Record<string, unknown> }) {
  if (!value || Object.keys(value).length === 0) return null;
  const rows = Object.entries(value).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 8);
  if (rows.length === 0) return null;
  return (
    <details style={{ marginTop: "0.45rem" }}>
      <summary style={{ cursor: "pointer", fontSize: "0.82rem", color: "var(--text-muted)" }}>Review bound change details</summary>
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(8rem, 0.7fr) 1.3fr", gap: "0.35rem 0.75rem", margin: "0.55rem 0 0", fontSize: "0.82rem" }}>
        {rows.map(([key, val]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt style={{ color: "var(--text-muted)" }}>{titleFor(key)}</dt>
            <dd style={{ margin: 0 }}>{String(val)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export default function ApprovalsPage() {
  const { request, operator, stepUp } = useOperatorSession();
  const [approvals, setApprovals] = useState<ApprovalWithTenant[] | null>(null);
  const [tenants, setTenants] = useState<Record<string, TenantSummary>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canRead = operator?.scopes.includes("identity.read") ?? false;

  const load = useCallback(async () => {
    if (!canRead) return;
    setError(null);
    try {
      const [approvalRes, tenantRes] = await Promise.all([
        request("/management/v1/approvals?limit=100"),
        request("/management/v1/tenants"),
      ]);
      if (!approvalRes.ok) {
        setError(approvalRes.status === 403 ? "You do not have access to the approval inbox." : "Could not load approvals.");
        return;
      }
      const body = await approvalRes.json() as { approvals: ApprovalWithTenant[] };
      setApprovals(body.approvals.filter((a) => a.status === "pending" || (a.status === "approved" && !a.executedAt)));
      if (tenantRes.ok) {
        const tenantBody = await tenantRes.json() as { tenants?: TenantSummary[] };
        setTenants(Object.fromEntries((tenantBody.tenants ?? []).map((t) => [t.id, t])));
      }
    } catch {
      setError("Could not load approvals.");
    }
  }, [canRead, request]);

  useEffect(() => { void load(); }, [load]);

  async function decide(approval: ApprovalWithTenant, decision: "approve" | "reject") {
    setBusy(approval.approvalId);
    setError(null);
    try {
      const res = await request(`/management/v1/approvals/${approval.approvalId}/${decision}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.error === "STEP_UP_REQUIRED") {
          stepUp("/approvals");
          return;
        }
        setError(body.message ?? body.error ?? "That decision could not be completed.");
        return;
      }
      await load();
    } catch {
      setError("That decision could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  const counts = useMemo(() => {
    const list = approvals ?? [];
    return {
      waitingForMe: list.filter((a) => a.status === "pending" && a.makerOperatorId !== operator?.operatorId).length,
      waitingOnOther: list.filter((a) => a.status === "pending" && a.makerOperatorId === operator?.operatorId).length,
      readyToExecute: list.filter((a) => a.status === "approved" && !a.executedAt).length,
    };
  }, [approvals, operator?.operatorId]);

  if (!canRead) {
    return <><div className="page-header"><h1 className="text-display">Approvals</h1></div><EmptyState label="You do not have access to the approval inbox." icon="lock" /></>;
  }

  return (
    <>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem", flexWrap: "wrap" }}>
        <div>
          <h1 className="text-display">Approvals</h1>
          <p>One inbox for high-risk changes. A request cannot be approved by the same operator who created it.</p>
        </div>
        <button className="btn" onClick={() => void load()}><Icon name="refresh" size="sm" /> Refresh</button>
      </div>

      {error && <ErrorState label={error} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))", gap: "0.75rem", marginBottom: "1rem" }}>
        <div className="card metric-card"><div className="metric-card-label">Needs your decision</div><div className="metric-card-value">{counts.waitingForMe}</div></div>
        <div className="card metric-card"><div className="metric-card-label">Your requests waiting</div><div className="metric-card-value">{counts.waitingOnOther}</div></div>
        <div className="card metric-card"><div className="metric-card-label">Approved, ready to finish</div><div className="metric-card-value">{counts.readyToExecute}</div></div>
      </div>

      {approvals === null && !error && <div className="card"><p className="overlay-note">Loading approvals…</p></div>}
      {approvals?.length === 0 && <EmptyState label="No approval is waiting for review or execution." icon="task_alt" />}
      {approvals && approvals.length > 0 && (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {approvals.map((approval) => {
            const ownRequest = approval.makerOperatorId === operator?.operatorId;
            const tenant = approval.targetTenantId ? tenants[approval.targetTenantId] : undefined;
            return (
              <article className="card" key={approval.approvalId}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ display: "flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap" }}>
                      <StatusBadge value={approval.status} />
                      <strong>{titleFor(approval.requestedAction)}</strong>
                    </div>
                    <div className="overlay-note" style={{ marginTop: "0.25rem" }}>
                      Requested {formatDate(approval.requestedAt)} · expires {formatDate(approval.expiresAt)}
                      {tenant ? ` · ${tenant.name}` : ""}
                    </div>
                  </div>
                  <a className="btn" href={owningHref(approval)}>{owningLabel(approval)}</a>
                </div>
                <p style={{ margin: "0.65rem 0 0", fontSize: "0.9rem" }}>{approval.reason}</p>
                <Summary value={approval.safeRequestSummary} />
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.7rem", alignItems: "center", flexWrap: "wrap" }}>
                  {approval.status === "pending" && !ownRequest && <>
                    <button className="btn btn-primary" disabled={busy === approval.approvalId} onClick={() => void decide(approval, "approve")}>Approve</button>
                    <button className="btn btn-danger" disabled={busy === approval.approvalId} onClick={() => void decide(approval, "reject")}>Reject</button>
                  </>}
                  {approval.status === "pending" && ownRequest && <span className="overlay-note" style={{ marginTop: 0 }}>Waiting for a different operator.</span>}
                  {approval.status === "approved" && <span className="overlay-note" style={{ marginTop: 0 }}>Approved. Open the owning control to execute it safely.</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
