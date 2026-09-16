import { randomUUID } from "node:crypto";

import type { DbClient } from "../../db/dbClient.js";
import {
  isValidTenantLifecycleTransition,
  type TenantLifecycleState,
  type TenantLifecycleProvenance,
} from "./tenantLifecycle.js";

// Phase 1A.8.4 — Governance's own desired-state projection
// (governance.commissioned_tenants, migrations 0005/0006). Control/fleet
// metadata only — never tenant business data, billing state, admin PII, or
// credentials (see 0006's own header and the scoping doc §3.8/§4.12).
//
// last_observed_platform_access_state is a denormalized read cache of
// Infrakinetic's own tenants.platform_access_state, refreshed by the
// orchestration layer after every mutation and by any subsequent
// reconciliation read — never itself the source of truth. A fresh
// GET /management/v1/tenants/:identifier read always is.

export class CommissionedTenantNotFoundError extends Error {
  constructor(readonly identifier: string) {
    super(`No commissioned-tenant projection found for '${identifier}'.`);
    this.name = "CommissionedTenantNotFoundError";
  }
}

export class InvalidLifecycleProjectionTransitionError extends Error {
  constructor(from: TenantLifecycleState, to: TenantLifecycleState) {
    super(`Cannot transition the commissioned-tenant projection from '${from}' to '${to}'.`);
    this.name = "InvalidLifecycleProjectionTransitionError";
  }
}

