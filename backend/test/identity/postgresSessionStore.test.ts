import { beforeEach, describe, expect, it } from "vitest";

import { PostgresSessionStore } from "../../src/identity/adapters/postgresSessionStore.js";
import { buildMigratedPgMemClient } from "../helpers/pgMemDb.js";

// operator_sessions.session_id is UUID (migrations/0001_operator_identity_schema.sql)
// — matching real usage, where the session id is a verified Cognito token's
// own jti. Every session id below must be UUID-shaped or Postgres (and
// pg-mem, which enforces the same type) rejects the query outright.
const SESSION_NEVER_SEEN = "00000000-0000-4000-8000-000000000000";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SESSION_C = "33333333-3333-4333-8333-333333333333";
const SESSION_D = "44444444-4444-4444-8444-444444444444";
const SESSION_E = "55555555-5555-4555-8555-555555555555";

describe("identity/adapters/postgresSessionStore", () => {
  let store: PostgresSessionStore;

  beforeEach(() => {
    const { client } = buildMigratedPgMemClient();
    store = new PostgresSessionStore(client);
  });

  it("a never-seen session id is not revoked and has no step-up state", async () => {
    await expect(store.isRevoked(SESSION_NEVER_SEEN)).resolves.toBe(false);
    await expect(store.getStepUp(SESSION_NEVER_SEEN)).resolves.toBeUndefined();
  });

  it("revoke() creates the row when none exists yet (no prior 'session established' event)", async () => {
    await store.revoke(SESSION_A, "operator-initiated logout");
    await expect(store.isRevoked(SESSION_A)).resolves.toBe(true);
  });

  it("recordStepUp() creates the row when none exists yet, independent of revoke()", async () => {
    await store.recordStepUp(SESSION_B, { verifiedAt: "2026-09-11T00:00:00.000Z", method: "totp" });
    const stepUp = await store.getStepUp(SESSION_B);
    expect(stepUp).toEqual({ verifiedAt: "2026-09-11T00:00:00.000Z", method: "totp" });
    // recordStepUp alone must not also mark the session revoked.
    await expect(store.isRevoked(SESSION_B)).resolves.toBe(false);
  });

  it("recordStepUp() then revoke() on the same session id preserves both facts (UPSERT, not overwrite)", async () => {
    await store.recordStepUp(SESSION_C, { verifiedAt: "2026-09-11T00:00:00.000Z", method: "totp" });
    await store.revoke(SESSION_C, "security incident");

    await expect(store.isRevoked(SESSION_C)).resolves.toBe(true);
    await expect(store.getStepUp(SESSION_C)).resolves.toEqual({
      verifiedAt: "2026-09-11T00:00:00.000Z",
      method: "totp",
    });
  });

  it("revoke() is idempotent — revoking an already-revoked session does not error", async () => {
    await store.revoke(SESSION_D, "first reason");
    await expect(store.revoke(SESSION_D, "second reason")).resolves.not.toThrow();
    await expect(store.isRevoked(SESSION_D)).resolves.toBe(true);
  });

  it("a second recordStepUp() call overwrites the prior step-up state for the same session", async () => {
    await store.recordStepUp(SESSION_E, { verifiedAt: "2026-09-11T00:00:00.000Z", method: "totp" });
    await store.recordStepUp(SESSION_E, { verifiedAt: "2026-09-11T00:05:00.000Z", method: "sms" });

    await expect(store.getStepUp(SESSION_E)).resolves.toEqual({
      verifiedAt: "2026-09-11T00:05:00.000Z",
      method: "sms",
    });
  });
});
