import request from "supertest";
import { describe, expect, it } from "vitest";

import { sha256Base64Url } from "../../src/identity/browserAuthCrypto.js";
import type { IdentityProvider } from "../../src/identity/identityProvider.js";
import { activeAdminOperator } from "../helpers/operators.js";
import { buildTestApp } from "../helpers/testApp.js";

const unusedIdentityProvider: IdentityProvider = {
  async verifyToken() {
    throw new Error("browser-session authentication must not re-read a raw Cognito token");
  },
};

describe("Governance-owned browser session authentication", () => {
  it("authenticates from an opaque HttpOnly-session value and returns the session CSRF token", async () => {
    const operator = activeAdminOperator();
    const { app, browserAuthStore } = buildTestApp(unusedIdentityProvider, [operator]);
    const sessionSecret = "opaque-browser-session-secret";
    const csrfToken = "browser-csrf-token";

    await browserAuthStore.createSession({
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionTokenHash: sha256Base64Url(sessionSecret),
      csrfToken,
      operatorId: operator.operatorId,
      cognitoSub: operator.cognitoSub,
      cognitoTokenId: "cognito-jti-used-only-at-session-establishment",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const response = await request(app)
      .get("/management/v1/whoami")
      .set("Cookie", `governance_session=${sessionSecret}`);

    expect(response.status).toBe(200);
    expect(response.body.operator.operatorId).toBe(operator.operatorId);
    expect(response.body.operator.roles).toEqual(["platform_admin"]);
    expect(response.body.csrfToken).toBe(csrfToken);
  });

  it("requires CSRF on cookie-authenticated mutations and revokes the browser session on logout", async () => {
    const operator = activeAdminOperator();
    const { app, browserAuthStore } = buildTestApp(unusedIdentityProvider, [operator]);
    const sessionSecret = "opaque-browser-session-secret-2";
    const csrfToken = "browser-csrf-token-2";
    const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await browserAuthStore.createSession({
      sessionId,
      sessionTokenHash: sha256Base64Url(sessionSecret),
      csrfToken,
      operatorId: operator.operatorId,
      cognitoSub: operator.cognitoSub,
      cognitoTokenId: "cognito-jti-2",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const missingCsrf = await request(app)
      .post("/management/v1/session/logout")
      .set("Cookie", `governance_session=${sessionSecret}`);
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error).toBe("CSRF_REQUIRED");

    const logout = await request(app)
      .post("/management/v1/session/logout")
      .set("Cookie", `governance_session=${sessionSecret}`)
      .set("x-governance-csrf", csrfToken);
    expect(logout.status).toBe(200);
    expect(logout.body.status).toBe("revoked");

    const after = await request(app)
      .get("/management/v1/whoami")
      .set("Cookie", `governance_session=${sessionSecret}`);
    expect(after.status).toBe(403);
    expect(after.body.error).toBe("SESSION_REVOKED");
  });
});