export interface CommissionedTenantRecord {
  projectionId: string;
  tenantId?: string;
  commissionRequestId?: string;
  lifecycleState: TenantLifecycleState;
  provenance: TenantLifecycleProvenance;
  lastOperationId?: string;
  desiredName?: string;
  desiredSlug?: string;
  desiredPlan?: string;
  accountType?: "demo" | "live";
  lastObservedPlatformAccessState?: "active" | "suspended" | "decommissioned";
  lastObservedAt?: string;
  responsibleOperatorId?: string;
  requestedAt?: string;
  approvedAt?: string;
  provisioningStartedAt?: string;
  activeAt?: string;
  suspendedAt?: string;
  decommissionRequestedAt?: string;
  decommissionedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectionRow {
  projection_id: string;
  tenant_id: string | null;
  commission_request_id: string | null;
  lifecycle_state: string;
  provenance: string;
  last_operation_id: string | null;
  desired_name: string | null;
  desired_slug: string | null;
  desired_plan: string | null;
  account_type: string | null;
  last_observed_platform_access_state: string | null;
  last_observed_at: string | null;
  responsible_operator_id: string | null;
  requested_at: string | null;
  approved_at: string | null;
  provisioning_started_at: string | null;
  active_at: string | null;
  suspended_at: string | null;
  decommission_requested_at: string | null;
  decommissioned_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ProjectionRow): CommissionedTenantRecord {
  return {
    projectionId: row.projection_id,
    tenantId: row.tenant_id ?? undefined,
    commissionRequestId: row.commission_request_id ?? undefined,
    lifecycleState: row.lifecycle_state as TenantLifecycleState,
    provenance: row.provenance as TenantLifecycleProvenance,
    lastOperationId: row.last_operation_id ?? undefined,
    desiredName: row.desired_name ?? undefined,
    desiredSlug: row.desired_slug ?? undefined,
    desiredPlan: row.desired_plan ?? undefined,
    accountType: (row.account_type as "demo" | "live" | null) ?? undefined,
    lastObservedPlatformAccessState: (row.last_observed_platform_access_state as "active" | "suspended" | "decommissioned" | null) ?? undefined,
    lastObservedAt: row.last_observed_at ?? undefined,
    responsibleOperatorId: row.responsible_operator_id ?? undefined,
    requestedAt: row.requested_at ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    provisioningStartedAt: row.provisioning_started_at ?? undefined,
    activeAt: row.active_at ?? undefined,
    suspendedAt: row.suspended_at ?? undefined,
    decommissionRequestedAt: row.decommission_requested_at ?? undefined,
    decommissionedAt: row.decommissioned_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Which timestamp column, if any, a transition into a given state stamps.
// 'requested'/'draft' have no dedicated column (created_at already covers
// project inception); every other real transition has one, per 0006's
// column set.
const STATE_TIMESTAMP_COLUMN: Partial<Record<TenantLifecycleState, string>> = {
  requested: "requested_at",
  approved: "approved_at",
  provisioning: "provisioning_started_at",
  active: "active_at",
  suspended: "suspended_at",
  decommission_requested: "decommission_requested_at",
  decommissioned: "decommissioned_at",
};

export interface CreateForCommissionRequestParams {
  commissionRequestId: string;
  desiredName: string;
  desiredSlug?: string;
  desiredPlan: string;
  accountType: "demo" | "live";
  responsibleOperatorId: string;
}

export interface TransitionProjectionParams {
  toState: TenantLifecycleState;
  tenantId?: string;
  lastOperationId?: string;
  observedPlatformAccessState?: "active" | "suspended" | "decommissioned";
  observedAt?: string;
}

export class CommissionedTenantsRepository {
  constructor(private readonly db: DbClient) {}

  // A commission request starts life as a real projection row at 'draft',
  // immediately transitioned to 'requested' — the operator has already
  // supplied every field the wizard needs by the time this orchestration
  // call fires; there is no separate "save as draft" product surface in
  // this slice. commission_request_id is stable across repair attempts
  // (§3.13) — a repair of the same commission never creates a second row.
  async createForCommissionRequest(params: CreateForCommissionRequestParams): Promise<CommissionedTenantRecord> {
    const projectionId = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.query<ProjectionRow>(
      `INSERT INTO governance.commissioned_tenants
         (projection_id, commission_request_id, lifecycle_state, provenance,
          desired_name, desired_slug, desired_plan, account_type,
          responsible_operator_id, requested_at, created_at, updated_at)
       VALUES ($1, $2, 'requested', 'governance_commissioned', $3, $4, $5, $6, $7, $8, $8, $8)
       RETURNING *`,
      [projectionId, params.commissionRequestId, params.desiredName, params.desiredSlug ?? null,
        params.desiredPlan, params.accountType, params.responsibleOperatorId, now],
    );
    return mapRow(result.rows[0]);
  }

  // Backfill entry point for a tenant that already existed before Governance
  // ever commissioned anything (1A.8.1's migration backfill; exposed here
  // too for any future ad hoc reconciliation of a tenant Governance has
  // never seen). Never fabricates a requested/approved/provisioning
  // timeline — see 0006's own header and scoping doc §3.15.
  async createLegacyExisting(params: {
    tenantId: string;
    createdAt: string;
    observedPlatformAccessState: "active" | "suspended" | "decommissioned";
  }): Promise<CommissionedTenantRecord> {
    const projectionId = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.query<ProjectionRow>(
      `INSERT INTO governance.commissioned_tenants
         (projection_id, tenant_id, lifecycle_state, provenance,
          last_observed_platform_access_state, last_observed_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'legacy_existing', $4, $5, $6, $5)
       RETURNING *`,
      [
        projectionId, params.tenantId,
        params.observedPlatformAccessState === "decommissioned" ? "decommissioned"
          : params.observedPlatformAccessState === "suspended" ? "suspended" : "active",
        params.observedPlatformAccessState, now, params.createdAt,
      ],
    );
    return mapRow(result.rows[0]);
  }

  async getByCommissionRequestId(commissionRequestId: string): Promise<CommissionedTenantRecord | undefined> {
    const result = await this.db.query<ProjectionRow>(
      `SELECT * FROM governance.commissioned_tenants WHERE commission_request_id = $1`,
      [commissionRequestId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async getByTenantId(tenantId: string): Promise<CommissionedTenantRecord | undefined> {
    const result = await this.db.query<ProjectionRow>(
      `SELECT * FROM governance.commissioned_tenants WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async getByProjectionId(projectionId: string): Promise<CommissionedTenantRecord> {
    const result = await this.db.query<ProjectionRow>(
      `SELECT * FROM governance.commissioned_tenants WHERE projection_id = $1`,
      [projectionId],
    );
    if (!result.rows[0]) throw new CommissionedTenantNotFoundError(projectionId);
    return mapRow(result.rows[0]);
  }

  async listAll(): Promise<CommissionedTenantRecord[]> {
    const result = await this.db.query<ProjectionRow>(
      `SELECT * FROM governance.commissioned_tenants ORDER BY created_at DESC`,
    );
    return result.rows.map(mapRow);
  }

  // Validates against the SAME locked state machine tenantLifecycle.ts
  // exports (never a second, divergent transition table), stamps the
  // matching per-state timestamp column, and refreshes the
  // Infrakinetic-observed-fact read cache in one statement.
  async transitionLifecycleState(projectionId: string, params: TransitionProjectionParams): Promise<CommissionedTenantRecord> {
    const current = await this.getByProjectionId(projectionId);
    // A same-state call is always permitted as a field-only refresh (e.g.
    // binding tenantId once Infrakinetic reports partially_completed while
    // the projection is already sitting at 'provisioning') — the locked
    // ALLOWED_TRANSITIONS table intentionally has no self-loops for real
    // forward progress, which this identity case is not.
    if (current.lifecycleState !== params.toState && !isValidTenantLifecycleTransition(current.lifecycleState, params.toState)) {
      throw new InvalidLifecycleProjectionTransitionError(current.lifecycleState, params.toState);
    }

    const isRealForwardProgress = current.lifecycleState !== params.toState;
    const timestampColumn = isRealForwardProgress ? STATE_TIMESTAMP_COLUMN[params.toState] : undefined;
    const setClauses = ["lifecycle_state = $2", "updated_at = now()"];
    const values: unknown[] = [projectionId, params.toState];

    if (timestampColumn) {
      values.push(new Date().toISOString());
      setClauses.push(`${timestampColumn} = $${values.length}`);
    }
    if (params.tenantId !== undefined) {
      values.push(params.tenantId);
      setClauses.push(`tenant_id = $${values.length}`);
    }
    if (params.lastOperationId !== undefined) {
      values.push(params.lastOperationId);
      setClauses.push(`last_operation_id = $${values.length}`);
    }
    if (params.observedPlatformAccessState !== undefined) {
      values.push(params.observedPlatformAccessState);
      setClauses.push(`last_observed_platform_access_state = $${values.length}`);
      values.push(params.observedAt ?? new Date().toISOString());
      setClauses.push(`last_observed_at = $${values.length}`);
    }

    const result = await this.db.query<ProjectionRow>(
      `UPDATE governance.commissioned_tenants SET ${setClauses.join(", ")} WHERE projection_id = $1 RETURNING *`,
      values,
    );
    return mapRow(result.rows[0]);
  }

  // Refreshes only the observed-fact read cache, without a lifecycle
  // transition — used after suspend/resume/decommission, whose lifecycle
  // projection transition (active<->suspended, ->decommission_requested->
  // decommissioning->decommissioned) is driven separately by the caller,
  // but whose Infrakinetic-observed platform_access_state should always be
  // refreshed from the same fresh post-mutation read.
  async refreshObservedState(
    projectionId: string,
    observedPlatformAccessState: "active" | "suspended" | "decommissioned",
    observedAt: string = new Date().toISOString(),
  ): Promise<CommissionedTenantRecord> {
    const result = await this.db.query<ProjectionRow>(
      `UPDATE governance.commissioned_tenants
       SET last_observed_platform_access_state = $2, last_observed_at = $3, updated_at = now()
       WHERE projection_id = $1
       RETURNING *`,
      [projectionId, observedPlatformAccessState, observedAt],
    );
    if (!result.rows[0]) throw new CommissionedTenantNotFoundError(projectionId);
    return mapRow(result.rows[0]);
  }
}
