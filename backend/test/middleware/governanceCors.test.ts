import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createGovernanceCors } from "../../src/middleware/governanceCors.js";

function app(origin: string | undefined) {
  const server = express();
  server.use(createGovernanceCors(origin));
  server.get("/probe", (_req, res) => res.status(200).json({ ok: true }));
  server.post("/probe", (_req, res) => res.status(200).json({ ok: true }));
  return server;
}

describe("Governance CORS boundary", () => {
  it("allows only the configured frontend origin and emits credentialed CORS headers", async () => {
    const res = await request(app("https://governance.example.test"))
      .get("/probe")
      .set("Origin", "https://governance.example.test");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://governance.example.test");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers.vary).toContain("Origin");
  });

  it("fails closed for a different browser origin before the route runs", async () => {
    const res = await request(app("https://governance.example.test"))
      .post("/probe")
      .set("Origin", "https://evil.example.test");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "ORIGIN_NOT_ALLOWED" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows same-origin/server-to-server requests with no Origin header", async () => {
    const res = await request(app("https://governance.example.test")).get("/probe");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers an allowed preflight with 204 and the configured credential headers", async () => {
    const res = await request(app("https://governance.example.test"))
      .options("/probe")
      .set("Origin", "https://governance.example.test");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://governance.example.test");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("fails closed when an Origin is present but no frontend origin is configured", async () => {
    const res = await request(app(undefined)).get("/probe").set("Origin", "https://governance.example.test");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("ORIGIN_NOT_ALLOWED");
  });
});
