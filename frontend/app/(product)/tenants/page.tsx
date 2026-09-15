"use client";

import { useEffect, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "../../../components/States";

interface TenantRegistryUser {
  id: string;
  full_name: string;
  email: string;
  role_key: string;
  status: string;
  created_at: string;
  last_active_at: string | null;
}

interface TenantRegistryEntry {
  id: string;
  name: string;
  slug: string;
  tenant_kind: "customer" | "platform";
  plan: string;
  status: string;
  trial_ends_at: string | null;
  industry: string | null;
  country: string;
  timezone: string;
  seat_limit: number | null;
  storage_limit_mb: number | null;
  created_at: string;
  updated_at: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function TenantsPage() {
  const { request } = useOperatorSession();
  const [tenants, setTenants] = useState<TenantRegistryEntry[] | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TenantRegistryEntry | null>(null);
  const [users, setUsers] = useState<TenantRegistryUser[] | null>(null);
  const [usersObservedAt, setUsersObservedAt] = useState<string | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    request("/management/v1/tenants")
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError("Could not load tenants.");
          return;
        }
        setTenants(body.tenants);
        setObservedAt(body.observedAt);
      })
      .catch(() => !cancelled && setError("Could not load tenants."));
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    if (!selected) {
      setUsers(null);
      setUsersObservedAt(null);
      setUsersError(null);
      return;
    }
    let cancelled = false;
    setUsers(null);
    setUsersError(null);
    request(`/management/v1/tenants/${encodeURIComponent(selected.id)}/users`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setUsersError("Could not load this tenant's users.");
          return;
        }
        setUsers(body.users);
        setUsersObservedAt(body.observedAt);
      })
      .catch(() => !cancelled && setUsersError("Could not load this tenant's users."));
    return () => {
      cancelled = true;
    };
  }, [request, selected]);

  return (
    <>
      <div className="page-header">
        <h1>Tenants</h1>
        <p>{observedAt ? `Last observed ${formatDate(observedAt)}` : "Read-only tenant registry."}</p>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        {error && <ErrorState label={error} />}
        {!error && tenants === null && <LoadingState label="Loading tenants…" />}
        {!error && tenants !== null && tenants.length === 0 && <EmptyState label="No tenants found." />}
        {!error && tenants !== null && tenants.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Kind</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Country</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} onClick={() => setSelected(t)}>
                  <td>{t.name}</td>
                  <td>{t.slug}</td>
                  <td>
                    <StatusBadge value={t.tenant_kind} />
                  </td>
                  <td>{t.plan}</td>
                  <td>
                    <StatusBadge value={t.status} />
                  </td>
                  <td>{t.country}</td>
                  <td>{formatDate(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.1rem" }}>{selected.name}</h2>
              <div style={{ display: "flex", gap: "0.4rem" }}>
                <StatusBadge value={selected.tenant_kind} />
                <StatusBadge value={selected.status} />
              </div>
            </div>
            <button className="btn" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem", marginTop: "1rem", fontSize: "0.88rem" }}>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Plan</dt>
              <dd style={{ margin: 0 }}>{selected.plan}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Industry</dt>
              <dd style={{ margin: 0 }}>{selected.industry ?? "—"}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Country / timezone</dt>
              <dd style={{ margin: 0 }}>
                {selected.country} · {selected.timezone}
              </dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Seat limit</dt>
              <dd style={{ margin: 0 }}>{selected.seat_limit ?? "—"}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Storage limit</dt>
              <dd style={{ margin: 0 }}>{selected.storage_limit_mb ? `${selected.storage_limit_mb} MB` : "—"}</dd>
            </div>
            <div>
              <dt style={{ color: "var(--text-muted)" }}>Trial ends</dt>
              <dd style={{ margin: 0 }}>{selected.trial_ends_at ? formatDate(selected.trial_ends_at) : "—"}</dd>
            </div>
          </dl>

          <h3 style={{ margin: "1.25rem 0 0.5rem", fontSize: "0.95rem" }}>Users</h3>
          <p style={{ margin: "0 0 0.6rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {usersObservedAt ? `Last observed ${formatDate(usersObservedAt)}` : " "}
          </p>
          {usersError && <ErrorState label={usersError} />}
          {!usersError && users === null && <LoadingState label="Loading users…" />}
          {!usersError && users !== null && users.length === 0 && <EmptyState label="No users found for this tenant." />}
          {!usersError && users !== null && users.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Last active</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.full_name || "—"}</td>
                    <td>{u.email}</td>
                    <td>{u.role_key}</td>
                    <td>
                      <StatusBadge value={u.status} />
                    </td>
                    <td>{formatDate(u.created_at)}</td>
                    <td>{u.last_active_at ? formatDate(u.last_active_at) : "Never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
