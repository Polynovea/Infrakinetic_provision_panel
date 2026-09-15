import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { InMemoryAuditSink } from "../../src/identity/adapters/inMemoryAuditSink.js";
import { InMemoryBrowserAuthStore } from "../../src/identity/adapters/inMemoryBrowserAuthStore.js";
import { InMemoryOperatorDirectory } from "../../src/identity/adapters/inMemoryOperatorDirectory.js";
import type { BrowserAuthConfig } from "../../src/identity/browserAuthConfig.js";
import { sha256Base64Url } from "../../src/identity/browserAuthCrypto.js";
import type { IdentityProvider, VerifiedTokenClaims } from "../../src/identity/identityProvider.js";
import { createBrowserAuthRouter } from "../../src/routes/auth/index.js";
import { activeAdminOperator, pendingMfaOperator } from "../helpers/operators.js";

const config: BrowserAuthConfig = {
  cognitoDomain: "https://operator-auth.example.test",
  appClientId: "governance-browser-client",
  appClientSecret: "governance-browser-client-test-secret",
  redirectUri: "http://localhost:4100/auth/callback",
  frontendOrigin: "http://localhost:3000",
  secureCookies: false,
  oauthTransactionTtlSeconds: 600,
  browserSessionMaxSeconds: 3600,
};

function cookieValue(setCookieHeader: string | string[] | undefined, name: string): string | undefined {
  const entries = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const entry of entries) {
    const match = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(entry);
    if (match) return decodeURIComponent(match[1]);
  }
  return undefined;
}

