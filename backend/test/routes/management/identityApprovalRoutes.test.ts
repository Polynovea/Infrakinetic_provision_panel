import request from "supertest";
import { describe, expect, it } from "vitest";

import { buildTestApp } from "../../helpers/testApp.js";
import { activeAdminOperator } from "../../helpers/operators.js";
import { buildTestIdentityProvider } from "../../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken } from "../../helpers/testToken.js";
import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import { CommissionedTenantsRepository } from "../../../src/management/operations/commissionedTenants.js";
import { ManagementApprovalStore } from "../../../src/management/operations/managementApprovalStore.js";

// 1A.12.5 — R3 identity route wiring: request requires fresh step-up (403
// STEP_UP_REQUIRED without it), and a maker cannot approve their own
// request even through the HTTP layer.

const TENANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("POST /management/v1/tenants/:tenantId/identities/:userId/force-reset/request", () => {
  it("403s with STEP_UP_REQUIRED when the operator has not freshly stepped up", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const op = activeAdminOperator({ roles: ["security_operator"], scopes: ["identity.recovery"] });
    const { app } = buildTestApp(provider, [op]);
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    const res = await request(app)
      .post(`/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/force-reset/request`)
      .set("authorization", `Bearer ${token}`)
      .send({ reason: "account takeover suspected" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("STEP_UP_REQUIRED");
  });

  it("missing identity.recovery scope -> 403 before step-up is even checked", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const op = activeAdminOperator({ roles: ["platform_viewer"], scopes: ["identity.read"] });
    const { app } = buildTestApp(provider, [op]);
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    const res = await request(app)
      .post(`/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/force-reset/request`)
      .set("authorization", `Bearer ${token}`)
      .send({ reason: "account takeover suspected" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("SCOPE_REQUIRED");
  });
});

describe("POST /management/v1/approvals/:approvalId/approve — self-approval", () => {
  it("the maker cannot approve their own request, even with the right scope", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const op = activeAdminOperator({ roles: ["security_operator"], scopes: ["identity.recovery", "identity.read"] });
    // governance.management_approvals.maker_operator_id has a real FK onto
    // governance.operators — the in-memory auth-layer operator fixture is
    // separate from this pg-mem client, so the same operator row must exist
    // here too (same pattern as tenantLifecycleRoutes.test.ts).
    const client = buildMigratedPgMemClient().client;
    await client.query(
      `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
       VALUES ($1, $2, $3, 'Test Operator', 'active', true, now(), now())`,
      [op.operatorId, op.cognitoSub, op.email],
    );
    const { app, sessionStore } = buildTestApp(provider, [op], {
      ledger: new ManagementOperationLedger(client),
      commissionedTenants: new CommissionedTenantsRepository(client),
      approvals: new ManagementApprovalStore(client),
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    // Record a fresh step-up directly on this operator's session so the
    // /request route's requireStepUp gate passes — this test is about the
    // self-approval rule, not step-up freshness.
    const jti = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).jti as string;
    await sessionStore.recordStepUp(jti, { verifiedAt: new Date().toISOString(), method: "cognito-fresh-reauth" });

    const requestRes = await request(app)
      .post(`/management/v1/tenants/${TENANT_ID}/identities/${USER_ID}/force-reset/request`)
      .set("authorization", `Bearer ${token}`)
      .send({ reason: "account takeover suspected" });
    expect(requestRes.status).toBe(201);
    const approvalId = requestRes.body.approval.approvalId as string;

    const approveRes = await request(app)
      .post(`/management/v1/approvals/${approvalId}/approve`)
      .set("authorization", `Bearer ${token}`);

    expect(approveRes.status).toBe(403);
    expect(approveRes.body.error).toBe("SELF_APPROVAL_NOT_ALLOWED");

    const listRes = await request(app)
      .get(`/management/v1/approvals?status=pending&tenantId=${TENANT_ID}`)
      .set("authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.approvals.map((a: { approvalId: string }) => a.approvalId)).toContain(approvalId);
  });
});
