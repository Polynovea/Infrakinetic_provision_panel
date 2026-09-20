import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryAuditSink } from "../../src/identity/adapters/inMemoryAuditSink.js";
import {
  requirePublicOnboardingServiceAuth,
  PUBLIC_ONBOARDING_SYSTEM_OPERATOR_ID,
} from "../../src/middleware/requirePublicOnboardingServiceAuth.js";

const ORIGINAL_KEY = process.env.PUBLIC_ONBOARDING_SERVICE_KEY;
const REAL_KEY = "real-secret-value-that-is-long-enough-32chars-plus";

function buildApp(auditSink: InMemoryAuditSink) {
  const app = express();
  app.use(express.json());
  app.use(requirePublicOnboardingServiceAuth({ auditSink }));
  app.get("/whoami", (req, res) => {
    res.status(200).json({ operatorContext: req.operatorContext });
  });
  return app;
}

describe("middleware/requirePublicOnboardingServiceAuth", () => {
  let auditSink: InMemoryAuditSink;

  beforeEach(() => {
    auditSink = new InMemoryAuditSink();
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.PUBLIC_ONBOARDING_SERVICE_KEY;
    else process.env.PUBLIC_ONBOARDING_SERVICE_KEY = ORIGINAL_KEY;
  });

  it("missing PUBLIC_ONBOARDING_SERVICE_KEY configuration -> 503, fail closed", async () => {
    delete process.env.PUBLIC_ONBOARDING_SERVICE_KEY;
    const app = buildApp(auditSink);
    const res = await request(app).get("/whoami").set("x-onboarding-service-key", "anything");
    expect(res.status).toBe(503);
  });

  it("configured key too short (< 32 chars) -> 503, fail closed, not merely 'weak but accepted'", async () => {
    process.env.PUBLIC_ONBOARDING_SERVICE_KEY = "too-short";
    const app = buildApp(auditSink);
    const res = await request(app).get("/whoami").set("x-onboarding-service-key", "too-short");
    expect(res.status).toBe(503);
  });

  it("no key header at all -> 403, no default-allow", async () => {
    process.env.PUBLIC_ONBOARDING_SERVICE_KEY = REAL_KEY;
    const app = buildApp(auditSink);
    const res = await request(app).get("/whoami");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("ONBOARDING_SERVICE_KEY_INVALID");
  });

  it("wrong key -> 403", async () => {
    process.env.PUBLIC_ONBOARDING_SERVICE_KEY = REAL_KEY;
    const app = buildApp(auditSink);
    const res = await request(app).get("/whoami").set("x-onboarding-service-key", "wrong-value-also-long-enough-32-chars");
    expect(res.status).toBe(403);
  });

  it("correct key -> attaches a fixed, narrow operatorContext (exactly tenants.commission + tenants.read, no roles)", async () => {
    process.env.PUBLIC_ONBOARDING_SERVICE_KEY = REAL_KEY;
    const app = buildApp(auditSink);
    const res = await request(app).get("/whoami").set("x-onboarding-service-key", REAL_KEY);
    expect(res.status).toBe(200);
    expect(res.body.operatorContext.operatorId).toBe(PUBLIC_ONBOARDING_SYSTEM_OPERATOR_ID);
    expect(res.body.operatorContext.scopes).toEqual(["tenants.commission", "tenants.read"]);
    expect(res.body.operatorContext.roles).toEqual([]);
  });

  it("records both a failure and a success in the audit sink", async () => {
    process.env.PUBLIC_ONBOARDING_SERVICE_KEY = REAL_KEY;
    const app = buildApp(auditSink);
    await request(app).get("/whoami").set("x-onboarding-service-key", "wrong-value-also-long-enough-32-chars");
    await request(app).get("/whoami").set("x-onboarding-service-key", REAL_KEY);
    const events = auditSink.events.map((e) => e.eventType);
    expect(events).toContain("auth.failure");
    expect(events).toContain("auth.success");
  });
});
