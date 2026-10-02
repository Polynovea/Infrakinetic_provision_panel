"use client";

import { useState } from "react";

import { ActionDialog } from "./AiActions";

const AI = "/management/v1/ai";
const STATUSES = ["active", "draining", "disabled", "revoked"] as const;

interface Common { onClose: () => void; onDone: () => void }

export function ManagedCredentialAddDialog({ poolKey, workloadLabel, onClose, onDone }: Common & { poolKey: string; workloadLabel: string }) {
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  return (
    <ActionDialog
      title={`Add managed credential — ${poolKey}`}
      description={<>Adds a platform-managed provider credential for <strong>{workloadLabel}</strong>. The key is relayed once to the Infrakinetic owner for encryption. Governance does not persist the plaintext value.</>}
      confirmLabel="Add credential"
      canSubmit={label.trim() !== "" && secret.trim() !== ""}
      build={(reason, idempotencyKey) => ({
        method: "POST",
        path: `${AI}/managed-credentials/${encodeURIComponent(poolKey)}`,
        body: { idempotencyKey, reason, label: label.trim(), secret: secret.trim() },
      })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>Label</label><input value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Primary production key" autoComplete="off" /></div>
      <div className="field"><label>Provider key</label><input type="password" value={secret} maxLength={4096} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} /></div>
      <p className="field-hint">The browser sends this value only for this operation. It is never returned by the read API.</p>
    </ActionDialog>
  );
}

export function ManagedCredentialRotateDialog({ poolKey, credentialId, label, onClose, onDone }: Common & { poolKey: string; credentialId: string; label: string }) {
  const [secret, setSecret] = useState("");
  return (
    <ActionDialog
      title={`Rotate ${label}`}
      description="Creates a new encrypted version for this managed credential. The owner supersedes the previous version; Governance retains only redacted audit evidence."
      confirmLabel="Rotate credential"
      canSubmit={secret.trim() !== ""}
      build={(reason, idempotencyKey) => ({
        method: "POST",
        path: `${AI}/managed-credentials/${encodeURIComponent(poolKey)}/${encodeURIComponent(credentialId)}/rotate`,
        body: { idempotencyKey, reason, secret: secret.trim() },
      })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>Replacement provider key</label><input type="password" value={secret} maxLength={4096} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} /></div>
    </ActionDialog>
  );
}

export function ManagedCredentialStatusDialog({ poolKey, credentialId, label, current, onClose, onDone }: Common & { poolKey: string; credentialId: string; label: string; current: string }) {
  const options = STATUSES.filter((status) => status !== current);
  const [status, setStatus] = useState<string>(options[0] ?? "draining");
  const destructive = status === "disabled" || status === "revoked";
  return (
    <ActionDialog
      title={`Credential state — ${label}`}
      description={status === "revoked" ? "Revocation removes this managed credential from future runtime selection. This is an explicit operational action and is audited." : "Changes whether this credential can be selected by the managed runtime pool."}
      confirmLabel={`Set ${status}`}
      danger={destructive}
      build={(reason, idempotencyKey) => ({
        method: "PUT",
        path: `${AI}/managed-credentials/${encodeURIComponent(poolKey)}/${encodeURIComponent(credentialId)}/status`,
        body: { idempotencyKey, reason, status },
      })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>New state (currently {current})</label><select value={status} onChange={(e) => setStatus(e.target.value)}>{options.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
    </ActionDialog>
  );
}

export function ManagedPoolSourceDialog({ poolKey, current, managedReady, onClose, onDone }: Common & { poolKey: string; current: string; managedReady: boolean }) {
  const source = current === "managed_db" ? "environment" : "managed_db";
  const movingToManaged = source === "managed_db";
  return (
    <ActionDialog
      title={`Runtime source — ${poolKey}`}
      description={movingToManaged
        ? "Requests a maker-checker cutover from legacy environment keys to the encrypted managed pool. Runtime does not switch when this request is created; a different operator must approve it and one of the approval parties must execute it."
        : "Requests a maker-checker rollback to the legacy environment-key source. The owner will refuse the cutover if the requested source is not ready."}
      confirmLabel={movingToManaged ? "Request managed-pool cutover" : "Request environment rollback"}
      canSubmit={!movingToManaged || managedReady}
      build={(reason) => ({
        method: "POST",
        path: `${AI}/managed-credentials/${encodeURIComponent(poolKey)}/source/request`,
        body: { reason, source },
      })}
      onClose={onClose}
      onDone={onDone}
    >
      <div className="field"><label>Requested runtime source</label><input value={source === "managed_db" ? "Managed encrypted pool" : "Legacy environment pool"} readOnly /></div>
      {movingToManaged && !managedReady && <p className="field-hint">This pool does not yet have enough active managed credentials for cutover. Add or reactivate credentials first.</p>}
    </ActionDialog>
  );
}
