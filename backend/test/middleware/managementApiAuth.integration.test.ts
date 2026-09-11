import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

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

    it("allows access after step-up is recorded, then rejects a non-admin role even with fresh step-up", async () => {
      const admin = activeAdminOperator();
      const viewer = activeViewerOperator();
      const { app: server } = app([admin, viewer]);

      const adminToken = await signTestToken(keyPair, { subject: admin.cognitoSub });
      await request(server).post("/management/v1/session/step-up").set("authorization", `Bearer ${adminToken}`);
      const adminRes = await request(server)
        .get("/management/v1/audit/self-test/step-up")
        .set("authorization", `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(200);

      const viewerToken = await signTestToken(keyPair, { subject: viewer.cognitoSub });
      await request(server).post("/management/v1/session/step-up").set("authorization", `Bearer ${viewerToken}`);
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
