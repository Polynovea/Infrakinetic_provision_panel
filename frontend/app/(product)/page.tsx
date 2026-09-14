"use client";

import { useEffect, useState } from "react";

import { useOperatorSession } from "../../lib/session";

export default function OverviewPage() {
  const { operator, request } = useOperatorSession();
  const [tenantCount, setTenantCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    request("/management/v1/tenants")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body) setTenantCount(body.tenants.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [request]);

  return (
    <>
      <div className="page-header">
        <h1>Overview</h1>
        <p>{operator ? `Signed in as ${operator.email}.` : "Welcome."}</p>
      </div>

      <div className="card-grid">
        <a className="card" href="/tenants" style={{ textDecoration: "none", color: "inherit" }}>
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Tenants</div>
          <div style={{ fontSize: "1.8rem", fontWeight: 600, marginTop: "0.35rem" }}>
            {tenantCount ?? "—"}
          </div>
          <div className="overlay-note">View tenant registry</div>
        </a>
        <a className="card" href="/engine-state" style={{ textDecoration: "none", color: "inherit" }}>
          <div style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>Platform</div>
          <div style={{ fontSize: "1.1rem", fontWeight: 600, marginTop: "0.35rem" }}>Engine controls</div>
          <div className="overlay-note">View and change engine state</div>
        </a>
      </div>
    </>
  );
}
