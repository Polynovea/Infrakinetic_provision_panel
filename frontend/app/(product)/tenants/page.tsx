"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { useOperatorSession } from "../../../lib/session";
import { StatusBadge } from "../../../components/StatusBadge";
import { Icon } from "../../../components/Icon";
import { Drawer } from "../../../components/Drawer";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { EmptyState, ErrorState } from "../../../components/States";
import { SkeletonTableRows } from "../../../components/Skeleton";
import { IdentityPanel } from "../../../components/IdentityPanel";

interface TenantRegistryUser {
  id: string;
  full_name: string;
  email: string;
  role_key: string;
  status: string;
  created_at: string;
  last_active_at: string | null;
}

type PlatformAccessState = "active" | "suspended" | "decommissioned";

interface TenantRegistryEntry {
  id: string;
  name: string;
  slug: string;
  tenant_kind: "customer" | "platform";
  plan: string;
  status: string;
  // 1A.8.5 — Governance-owned platform-access fact, independent of the
  // Billing-owned `status` above (scoping doc §3.1/§3.15). Optional:
  // older Infrakinetic deploys may not send it yet.
  platform_access_state?: PlatformAccessState;
  trial_ends_at: string | null;
  industry: string | null;
  country: string;
  timezone: string;
  seat_limit: number | null;
  storage_limit_mb: number | null;
  created_at: string;
  updated_at: string;
}

// 1A.9.4 — engine entitlement lifecycle. Tri-state read (scoping doc §3.3):
// `configured` distinguishes "no row, default-resolved" from an explicit
// operator decision — never flattened to one boolean. `platformEngineState`
// is shown as its own badge, never merged with entitlement into one pill
// (same "two independently-owned facts" doctrine the platform/commercial
// status cards above already apply).
interface TenantEngineEntitlementEntry {
  canonicalEngine: string;
  label?: string;
  configured: boolean;
  effectiveEnabled: boolean;
  defaultDeny: boolean;
  platformEngineState: { state: string; reason: string | null };
}

interface EntitlementOperationBody {
  operation: {
    operationId: string;
    status: string;
    result?: {
      canonicalEngine?: string;
      requestedEnabled?: boolean;
      resultingEntitlement?: { configured: boolean; effectiveEnabled: boolean; defaultDeny: boolean };
    };
  };
  replay: boolean;
}

interface ManagementOperationWarning {
  stage: string;
  message: string;
}

// 1A.12.6 — pending invitation, listed alongside Users in the tenant
// identity section (§14's suggested information architecture).
interface IdentityInvitationSummary {
  invitationId: string;
  email: string;
  displayName: string;
  roleKey: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
}

// 1A.10.5 — reconciliation repair result (POST .../reconciliation/tenants/:tenantId/recheck).
// Projection repair and stuck-operation resolution run isolated from each
// other (a resilience patch after 1A.10.5) — either can fail without
// blocking the other, so both must be checked independently rather than
// inferred from projection/resolvedOperations alone.
interface ReconcileTenantResult {
  tenantId: string;
  projection: { created: boolean; observedRefreshed: boolean };
  projectionError?: string;
  resolvedOperations: Array<{ operationId: string; requestedAction: string; from: string; to: string; stage?: string }>;
  remainingDrift: Array<{ operationId: string; requestedAction: string; class: string; note: string }>;
  stuckOperationsError?: string;
  outcome: "complete" | "partial" | "failed";
  observedAt: string;
}

interface ManagementOperationBody {
  operation: {
    operationId: string;
    status: string;
    result?: {
      tenantId?: string;
      lifecycleOutcome?: string;
      warnings?: ManagementOperationWarning[];
      previousPlatformAccessState?: string | null;
      resultingPlatformAccessState?: string | null;
    };
  };
  replay: boolean;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function uniqueSorted(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v)))).sort();
}

const ALL = "__all__";