describe("backend-owned Cognito browser auth", () => {
  it("creates state/nonce/PKCE server-side and exchanges the callback into an opaque Governance session", async () => {
    const operator = activeAdminOperator();
    const store = new InMemoryBrowserAuthStore();
    const auditSink = new InMemoryAuditSink();
    let expectedNonce = "";

    const identityProvider: IdentityProvider = {
      async verifyToken(rawToken: string): Promise<VerifiedTokenClaims> {
        expect(rawToken).toBe("signed-id-token");
        return {
          subject: operator.cognitoSub,
          tokenId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          issuedAt: new Date(Date.now() - 1_000),
          expiresAt: new Date(Date.now() + 3_600_000),
          rawClaims: { nonce: expectedNonce },
        };
      },
    };
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ id_token: "signed-id-token", refresh_token: "must-not-be-persisted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const app = express();
    app.use(
      "/auth",
      createBrowserAuthRouter({
        identityProvider,
        operatorDirectory: new InMemoryOperatorDirectory([operator]),
        browserAuthStore: store,
        auditSink,
        loadConfig: () => config,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    const login = await request(app).get("/auth/login?returnTo=%2Ftenants");
    expect(login.status).toBe(302);
    const authorizeUrl = new URL(login.headers.location);
    expect(authorizeUrl.origin).toBe("https://operator-auth.example.test");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
    expectedNonce = authorizeUrl.searchParams.get("nonce") ?? "";
    expect(expectedNonce).not.toBe("");

    const oauthCookie = cookieValue(login.headers["set-cookie"], "governance_oauth");
    expect(oauthCookie).toBeTruthy();
    const callback = await request(app)
      .get(`/auth/callback?code=authorization-code&state=${encodeURIComponent(authorizeUrl.searchParams.get("state") ?? "")}`)
      .set("Cookie", `governance_oauth=${oauthCookie}`);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("http://localhost:3000/tenants");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://operator-auth.example.test/oauth2/token");
    const authorizationHeader = (tokenInit.headers as Record<string, string>).authorization;
    expect(authorizationHeader).toBe(
      `Basic ${Buffer.from(`${config.appClientId}:${config.appClientSecret}`, "utf8").toString("base64")}`,
    );
    const bodyText = tokenInit.body as string;
    expect(bodyText).not.toContain(config.appClientSecret);
    const sessionSecret = cookieValue(callback.headers["set-cookie"], "governance_session");
    expect(sessionSecret).toBeTruthy();
    const session = await store.findSessionByTokenHash(sha256Base64Url(sessionSecret ?? ""));
    expect(session?.operatorId).toBe(operator.operatorId);
    expect(session?.cognitoSub).toBe(operator.cognitoSub);
    expect(session?.csrfToken).toBeTruthy();
  });

  it("self-activates an operator bootstrapped pending their first MFA'd login, on that first successful login", async () => {
    const operator = pendingMfaOperator();
    const directory = new InMemoryOperatorDirectory([operator]);
    const store = new InMemoryBrowserAuthStore();
    const auditSink = new InMemoryAuditSink();
    let expectedNonce = "";

    const identityProvider: IdentityProvider = {
      async verifyToken(): Promise<VerifiedTokenClaims> {
        return {
          subject: operator.cognitoSub,
          tokenId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          issuedAt: new Date(Date.now() - 1_000),
          expiresAt: new Date(Date.now() + 3_600_000),
          rawClaims: { nonce: expectedNonce },
        };
      },
    };
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ id_token: "signed-id-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const app = express();
    app.use(
      "/auth",
      createBrowserAuthRouter({
        identityProvider,
        operatorDirectory: directory,
        browserAuthStore: store,
        auditSink,
        loadConfig: () => config,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    const login = await request(app).get("/auth/login");
    const authorizeUrl = new URL(login.headers.location);
    expectedNonce = authorizeUrl.searchParams.get("nonce") ?? "";
    const oauthCookie = cookieValue(login.headers["set-cookie"], "governance_oauth");

    const callback = await request(app)
      .get(`/auth/callback?code=authorization-code&state=${encodeURIComponent(authorizeUrl.searchParams.get("state") ?? "")}`)
      .set("Cookie", `governance_oauth=${oauthCookie}`);

    // Proves this was treated as a real success, not silently rejected.
    expect(callback.status).toBe(302);
    expect(callback.headers.location).not.toContain("auth=");
    expect(cookieValue(callback.headers["set-cookie"], "governance_session")).toBeTruthy();

    const activated = await directory.findByCognitoSub(operator.cognitoSub);
    expect(activated?.status).toBe("active");
    expect(activated?.mfaEnrolled).toBe(true);
    expect(activated?.disabledAt).toBeUndefined();
    expect(activated?.disabledReason).toBeUndefined();

    const successEvent = auditSink.events.find((e) => e.eventType === "auth.success");
    expect(successEvent?.detail).toEqual({ selfActivatedPendingMfa: true });
  });

  it("does NOT self-activate an operator disabled for cause (mfaEnrolled was already true)", async () => {
    const operator = activeAdminOperator({ status: "disabled", disabledAt: "2026-09-15T00:00:00.000Z", disabledReason: "terminated" });
    const directory = new InMemoryOperatorDirectory([operator]);
    const store = new InMemoryBrowserAuthStore();
    let expectedNonce = "";
    const identityProvider: IdentityProvider = {
      async verifyToken(): Promise<VerifiedTokenClaims> {
        return {
          subject: operator.cognitoSub,
          tokenId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          issuedAt: new Date(Date.now() - 1_000),
          expiresAt: new Date(Date.now() + 3_600_000),
          rawClaims: { nonce: expectedNonce },
        };
      },
    };
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ id_token: "signed-id-token" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const app = express();
    app.use(
      "/auth",
      createBrowserAuthRouter({
        identityProvider,
        operatorDirectory: directory,
        browserAuthStore: store,
        auditSink: new InMemoryAuditSink(),
        loadConfig: () => config,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    const login = await request(app).get("/auth/login");
    const authorizeUrl = new URL(login.headers.location);
    expectedNonce = authorizeUrl.searchParams.get("nonce") ?? "";
    const oauthCookie = cookieValue(login.headers["set-cookie"], "governance_oauth");

    const callback = await request(app)
      .get(`/auth/callback?code=authorization-code&state=${encodeURIComponent(authorizeUrl.searchParams.get("state") ?? "")}`)
      .set("Cookie", `governance_oauth=${oauthCookie}`);

    expect(callback.headers.location).toContain("auth=forbidden");
    const stillDisabled = await directory.findByCognitoSub(operator.cognitoSub);
    expect(stillDisabled?.status).toBe("disabled");
  });

  it("rejects a mismatched OAuth state before token exchange", async () => {
    const operator = activeAdminOperator();
    const store = new InMemoryBrowserAuthStore();
    const fetchImpl = vi.fn();
    const identityProvider: IdentityProvider = {
      async verifyToken(): Promise<VerifiedTokenClaims> {
        throw new Error("must not verify a token on state mismatch");
      },
    };
    const app = express();
    app.use(
      "/auth",
      createBrowserAuthRouter({
        identityProvider,
        operatorDirectory: new InMemoryOperatorDirectory([operator]),
        browserAuthStore: store,
        auditSink: new InMemoryAuditSink(),
        loadConfig: () => config,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    );

    const login = await request(app).get("/auth/login");
    const oauthCookie = cookieValue(login.headers["set-cookie"], "governance_oauth");
    const callback = await request(app)
      .get("/auth/callback?code=authorization-code&state=attacker-state")
      .set("Cookie", `governance_oauth=${oauthCookie}`);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("auth=failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});