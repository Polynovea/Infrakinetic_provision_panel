"use client";

import { useState } from "react";

import { ActionDialog } from "./AiActions";
import type { ApprovalRecord } from "./ApprovalQueue";

// Phase 1A.15 final closure — fleet-level AI operator actions (providers, models, exceptions). Thin forms over
// one contract route each; the backend enforces scope, step-up, risk class and the strict request schema.
//
//   provider state   activate R2 · disable/deprecate R4 (recovery intent, fresh step-up)   ai.provider_policy.write
//   model lifecycle  R3 request -> a different operator approves -> execute               ai.provider_policy.write
//   model certify    R3 request with an evidence reference                                 ai.provider_policy.write
//   metering resolve R1                                                                    ai.quota.write
//   reconciliation   R1 (statement ingestion is an owner-side CLI/job — never uploaded here)  finops.policy.write
//   managed keys     add/rotate/status R2; runtime-source cutover R3 maker-checker              ai.credentials.manage

const AI = "/management/v1/ai";
const PROVIDER_STATUSES = ["active", "disabled", "deprecated"] as const;
const LIFECYCLES = ["active", "deprecated", "retired"] as const;
const CERTIFICATIONS = ["uncertified", "synthetic_certified", "provider_certified"] as const;

interface Common { onClose: () => void; onDone: () => void }

