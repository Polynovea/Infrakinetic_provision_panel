import request from "supertest";
import { describe, expect, it } from "vitest";

import { buildTestApp } from "../../helpers/testApp.js";
import { activeAdminOperator } from "../../helpers/operators.js";
import { buildTestIdentityProvider } from "../../helpers/testProvider.js";
import { generateTestKeyPair, signTestToken, type TestKeyPair } from "../../helpers/testToken.js";
import type { BrowserAuthConfig } from "../../../src/identity/browserAuthConfig.js";

// 1A.12.4 — real operator step-up. Exercises the actual route handlers
// (GET /session/step-up/start -> redirect to Cognito with prompt=login;
// GET /session/step-up/callback -> token exchange -> subject-match check
// -> sessionStore.recordStepUp), same "real Express router, mocked network
// boundary" style as routes/auth's own callback tests.

const FIXTURE_CONFIG: BrowserAuthConfig = {
  cognitoDomain: "https://auth.governance.test.invalid",
  appClientId: "test-client-id",
  appClientSecret: "test-client-secret",
  redirectUri: "https://governance.test.invalid/auth/callback",
  frontendOrigin: "https://app.governance.test.invalid",
  secureCookies: true,
  oauthTransactionTtlSeconds: 600,
  browserSessionMaxSeconds: 3600,
};

function extractQueryParam(location: string, name: string): string | null {
  return new URL(location).searchParams.get(name);
}

describe("GET /management/v1/session/step-up/start", () => {
  it("redirects to Cognito's Hosted UI with prompt=login (forced fresh re-auth) and PKCE/state/nonce", async () => {
    const keyPair: TestKeyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const op = activeAdminOperator();
    const { app } = buildTestApp(provider, [op], { loadBrowserAuthConfig: () => FIXTURE_CONFIG });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    const res = await request(app).get("/management/v1/session/step-up/start").set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    expect(location.startsWith(FIXTURE_CONFIG.cognitoDomain)).toBe(true);
    expect(extractQueryParam(location, "prompt")).toBe("login");
    expect(extractQueryParam(location, "client_id")).toBe(FIXTURE_CONFIG.appClientId);
    expect(extractQueryParam(location, "code_challenge_method")).toBe("S256");
    expect(extractQueryParam(location, "state")).toBeTruthy();
    expect(extractQueryParam(location, "nonce")).toBeTruthy();
    // The step-up redirect_uri must be distinct from the ordinary login
    // callback so Cognito routes the response to the right handler.
    expect(extractQueryParam(location, "redirect_uri")).toBe("https://governance.test.invalid/management/v1/session/step-up/callback");
  });

  it("rejects with NOT_AUTHENTICATED when no credential is presented", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const { app } = buildTestApp(provider, [], { loadBrowserAuthConfig: () => FIXTURE_CONFIG });
    const res = await request(app).get("/management/v1/session/step-up/start");
    expect(res.status).toBe(401); // requireManagementApiAuth denies before the handler runs
  });
});

describe("GET /management/v1/session/step-up/callback", () => {
  async function startTransaction(agent: ReturnType<typeof request.agent>, token: string) {
    const startRes = await agent.get("/management/v1/session/step-up/start").set("authorization", `Bearer ${token}`);
    const location = startRes.headers.location as string;
    return extractQueryParam(location, "state")!;
  }

  it("subject match: exchanges the code, verifies the fresh re-auth is the SAME operator, and records step-up on that operator's session", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const op = activeAdminOperator();

    // The nonce is generated server-side and unknown ahead of time, so the
    // fake token endpoint must mint an ID token carrying whatever nonce the
    // real /start call generated — capture it via a wrapping fetchImpl.
    let capturedNonce = "";
    const { app, sessionStore } = buildTestApp(provider, [op], {
      loadBrowserAuthConfig: () => FIXTURE_CONFIG,
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        const idToken = await signTestToken(keyPair, { subject: op.cognitoSub, extraClaims: { nonce: capturedNonce } });
        return { ok: true, json: async () => ({ id_token: idToken }) } as Response;
      }) as typeof fetch,
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const agent = request.agent(app);

    const startRes = await agent.get("/management/v1/session/step-up/start").set("authorization", `Bearer ${token}`);
    const location = startRes.headers.location as string;
    const state = extractQueryParam(location, "state")!;
    capturedNonce = extractQueryParam(location, "nonce")!;

    const callbackRes = await agent
      .get("/management/v1/session/step-up/callback")
      .query({ code: "fake-code", state })
      .set("authorization", `Bearer ${token}`);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toBe(`${FIXTURE_CONFIG.frontendOrigin}/`);
    const stepUp = await sessionStore.getStepUp(token.split(".")[1] ? JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).jti : "");
    expect(stepUp?.method).toBe("cognito-fresh-reauth");
  });

  it("subject mismatch: fails closed, never records step-up, and the transaction is single-use", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const op = activeAdminOperator();
    const attackerSub = "someone-else-entirely";
    let capturedNonce = "";
    const { app, sessionStore } = buildTestApp(provider, [op], {
      loadBrowserAuthConfig: () => FIXTURE_CONFIG,
      fetchImpl: (async () => {
        const idToken = await signTestToken(keyPair, { subject: attackerSub, extraClaims: { nonce: capturedNonce } });
        return { ok: true, json: async () => ({ id_token: idToken }) } as Response;
      }) as typeof fetch,
    });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });
    const agent = request.agent(app);
    const jti = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).jti as string;

    const startRes = await agent.get("/management/v1/session/step-up/start").set("authorization", `Bearer ${token}`);
    const location = startRes.headers.location as string;
    const state = extractQueryParam(location, "state")!;
    capturedNonce = extractQueryParam(location, "nonce")!;

    const callbackRes = await agent
      .get("/management/v1/session/step-up/callback")
      .query({ code: "fake-code", state })
      .set("authorization", `Bearer ${token}`);

    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.location).toContain("stepUp=forbidden");
    expect(await sessionStore.getStepUp(jti)).toBeUndefined();

    // Replaying the same state must not succeed either — single-use.
    const replay = await agent.get("/management/v1/session/step-up/callback").query({ code: "fake-code", state }).set("authorization", `Bearer ${token}`);
    expect(replay.headers.location).toContain("stepUp=failed");
  });

  it("invalid/unknown state -> failed, no step-up recorded", async () => {
    const keyPair = await generateTestKeyPair();
    const provider = buildTestIdentityProvider(keyPair);
    const op = activeAdminOperator();
    const { app } = buildTestApp(provider, [op], { loadBrowserAuthConfig: () => FIXTURE_CONFIG });
    const token = await signTestToken(keyPair, { subject: op.cognitoSub });

    const res = await request(app)
      .get("/management/v1/session/step-up/callback")
      .query({ code: "fake-code", state: "never-issued" })
      .set("authorization", `Bearer ${token}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("stepUp=failed");
  });
});
