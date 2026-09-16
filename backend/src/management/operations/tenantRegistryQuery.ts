import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError } from "./engineStateOperation.js";

// 1A.7 — the tenant registry read model. Deliberately NOT an "operation" in
// 1A.5's ledger sense: this is R0 (read-only) per 1A.5's own risk
// classification, so there is no idempotency key, no
// createOrReplayOperation() call, and no management_operations row — the
// ledger exists to make mutations safe to retry and auditable as durable
// outcomes, neither of which a read needs. Authn/authz denial is still
// audited via the existing requireManagementApiAuth/requireScope perimeter
// (deps.auditSink's authz.denied events), same as every other route.
//
// Shape otherwise mirrors engineStateOperation.ts's "mint one assertion,
// call one Infrakinetic route" pattern exactly, minus the idempotency/
// verify-after-mutation steps that don't apply to a pure read.
//
// See docs/1A.7_scoping.md for the ground-truthing that established: no
// reusable list-tenants primitive existed anywhere before this phase, the
// exact sanitized field list (an architectural boundary, not a temporary
// pass), and why the reserved platform-kind tenant is included, not
// filtered.

export class UnknownTenantError extends Error {
  constructor(readonly identifier: string) {
    super(`'${identifier}' does not resolve to a known tenant.`);
    this.name = "UnknownTenantError";
  }
}

export interface TenantRegistryQueryDeps {
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface TenantRegistryQueryParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

// Real column set, per docs/1A.7_scoping.md's locked, explicit allow-list —
// this type exists so a future accidental widening on the Infrakinetic side
// still gets caught by TypeScript here rather than silently passed through.
export interface TenantRegistryEntry {
  id: string;
  name: string;
  slug: string;
  tenant_kind: "customer" | "platform";
  plan: string;
  status: string;
  // Governance-owned platform-access fact (1A.8.1/1A.8.2), independent of
  // the Billing-owned `status` above — surfaced by Infrakinetic's tenant
  // registry read starting 1A.8.3/1A.8.5. Optional because it is a newer
  // field than this interface's other columns; UI code must not assume a
  // stale Infrakinetic deploy always sends it.
  platform_access_state?: "active" | "suspended" | "decommissioned";
  trial_ends_at: string | null;
  industry: string | null;
  country: string;
  timezone: string;
  seat_limit: number | null;
  storage_limit_mb: number | null;
  created_at: string;
  updated_at: string;
}

interface FreshnessEnvelope {
  observedAt: string;
  source: string;
  freshness: string;
}

// Real column set for a tenant's user inventory, mirroring
// TenantRegistryEntry's role: catches an accidental widening on the
// Infrakinetic side here too. No MFA field — Cognito-side only, not
// mirrored into Infrakinetic's own app_users table, so it is not
// "safely available" from this existing read primitive.
export interface TenantRegistryUser {
  id: string;
  full_name: string;
  email: string;
  role_key: string;
  status: string;
  created_at: string;
  last_active_at: string | null;
}

export type TenantRegistryListResult = FreshnessEnvelope & { tenants: TenantRegistryEntry[] };
export type TenantRegistryDetailResult = FreshnessEnvelope & { tenant: TenantRegistryEntry };
export type TenantRegistryUsersResult = FreshnessEnvelope & { tenantId: string; users: TenantRegistryUser[] };

// No engine is involved in a tenant-registry read; target_engine is a
// required claim on every management assertion (managementAssertionIssuer.ts),
// so this fixed, honest sentinel is used instead of a real engine key —
// Infrakinetic's GET /tenants routes don't check target_engine (only the
// engine-state PUT mutation route does), matching how GET /engines/catalog
// is unchecked on that axis too.
const TENANT_REGISTRY_TARGET = "tenant-registry";

async function mintAndCall(
  deps: TenantRegistryQueryDeps,
  params: TenantRegistryQueryParams,
  requestedAction: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["tenants.read"],
    targetEngine: TENANT_REGISTRY_TARGET,
    requestedAction,
    correlationId,
  });
  return callInfrakineticManagementApi({
    baseUrl: deps.infrakineticBaseUrl,
    path,
    assertion,
    method: "GET",
    correlationId,
    fetchImpl: deps.fetchImpl,
  });
}

export async function listTenantRegistry(
  deps: TenantRegistryQueryDeps,
  params: TenantRegistryQueryParams,
): Promise<TenantRegistryListResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants`;
  const result = await mintAndCall(deps, params, "tenants.registry.read", path);
  if (result.status !== 200) {
    throw new UnexpectedManagementApiResponseError(result.status, path);
  }
  return result.body as TenantRegistryListResult;
}

export async function getTenantRegistryEntry(
  deps: TenantRegistryQueryDeps,
  params: TenantRegistryQueryParams & { identifier: string },
): Promise<TenantRegistryDetailResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.identifier)}`;
  const result = await mintAndCall(deps, params, "tenants.registry.detail.read", path);
  if (result.status === 404) {
    throw new UnknownTenantError(params.identifier);
  }
  if (result.status !== 200) {
    throw new UnexpectedManagementApiResponseError(result.status, path);
  }
  return result.body as TenantRegistryDetailResult;
}

export async function getTenantRegistryUsers(
  deps: TenantRegistryQueryDeps,
  params: TenantRegistryQueryParams & { identifier: string },
): Promise<TenantRegistryUsersResult> {
  const path = `${MANAGEMENT_V1_PREFIX}/tenants/${encodeURIComponent(params.identifier)}/users`;
  const result = await mintAndCall(deps, params, "tenants.registry.users.read", path);
  if (result.status === 404) {
    throw new UnknownTenantError(params.identifier);
  }
  if (result.status !== 200) {
    throw new UnexpectedManagementApiResponseError(result.status, path);
  }
  return result.body as TenantRegistryUsersResult;
}
