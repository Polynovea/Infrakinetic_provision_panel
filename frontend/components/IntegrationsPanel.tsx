"use client";

import { useEffect, useState } from "react";

import { StatusBadge } from "./StatusBadge";
import { ErrorState } from "./States";

// Phase 1A.14 §4.1 — tenant integration inventory. Read-only: each owning
// engine publishes its own safe projection (Payments / Marketing /
// Migration); Governance renders it live and stores nothing. A failed owner
// is shown as failed — never as an empty, "healthy-looking" list.

interface Integration {
  integrationId: string;
  owningEngine: string;
  kind: string;
  provider: string;
  adapterVersion: string | null;
  environment: string | null;
  status: string;
  connectedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorClass: string | null;
  externalRefHint: string | null;
  credentialRef: { secretVersions: Array<{ kind: string; version: number; status: string; maskedHint: string | null }> } | null;
  webhooks: Array<{ endpointId: string; status: string; lastReceiptAt: string | null; quarantined24h: number; failed24h: number }>;
}

interface Observation {
  owningEngine: string;
  status: "healthy" | "failed";
  count?: number;
  errorClass?: string;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

export function IntegrationsPanel({ tenantId, request }: { tenantId: string; request: (path: string, init?: RequestInit) => Promise<Response> }) {
  const [data, setData] = useState<{ integrations: Integration[]; observations: Observation[]; observedAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request(`/management/v1/tenants/${encodeURIComponent(tenantId)}/integrations`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setError("Could not load integrations."); return; }
        setData(await res.json());
      })
      .catch(() => !cancelled && setError("Could not load integrations."));
    return () => { cancelled = true; };
  }, [request, tenantId]);

  return (
    <>
      <h3 className="text-subhead" style={{ margin: "1.25rem 0 0.5rem" }}>Integrations</h3>
      {error && <ErrorState label={error} />}
      {data && (
        <>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
            {data.observations.map((o) => (
              <span key={o.owningEngine} className="overlay-note" style={{ marginTop: 0, display: "inline-flex", gap: "0.3rem", alignItems: "center" }}>
                {o.owningEngine}: <StatusBadge value={o.status} />
                {o.status === "failed" && o.errorClass ? ` (${o.errorClass})` : ""}
              </span>
            ))}
            <span className="overlay-note" style={{ marginTop: 0 }}>Observed {when(data.observedAt)}</span>
          </div>
          {data.integrations.length === 0 ? (
            <p className="overlay-note">No integrations reported by any owner.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr><th>Owner</th><th>Provider</th><th>Status</th><th>Last success</th><th>Last failure</th><th>Webhooks (24h)</th></tr>
              </thead>
              <tbody>
                {data.integrations.map((i) => (
                  <tr key={`${i.owningEngine}:${i.integrationId}`}>
                    <td>{i.owningEngine}</td>
                    <td>
                      {i.provider}
                      {i.adapterVersion ? ` @${i.adapterVersion}` : ""}
                      {i.environment ? ` · ${i.environment}` : ""}
                      {i.externalRefHint ? ` · ${i.externalRefHint}` : ""}
                    </td>
                    <td>
                      <StatusBadge value={i.status} />
                      {i.lastErrorClass && <div className="overlay-note">{i.lastErrorClass}</div>}
                    </td>
                    <td>{when(i.lastSuccessAt)}</td>
                    <td>{when(i.lastFailureAt)}</td>
                    <td>
                      {i.webhooks.length === 0
                        ? "—"
                        : i.webhooks.map((w) => `${w.status}: ${w.failed24h} failed, ${w.quarantined24h} quarantined`).join("; ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
