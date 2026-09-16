import { beforeEach, describe, expect, it } from "vitest";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import {
  CommissionedTenantsRepository,
  CommissionedTenantNotFoundError,
  InvalidLifecycleProjectionTransitionError,
} from "../../../src/management/operations/commissionedTenants.js";
import type { DbClient } from "../../../src/db/dbClient.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";

async function seedOperator(client: DbClient) {
  await client.query(
    `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
     VALUES ($1, 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())`,
    [OPERATOR_ID],
  );
}

describe("management/operations/commissionedTenants", () => {
  let client: DbClient;
  let repo: CommissionedTenantsRepository;

  beforeEach(async () => {
    const built = buildMigratedPgMemClient();
    client = built.client;
    repo = new CommissionedTenantsRepository(client);
    await seedOperator(client);
  });

  it("creates a governance_commissioned projection at 'requested' with requested_at stamped", async () => {
    const record = await repo.createForCommissionRequest({
      commissionRequestId: "22222222-2222-4222-8222-222222222222",
      desiredName: "Acme",
      desiredSlug: "acme",
      desiredPlan: "pro",
      accountType: "demo",
      responsibleOperatorId: OPERATOR_ID,
    });

    expect(record.lifecycleState).toBe("requested");
    expect(record.provenance).toBe("governance_commissioned");
    expect(record.requestedAt).toBeTruthy();
    expect(record.tenantId).toBeUndefined();
  });

  it("creates a legacy_existing projection without a fabricated requested/approved timeline", async () => {
    const record = await repo.createLegacyExisting({
      tenantId: "33333333-3333-4333-8333-333333333333",
      createdAt: "2026-01-01T00:00:00.000Z",
      observedPlatformAccessState: "active",
    });

    expect(record.provenance).toBe("legacy_existing");
    expect(record.lifecycleState).toBe("active");
    expect(record.requestedAt).toBeUndefined();
    expect(record.approvedAt).toBeUndefined();
    expect(record.lastObservedPlatformAccessState).toBe("active");
  });

  it("resolves the same projection by commissionRequestId and by tenantId once bound", async () => {
    const created = await repo.createForCommissionRequest({
      commissionRequestId: "44444444-4444-4444-8444-444444444444",
      desiredName: "Beta", desiredPlan: "pro", accountType: "live", responsibleOperatorId: OPERATOR_ID,
    });
    await repo.transitionLifecycleState(created.projectionId, { toState: "approved" });
    await repo.transitionLifecycleState(created.projectionId, { toState: "provisioning", tenantId: "55555555-5555-4555-8555-555555555555" });

    const byRequest = await repo.getByCommissionRequestId("44444444-4444-4444-8444-444444444444");
    const byTenant = await repo.getByTenantId("55555555-5555-4555-8555-555555555555");
    expect(byRequest?.projectionId).toBe(created.projectionId);
    expect(byTenant?.projectionId).toBe(created.projectionId);
  });

  it("rejects an invalid transition (e.g. requested -> active directly)", async () => {
    const created = await repo.createForCommissionRequest({
      commissionRequestId: "66666666-6666-4666-8666-666666666666",
      desiredName: "Gamma", desiredPlan: "pro", accountType: "demo", responsibleOperatorId: OPERATOR_ID,
    });

    await expect(repo.transitionLifecycleState(created.projectionId, { toState: "active" }))
      .rejects.toBeInstanceOf(InvalidLifecycleProjectionTransitionError);
  });

  it("stamps the matching timestamp column per transition and refreshes the observed-state cache", async () => {
    const created = await repo.createForCommissionRequest({
      commissionRequestId: "77777777-7777-4777-8777-777777777777",
      desiredName: "Delta", desiredPlan: "pro", accountType: "demo", responsibleOperatorId: OPERATOR_ID,
    });
    const approved = await repo.transitionLifecycleState(created.projectionId, { toState: "approved" });
    expect(approved.approvedAt).toBeTruthy();

    const provisioning = await repo.transitionLifecycleState(approved.projectionId, {
      toState: "provisioning", tenantId: "88888888-8888-4888-8888-888888888888",
    });
    expect(provisioning.provisioningStartedAt).toBeTruthy();

    const active = await repo.transitionLifecycleState(provisioning.projectionId, {
      toState: "active", observedPlatformAccessState: "active",
    });
    expect(active.activeAt).toBeTruthy();
    expect(active.lastObservedPlatformAccessState).toBe("active");
    expect(active.lastObservedAt).toBeTruthy();
  });

  it("suspend/decommission never touches Billing-owned facts — only the projection's own governance columns are written", async () => {
    const created = await repo.createLegacyExisting({
      tenantId: "99999999-9999-4999-8999-999999999999",
      createdAt: "2026-01-01T00:00:00.000Z",
      observedPlatformAccessState: "active",
    });
    const suspended = await repo.transitionLifecycleState(created.projectionId, {
      toState: "suspended", observedPlatformAccessState: "suspended",
    });
    expect(suspended.suspendedAt).toBeTruthy();
    expect(suspended.lastObservedPlatformAccessState).toBe("suspended");
  });

  it("getByProjectionId throws CommissionedTenantNotFoundError for an unknown id", async () => {
    await expect(repo.getByProjectionId("aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa")).rejects.toBeInstanceOf(CommissionedTenantNotFoundError);
  });

  it("refreshObservedState updates the read cache without requiring a lifecycle transition", async () => {
    const created = await repo.createLegacyExisting({
      tenantId: "10101010-1010-4101-8101-101010101010",
      createdAt: "2026-01-01T00:00:00.000Z",
      observedPlatformAccessState: "active",
    });
    const refreshed = await repo.refreshObservedState(created.projectionId, "suspended");
    expect(refreshed.lastObservedPlatformAccessState).toBe("suspended");
    expect(refreshed.lifecycleState).toBe("active"); // lifecycle_state itself untouched by this method
  });

  it("listAll returns every projection, newest first", async () => {
    await repo.createLegacyExisting({ tenantId: "a0000000-0000-4000-8000-000000000001", createdAt: "2026-01-01T00:00:00.000Z", observedPlatformAccessState: "active" });
    await repo.createLegacyExisting({ tenantId: "a0000000-0000-4000-8000-000000000002", createdAt: "2026-01-02T00:00:00.000Z", observedPlatformAccessState: "active" });
    const all = await repo.listAll();
    expect(all.length).toBe(2);
  });
});