export function ProviderStateDialog({ providerKey, current, onClose, onDone }: Common & { providerKey: string; current: string }) {
  const options = PROVIDER_STATUSES.filter((s) => s !== current);
  const [status, setStatus] = useState<string>(options[0] ?? "active");
  const [recoveryIntent, setRecoveryIntent] = useState("");
  const narrowing = status !== "active";
  return (
    <ActionDialog
      title={`Provider ${providerKey}`}
      description={narrowing
        ? "Disabling or deprecating a provider stops AI calls through it for every tenant. It needs a fresh sign-in confirmation and a recovery intent."
        : "Reactivating a provider lets tenants use it again, subject to their own policy."}
      confirmLabel={narrowing ? `Set ${status}` : "Activate"}
      danger={narrowing}
      canSubmit={!narrowing || recoveryIntent.trim() !== ""}
      build={(reason, idempotencyKey) => ({
        method: "PUT",
        path: `${AI}/providers/${encodeURIComponent(providerKey)}/state`,
        body: { idempotencyKey, reason, status, ...(narrowing ? { recoveryIntent: recoveryIntent.trim() } : {}) },
      })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>New status (currently {current})</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>{options.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
      {narrowing && (
        <div className="field"><label>Recovery intent</label>
          <textarea rows={2} value={recoveryIntent} onChange={(e) => setRecoveryIntent(e.target.value)} placeholder="How and when will this provider be restored?" /></div>
      )}
    </ActionDialog>
  );
}

export function ModelLifecycleDialog({ modelId, label, current, onClose, onDone }: Common & { modelId: string; label: string; current: string }) {
  const options = LIFECYCLES.filter((l) => l !== current);
  const [lifecycle, setLifecycle] = useState<string>(options[0] ?? "deprecated");
  return (
    <ActionDialog
      title={`Model lifecycle — ${label}`}
      description="A lifecycle change is maker-checker: this creates an approval for a different operator to decide, then execute. The approval shows which capabilities use this model as their default; execution is refused if the model has changed meanwhile. Retired is terminal."
      confirmLabel="Request change"
      canSubmit={current !== "retired"}
      build={(reason) => ({ method: "POST", path: `${AI}/models/${encodeURIComponent(modelId)}/lifecycle/request`, body: { reason, lifecycle } })}
      onClose={onClose}
      onDone={onDone}
    >
      {current === "retired" ? <p className="field-hint">This model is retired; retirement cannot be undone.</p> : (
        <div className="field"><label>New lifecycle (currently {current})</label>
          <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>{options.map((l) => <option key={l} value={l}>{l}</option>)}</select></div>
      )}
    </ActionDialog>
  );
}

export function ModelCertificationDialog({ modelId, label, current, onClose, onDone }: Common & { modelId: string; label: string; current: string }) {
  const [certification, setCertification] = useState<string>(CERTIFICATIONS.find((c) => c !== current) ?? "synthetic_certified");
  const [evidenceRef, setEvidenceRef] = useState("");
  return (
    <ActionDialog
      title={`Model certification — ${label}`}
      description="Certification is maker-checker and needs an evidence reference — the identifier of the certification run or artefact. It must be an identifier, never a credential."
      confirmLabel="Request certification"
      canSubmit={evidenceRef.trim() !== ""}
      build={(reason) => ({ method: "POST", path: `${AI}/models/${encodeURIComponent(modelId)}/certification/request`, body: { reason, certification, evidenceRef: evidenceRef.trim() } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>Certification (currently {current})</label>
        <select value={certification} onChange={(e) => setCertification(e.target.value)}>{CERTIFICATIONS.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select></div>
      <div className="field"><label>Evidence reference</label><input value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} placeholder="e.g. cert-run-2026-10-05" maxLength={200} /></div>
    </ActionDialog>
  );
}

export function ManagedCredentialAddDialog({ poolKey, poolName, onClose, onDone }: Common & { poolKey: string; poolName: string }) {
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  return (
    <ActionDialog
      title={`Add managed key — ${poolName}`}
      description="The key is sent once to the owner for encryption. Governance stores only a one-way digest for idempotency/audit and never stores or returns the raw key. Adding a key does not change the pool's runtime source."
      confirmLabel="Add key"
      canSubmit={label.trim() !== "" && secret.trim().length >= 8}
      build={(reason, idempotencyKey) => ({ method: "POST", path: `${AI}/managed-credentials/${encodeURIComponent(poolKey)}`, body: { idempotencyKey, reason, label: label.trim(), secret: secret.trim() } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>Label</label><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. NVIDIA account A" maxLength={120} autoComplete="off" /></div>
      <div className="field"><label>Provider key</label><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Paste once" autoComplete="new-password" /></div>
    </ActionDialog>
  );
}

export function ManagedCredentialRotateDialog({ poolKey, credentialId, label, onClose, onDone }: Common & { poolKey: string; credentialId: string; label: string }) {
  const [secret, setSecret] = useState("");
  return (
    <ActionDialog
      title={`Rotate key — ${label}`}
      description="Creates a new encrypted version and supersedes the previous version. The pool keeps using all active credentials; use Drain/Disable separately if you need a staged cutover."
      confirmLabel="Rotate key"
      canSubmit={secret.trim().length >= 8}
      build={(reason, idempotencyKey) => ({ method: "POST", path: `${AI}/managed-credentials/${encodeURIComponent(poolKey)}/${encodeURIComponent(credentialId)}/rotate`, body: { idempotencyKey, reason, secret: secret.trim() } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>New provider key</label><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Paste once" autoComplete="new-password" /></div>
    </ActionDialog>
  );
}

export function ManagedCredentialStatusDialog({ poolKey, credentialId, label, current, onClose, onDone }: Common & { poolKey: string; credentialId: string; label: string; current: string }) {
  const options = ["active", "draining", "disabled", "revoked"].filter((value) => value !== current);
  const [status, setStatus] = useState(options[0] ?? "draining");
  const danger = status === "revoked" || status === "disabled";
  return (
    <ActionDialog
      title={`Key status — ${label}`}
      description={status === "draining" ? "Draining stops this key from being selected once the managed pool is authoritative, while keeping its audit history." : status === "revoked" ? "Revocation is terminal for this version. The owner refuses the change if it would leave a managed runtime pool below its minimum active-key count." : "Change the key's participation in the managed pool."}
      confirmLabel={`Set ${status}`}
      danger={danger}
      build={(reason, idempotencyKey) => ({ method: "PUT", path: `${AI}/managed-credentials/${encodeURIComponent(poolKey)}/${encodeURIComponent(credentialId)}/status`, body: { idempotencyKey, reason, status } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>New status (currently {current})</label><select value={status} onChange={(e) => setStatus(e.target.value)}>{options.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
    </ActionDialog>
  );
}

export function ManagedPoolSourceDialog({ poolKey, poolName, current, environmentCount, managedActiveCount, keyringPosture, onClose, onDone }: Common & { poolKey: string; poolName: string; current: string; environmentCount: number; managedActiveCount: number; keyringPosture: string }) {
  const target = current === "environment" ? "managed_db" : "environment";
  return (
    <ActionDialog
      title={`Runtime source — ${poolName}`}
      description="Runtime-source cutover is maker-checker. A different operator must approve the exact source and current readiness counts; execution re-reads them and refuses if they changed. No key material appears in the approval."
      confirmLabel={`Request ${target === "managed_db" ? "Governance-managed" : "environment"} source`}
      canSubmit={target === "environment" ? environmentCount > 0 : managedActiveCount > 0 && keyringPosture === "configured"}
      build={(reason) => ({ method: "POST", path: `${AI}/managed-credentials/${encodeURIComponent(poolKey)}/source/request`, body: { reason, source: target } })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="card" style={{ fontSize: "0.85rem" }}>
        <div>Current: <strong>{current === "managed_db" ? "Governance-managed" : "environment"}</strong></div>
        <div>Environment keys: {environmentCount} · active managed keys: {managedActiveCount}</div>
        <div>Managed encryption keyring: {keyringPosture}</div>
      </div>
    </ActionDialog>
  );
}

export function ResolveMeteringDialog({ exceptionId, type, onClose, onDone }: Common & { exceptionId: string; type: string }) {
  return (
    <ActionDialog
      title="Resolve metering exception"
      description={`Records that this ${type.replace(/_/g, " ")} exception was investigated. It does not alter usage or evidence, and it stays resolved unless the underlying data changes.`}
      confirmLabel="Resolve"
      build={(reason, idempotencyKey) => ({ method: "POST", path: `${AI}/metering-exceptions/${encodeURIComponent(exceptionId)}/resolve`, body: { idempotencyKey, reason } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function ResolveReconciliationDialog({ reconciliationId, outcome, onClose, onDone }: Common & { reconciliationId: string; outcome: string }) {
  return (
    <ActionDialog
      title="Resolve reconciliation exception"
      description={`Records the outcome '${outcome.replace(/_/g, " ")}' as reviewed against the provider's statement. It does not change the statement or any usage figure.`}
      confirmLabel="Resolve"
      build={(reason, idempotencyKey) => ({ method: "POST", path: `${AI}/reconciliation/lines/${encodeURIComponent(reconciliationId)}/resolve`, body: { idempotencyKey, reason } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

// The checker decides against what the maker saw: the owner's facts bound into the approval, in plain terms.
export function AiApprovalSummary({ approval }: { approval: ApprovalRecord }) {
  const s = (approval.safeRequestSummary ?? {}) as Record<string, unknown>;
  const row = (label: string, value: unknown) => (value === undefined || value === null || value === "" ? null : (
    <div key={label}><span className="overlay-note" style={{ marginTop: 0 }}>{label}: </span>{String(value)}</div>
  ));
  const when = (iso: unknown) => (typeof iso === "string" ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : undefined);
  let rows: Array<React.ReactNode>;
  if (approval.requestedAction === "ai.tenant.emergency.resume") {
    rows = [row("Tenant", s.tenantId), row("Suspended since", when(s.suspendedSince)), row("Suspension reason", s.suspendReason), row("Recovery intent", s.recoveryIntent), row("Result", "AI resumes for this tenant")];
  } else if (approval.requestedAction === "ai.model.lifecycle.set") {
    const users = Array.isArray(s.capabilitiesUsingAsDefault) ? (s.capabilitiesUsingAsDefault as string[]) : [];
    rows = [
      row("Model", `${s.providerKey}/${s.modelKey}`), row("Lifecycle", `${s.lifecycleAtRequest} → ${s.requestedLifecycle}`),
      row("Provider status", s.providerStatusAtRequest), row("Capabilities using it as default", users.length ? users.join(", ") : "none"),
    ];
  } else if (approval.requestedAction === "ai.model.certification.set") {
    rows = [row("Model", `${s.providerKey}/${s.modelKey}`), row("Certification", `${String(s.certificationAtRequest).replace(/_/g, " ")} → ${String(s.requestedCertification).replace(/_/g, " ")}`), row("Evidence", s.evidenceRef)];
  } else if (approval.requestedAction === "ai.managed-credential.pool-source.set") {
    rows = [
      row("Credential pool", s.poolKey), row("Workload", s.workloadLabel),
      row("Runtime source", `${s.currentSource} → ${s.requestedSource}`),
      row("Environment keys", s.environmentCredentialCount), row("Active managed keys", s.managedActiveCredentialCount),
      row("Encryption keyring", s.keyringPosture), row("Ready at request", s.runtimeReadyAtRequest),
    ];
  } else {
    rows = [];
  }
  return <div style={{ fontSize: "0.85rem", margin: "0.35rem 0" }}>{rows}</div>;
}
