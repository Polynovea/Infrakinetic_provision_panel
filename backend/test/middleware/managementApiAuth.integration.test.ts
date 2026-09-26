import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CognitoIdentityProvider } from "../../src/identity/providers/cognitoIdentityProvider.js";
import { buildTestApp, type TestAppHandle } from "../helpers/testApp.js";
import {
  activeAdminOperator,
  activeViewerOperator,
  disabledOperator,
  overPrivilegedOperator,
  revokedOperator,
} from "../helpers/operators.js";
import { buildTestIdentityProvider } from "../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken, type TestKeyPair } from "../helpers/testToken.js";

describe("requireManagementApiAuth — end-to-end through a real Express router", () => {
  let keyPair: TestKeyPair;
  let provider: CognitoIdentityProvider;

  beforeEach(async () => {
    keyPair = await generateTestKeyPair();
    provider = buildTestIdentityProvider(keyPair);
  });

  function app(operators: Parameters<typeof buildTestApp>[1]): TestAppHandle {
    return buildTestApp(provider, operators);
  }

  it("rejects a request with no Authorization header — deny by default", async () => {
    const { app: server } = app([activeAdminOperator()]);
    const res = await request(server).get("/management/v1/whoami");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("TOKEN_MISSING");
  });

  it("rejects a malformed bearer token", async () => {
    const { app: server } = app([activeAdminOperator()]);
    const res = await request(server).get("/management/v1/whoami").set("authorization", "Bearer garbage");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("TOKEN_MALFORMED");
  });

  it("rejects a valid token whose subject is not a provisioned operator", async () => {
    const { app: server } = app([]); // empty directory
    const token = await signTestToken(keyPair, { subject: "fixture-sub-admin" });
    const res = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("OPERATOR_NOT_PROVISIONED");
  });

  it("rejects a disabled operator", async () => {
    const op = disabledOperator();
    const { app: server } = app([op]);
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("OPERATOR_DISABLED");
  });

  it("rejects an active operator that is not marked MFA-enrolled in the Governance directory", async () => {
    const op = activeAdminOperator({ mfaEnrolled: false });
    const { app: server } = app([op]);
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("OPERATOR_MFA_REQUIRED");
  });

  it("rejects a revoked operator", async () => {
    const op = revokedOperator();
    const { app: server } = app([op]);
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("OPERATOR_DISABLED");
  });

  it("rejects an operator record whose scopes exceed its role ceiling (insufficient privilege / data-integrity guard)", async () => {
    const op = overPrivilegedOperator();
    const { app: server } = app([op]);
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("INSUFFICIENT_PRIVILEGE");
  });

  it("accepts a valid token for an active, correctly-scoped operator and attaches operator context", async () => {
    const op = activeAdminOperator();
    const { app: server } = app([op]);
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.operator.operatorId).toBe(op.operatorId);
    expect(res.body.operator.roles).toEqual(["platform_admin"]);
  });

  // Audit remediation L8 — raw bearer auth is a controlled capability.
  describe("production bearer capability (L8)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("production with the capability unset: a genuinely valid Cognito bearer token is rejected", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("GOVERNANCE_OPERATOR_BEARER_AUTH", "");
      const op = activeAdminOperator();
      const { app: server } = app([op]);
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("BEARER_AUTH_DISABLED");
      expect(res.body.operator).toBeUndefined();
    });

    it.each(["true", "1", "enabled", "ENABLED-FOR-TOOLING"])("production with an ambiguous value (%s) fails closed", async (value) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("GOVERNANCE_OPERATOR_BEARER_AUTH", value);
      const op = activeAdminOperator();
      const { app: server } = app([op]);
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("BEARER_AUTH_DISABLED");
    });

    it("production explicitly enabled for tooling: bearer works, with every operator check still applied", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("GOVERNANCE_OPERATOR_BEARER_AUTH", "enabled-for-tooling");
      const active = activeAdminOperator();
      const disabled = disabledOperator();
      const { app: server } = app([active, disabled]);
      const ok = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${await signTestToken(keyPair, { subject: active.cognitoSub })}`);
      expect(ok.status).toBe(200);
      const denied = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${await signTestToken(keyPair, { subject: disabled.cognitoSub })}`);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe("OPERATOR_DISABLED");
    });
  });

  it("rejects an unknown route under /management/v1 with 404 — no permissive catch-all", async () => {
    const op = activeAdminOperator();
    const { app: server } = app([op]);
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const res = await request(server).get("/management/v1/does-not-exist").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  describe("scope authorization (requireScope) — separate from authentication", () => {
    it("rejects an authenticated operator missing the required scope", async () => {
      const op = activeViewerOperator({ scopes: ["tenants.read"] }); // no audit.read
      const { app: server } = app([op]);
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server).get("/management/v1/audit/self-test").set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("SCOPE_REQUIRED");
    });

    it("allows an authenticated operator that holds the required scope", async () => {
      const op = activeViewerOperator({ scopes: ["tenants.read", "audit.read"] });
      const { app: server } = app([op]);
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server).get("/management/v1/audit/self-test").set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  describe("role authorization (requireRole) + step-up skeleton", () => {
    it("rejects when step-up has never been recorded", async () => {
      const op = activeAdminOperator();
      const { app: server } = app([op]);
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });
      const res = await request(server)
        .get("/management/v1/audit/self-test/step-up")
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("STEP_UP_REQUIRED");
    });

    it("never lets the caller self-assert step-up, but accepts separately-recorded verified MFA evidence", async () => {
      const admin = activeAdminOperator();
      const viewer = activeViewerOperator();
      const { app: server, sessionStore } = app([admin, viewer]);

      const adminJti = "11111111-1111-4111-8111-111111111111";
      const adminToken = await signTestToken(keyPair, { subject: admin.cognitoSub, jti: adminJti });
      const selfAssert = await request(server)
        .post("/management/v1/session/step-up")
        .set("authorization", `Bearer ${adminToken}`);
      expect(selfAssert.status).toBe(501);
      expect(selfAssert.body.error).toBe("STEP_UP_NOT_CONFIGURED");

      const stillBlocked = await request(server)
        .get("/management/v1/audit/self-test/step-up")
        .set("authorization", `Bearer ${adminToken}`);
      expect(stillBlocked.status).toBe(403);
      expect(stillBlocked.body.error).toBe("STEP_UP_REQUIRED");

      await sessionStore.recordStepUp(adminJti, { verifiedAt: new Date().toISOString(), method: "cognito-mfa" });
      const adminRes = await request(server)
        .get("/management/v1/audit/self-test/step-up")
        .set("authorization", `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(200);

      const viewerJti = "22222222-2222-4222-8222-222222222222";
      const viewerToken = await signTestToken(keyPair, { subject: viewer.cognitoSub, jti: viewerJti });
      await sessionStore.recordStepUp(viewerJti, { verifiedAt: new Date().toISOString(), method: "cognito-mfa" });
      const viewerRes = await request(server)
        .get("/management/v1/audit/self-test/step-up")
        .set("authorization", `Bearer ${viewerToken}`);
      expect(viewerRes.status).toBe(403);
      expect(viewerRes.body.error).toBe("ROLE_REQUIRED");
    });
  });

  describe("session revocation (logout)", () => {
    it("rejects further requests with the same token after logout", async () => {
      const op = activeAdminOperator();
      const { app: server } = app([op]);
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });

      const before = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
      expect(before.status).toBe(200);

      const logout = await request(server).post("/management/v1/session/logout").set("authorization", `Bearer ${token}`);
      expect(logout.status).toBe(200);

      const after = await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${token}`);
      expect(after.status).toBe(403);
      expect(after.body.error).toBe("SESSION_REVOKED");
    });
  });

  describe("audit/provenance hooks", () => {
    it("records both auth.success and auth.failure events", async () => {
      const op = activeAdminOperator();
      const { app: server, auditSink } = app([op]);
      const goodToken = await signTestToken(keyPair, { subject: op.cognitoSub });

      await request(server).get("/management/v1/whoami").set("authorization", `Bearer ${goodToken}`);
      await request(server).get("/management/v1/whoami"); // no token

      const eventTypes = auditSink.events.map((e) => e.eventType);
      expect(eventTypes).toContain("auth.success");
      expect(eventTypes).toContain("auth.failure");
      const failure = auditSink.events.find((e) => e.eventType === "auth.failure");
      expect(failure?.reasonCode).toBe("TOKEN_MISSING");
    });

    it("records authz.denied when a scope check fails", async () => {
      const op = activeViewerOperator({ scopes: ["tenants.read"] });
      const { app: server, auditSink } = app([op]);
      const token = await signTestToken(keyPair, { subject: op.cognitoSub });

      await request(server).get("/management/v1/audit/self-test").set("authorization", `Bearer ${token}`);

      expect(auditSink.events.some((e) => e.eventType === "authz.denied" && e.reasonCode === "SCOPE_REQUIRED")).toBe(
        true,
      );
    });
  });
});
