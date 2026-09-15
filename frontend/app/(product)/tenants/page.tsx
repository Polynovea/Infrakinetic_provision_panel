"use client";

import { useEffect, useMemo, useState } from "react";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { Icon } from "../../../components/Icon";
import { Drawer } from "../../../components/Drawer";
import { EmptyState, ErrorState } from "../../../components/States";
import { SkeletonTableRows } from "../../../components/Skeleton";

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

function uniqueSorted(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v)))).sort();
}

const ALL = "__all__";

export default function TenantsPage() {
  const { request } = useOperatorSession();
  const [tenants, setTenants] = useState<TenantRegistryEntry[] | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TenantRegistryEntry | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [planFilter, setPlanFilter] = useState(ALL);
  const [kindFilter, setKindFilter] = useState(ALL);
  const [countryFilter, setCountryFilter] = useState(ALL);

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

  const counts = useMemo(() => {
    if (!tenants) return null;
    return {
      total: tenants.length,
      active: tenants.filter((t) => t.status === "active").length,
      trial: tenants.filter((t) => t.status === "trial").length,
      suspended: tenants.filter((t) => t.status === "suspended").length,
    };
  }, [tenants]);

  const statuses = useMemo(() => uniqueSorted((tenants ?? []).map((t) => t.status)), [tenants]);
  const plans = useMemo(() => uniqueSorted((tenants ?? []).map((t) => t.plan)), [tenants]);
  const kinds = useMemo(() => uniqueSorted((tenants ?? []).map((t) => t.tenant_kind)), [tenants]);
  const countries = useMemo(() => uniqueSorted((tenants ?? []).map((t) => t.country)), [tenants]);

  const filtered = useMemo(() => {
    if (!tenants) return null;
    const needle = search.trim().toLowerCase();
    return tenants.filter((t) => {
      if (needle && !t.name.toLowerCase().includes(needle) && !t.slug.toLowerCase().includes(needle)) return false;
      if (statusFilter !== ALL && t.status !== statusFilter) return false;
      if (planFilter !== ALL && t.plan !== planFilter) return false;
      if (kindFilter !== ALL && t.tenant_kind !== kindFilter) return false;
      if (countryFilter !== ALL && t.country !== countryFilter) return false;
      return true;
    });
  }, [tenants, search, statusFilter, planFilter, kindFilter, countryFilter]);

  const filtersActive = statusFilter !== ALL || planFilter !== ALL || kindFilter !== ALL || countryFilter !== ALL || search.trim() !== "";

  function clearFilters() {
    setSearch("");
    setStatusFilter(ALL);
    setPlanFilter(ALL);
    setKindFilter(ALL);
    setCountryFilter(ALL);
  }

  return (
    <>
      <div className="page-header">
        <h1 className="text-display">Tenants</h1>
        <p>{observedAt ? `Last observed ${formatDate(observedAt)}` : "The platform's tenant registry."}</p>
      </div>

      {counts && (
        <div className="metric-row" style={{ marginBottom: "1.25rem" }}>
          <span className="metric-chip">
            <span className="metric-chip-value">{counts.total}</span> total
          </span>
          <span className="metric-chip">
            <span className="metric-chip-value" style={{ color: "var(--success-fg)" }}>
              {counts.active}
            </span>{" "}
            active
          </span>
          <span className="metric-chip">
            <span className="metric-chip-value" style={{ color: "var(--warning-fg)" }}>
              {counts.trial}
            </span>{" "}
            trial
          </span>
          <span className="metric-chip">
            <span className="metric-chip-value" style={{ color: "var(--danger-fg)" }}>
              {counts.suspended}
            </span>{" "}
            suspended
          </span>
        </div>
      )}

      <div className="card" style={{ marginBottom: "1rem", display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end" }}>
        <div className="field" style={{ flex: "1 1 220px", marginBottom: 0 }}>
          <label>Search</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or slug" />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value={ALL}>All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Plan</label>
          <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value)}>
            <option value={ALL}>All plans</option>
            {plans.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Kind</label>
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
            <option value={ALL}>All kinds</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Country</label>
          <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)}>
            <option value={ALL}>All countries</option>
            {countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        {filtersActive && (
          <button className="btn" onClick={clearFilters}>
            <Icon name="filter_alt_off" size="sm" /> Clear
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        {error && <ErrorState label={error} />}
        {!error && tenants === null && (
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
              <SkeletonTableRows columns={7} />
            </tbody>
          </table>
        )}
        {!error && filtered !== null && filtered.length === 0 && (
          <EmptyState label={filtersActive ? "No tenants match these filters." : "No tenants found."} icon="domain" />
        )}
        {!error && filtered !== null && filtered.length > 0 && (
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
              {filtered.map((t) => (
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

      {selected && <TenantDetailDrawer tenant={selected} request={request} onClose={() => setSelected(null)} />}
    </>
  );
}

function TenantDetailDrawer({
  tenant,
  request,
  onClose,
}: {
  tenant: TenantRegistryEntry;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
}) {
  const [users, setUsers] = useState<TenantRegistryUser[] | null>(null);
  const [usersObservedAt, setUsersObservedAt] = useState<string | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUsers(null);
    setUsersError(null);
    request(`/management/v1/tenants/${encodeURIComponent(tenant.id)}/users`)
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
  }, [request, tenant.id]);

  return (
    <Drawer title={tenant.name} subtitle={tenant.slug} onClose={onClose}>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem" }}>
        <StatusBadge value={tenant.tenant_kind} />
        <StatusBadge value={tenant.status} />
      </div>

      <h3 className="text-subhead" style={{ marginBottom: "0.6rem" }}>
        Overview
      </h3>
      <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem", fontSize: "0.88rem" }}>
        <div>
          <dt style={{ color: "var(--text-muted)" }}>Plan</dt>
          <dd style={{ margin: 0 }}>{tenant.plan}</dd>
        </div>
        <div>
          <dt style={{ color: "var(--text-muted)" }}>Industry</dt>
          <dd style={{ margin: 0 }}>{tenant.industry ?? "—"}</dd>
        </div>
        <div>
          <dt style={{ color: "var(--text-muted)" }}>Country / timezone</dt>
          <dd style={{ margin: 0 }}>
            {tenant.country} · {tenant.timezone}
          </dd>
        </div>
        <div>
          <dt style={{ color: "var(--text-muted)" }}>Seat limit</dt>
          <dd style={{ margin: 0 }}>{tenant.seat_limit ?? "—"}</dd>
        </div>
        <div>
          <dt style={{ color: "var(--text-muted)" }}>Storage limit</dt>
          <dd style={{ margin: 0 }}>{tenant.storage_limit_mb ? `${tenant.storage_limit_mb} MB` : "—"}</dd>
        </div>
        <div>
          <dt style={{ color: "var(--text-muted)" }}>Trial ends</dt>
          <dd style={{ margin: 0 }}>{tenant.trial_ends_at ? formatDate(tenant.trial_ends_at) : "—"}</dd>
        </div>
        <div>
          <dt style={{ color: "var(--text-muted)" }}>Created</dt>
          <dd style={{ margin: 0 }}>{formatDate(tenant.created_at)}</dd>
        </div>
      </dl>

      <h3 className="text-subhead" style={{ margin: "1.5rem 0 0.6rem" }}>
        Users
      </h3>
      <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>
        {usersObservedAt ? `Last observed ${formatDate(usersObservedAt)}` : " "}
      </p>
      {usersError && <ErrorState label={usersError} />}
      {!usersError && users === null && (
        <table className="data-table">
          <tbody>
            <SkeletonTableRows columns={6} rows={2} />
          </tbody>
        </table>
      )}
      {!usersError && users !== null && users.length === 0 && <EmptyState label="No users found for this tenant." icon="group" />}
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

      <div className="card" style={{ marginTop: "1.5rem" }}>
        <button
          className="btn"
          style={{ border: "none", background: "transparent", padding: 0, fontSize: "0.82rem", color: "var(--text-muted)" }}
          onClick={() => setShowTechnical((v) => !v)}
        >
          <Icon name={showTechnical ? "expand_less" : "expand_more"} size="sm" /> Technical details
        </button>
        {showTechnical && (
          <dl style={{ marginTop: "0.6rem", fontSize: "0.85rem" }}>
            <dt style={{ color: "var(--text-muted)" }}>Tenant ID</dt>
            <dd style={{ margin: "0.1rem 0", fontFamily: "monospace" }}>{tenant.id}</dd>
          </dl>
        )}
      </div>
    </Drawer>
  );
}