export default function TenantsPage() {
  const { request, operator, stepUp } = useOperatorSession();
  const searchParams = useSearchParams();
  const [tenants, setTenants] = useState<TenantRegistryEntry[] | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<TenantRegistryEntry | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [planFilter, setPlanFilter] = useState(ALL);
  const [kindFilter, setKindFilter] = useState(ALL);
  const [countryFilter, setCountryFilter] = useState(ALL);

  const loadTenants = useCallback(() => {
    setError(null);
    return request("/management/v1/tenants")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setError("Could not load tenants.");
          return;
        }
        setTenants(body.tenants);
        setObservedAt(body.observedAt);
      })
      .catch(() => setError("Could not load tenants."));
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    loadTenants().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
    // loadTenants is stable across renders (memoized on `request`, which is
    // itself stable) — only ever needs to run on mount / when request changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // 1A.12.4/1A.12.6 — the step-up OAuth round trip is a full-page
  // navigation away and back (see useOperatorSession's stepUp()), which
  // discards this page's in-memory state. Reopening the right tenant's
  // drawer via a `?tenant=` query param (set as the step-up `returnTo`) is
  // a deliberately minimal restoration — it does not attempt to reopen the
  // specific user's identity panel or pending-action dialog, which would
  // need considerably more state threaded through the URL for a marginal
  // UX gain over "click the user again."
  useEffect(() => {
    if (!tenants) return;
    const tenantId = searchParams.get("tenant");
    if (!tenantId) return;
    const match = tenants.find((t) => t.id === tenantId);
    if (match) setSelected(match);
    // Only reacts to `tenants` finishing its first load — deliberately not
    // re-running on every searchParams change, which would fight the user
    // manually closing the drawer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants]);

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

  const canCommission = operator?.scopes.includes("tenants.commission") ?? false;

  return (
    <>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h1 className="text-display">Tenants</h1>
          <p>{observedAt ? `Last observed ${formatDate(observedAt)}` : "The platform's tenant registry."}</p>
        </div>
        {canCommission && (
          <button className="btn btn-primary" onClick={() => setShowWizard(true)}>
            <Icon name="add_business" size="sm" /> Commission tenant
          </button>
        )}
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

      {selected && operator && (
        <TenantDetailDrawer
          tenant={selected}
          request={request}
          stepUp={stepUp}
          operatorId={operator.operatorId}
          operatorScopes={operator.scopes}
          onClose={() => setSelected(null)}
          onMutated={loadTenants}
        />
      )}
      {showWizard && (
        <CommissionWizard
          request={request}
          onClose={() => setShowWizard(false)}
          onCommissioned={loadTenants}
        />
      )}
    </>
  );
}

const LIFECYCLE_ACTION_LABEL: Record<"suspend" | "resume" | "decommission", string> = {
  suspend: "Suspend",
  resume: "Resume",
  decommission: "Decommission",
};

function TenantDetailDrawer({
  tenant: initialTenant,
  request,
  stepUp,
  operatorId,
  operatorScopes,
  onClose,
  onMutated,
}: {
  tenant: TenantRegistryEntry;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  stepUp: (returnTo?: string) => void;
  operatorId: string;
  operatorScopes: readonly string[];
  onClose: () => void;
  onMutated: () => void;
}) {
  const [tenant, setTenant] = useState(initialTenant);
  const [users, setUsers] = useState<TenantRegistryUser[] | null>(null);
  const [usersObservedAt, setUsersObservedAt] = useState<string | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [selectedUser, setSelectedUser] = useState<TenantRegistryUser | null>(null);

  const [invitations, setInvitations] = useState<IdentityInvitationSummary[] | null>(null);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  const [invitationsRefreshKey, setInvitationsRefreshKey] = useState(0);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteReason, setInviteReason] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitationActionBusy, setInvitationActionBusy] = useState<string | null>(null);

  const [pendingAction, setPendingAction] = useState<"suspend" | "resume" | "decommission" | null>(null);
  const [reason, setReason] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastActionStatus, setLastActionStatus] = useState<string | null>(null);

  const [engines, setEngines] = useState<TenantEngineEntitlementEntry[] | null>(null);
  const [enginesObservedAt, setEnginesObservedAt] = useState<string | null>(null);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  const [enginesRefreshKey, setEnginesRefreshKey] = useState(0);

  const [pendingEntitlement, setPendingEntitlement] = useState<{ engine: TenantEngineEntitlementEntry; enabled: boolean } | null>(null);
  const [entitlementReason, setEntitlementReason] = useState("");
  const [entitlementBusy, setEntitlementBusy] = useState(false);
  const [entitlementError, setEntitlementError] = useState<string | null>(null);

  const [recheckBusy, setRecheckBusy] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [recheckResult, setRecheckResult] = useState<ReconcileTenantResult | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    setInvitations(null);
    setInvitationsError(null);
    request(`/management/v1/tenants/${encodeURIComponent(tenant.id)}/identity-invitations`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setInvitationsError("Could not load pending invitations.");
          return;
        }
        setInvitations(body.invitations);
      })
      .catch(() => !cancelled && setInvitationsError("Could not load pending invitations."));
    return () => {
      cancelled = true;
    };
  }, [request, tenant.id, invitationsRefreshKey]);

  async function submitInvite() {
    if (inviteEmail.trim() === "" || inviteReason.trim() === "") {
      setInviteError("Email and reason are required.");
      return;
    }
    setInviteBusy(true);
    setInviteError(null);
    try {
      const res = await request(`/management/v1/tenants/${encodeURIComponent(tenant.id)}/identity-invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail, fullName: inviteName.trim() || undefined, roleKey: inviteRole,
          reason: inviteReason, idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setInviteError(body.message ?? body.error ?? "The invitation could not be sent.");
        return;
      }
      setShowInviteForm(false);
      setInviteEmail("");
      setInviteName("");
      setInviteReason("");
      setInvitationsRefreshKey((k) => k + 1);
    } catch {
      setInviteError("The invitation could not be sent.");
    } finally {
      setInviteBusy(false);
    }
  }

  async function runInvitationAction(invitationId: string, action: "resend" | "cancel") {
    setInvitationActionBusy(invitationId);
    try {
      await request(`/management/v1/tenants/${encodeURIComponent(tenant.id)}/identity-invitations/${encodeURIComponent(invitationId)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: `${action} via Governance UI`, idempotencyKey: crypto.randomUUID() }),
      });
      setInvitationsRefreshKey((k) => k + 1);
    } finally {
      setInvitationActionBusy(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setEngines(null);
    setEnginesError(null);
    request(`/management/v1/tenants/${encodeURIComponent(tenant.id)}/engines`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setEnginesError("Could not load this tenant's engine entitlements.");
          return;
        }
        setEngines(body.engines);
        setEnginesObservedAt(body.observedAt);
      })
      .catch(() => !cancelled && setEnginesError("Could not load this tenant's engine entitlements."));
    return () => {
      cancelled = true;
    };
  }, [request, tenant.id, enginesRefreshKey]);

  async function runEntitlementChange() {
    if (!pendingEntitlement) return;
    if (entitlementReason.trim() === "") {
      setEntitlementError("A reason is required.");
      return;
    }
    setEntitlementBusy(true);
    setEntitlementError(null);
    try {
      const res = await request(
        `/management/v1/tenants/${encodeURIComponent(tenant.id)}/engines/${encodeURIComponent(pendingEntitlement.engine.canonicalEngine)}/entitlement`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: pendingEntitlement.enabled,
            reason: entitlementReason,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      const body = (await res.json()) as EntitlementOperationBody & { error?: string; message?: string };
      if (!res.ok) {
        setEntitlementError(body.message ?? body.error ?? "The request failed.");
        return;
      }
      setPendingEntitlement(null);
      setEntitlementReason("");
      setEnginesRefreshKey((k) => k + 1);
    } catch {
      setEntitlementError("The request failed.");
    } finally {
      setEntitlementBusy(false);
    }
  }

  async function runRecheck() {
    setRecheckBusy(true);
    setRecheckError(null);
    try {
      const res = await request(`/management/v1/reconciliation/tenants/${encodeURIComponent(tenant.id)}/recheck`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      const body = (await res.json()) as ReconcileTenantResult & { error?: string; message?: string };
      if (!res.ok) {
        setRecheckError(body.message ?? body.error ?? "The recheck failed.");
        return;
      }
      setRecheckResult(body);
      if (body.projection.created || body.projection.observedRefreshed || body.resolvedOperations.length > 0) {
        await refetchTenant();
        onMutated();
      }
    } catch {
      setRecheckError("The recheck failed.");
    } finally {
      setRecheckBusy(false);
    }
  }

  async function refetchTenant() {
    try {
      const res = await request(`/management/v1/tenants/${encodeURIComponent(tenant.id)}`);
      if (res.ok) {
        const body = await res.json();
        setTenant(body.tenant);
      }
    } catch {
      // Best-effort refresh — the drawer already shows the last-known
      // state, and the parent list refresh (onMutated) is the primary
      // signal the mutation happened.
    }
  }

  async function runAction(action: "suspend" | "resume" | "decommission") {
    if (reason.trim() === "") {
      setActionError("A reason is required.");
      return;
    }
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await request(`/management/v1/tenants/${encodeURIComponent(tenant.id)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason, idempotencyKey: crypto.randomUUID() }),
      });
      const body = (await res.json()) as ManagementOperationBody & { error?: string; message?: string };
      if (!res.ok) {
        setActionError(body.message ?? body.error ?? "The request failed.");
        return;
      }
      setLastActionStatus(body.operation.status);
      await refetchTenant();
      onMutated();
      setPendingAction(null);
      setReason("");
    } catch {
      setActionError("The request failed.");
    } finally {
      setActionBusy(false);
    }
  }

  const canSuspend = operatorScopes.includes("tenants.suspend");
  const canResume = operatorScopes.includes("tenants.resume");
  const canDecommission = operatorScopes.includes("tenants.decommission");
  const canWriteEntitlement = operatorScopes.includes("engines.entitlement.write");
  const canReconcile = operatorScopes.includes("runtime.repair.request");
  const canReadIdentity = operatorScopes.includes("identity.read");
  const canInvite = operatorScopes.includes("identity.recovery");
  const platformState = tenant.platform_access_state;
  const isPlatformTenant = tenant.tenant_kind === "platform";
  const hasAnyLifecycleScope = canSuspend || canResume || canDecommission;

  return (
    <Drawer title={tenant.name} subtitle={tenant.slug} onClose={onClose}>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1rem" }}>
        <StatusBadge value={tenant.tenant_kind} />
      </div>

      {/* Two independently-labeled, independently-owned facts — never
          merged into one status pill (scoping doc §9). A tenant Billing
          has independently paused/cancelled must not read as a Governance
          suspension, and vice versa. */}
      <div className="card" style={{ marginBottom: "1rem", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <div>
          <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.25rem" }}>Platform access (Governance)</div>
          {platformState ? <StatusBadge value={platformState} /> : <span className="overlay-note">Not reported</span>}
        </div>
        <div>
          <div style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.25rem" }}>Commercial status (Billing)</div>
          <StatusBadge value={tenant.status} />
        </div>
      </div>

      {isPlatformTenant && (
        <p className="overlay-note" style={{ marginBottom: "1rem" }}>
          The reserved platform tenant has no lifecycle controls.
        </p>
      )}

      {!isPlatformTenant && platformState && hasAnyLifecycleScope && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3 className="text-subhead" style={{ marginBottom: "0.6rem" }}>
            Lifecycle actions
          </h3>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {platformState === "active" && canSuspend && (
              <button className="btn" onClick={() => setPendingAction("suspend")}>
                Suspend
              </button>
            )}
            {platformState === "suspended" && canResume && (
              <button className="btn btn-primary" onClick={() => setPendingAction("resume")}>
                Resume
              </button>
            )}
            {platformState !== "decommissioned" && canDecommission && (
              <button className="btn btn-danger" onClick={() => setPendingAction("decommission")}>
                Decommission
              </button>
            )}
          </div>
          {lastActionStatus && (
            <p style={{ marginTop: "0.6rem", fontSize: "0.85rem", display: "flex", gap: "0.4rem", alignItems: "center" }}>
              Last action: <StatusBadge value={lastActionStatus} />
            </p>
          )}
        </div>
      )}

      <h3 className="text-subhead" style={{ marginBottom: "0.6rem" }}>
        Overview
      </h3>
      <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem", fontSize: "0.88rem" }}>
        <div>
          <dt style={{ color: "var(--text-muted)" }}>Legacy bootstrap profile</dt>
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
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <tbody>
              <SkeletonTableRows columns={6} rows={2} />
            </tbody>
          </table>
        </div>
      )}
      {!usersError && users !== null && users.length === 0 && <EmptyState label="No users found for this tenant." icon="group" />}
      {!usersError && users !== null && users.length > 0 && (
        <div style={{ overflowX: "auto" }}>
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
              <tr
                key={u.id}
                onClick={canReadIdentity ? () => setSelectedUser(u) : undefined}
                style={canReadIdentity ? { cursor: "pointer" } : undefined}
              >
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
        </div>
      )}

      {canReadIdentity && selectedUser && (
        <IdentityPanel
          tenantId={tenant.id}
          userId={selectedUser.id}
          displayName={selectedUser.full_name || selectedUser.email}
          request={request}
          stepUp={stepUp}
          operatorId={operatorId}
          operatorScopes={operatorScopes}
          onClose={() => setSelectedUser(null)}
          onMutated={() => {
            onMutated();
            setInvitationsRefreshKey((k) => k + 1);
          }}
        />
      )}

      {canReadIdentity && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "1.5rem 0 0.6rem" }}>
            <h3 className="text-subhead" style={{ margin: 0 }}>
              Invitations
            </h3>
            {canInvite && (
              <button className="btn" style={{ fontSize: "0.82rem" }} onClick={() => setShowInviteForm(true)}>
                <Icon name="person_add" size="sm" /> Invite user
              </button>
            )}
          </div>
          {invitationsError && <ErrorState label={invitationsError} />}
          {!invitationsError && invitations === null && (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <tbody>
                  <SkeletonTableRows columns={5} rows={1} />
                </tbody>
              </table>
            </div>
          )}
          {!invitationsError && invitations !== null && invitations.length === 0 && (
            <EmptyState label="No pending invitations." icon="mail" />
          )}
          {!invitationsError && invitations !== null && invitations.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((inv) => (
                    <tr key={inv.invitationId}>
                      <td>{inv.email}</td>
                      <td>{inv.roleKey}</td>
                      <td>
                        <StatusBadge value={inv.status} />
                      </td>
                      <td>{formatDate(inv.expiresAt)}</td>
                      <td style={{ display: "flex", gap: "0.35rem" }}>
                        {canInvite && (
                          <>
                            <button
                              className="btn"
                              style={{ fontSize: "0.78rem" }}
                              disabled={invitationActionBusy === inv.invitationId}
                              onClick={() => runInvitationAction(inv.invitationId, "resend")}
                            >
                              Resend
                            </button>
                            <button
                              className="btn btn-danger"
                              style={{ fontSize: "0.78rem" }}
                              disabled={invitationActionBusy === inv.invitationId}
                              onClick={() => runInvitationAction(inv.invitationId, "cancel")}
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h3 className="text-subhead" style={{ margin: "1.5rem 0 0.6rem" }}>
        Engines &amp; Capabilities
      </h3>
      <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>
        {enginesObservedAt ? `Last observed ${formatDate(enginesObservedAt)}` : " "}
      </p>
      {enginesError && <ErrorState label={enginesError} />}
      {!enginesError && engines === null && (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <tbody>
              <SkeletonTableRows columns={4} rows={4} />
            </tbody>
          </table>
        </div>
      )}
      {!enginesError && engines !== null && (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Engine</th>
                <th>Desired entitlement</th>
                <th>Platform state</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {engines.map((e) => (
                <tr key={e.canonicalEngine}>
                  <td>
                    {e.label ?? e.canonicalEngine}
                    <div style={{ fontSize: "0.76rem", color: "var(--text-muted)", fontFamily: "monospace" }}>{e.canonicalEngine}</div>
                  </td>
                  <td>
                    <StatusBadge value={e.effectiveEnabled ? "active" : "disabled"} />
                    {!e.configured && (
                      <span className="overlay-note" style={{ marginLeft: "0.4rem" }}>
                        {e.defaultDeny ? "default: off" : "default: on"}
                      </span>
                    )}
                  </td>
                  <td>
                    <StatusBadge value={e.platformEngineState.state} />
                    {e.platformEngineState.reason && (
                      <div style={{ fontSize: "0.76rem", color: "var(--text-muted)" }}>{e.platformEngineState.reason}</div>
                    )}
                  </td>
                  <td>
                    {canWriteEntitlement && (
                      <button
                        className="btn"
                        style={{ fontSize: "0.8rem" }}
                        onClick={() => setPendingEntitlement({ engine: e, enabled: !e.effectiveEnabled })}
                      >
                        {e.effectiveEnabled ? "Disable" : "Enable"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canReconcile && !isPlatformTenant && (
        <div className="card" style={{ marginTop: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
            <h3 className="text-subhead" style={{ margin: 0 }}>
              Reconciliation
            </h3>
            <button className="btn" onClick={() => void runRecheck()} disabled={recheckBusy}>
              <Icon name="sync" size="sm" /> {recheckBusy ? "Rechecking…" : "Recheck"}
            </button>
          </div>
          <p className="overlay-note" style={{ margin: "0 0 0.6rem" }}>
            Creates a missing Governance projection from a fresh owner read, refreshes a stale observed state, and resolves any stuck
            operations for this tenant from their durable owner-side receipt — never resends a mutation.
          </p>
          {recheckError && <ErrorState label={recheckError} />}
          {recheckResult && (
            <div style={{ fontSize: "0.85rem" }}>
              {recheckResult.outcome !== "complete" && (
                <p style={{ margin: "0 0 0.4rem", color: "var(--warning-fg)" }}>
                  {recheckResult.outcome === "failed" ? "Recheck could not complete: " : "Recheck partially completed: "}
                  {[recheckResult.projectionError, recheckResult.stuckOperationsError].filter(Boolean).join(" · ")}
                </p>
              )}
              <p style={{ margin: "0 0 0.4rem" }}>
                Projection: {recheckResult.projectionError
                  ? "could not be checked"
                  : recheckResult.projection.created ? "created" : recheckResult.projection.observedRefreshed ? "refreshed" : "no drift found"}
              </p>
              {recheckResult.resolvedOperations.length > 0 && (
                <div style={{ marginBottom: "0.4rem" }}>
                  <strong>Resolved:</strong>
                  <ul style={{ margin: "0.2rem 0 0", paddingLeft: "1.2rem" }}>
                    {recheckResult.resolvedOperations.map((o) => (
                      <li key={o.operationId}>
                        {o.requestedAction}: {o.from} → {o.to}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {recheckResult.remainingDrift.length > 0 && (
                <div>
                  <strong>Still needs attention:</strong>
                  <ul style={{ margin: "0.2rem 0 0", paddingLeft: "1.2rem" }}>
                    {recheckResult.remainingDrift.map((d) => (
                      <li key={d.operationId}>
                        {d.requestedAction} ({d.class}): {d.note}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
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

      {pendingAction && (
        <ConfirmDialog
          title={`${LIFECYCLE_ACTION_LABEL[pendingAction]} ${tenant.name}?`}
          description={
            pendingAction === "decommission"
              ? "This disables platform access. It does not cancel billing. Tenant data and history are retained."
              : pendingAction === "suspend"
                ? "This disables platform access for every user in this tenant. It does not affect billing."
                : "This restores platform access. Billing/commercial status is unaffected."
          }
          confirmLabel={LIFECYCLE_ACTION_LABEL[pendingAction]}
          danger={pendingAction !== "resume"}
          busy={actionBusy}
          onCancel={() => {
            setPendingAction(null);
            setReason("");
            setActionError(null);
          }}
          onConfirm={() => runAction(pendingAction)}
        >
          <div className="field">
            <label>Reason</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Required" />
          </div>
          {actionError && <ErrorState label={actionError} />}
        </ConfirmDialog>
      )}

      {pendingEntitlement && (
        <ConfirmDialog
          title={`${pendingEntitlement.enabled ? "Enable" : "Disable"} ${pendingEntitlement.engine.label ?? pendingEntitlement.engine.canonicalEngine} for ${tenant.name}?`}
          description={
            pendingEntitlement.enabled
              ? "This sets the tenant's desired entitlement to enabled. Effective access still depends on platform engine state and any team-level restriction."
              : "This sets the tenant's desired entitlement to disabled. Every team/user in this tenant loses access to this engine on the next request."
          }
          confirmLabel={pendingEntitlement.enabled ? "Enable" : "Disable"}
          danger={!pendingEntitlement.enabled}
          busy={entitlementBusy}
          onCancel={() => {
            setPendingEntitlement(null);
            setEntitlementReason("");
            setEntitlementError(null);
          }}
          onConfirm={runEntitlementChange}
        >
          <div className="field">
            <label>Reason</label>
            <textarea value={entitlementReason} onChange={(e) => setEntitlementReason(e.target.value)} rows={2} placeholder="Required" />
          </div>
          {entitlementError && <ErrorState label={entitlementError} />}
        </ConfirmDialog>
      )}

      {showInviteForm && (
        <ConfirmDialog
          title={`Invite a user to ${tenant.name}`}
          confirmLabel="Send invitation"
          busy={inviteBusy}
          onCancel={() => {
            setShowInviteForm(false);
            setInviteError(null);
          }}
          onConfirm={submitInvite}
        >
          <div className="field">
            <label>Email</label>
            <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Full name</label>
            <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} />
          </div>
          <div className="field">
            <label>Role</label>
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <div className="field">
            <label>Reason</label>
            <textarea value={inviteReason} onChange={(e) => setInviteReason(e.target.value)} rows={2} placeholder="Required" />
          </div>
          {inviteError && <ErrorState label={inviteError} />}
        </ConfirmDialog>
      )}
    </Drawer>
  );
}

type AccountType = "demo" | "live";

interface WizardState {
  name: string;
  slug: string;
  industry: string;
  country: string;
  timezone: string;
  plan: string;
  accountType: AccountType;
  trialDays: string;
  sendInvite: boolean;
  adminName: string;
  adminEmail: string;
  reason: string;
}

const INITIAL_WIZARD_STATE: WizardState = {
  name: "",
  slug: "",
  industry: "",
  country: "IN",
  timezone: "Asia/Kolkata",
  plan: "",
  accountType: "live",
  trialDays: "14",
  sendInvite: true,
  adminName: "",
  adminEmail: "",
  reason: "",
};

const WIZARD_STEPS = ["Organisation", "Provisioning bootstrap", "Initial administrator", "Review", "Execution"] as const;

function CommissionWizard({
  request,
  onClose,
  onCommissioned,
}: {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  onClose: () => void;
  onCommissioned: () => void;
}) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(INITIAL_WIZARD_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: string; tenantId: string; warnings: ManagementOperationWarning[] } | null>(null);

  function update<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  const canProceedFromOrg = state.name.trim() !== "";
  const canProceedFromProvisioning =
    state.plan.trim() !== "" && (state.accountType === "live" || (state.trialDays.trim() !== "" && Number(state.trialDays) >= 0));
  const canProceedFromAdmin = state.sendInvite ? state.adminName.trim() !== "" && state.adminEmail.trim() !== "" : true;
  const canExecute = state.reason.trim() !== "";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const hasAdminDetails = state.adminName.trim() !== "" && state.adminEmail.trim() !== "";
      const res = await request("/management/v1/tenants/commission", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          name: state.name,
          slug: state.slug.trim() || undefined,
          plan: state.plan,
          industry: state.industry.trim() || undefined,
          country: state.country.trim() || undefined,
          timezone: state.timezone.trim() || undefined,
          accountType: state.accountType,
          trialDays: state.accountType === "demo" ? Number(state.trialDays) : undefined,
          sendInvite: state.sendInvite,
          initialAdmin: state.sendInvite || hasAdminDetails ? { name: state.adminName, email: state.adminEmail } : undefined,
          reason: state.reason,
        }),
      });
      const body = (await res.json()) as ManagementOperationBody & { error?: string; message?: string };
      if (!res.ok) {
        setError(body.message ?? body.error ?? "Commission failed.");
        return;
      }
      setResult({
        status: body.operation.status,
        tenantId: body.operation.result?.tenantId ?? "",
        warnings: body.operation.result?.warnings ?? [],
      });
      setStep(4);
      onCommissioned();
    } catch {
      setError("Commission failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="confirm-backdrop" onClick={result ? onClose : undefined}>
      <div
        className="confirm-dialog"
        style={{ maxWidth: "560px", width: "100%" }}
        role="dialog"
        aria-modal="true"
        aria-label="Commission tenant"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-subhead">Commission tenant</h2>
        <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "0.3rem 0 1rem" }}>
          Step {step + 1} of {WIZARD_STEPS.length}: {WIZARD_STEPS[step]}
        </p>

        {step === 0 && (
          <>
            <div className="field">
              <label>Name</label>
              <input value={state.name} onChange={(e) => update("name", e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label>Slug</label>
              <input value={state.slug} onChange={(e) => update("slug", e.target.value)} placeholder="Auto-generated from name if left blank" />
            </div>
            <div className="field">
              <label>Industry</label>
              <input value={state.industry} onChange={(e) => update("industry", e.target.value)} />
            </div>
            <div className="field">
              <label>Country</label>
              <input value={state.country} onChange={(e) => update("country", e.target.value)} />
            </div>
            <div className="field">
              <label>Timezone</label>
              <input value={state.timezone} onChange={(e) => update("timezone", e.target.value)} />
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div className="field">
              <label>Legacy bootstrap profile</label>
              <input value={state.plan} onChange={(e) => update("plan", e.target.value)} />
              <p className="field-hint">
                Technical compatibility input for the current owner-side provisioning primitive. This is not a commercial/pricing tier; contracted engines are commissioned separately through engine entitlements.
              </p>
            </div>
            <div className="field">
              <label>Provisioning mode</label>
              <select value={state.accountType} onChange={(e) => update("accountType", e.target.value as AccountType)}>
                <option value="live">Live customer</option>
                <option value="demo">Synthetic / test only</option>
              </select>
            </div>
            {state.accountType === "demo" && (
              <div className="field">
                <label>Test expiry days</label>
                <input type="number" min={0} value={state.trialDays} onChange={(e) => update("trialDays", e.target.value)} />
                <p className="field-hint">Synthetic/test commissioning only. 0 means no expiry.</p>
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div className="field">
              <label>
                <input type="checkbox" checked={state.sendInvite} onChange={(e) => update("sendInvite", e.target.checked)} /> Send invite now
              </label>
            </div>
            {!state.sendInvite && (
              <p className="field-hint" style={{ marginBottom: "0.75rem" }}>
                The admin can be invited later. Their details below are optional and, if supplied, are recorded now for that later step.
              </p>
            )}
            <div className="field">
              <label>Admin name{state.sendInvite ? "" : " (optional)"}</label>
              <input value={state.adminName} onChange={(e) => update("adminName", e.target.value)} />
            </div>
            <div className="field">
              <label>Admin email{state.sendInvite ? "" : " (optional)"}</label>
              <input value={state.adminEmail} onChange={(e) => update("adminEmail", e.target.value)} />
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <dl style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>
              <dt style={{ color: "var(--text-muted)" }}>Name</dt>
              <dd style={{ margin: "0 0 0.5rem" }}>{state.name}</dd>
              <dt style={{ color: "var(--text-muted)" }}>Legacy bootstrap profile</dt>
              <dd style={{ margin: "0 0 0.5rem" }}>
                {state.plan} ({state.accountType})
              </dd>
              {state.accountType === "demo" && (
                <>
                  <dt style={{ color: "var(--text-muted)" }}>Synthetic/test expiry</dt>
                  <dd style={{ margin: "0 0 0.5rem" }}>{Number(state.trialDays) === 0 ? "Indefinite (no expiry)" : `${state.trialDays} days`}</dd>
                </>
              )}
              <dt style={{ color: "var(--text-muted)" }}>Administrator</dt>
              <dd style={{ margin: "0 0 0.5rem" }}>
                {state.adminName || state.adminEmail ? `${state.adminName} <${state.adminEmail}>` : "None supplied"}
                {" — "}
                {state.sendInvite ? "invited immediately" : "pending (invite later)"}
              </dd>
            </dl>
            <div className="field">
              <label>Reason</label>
              <textarea value={state.reason} onChange={(e) => update("reason", e.target.value)} rows={2} placeholder="Required" />
            </div>
            {error && <ErrorState label={error} />}
          </>
        )}

        {step === 4 && result && (
          <div>
            <p style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              Commission <StatusBadge value={result.status} />
            </p>
            {result.tenantId && (
              <p style={{ fontFamily: "monospace", fontSize: "0.8rem", color: "var(--text-muted)" }}>Tenant ID: {result.tenantId}</p>
            )}
            {result.warnings.length > 0 && (
              <>
                <p className="field-hint" style={{ marginTop: "0.75rem" }}>Warnings:</p>
                <ul style={{ fontSize: "0.85rem", paddingLeft: "1.2rem" }}>
                  {result.warnings.map((w, i) => (
                    <li key={i}>
                      <strong>{w.stage}:</strong> {w.message}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="confirm-dialog-actions">
          {step < 4 && (
            <button className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          )}
          {step > 0 && step < 4 && (
            <button className="btn" onClick={() => setStep((s) => s - 1)} disabled={busy}>
              Back
            </button>
          )}
          {step < 3 && (
            <button
              className="btn btn-primary"
              disabled={(step === 0 && !canProceedFromOrg) || (step === 1 && !canProceedFromProvisioning) || (step === 2 && !canProceedFromAdmin)}
              onClick={() => setStep((s) => s + 1)}
            >
              Next
            </button>
          )}
          {step === 3 && (
            <button className="btn btn-primary" disabled={!canExecute || busy} onClick={submit}>
              {busy ? "Commissioning…" : "Commission"}
            </button>
          )}
          {step === 4 && (
            <button className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
