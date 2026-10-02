"use client";

import { useRef, useState, type ReactNode } from "react";

import { useOperatorSession } from "../lib/session";
import { ConfirmDialog } from "./ConfirmDialog";

// Phase 1A.15 final closure — the operator action surface for the AI plane. Every mutation goes through
// ONE dialog that:
//   - collects a mandatory reason,
//   - holds a stable idempotency key for the life of the dialog (a retry of the same intent replays; a
//     definitive refusal mints a fresh key for the next attempt),
//   - offers the real fresh-sign-in step-up when the backend demands it (suspend, provider narrowing, every R3 step),
//   - reports the operation's honest outcome: verified by an independent read, refused by the owner, or
//     outcome-uncertain (never presented as success).
// Tenant BYOAI remains metadata + revoke only. Platform-managed provider keys use dedicated root routes; secret fields are single-transit and are never persisted by Governance.

export const newKey = (prefix: string): string => {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ui-${prefix}-${random}`;
};

export interface AiOperationView {
  status: string;
  partialFailureState?: { stage?: string; message?: string; status?: number; body?: { error?: string; message?: string }; expected?: unknown; observed?: unknown; fieldPath?: string };
  result?: { observation?: { status: string; via?: string; message?: string } };
}

export interface Outcome { tone: "ok" | "warn" | "bad"; text: string }

export function explainOperation(operation: AiOperationView | undefined, replay: boolean): Outcome {
  if (!operation) return { tone: "warn", text: "The request was accepted but no operation was returned." };
  const prefix = replay ? "Already recorded (replay): " : "";
  if (operation.status === "completed") {
    const observation = operation.result?.observation;
    const verified = observation?.status === "verified";
    return {
      tone: "ok",
      text: `${prefix}Done${verified ? ", and confirmed by an independent read of the owner." : observation?.status === "not_observable" ? ". The owner accepted it; this operator cannot independently read the result." : "."}`,
    };
  }
  const failure = operation.partialFailureState;
  if (operation.status === "failed") {
    const ownerError = failure?.body?.message ?? failure?.body?.error;
    return {
      tone: "bad",
      text: `${prefix}${failure?.stage === "mutation-call-never-dispatched" ? "The owner could not be reached; nothing was changed." : `The owner refused this change${ownerError ? `: ${ownerError}` : ""}.`}`,
    };
  }
  if (operation.status === "partially_completed") {
    const detail = failure?.stage === "effective-mismatch"
      ? "the owner reported success but a fresh read does not show the change"
      : failure?.stage === "owner-response-unsafe"
        ? "the owner's response was withheld by the safety filter"
        : failure?.message ?? "the outcome could not be confirmed";
    return { tone: "warn", text: `${prefix}Outcome uncertain — ${detail}. Do not retry with a new key; check the owner receipt for this operation first.` };
  }
  return { tone: "warn", text: `${prefix}Operation is ${operation.status}.` };
}

interface ErrorBody { error?: string; message?: string; violations?: string[] }

function describeError(body: ErrorBody): string {
  if (body.violations?.length) return `${body.message ?? body.error ?? "Invalid request"}`;
  return body.message ?? body.error ?? "That action failed.";
}

export interface ActionRequest { method: "PUT" | "POST" | "DELETE"; path: string; body: Record<string, unknown> }

export function ActionDialog({
  title, description, confirmLabel, danger = false, canSubmit = true, returnTo, build, onClose, onDone, children,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Validity of the caller's own fields; the mandatory reason is checked here. */
  canSubmit?: boolean;
  /** Where the fresh-sign-in step-up returns to; defaults to the current page. */
  returnTo?: string;
  /** Builds the request from the reason and this dialog's idempotency key. R3 requests must NOT include the key. */
  build: (reason: string, idempotencyKey: string) => ActionRequest;
  onClose: () => void;
  onDone: () => void;
  children?: ReactNode;
}) {
  const { request, stepUp } = useOperatorSession();
  const [reason, setReason] = useState("");
  const keyRef = useRef(newKey("ai"));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const finished = outcome?.tone === "ok" || outcome?.tone === "warn";

  async function submit() {
    setBusy(true);
    setOutcome(null);
    setNeedsStepUp(false);
    try {
      const spec = build(reason.trim(), keyRef.current);
      const res = await request(spec.path, { method: spec.method, headers: { "content-type": "application/json" }, body: JSON.stringify(spec.body) });
      const out = (await res.json().catch(() => ({}))) as ErrorBody & { approval?: unknown; operation?: AiOperationView; replay?: boolean };
      if (!res.ok) {
        if (out.error === "STEP_UP_REQUIRED") setNeedsStepUp(true);
        else setOutcome({ tone: "bad", text: describeError(out) });
        return;
      }
      if (out.approval) {
        setOutcome({ tone: "ok", text: "Approval requested. A different operator must approve it and then execute it (AI page → Approvals)." });
        onDone();
        return;
      }
      const view = explainOperation(out.operation, Boolean(out.replay));
      // A definitive refusal ends this intent: the next attempt is a new request with a new key.
      if (view.tone === "bad") keyRef.current = newKey("ai");
      setOutcome(view);
      onDone();
    } catch (err) {
      setOutcome({ tone: "bad", text: err instanceof Error ? err.message : "That action failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      danger={danger}
      busy={busy}
      confirmDisabled={!canSubmit || reason.trim() === "" || finished}
      onConfirm={submit}
      onCancel={onClose}
    >
      <div style={{ marginTop: "0.75rem", display: "grid", gap: "0.5rem" }}>
        {children}
        <div className="field">
          <label>Reason</label>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this change needed? (recorded in the audit trail)" disabled={finished} />
        </div>
        {needsStepUp && (
          <div>
            <p style={{ fontSize: "0.85rem", margin: "0 0 0.5rem" }}>This action requires a fresh sign-in confirmation.</p>
            <button className="btn btn-primary" onClick={() => stepUp(returnTo)}>Step up now</button>
          </div>
        )}
        {outcome && (
          <p role={outcome.tone === "bad" ? "alert" : "status"} style={{ fontSize: "0.85rem", margin: 0, color: outcome.tone === "bad" ? "var(--danger-fg)" : outcome.tone === "warn" ? "var(--warning-fg)" : undefined }}>
            {outcome.text}
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

// ── quota policy key (client-derived address of a root quota policy) ────
//
// The owner addresses a quota policy by <scopeType>:<scopeKey|*>:<plane|*>:<period>:<limitType>:<usageUnit|*>. It never
// PARSES a key — a PUT recomputes it from the body and refuses a mismatch — so a wrong key here can only be refused,
// never mis-applied. Existing rows use the `policyKey` the owner reported; this derivation is only for NEW policies.
const KEY_PART = /^[A-Za-z0-9._/-]{1,128}$/;
const absent = (value: string | null | undefined) => value === null || value === undefined || value === "";

export function quotaPolicyKey(policy: { scopeType: string; scopeKey?: string | null; aiPlane?: string | null; period: string; limitType: string; usageUnit?: string | null }): string | null {
  for (const required of [policy.scopeType, policy.period, policy.limitType]) if (!KEY_PART.test(required)) return null;
  for (const optional of [policy.scopeKey, policy.aiPlane, policy.usageUnit]) if (!absent(optional) && !KEY_PART.test(optional as string)) return null;
  const wild = (value: string | null | undefined) => (absent(value) ? "*" : (value as string));
  return [policy.scopeType, wild(policy.scopeKey), wild(policy.aiPlane), policy.period, policy.limitType, wild(policy.usageUnit)].join(":");
}
