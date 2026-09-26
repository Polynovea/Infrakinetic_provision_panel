import { Router, type ErrorRequestHandler } from "express";

import type { AuditSink } from "../../identity/auditSink.js";
import type { BrowserAuthStore } from "../../identity/browserAuthStore.js";
import { ManagementAuthError, StepUpNotConfiguredError } from "../../identity/errors.js";
import type { IdentityProvider } from "../../identity/identityProvider.js";
import type { OperatorDirectory } from "../../identity/operatorDirectory.js";
import type { OperatorSessionStore } from "../../identity/sessionStore.js";
import type { BrowserAuthConfig } from "../../identity/browserAuthConfig.js";
import { loadBrowserAuthConfig } from "../../identity/browserAuthConfig.js";
import { browserCookieNames, parseCookies } from "../../identity/browserCookies.js";
import {
  pkceChallenge,
  randomOpaqueSecret,
  safeEqualText,
  safeRelativeReturnPath,
  sha256Base64Url,
} from "../../identity/browserAuthCrypto.js";
import { requireRole, requireScope, requireStepUp } from "../../middleware/authorize.js";
import { requireBrowserCsrf } from "../../middleware/requireBrowserCsrf.js";
import { requireManagementApiAuth } from "../../middleware/requireManagementApiAuth.js";
import type { ManagementOperationLedger } from "../../management/operations/managementOperationLedger.js";
import type { ManagementSigningKeySet } from "../../management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../management/managementConfig.js";
import { DatabaseUnavailableError } from "../../db/errors.js";
import {
  requestEngineStateChange,
  recoverEngineState,
  UnknownEngineError,
  MissingRecoveryIntentError,
  UnexpectedManagementApiResponseError,
  ManagementApiUnreachableError,
} from "../../management/operations/engineStateOperation.js";
import { ManagementOperationError, OperationNotFoundError } from "../../management/operations/managementOperationErrors.js";
import { listTenantRegistry, getTenantRegistryEntry, getTenantRegistryUsers, UnknownTenantError } from "../../management/operations/tenantRegistryQuery.js";
import { listEngineCatalog } from "../../management/operations/engineCatalogQuery.js";
import { isOperationStatus, type OperationStatus } from "../../management/operations/lifecycle.js";
import {
  requestTenantCommission,
  requestTenantSuspend,
  requestTenantResume,
  requestTenantDecommission,
  MissingTenantIdentifierError,
} from "../../management/operations/tenantLifecycleOperation.js";
import type { CommissionedTenantsRepository } from "../../management/operations/commissionedTenants.js";
import {
  requestTenantEngineEntitlementChange,
  UnknownEntitlementEngineError,
  UnknownEntitlementTenantError,
  MissingEntitlementTenantIdentifierError,
} from "../../management/operations/tenantEngineEntitlementOperation.js";
import {
  getTenantEngineEntitlementRead,
  listTenantEngineEntitlements,
} from "../../management/operations/tenantEngineEntitlementQuery.js";
import { listDrift } from "../../management/operations/reconciliationQuery.js";
import { reconcileTenant, reconcileCommissionRequest } from "../../management/operations/reconciliationOperation.js";
import {
  listTenantIdentities,
  getIdentityDetail,
  getIdentityHistory,
  listTenantInvitations,
  UnknownIdentityError,
} from "../../management/operations/identityQuery.js";
import {
  requestIdentityInvitation,
  requestIdentityInvitationResend,
  requestIdentityInvitationCancel,
  requestIdentityRecovery,
  requestIdentitySuspend,
  requestIdentityRestore,
  requestIdentityGlobalSignout,
  requestIdentitySessionsRevoke,
  MissingIdentityTargetError,
} from "../../management/operations/identityOperation.js";
import {
  requestIdentityR3Approval,
  decideIdentityR3Approval,
  executeIdentityR3Approval,
  IDENTITY_R3_ACTIONS,
  UnknownIdentityR3ActionError,
  MissingIdentityApprovalTargetError,
  type IdentityR3ActionKey,
} from "../../management/operations/identityApprovalOperation.js";
import type { ManagementApprovalStore } from "../../management/operations/managementApprovalStore.js";
import {
  ApprovalNotFoundError,
  ApprovalExpiredError,
  ApprovalNotPendingError,
  SelfApprovalNotAllowedError,
  ApprovalNotApprovedError,
  ApprovalAlreadyExecutedError,
  ApprovalPayloadMismatchError,
} from "../../management/operations/managementApprovalStore.js";
import {
  listTenantCredentials,
  getCredentialDetail,
  getCredentialHistory,
  UnknownCredentialError,
} from "../../management/operations/credentialQuery.js";
import {
  requestCredentialReplace,
  requestCredentialTest,
  MissingCredentialTargetError,
} from "../../management/operations/credentialOperation.js";
import {
  requestCredentialR3Approval,
  executeCredentialR3Approval,
  CREDENTIAL_R3_ACTIONS,
  UnknownCredentialR3ActionError,
  MissingCredentialApprovalTargetError,
  type CredentialR3ActionKey,
} from "../../management/operations/credentialApprovalOperation.js";

export interface ManagementRouterDeps {
  identityProvider: IdentityProvider;
  operatorDirectory: OperatorDirectory;
  sessionStore: OperatorSessionStore;
  auditSink: AuditSink;
  browserAuthStore?: BrowserAuthStore;
  // 1A.6 — the real engine-state mutation vertical. getManagementSigningKeys
  // and loadTransportConfig are injected as functions (not resolved values)
  // so server boot never requires GOVERNANCE_MANAGEMENT_* to be set — only
  // an actual PUT to this route does, matching every other lazy dependency
  // in this backend.
  ledger: ManagementOperationLedger;
  getManagementSigningKeys: () => Promise<ManagementSigningKeySet>;
  loadTransportConfig: () => ManagementTransportConfig;
  infrakineticBaseUrl: string;
  // 1A.8.4 — the desired-tenant-lifecycle projection (governance.
  // commissioned_tenants), read/written by the commission/suspend/resume/
  // decommission routes below.
  commissionedTenants: CommissionedTenantsRepository;
  // 1A.12.4 — real operator step-up. Injectable for tests, same pattern as
  // createBrowserAuthRouter's own loadConfig/fetchImpl.
  loadBrowserAuthConfig?: () => BrowserAuthConfig;
  fetchImpl?: typeof fetch;
  // 1A.12.5 — the maker-checker approval substrate for R3 identity actions.
  approvals: ManagementApprovalStore;
}

// 1A.2 route integration points (whoami/session/audit) prove the operator
// authentication/authorization/session seams end-to-end. /tenants and
// /tenants/:identifier (1A.7) and /engine-state/:engineKey (1A.6) are the
// real operator-facing verticals built on top of that seam.
export function createManagementRouter(deps: ManagementRouterDeps): Router {
  const router = Router();
  const auth = requireManagementApiAuth(deps);

  router.use(auth);
  router.use(requireBrowserCsrf());

  router.get("/whoami", (req, res) => {
    res.status(200).json({
      operator: req.operatorContext,
      csrfToken: req.operatorAuthMethod === "browser-session" ? req.browserSessionCsrfToken : undefined,
    });
  });

  router.post("/session/logout", async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      if (req.operatorAuthMethod === "browser-session" && deps.browserAuthStore) {
        await deps.browserAuthStore.revokeSession(ctx.operatorSessionId, "operator-initiated logout");
      }
      await deps.sessionStore.revoke(ctx.operatorSessionId, "operator-initiated logout");
      await deps.auditSink.record({
        eventType: "session.revoked",
        occurredAt: new Date().toISOString(),
        operatorId: ctx.operatorId,
        operatorSessionId: ctx.operatorSessionId,
        reasonCode: "OPERATOR_LOGOUT",
        route: req.originalUrl,
        method: req.method,
        correlationId: ctx.correlationId,
      });
      res.clearCookie("__Host-governance_session", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
      res.clearCookie("__Host-governance_csrf", { httpOnly: false, secure: true, sameSite: "lax", path: "/" });
      res.clearCookie("governance_session", { httpOnly: true, secure: false, sameSite: "lax", path: "/" });
      res.clearCookie("governance_csrf", { httpOnly: false, secure: false, sameSite: "lax", path: "/" });
      res.status(200).json({ status: "revoked" });
    } catch (err) {
      next(err);
    }
  });

  // Never persist caller-asserted step-up evidence. Real step-up must be
  // backed by a fresh Cognito MFA challenge before this route is enabled.
  router.post("/session/step-up", (_req, _res, next) => {
    next(new StepUpNotConfiguredError());
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1A.12.4 — real operator step-up. Browser-navigated (GET, redirect-
  // based), NOT the JSON POST stub above: a step-up cannot be "asserted" by
  // a fetch() call, only proven by the operator actually completing a
  // second, forced-fresh Cognito authentication. Mirrors routes/auth/
  // index.ts's login/callback OAuth mechanics exactly (PKCE + state + nonce
  // + cookie-binding-when-present), with two deliberate differences:
  //   - `prompt=login` on the authorize URL forces a fresh interactive
  //     Cognito authentication rather than silently reusing an existing
  //     Hosted UI SSO session (§9.1 — "not silent SSO reuse"). The exact
  //     parameter is Cognito Hosted UI behavior that must be proven live
  //     during 1A.12.8 certification, not merely assumed from docs.
  //   - the callback's success path never mints a new session; it can only
  //     recordStepUp() on the SAME operator session /start was called from,
  //     and only after verifying the fresh re-auth's Cognito subject
  //     matches that session's own cognito_sub. A subject mismatch fails
  //     closed and the transaction is already consumed (single-use) by the
  //     time that check runs, so it cannot be retried.
  router.get("/session/step-up/start", async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const config = deps.loadBrowserAuthConfig ? deps.loadBrowserAuthConfig() : loadBrowserAuthConfig();
      if (!deps.browserAuthStore) {
        next(new StepUpNotConfiguredError());
        return;
      }
      const names = browserCookieNames(config.secureCookies);
      const transactionSecret = randomOpaqueSecret();
      const state = randomOpaqueSecret();
      const nonce = randomOpaqueSecret();
      const codeVerifier = randomOpaqueSecret(48);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + config.oauthTransactionTtlSeconds * 1000);
      const stepUpRedirectUri = new URL("/management/v1/session/step-up/callback", new URL(config.redirectUri).origin).toString();

      await deps.browserAuthStore.createStepUpTransaction({
        transactionHash: sha256Base64Url(transactionSecret),
        stateHash: sha256Base64Url(state),
        nonce,
        codeVerifier,
        boundOperatorSessionId: ctx.operatorSessionId,
        boundCognitoSub: ctx.cognitoSub,
        returnPath: safeRelativeReturnPath(req.query.returnTo),
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      res.cookie(names.stepUp, transactionSecret, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: config.oauthTransactionTtlSeconds * 1000,
      });

      const url = new URL(`${config.cognitoDomain}/login`);
      url.searchParams.set("client_id", config.appClientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email");
      url.searchParams.set("redirect_uri", stepUpRedirectUri);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("prompt", "login");
      res.redirect(302, url.toString());
    } catch (err) {
      next(err);
    }
  });

  // Clock skew tolerated between Governance and Cognito when comparing the
  // ID token's auth_time with the step-up transaction's start.
  const STEP_UP_AUTH_TIME_SKEW_SECONDS = 30;

  router.get("/session/step-up/callback", async (req, res, next) => {
    let config: BrowserAuthConfig;
    try {
      config = deps.loadBrowserAuthConfig ? deps.loadBrowserAuthConfig() : loadBrowserAuthConfig();
    } catch (err) {
      next(err);
      return;
    }
    if (!deps.browserAuthStore) {
      next(new StepUpNotConfiguredError());
      return;
    }
    const fetchImpl = deps.fetchImpl ?? fetch;
    const names = browserCookieNames(config.secureCookies);

    function clearStepUpCookie() {
      res.clearCookie(names.stepUp, { httpOnly: true, secure: config.secureCookies, sameSite: "lax", path: "/" });
    }
    function redirectStepUpFailure(code: string) {
      const url = new URL(config.frontendOrigin);
      url.searchParams.set("stepUp", code);
      res.redirect(302, url.toString());
    }

    try {
      const cookies = parseCookies(req.header("cookie"));
      const transactionSecret = cookies[names.stepUp];
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const state = typeof req.query.state === "string" ? req.query.state : undefined;

      if (!code || !state || typeof req.query.error === "string") {
        await deps.auditSink.record({
          eventType: "authz.denied",
          occurredAt: new Date().toISOString(),
          operatorId: req.operatorContext?.operatorId,
          operatorSessionId: req.operatorContext?.operatorSessionId,
          reasonCode: typeof req.query.error === "string" ? "STEP_UP_OAUTH_PROVIDER_ERROR" : "STEP_UP_CALLBACK_PARAMS_MISSING",
        });
        clearStepUpCookie();
        redirectStepUpFailure("failed");
        return;
      }

      // Single-use: consuming by state hash immediately marks the
      // transaction consumed, so a subject-mismatch failure below can never
      // be retried against the same transaction.
      const transaction = await deps.browserAuthStore.consumeStepUpTransactionByStateHash(sha256Base64Url(state));
      clearStepUpCookie();
      if (!transaction) {
        await deps.auditSink.record({ eventType: "authz.denied", occurredAt: new Date().toISOString(), reasonCode: "STEP_UP_STATE_INVALID" });
        redirectStepUpFailure("failed");
        return;
      }

      const cookieBindingVerified = Boolean(transactionSecret) && safeEqualText(sha256Base64Url(transactionSecret ?? ""), transaction.transactionHash);
      if (transactionSecret && !cookieBindingVerified) {
        await deps.auditSink.record({ eventType: "authz.denied", occurredAt: new Date().toISOString(), reasonCode: "STEP_UP_COOKIE_BINDING_MISMATCH" });
        redirectStepUpFailure("failed");
        return;
      }

      const basicAuth = Buffer.from(`${config.appClientId}:${config.appClientSecret}`, "utf8").toString("base64");
      const stepUpRedirectUri = new URL("/management/v1/session/step-up/callback", new URL(config.redirectUri).origin).toString();
      const tokenResponse = await fetchImpl(`${config.cognitoDomain}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basicAuth}` },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.appClientId,
          code,
          redirect_uri: stepUpRedirectUri,
          code_verifier: transaction.codeVerifier,
        }).toString(),
      });
      if (!tokenResponse.ok) {
        await deps.auditSink.record({
          eventType: "authz.denied", occurredAt: new Date().toISOString(),
          operatorSessionId: transaction.boundOperatorSessionId, reasonCode: "STEP_UP_TOKEN_EXCHANGE_FAILED",
        });
        redirectStepUpFailure("failed");
        return;
      }

      const tokenBody = (await tokenResponse.json()) as { id_token?: string };
      if (!tokenBody.id_token) {
        await deps.auditSink.record({
          eventType: "authz.denied", occurredAt: new Date().toISOString(),
          operatorSessionId: transaction.boundOperatorSessionId, reasonCode: "STEP_UP_ID_TOKEN_MISSING",
        });
        redirectStepUpFailure("failed");
        return;
      }

      const claims = await deps.identityProvider.verifyToken(tokenBody.id_token);
      if (claims.rawClaims.nonce !== transaction.nonce) {
        await deps.auditSink.record({
          eventType: "authz.denied", occurredAt: new Date().toISOString(),
          operatorSessionId: transaction.boundOperatorSessionId, reasonCode: "STEP_UP_NONCE_INVALID",
        });
        redirectStepUpFailure("failed");
        return;
      }

      // The one check this whole flow exists for: the fresh re-auth MUST be
      // the SAME subject as the session that started it. This is what
      // prevents the callback from ever annotating a different operator's
      // session with someone else's step-up proof.
      if (claims.subject !== transaction.boundCognitoSub) {
        await deps.auditSink.record({
          eventType: "authz.denied", occurredAt: new Date().toISOString(),
          operatorSessionId: transaction.boundOperatorSessionId, reasonCode: "STEP_UP_SUBJECT_MISMATCH",
        });
        redirectStepUpFailure("forbidden");
        return;
      }

      // Audit remediation M8 — prove the re-authentication actually happened
      // AFTER this step-up began, rather than trusting Cognito to have
      // honoured prompt=login. A silently reused Hosted UI SSO session yields
      // an ID token whose auth_time predates the transaction; that must not
      // be recorded as a fresh re-auth. Missing auth_time fails closed.
      const authTime = claims.rawClaims.auth_time;
      const transactionStartedSeconds = Math.floor(new Date(transaction.createdAt).getTime() / 1000);
      if (typeof authTime !== "number" || authTime < transactionStartedSeconds - STEP_UP_AUTH_TIME_SKEW_SECONDS) {
        await deps.auditSink.record({
          eventType: "authz.denied", occurredAt: new Date().toISOString(),
          operatorSessionId: transaction.boundOperatorSessionId, reasonCode: "STEP_UP_NOT_FRESH",
        });
        redirectStepUpFailure("failed");
        return;
      }

      const verifiedAt = new Date().toISOString();
      await deps.sessionStore.recordStepUp(transaction.boundOperatorSessionId, { verifiedAt, method: "cognito-fresh-reauth" });
      await deps.auditSink.record({
        eventType: "session.step_up_recorded",
        occurredAt: verifiedAt,
        operatorSessionId: transaction.boundOperatorSessionId,
        reasonCode: "STEP_UP_VERIFIED",
        detail: { cookieBindingVerified },
      });

      res.redirect(302, `${config.frontendOrigin}${transaction.returnPath}`);
    } catch (err) {
      next(err);
    }
  });

  router.get("/audit/self-test", requireScope("audit.read", deps.auditSink), (req, res) => {
    res.status(200).json({ status: "ok", operatorId: req.operatorContext?.operatorId });
  });

  router.get(
    "/audit/self-test/step-up",
    requireStepUp(300, deps.sessionStore, deps.auditSink),
    requireRole("platform_admin", deps.auditSink),
    (req, res) => {
      res.status(200).json({ status: "ok", operatorId: req.operatorContext?.operatorId });
    },
  );

  // 1A.7 — tenant registry, read-only (R0, no ledger — see
  // tenantRegistryQuery.ts's header for why). tenants.read already existed,
  // unused, in the 1A.2 scope catalog; no new scope was introduced.
  router.get("/tenants", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listTenantRegistry(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/tenants/:identifier", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getTenantRegistryEntry(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          identifier: req.params.identifier,
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownTenantError) {
        res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
        return;
      }
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  // Tenant-user inventory, read-only (same R0/no-ledger reasoning as the
  // registry routes above). Governance never reads app_users directly —
  // this goes through Infrakinetic's own Management API contract only,
  // same as every other tenant-registry read.
  router.get("/tenants/:identifier/users", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getTenantRegistryUsers(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          identifier: req.params.identifier,
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownTenantError) {
        res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
        return;
      }
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  // 1A.1–1A.7 closure pass — the engine catalog + per-engine platform state,
  // read-only (R0, same reasoning as the /tenants routes above). This is
  // what lets the Platform page show a real engine list instead of asking
  // the operator to type a raw engine key by hand.
  router.get("/engines", requireScope("engines.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listEngineCatalog(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      next(err);
    }
  });

  // 1A.1–1A.7 closure pass — bounded, newest-first read of the 1A.5 ledger.
  // Powers the Overview dashboard's "recent privileged operations" feed.
  // Purely a Governance-DB read (no Infrakinetic call, no assertion minted)
  // — same scope as the existing single-operation GET below, for
  // consistency; no new scope invented.
  router.get("/operations", requireScope("engines.read", deps.auditSink), async (req, res, next) => {
    try {
      const rawLimit = req.query.limit;
      let limit: number | undefined;
      if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed) || parsed < 1) {
          res.status(400).json({ error: "INVALID_LIMIT" });
          return;
        }
        limit = parsed;
      }

      const rawStatus = req.query.status;
      let status: OperationStatus | undefined;
      if (typeof rawStatus === "string" && rawStatus.trim() !== "") {
        if (!isOperationStatus(rawStatus)) {
          res.status(400).json({ error: "INVALID_STATUS" });
          return;
        }
        status = rawStatus;
      }

      const action = typeof req.query.action === "string" && req.query.action.trim() !== "" ? req.query.action : undefined;
      const tenantId = typeof req.query.tenantId === "string" && req.query.tenantId.trim() !== "" ? req.query.tenantId : undefined;
      const engineKey = typeof req.query.engineKey === "string" && req.query.engineKey.trim() !== "" ? req.query.engineKey : undefined;

      const operations = await deps.ledger.listOperations({
        limit,
        status,
        requestedAction: action,
        targetTenantId: tenantId,
        targetEngine: engineKey,
      });

      res.status(200).json({
        operations: operations.map((op) => ({
          operationId: op.operationId,
          requestedAction: op.requestedAction,
          targetTenantId: op.targetTenantId,
          targetEngine: op.targetEngine,
          riskClass: op.riskClass,
          status: op.status,
          reason: op.reason,
          correlationId: op.correlationId,
          requestedAt: op.requestedAt,
          acceptedAt: op.acceptedAt,
          completedAt: op.completedAt,
          failedAt: op.failedAt,
        })),
      });
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  // 1A.6 — the real vertical. Originally shipped without step-up because the
  // step-up challenge was then only a skeleton (wiring an R4 action to a fake
  // step-up would have been false assurance). Audit remediation M7: real
  // Cognito re-auth step-up shipped in 1A.12.4, so that justification is
  // gone — global engine disable is R4 (master plan §20, "strongest
  // controls") and now needs a fresh step-up, like every R3 action already
  // does. Only the R4 transition (desiredState 'disabled') is gated: moving
  // an engine back to operational/degraded is R2 recovery and must stay fast
  // during an incident. engines.platform_state.write stays restricted to
  // platform_admin/break_glass by ROLE_SCOPE_CEILING (roles.ts). R4
  // maker-checker and the break-glass policy remain 1A.19's deliverable.
  const requireStepUpForR4EngineState = requireStepUp(300, deps.sessionStore, deps.auditSink);
  router.put(
    "/engine-state/:engineKey",
    requireScope("engines.platform_state.write", deps.auditSink),
    (req, res, next) => {
      const desiredState = (req.body as Record<string, unknown> | undefined)?.desiredState;
      if (desiredState === "disabled") return requireStepUpForR4EngineState(req, res, next);
      next();
    },
    async (req, res, next) => {
      try {
        const ctx = req.operatorContext;
        if (!ctx) {
          res.status(403).json({ error: "NOT_AUTHENTICATED" });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
          res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
          return;
        }
        if (typeof body.reason !== "string" || body.reason.trim() === "") {
          res.status(400).json({ error: "REASON_REQUIRED" });
          return;
        }
        const desiredState = body.desiredState;
        if (desiredState !== "operational" && desiredState !== "degraded" && desiredState !== "disabled") {
          res.status(400).json({ error: "INVALID_DESIRED_STATE" });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await requestEngineStateChange(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            engineKeyOrAlias: req.params.engineKey,
            desiredState,
            reason: body.reason,
            metadata: typeof body.metadata === "object" && body.metadata !== null ? (body.metadata as Record<string, unknown>) : undefined,
            recoveryIntent: typeof body.recoveryIntent === "string" ? body.recoveryIntent : undefined,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (err instanceof UnknownEngineError) {
          res.status(404).json({ error: "UNKNOWN_ENGINE", message: err.message });
          return;
        }
        if (err instanceof MissingRecoveryIntentError) {
          res.status(400).json({ error: "RECOVERY_INTENT_REQUIRED", message: err.message });
          return;
        }
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) {
          res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
          return;
        }
        if (err instanceof ManagementOperationError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        if (err instanceof DatabaseUnavailableError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  router.get("/operations/:operationId", requireScope("engines.read", deps.auditSink), async (req, res, next) => {
    try {
      const operation = await deps.ledger.getOperation(req.params.operationId);
      res.status(200).json({ operation });
    } catch (err) {
      if (err instanceof OperationNotFoundError) {
        res.status(404).json({ error: err.code, message: err.message });
        return;
      }
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  router.post(
    "/operations/:operationId/recover",
    requireScope("engines.platform_state.write", deps.auditSink),
    async (req, res, next) => {
      try {
        const ctx = req.operatorContext;
        if (!ctx) {
          res.status(403).json({ error: "NOT_AUTHENTICATED" });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
          res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
          return;
        }
        if (typeof body.reason !== "string" || body.reason.trim() === "") {
          res.status(400).json({ error: "REASON_REQUIRED" });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await recoverEngineState(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          deps.ledger,
          {
            originalOperationId: req.params.operationId,
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            reason: body.reason,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (err instanceof OperationNotFoundError) {
          res.status(404).json({ error: err.code, message: err.message });
          return;
        }
        if (err instanceof ManagementOperationError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        if (err instanceof DatabaseUnavailableError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // 1A.8.4 — the real tenant-commissioning vertical, mirroring the engine-
  // state vertical's own shape above (requireScope, R2 reason requirement,
  // idempotencyKey requirement, ManagementOperationError/DatabaseUnavailableError
  // mapping). commissionRequestId is Governance-generated here (not
  // caller-supplied) — the operator's browser has no legitimate reason to
  // mint its own commission identity.
  type CommissionBody = Omit<Parameters<typeof requestTenantCommission>[1],
    "operatorId" | "operatorSessionId" | "operatorRoles" | "operatorGrantedScopes" | "commissionRequestId" | "correlationId" | "causationId">;

  // Shared by commission and commission-repair: returns the parsed body, or
  // writes the 400 and returns undefined.
  function parseCommissionBody(raw: unknown, res: import("express").Response): CommissionBody | undefined {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") { res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" }); return undefined; }
    if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return undefined; }
    if (typeof body.name !== "string" || body.name.trim() === "") { res.status(400).json({ error: "NAME_REQUIRED" }); return undefined; }
    if (typeof body.plan !== "string" || body.plan.trim() === "") { res.status(400).json({ error: "PLAN_REQUIRED" }); return undefined; }
    if (body.accountType !== "demo" && body.accountType !== "live") { res.status(400).json({ error: "INVALID_ACCOUNT_TYPE" }); return undefined; }
    const sendInvite = body.sendInvite !== false;
    const initialAdmin = body.initialAdmin as { name?: string; email?: string } | undefined;
    if (sendInvite && (!initialAdmin?.name || !initialAdmin?.email)) { res.status(400).json({ error: "INITIAL_ADMIN_REQUIRED" }); return undefined; }
    return {
      idempotencyKey: body.idempotencyKey,
      name: body.name,
      slug: typeof body.slug === "string" ? body.slug : undefined,
      plan: body.plan,
      industry: typeof body.industry === "string" ? body.industry : undefined,
      country: typeof body.country === "string" ? body.country : undefined,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      accountType: body.accountType,
      trialDays: typeof body.trialDays === "number" ? body.trialDays : undefined,
      initialAdmin: sendInvite || initialAdmin ? (initialAdmin as { name: string; email: string }) : undefined,
      sendInvite,
      reason: body.reason,
    };
  }

  function commissionErrorResponse(err: unknown, res: import("express").Response): boolean {
    if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return true; }
    if (err instanceof ManagementOperationError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return true; }
    if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return true; }
    return false;
  }

  router.post(
    "/tenants/commission",
    requireScope("tenants.commission", deps.auditSink),
    async (req, res, next) => {
      try {
        const ctx = req.operatorContext;
        if (!ctx) {
          res.status(403).json({ error: "NOT_AUTHENTICATED" });
          return;
        }
        const parsed = parseCommissionBody(req.body, res);
        if (!parsed) return;

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await requestTenantCommission(
          { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            ...parsed,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            // Stable across a same-key retry (audit remediation M5), so a
            // timeout retry replays instead of 409-ing.
            commissionRequestId: await deps.ledger.resolveStableRequestId(parsed.idempotencyKey, "tenant.commission", "commission_request"),
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (commissionErrorResponse(err, res)) return;
        next(err);
      }
    },
  );

  // Audit remediation H3 — the repair path the owner-side receipt design
  // exists for (Infrakinetic resumes from durable stage checkpoints when it
  // sees a NEW idempotency key with the SAME commissionRequestId). Before
  // this route, every HTTP commission minted a fresh commissionRequestId, so
  // a partially-completed commission (e.g. identity stage failed) had no
  // reachable repair. Governance never stored the admin's PII (0006), so the
  // operator resubmits the commission fields; they must match the stored
  // desired name/plan/account type/slug, so a repair can finish the approved
  // commission but never repurpose it.
  router.post(
    "/tenants/commission-requests/:commissionRequestId/repair",
    requireScope("tenants.commission", deps.auditSink),
    async (req, res, next) => {
      try {
        const ctx = req.operatorContext;
        if (!ctx) {
          res.status(403).json({ error: "NOT_AUTHENTICATED" });
          return;
        }
        const parsed = parseCommissionBody(req.body, res);
        if (!parsed) return;

        const projection = await deps.commissionedTenants.getByCommissionRequestId(req.params.commissionRequestId);
        if (!projection || projection.provenance !== "governance_commissioned") {
          res.status(404).json({ error: "COMMISSION_REQUEST_NOT_FOUND" });
          return;
        }
        if (projection.lifecycleState !== "provisioning") {
          res.status(409).json({
            error: "COMMISSION_NOT_REPAIRABLE",
            message: `Only a commission still in 'provisioning' can be repaired; this one is '${projection.lifecycleState}'.`,
          });
          return;
        }
        if (
          projection.desiredName !== parsed.name ||
          projection.desiredPlan !== parsed.plan ||
          projection.accountType !== parsed.accountType ||
          (projection.desiredSlug ?? undefined) !== (parsed.slug ?? undefined)
        ) {
          res.status(409).json({ error: "COMMISSION_REPAIR_MISMATCH", message: "Repair must resubmit the original commission's name, slug, plan and account type." });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();
        const result = await requestTenantCommission(
          { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            ...parsed,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            commissionRequestId: req.params.commissionRequestId,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (commissionErrorResponse(err, res)) return;
        next(err);
      }
    },
  );

  // H3 operator surface — what the repair dialog shows and prefills: the
  // stored, approved commission (Governance-owned desired fields only; the
  // initial admin's PII was never stored, per 0006). Read-only, R0; gated on
  // the same scope as the repair it exists to prefill.
  router.get(
    "/tenants/commission-requests/:commissionRequestId",
    requireScope("tenants.commission", deps.auditSink),
    async (req, res, next) => {
      try {
        const projection = await deps.commissionedTenants.getByCommissionRequestId(req.params.commissionRequestId);
        if (!projection || projection.provenance !== "governance_commissioned") {
          res.status(404).json({ error: "COMMISSION_REQUEST_NOT_FOUND" });
          return;
        }
        res.status(200).json({
          commissionRequest: {
            commissionRequestId: req.params.commissionRequestId,
            tenantId: projection.tenantId ?? null,
            lifecycleState: projection.lifecycleState,
            repairable: projection.lifecycleState === "provisioning",
            desiredName: projection.desiredName,
            desiredSlug: projection.desiredSlug ?? null,
            desiredPlan: projection.desiredPlan,
            accountType: projection.accountType,
          },
        });
      } catch (err) {
        if (err instanceof DatabaseUnavailableError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  const TENANT_TRANSITION_ROUTES = [
    { segment: "suspend", scope: "tenants.suspend", fn: requestTenantSuspend },
    { segment: "resume", scope: "tenants.resume", fn: requestTenantResume },
    { segment: "decommission", scope: "tenants.decommission", fn: requestTenantDecommission },
  ] as const;

  for (const { segment, scope, fn } of TENANT_TRANSITION_ROUTES) {
    router.post(
      `/tenants/:tenantId/${segment}`,
      requireScope(scope, deps.auditSink),
      async (req, res, next) => {
        try {
          const ctx = req.operatorContext;
          if (!ctx) {
            res.status(403).json({ error: "NOT_AUTHENTICATED" });
            return;
          }
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
            res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
            return;
          }
          if (typeof body.reason !== "string" || body.reason.trim() === "") {
            res.status(400).json({ error: "REASON_REQUIRED" });
            return;
          }

          const signingKeys = await deps.getManagementSigningKeys();
          const transportConfig = deps.loadTransportConfig();

          const result = await fn(
            { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
            {
              idempotencyKey: body.idempotencyKey,
              operatorId: ctx.operatorId,
              operatorSessionId: ctx.operatorSessionId,
              operatorRoles: ctx.roles,
              operatorGrantedScopes: ctx.scopes,
              tenantId: req.params.tenantId,
              reason: body.reason,
              correlationId: ctx.correlationId,
            },
          );
          res.status(200).json({ operation: result.operation, replay: result.replay });
        } catch (err) {
          if (err instanceof MissingTenantIdentifierError) {
            res.status(400).json({ error: "TENANT_ID_REQUIRED", message: err.message });
            return;
          }
          if (err instanceof UnexpectedManagementApiResponseError) {
            res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
            return;
          }
          if (err instanceof ManagementOperationError) {
            res.status(err.httpStatus).json({ error: err.code, message: err.message });
            return;
          }
          if (err instanceof DatabaseUnavailableError) {
            res.status(err.httpStatus).json({ error: err.code, message: err.message });
            return;
          }
          next(err);
        }
      },
    );
  }

  // 1A.9.4 — engine entitlement lifecycle, read half (R0, no ledger — same
  // reasoning as /tenants and /engines above). tenants.read already existed,
  // unused for this purpose, in the 1A.2 scope catalog; no new scope was
  // introduced for the reads.
  router.get("/tenants/:tenantId/engines/:engineKey/entitlement", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getTenantEngineEntitlementRead(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          tenantId: req.params.tenantId,
          engineKeyOrAlias: req.params.engineKey,
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownEntitlementTenantError) {
        res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
        return;
      }
      if (err instanceof UnknownEntitlementEngineError) {
        res.status(404).json({ error: "UNKNOWN_ENGINE", message: err.message });
        return;
      }
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/tenants/:tenantId/engines", requireScope("tenants.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listTenantEngineEntitlements(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          tenantId: req.params.tenantId,
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownEntitlementTenantError) {
        res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
        return;
      }
      if (err instanceof UnexpectedManagementApiResponseError) {
        res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
        return;
      }
      next(err);
    }
  });

  // 1A.9.4 — the real mutation vertical, mirroring the engine-state and
  // tenant-lifecycle verticals' own shape (requireScope, R2 reason
  // requirement, idempotencyKey requirement, ManagementOperationError/
  // DatabaseUnavailableError mapping). Uniformly R2 (§3.2 of the scoping
  // doc) — no step-up/maker-checker gate, same bar as tenant suspend/
  // resume/decommission.
  router.put(
    "/tenants/:tenantId/engines/:engineKey/entitlement",
    requireScope("engines.entitlement.write", deps.auditSink),
    async (req, res, next) => {
      try {
        const ctx = req.operatorContext;
        if (!ctx) {
          res.status(403).json({ error: "NOT_AUTHENTICATED" });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
          res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
          return;
        }
        if (typeof body.reason !== "string" || body.reason.trim() === "") {
          res.status(400).json({ error: "REASON_REQUIRED" });
          return;
        }
        if (typeof body.enabled !== "boolean") {
          res.status(400).json({ error: "INVALID_ENABLED" });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await requestTenantEngineEntitlementChange(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            tenantId: req.params.tenantId,
            engineKeyOrAlias: req.params.engineKey,
            enabled: body.enabled,
            reason: body.reason,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (err instanceof MissingEntitlementTenantIdentifierError) {
          res.status(400).json({ error: "TENANT_ID_REQUIRED", message: err.message });
          return;
        }
        if (err instanceof UnknownEntitlementTenantError) {
          res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
          return;
        }
        if (err instanceof UnknownEntitlementEngineError) {
          res.status(404).json({ error: "UNKNOWN_ENGINE", message: err.message });
          return;
        }
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) {
          res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
          return;
        }
        if (err instanceof ManagementOperationError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        if (err instanceof DatabaseUnavailableError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // 1A.10.5 — reconciliation drift read (R0). runtime.read already existed,
  // unused, in the 1A.2 scope catalog. Optional ?tenantId narrows every
  // drift class to one real tenant, same shape as /operations' own optional
  // filters above.
  router.get("/reconciliation/drift", requireScope("runtime.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) {
        res.status(403).json({ error: "NOT_AUTHENTICATED" });
        return;
      }
      const tenantId = typeof req.query.tenantId === "string" && req.query.tenantId.trim() !== "" ? req.query.tenantId : undefined;
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listDrift(
        { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          operatorId: ctx.operatorId,
          operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles,
          operatorGrantedScopes: ctx.scopes,
          correlationId: ctx.correlationId,
          tenantId,
        },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownTenantError) {
        res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
        return;
      }
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message });
        return;
      }
      next(err);
    }
  });

  // 1A.10.5 — the reconciliation repair vertical. R1 (§3.9 of the scoping
  // doc — low-impact metadata, no reason required): every repair here
  // either writes Governance's own projection from a fresh owner read or
  // resolves a stuck ledger operation from a durable owner-side receipt —
  // it never mutates owner state and never resends the original mutation.
  // runtime.repair.request already existed, unused, in the 1A.2 scope
  // catalog.
  router.post(
    "/reconciliation/tenants/:tenantId/recheck",
    requireScope("runtime.repair.request", deps.auditSink),
    async (req, res, next) => {
      try {
        const ctx = req.operatorContext;
        if (!ctx) {
          res.status(403).json({ error: "NOT_AUTHENTICATED" });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
          res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();

        const result = await reconcileTenant(
          { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            tenantId: req.params.tenantId,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json(result);
      } catch (err) {
        if (err instanceof UnknownTenantError) {
          res.status(404).json({ error: "UNKNOWN_TENANT", message: err.message });
          return;
        }
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) {
          res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message });
          return;
        }
        if (err instanceof ManagementOperationError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        if (err instanceof DatabaseUnavailableError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // Audit remediation M3 — the same R1 receipt-driven resolution for a
  // commission request whose projection has no tenant id yet (ambiguous
  // before the owner reported one), which no per-tenant recheck can reach.
  router.post(
    "/reconciliation/commission-requests/:commissionRequestId/recheck",
    requireScope("runtime.repair.request", deps.auditSink),
    async (req, res, next) => {
      try {
        const ctx = req.operatorContext;
        if (!ctx) {
          res.status(403).json({ error: "NOT_AUTHENTICATED" });
          return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") {
          res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" });
          return;
        }
        const projection = await deps.commissionedTenants.getByCommissionRequestId(req.params.commissionRequestId);
        if (!projection) {
          res.status(404).json({ error: "COMMISSION_REQUEST_NOT_FOUND" });
          return;
        }
        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();
        const result = await reconcileCommissionRequest(
          { ledger: deps.ledger, commissionedTenants: deps.commissionedTenants, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey,
            operatorId: ctx.operatorId,
            operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles,
            operatorGrantedScopes: ctx.scopes,
            commissionRequestId: req.params.commissionRequestId,
            correlationId: ctx.correlationId,
          },
        );
        res.status(200).json(result);
      } catch (err) {
        if (err instanceof ManagementOperationError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        if (err instanceof DatabaseUnavailableError) {
          res.status(err.httpStatus).json({ error: err.code, message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // 1A.12 — identity administration. Reads (R0, no ledger, same reasoning
  // as /tenants above) plus the routine (R2) invitation/recovery/access-
  // lifecycle commands. R3 actions (force-reset, mfa.reset) are a separate
  // vertical (identityApprovalOperation.ts, 1A.12.5) requiring step-up and
  // maker-checker approval — not wired here.
  // ───────────────────────────────────────────────────────────────────────

  router.get("/tenants/:tenantId/identities", requireScope("identity.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listTenantIdentities(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  router.get("/tenants/:tenantId/identities/:userId", requireScope("identity.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getIdentityDetail(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, userId: req.params.userId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownIdentityError) { res.status(404).json({ error: "IDENTITY_NOT_FOUND", message: err.message }); return; }
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  router.get("/tenants/:tenantId/identities/:userId/history", requireScope("identity.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getIdentityHistory(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, userId: req.params.userId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownIdentityError) { res.status(404).json({ error: "IDENTITY_NOT_FOUND", message: err.message }); return; }
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  function identityOperationErrorResponse(err: unknown, res: import("express").Response): boolean {
    if (err instanceof MissingIdentityTargetError) { res.status(400).json({ error: "IDENTITY_TARGET_REQUIRED", message: err.message }); return true; }
    if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return true; }
    return false;
  }

  router.get("/tenants/:tenantId/identity-invitations", requireScope("identity.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listTenantInvitations(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  router.post("/tenants/:tenantId/identity-invitations", requireScope("identity.recovery", deps.auditSink), async (req, res, next) => {
    const ctx = req.operatorContext;
    try {
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") { res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" }); return; }
      if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return; }
      if (typeof body.email !== "string" || body.email.trim() === "") { res.status(400).json({ error: "EMAIL_REQUIRED" }); return; }

      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await requestIdentityInvitation(
        { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          idempotencyKey: body.idempotencyKey, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, tenantId: req.params.tenantId,
          invitationRequestId: await deps.ledger.resolveStableRequestId(body.idempotencyKey, "identity.invitation.issue", "identity_invitation_request"),
          email: body.email,
          fullName: typeof body.fullName === "string" ? body.fullName : undefined,
          roleKey: typeof body.roleKey === "string" ? body.roleKey : undefined,
          reason: body.reason, correlationId: ctx.correlationId,
        },
      );
      res.status(200).json({ operation: result.operation, replay: result.replay });
    } catch (err) {
      if (identityOperationErrorResponse(err, res)) return;
      if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof ManagementOperationError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  const IDENTITY_INVITATION_ACTIONS = [
    { segment: "resend", fn: requestIdentityInvitationResend },
    { segment: "cancel", fn: requestIdentityInvitationCancel },
  ] as const;

  for (const { segment, fn } of IDENTITY_INVITATION_ACTIONS) {
    router.post(`/tenants/:tenantId/identity-invitations/:invitationId/${segment}`, requireScope("identity.recovery", deps.auditSink), async (req, res, next) => {
      const ctx = req.operatorContext;
      try {
        if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") { res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" }); return; }
        if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return; }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();
        const result = await fn(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, tenantId: req.params.tenantId,
            invitationId: req.params.invitationId, reason: body.reason, correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (identityOperationErrorResponse(err, res)) return;
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
        if (err instanceof ManagementOperationError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
        next(err);
      }
    });
  }

  const IDENTITY_USER_ACTIONS = [
    { segment: "recovery", scope: "identity.recovery", fn: requestIdentityRecovery },
    { segment: "suspend", scope: "identity.disable", fn: requestIdentitySuspend },
    { segment: "restore", scope: "identity.disable", fn: requestIdentityRestore },
    { segment: "global-signout", scope: "identity.disable", fn: requestIdentityGlobalSignout },
    { segment: "sessions/revoke", scope: "identity.disable", fn: requestIdentitySessionsRevoke },
  ] as const;

  for (const { segment, scope, fn } of IDENTITY_USER_ACTIONS) {
    router.post(`/tenants/:tenantId/identities/:userId/${segment}`, requireScope(scope, deps.auditSink), async (req, res, next) => {
      const ctx = req.operatorContext;
      try {
        if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") { res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" }); return; }
        if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return; }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();
        const result = await fn(
          { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
          {
            idempotencyKey: body.idempotencyKey, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId,
            operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, tenantId: req.params.tenantId,
            userId: req.params.userId, reason: body.reason, correlationId: ctx.correlationId,
          },
        );
        res.status(200).json({ operation: result.operation, replay: result.replay });
      } catch (err) {
        if (identityOperationErrorResponse(err, res)) return;
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
        if (err instanceof ManagementOperationError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
        next(err);
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // 1A.13 — credential administration (Payments domain only, §7.4 of the
  // scoping doc). Reads (R0, no ledger, same reasoning as identity reads
  // above), test (R0/R1, no ledger — see credentialOperation.ts's header),
  // and replace (R2, ledger-backed). R3 actions (rotate, revoke) are a
  // separate vertical (credentialApprovalOperation.ts) requiring step-up and
  // maker-checker approval — wired into the shared R3 approval section below.
  // ───────────────────────────────────────────────────────────────────────

  router.get("/tenants/:tenantId/credentials", requireScope("credentials.metadata.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await listTenantCredentials(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  router.get("/tenants/:tenantId/credentials/:credentialId", requireScope("credentials.metadata.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getCredentialDetail(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, credentialId: req.params.credentialId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownCredentialError) { res.status(404).json({ error: "CREDENTIAL_NOT_FOUND", message: err.message }); return; }
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  router.get("/tenants/:tenantId/credentials/:credentialId/history", requireScope("credentials.metadata.read", deps.auditSink), async (req, res, next) => {
    try {
      const ctx = req.operatorContext;
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await getCredentialHistory(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, credentialId: req.params.credentialId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof UnknownCredentialError) { res.status(404).json({ error: "CREDENTIAL_NOT_FOUND", message: err.message }); return; }
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  function credentialOperationErrorResponse(err: unknown, res: import("express").Response): boolean {
    if (err instanceof MissingCredentialTargetError) { res.status(400).json({ error: "CREDENTIAL_TARGET_REQUIRED", message: err.message }); return true; }
    if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return true; }
    return false;
  }

  // Audit remediation L7 — a test decrypts the tenant's live secrets and
  // makes a real provider call with them. That is not a metadata read: a
  // read-only platform_viewer (who holds credentials.metadata.read) must not
  // be able to trigger it. Gated on credentials.submit — the operator
  // already trusted with this credential's material. (The owner-side
  // assertion scope is unchanged: Governance is the gate that knows roles.)
  router.post("/tenants/:tenantId/credentials/:credentialId/test", requireScope("credentials.submit", deps.auditSink), async (req, res, next) => {
    const ctx = req.operatorContext;
    try {
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await requestCredentialTest(
        { signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        { tenantId: req.params.tenantId, credentialId: req.params.credentialId, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId, operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId },
      );
      res.status(200).json(result);
    } catch (err) {
      if (credentialOperationErrorResponse(err, res)) return;
      if (err instanceof UnexpectedManagementApiResponseError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      next(err);
    }
  });

  // secretKind is "webhook_secret" | "api_key_pair" (audit fix 2026-09-23 —
  // see credentialOperation.ts's header). Material fields differ per kind:
  // webhook_secret carries secretValue, api_key_pair carries apiKeyId +
  // apiKeySecret together. None of these are written into req-scoped state,
  // the ledger payload, or any response this route returns (see
  // credentialOperation.ts's header for the defense-in-depth chain).
  function requireCredentialSecretMaterial(body: Record<string, unknown>, res: import("express").Response): boolean {
    if (body.secretKind === "webhook_secret") {
      if (typeof body.secretValue !== "string" || body.secretValue.trim() === "") { res.status(400).json({ error: "SECRET_VALUE_REQUIRED" }); return false; }
      return true;
    }
    if (body.secretKind === "api_key_pair") {
      if (typeof body.apiKeyId !== "string" || body.apiKeyId.trim() === "" || typeof body.apiKeySecret !== "string" || body.apiKeySecret.trim() === "") {
        res.status(400).json({ error: "API_KEY_PAIR_REQUIRED", message: "apiKeyId and apiKeySecret are both required." });
        return false;
      }
      return true;
    }
    res.status(400).json({ error: "INVALID_SECRET_KIND", message: "secretKind must be one of webhook_secret, api_key_pair." });
    return false;
  }

  // R2 — immediate replace. Establish-only: Infrakinetic fails closed
  // (CREDENTIAL_ALREADY_ESTABLISHED, 409) when the targeted kind already has
  // live material — existing material may only be mutated via rotate (R3)
  // below.
  router.post("/tenants/:tenantId/credentials/:credentialId/replace", requireScope("credentials.submit", deps.auditSink), async (req, res, next) => {
    const ctx = req.operatorContext;
    try {
      if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") { res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" }); return; }
      if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return; }
      if (typeof body.secretKind !== "string" || body.secretKind.trim() === "") { res.status(400).json({ error: "SECRET_KIND_REQUIRED" }); return; }
      if (!requireCredentialSecretMaterial(body, res)) return;

      const signingKeys = await deps.getManagementSigningKeys();
      const transportConfig = deps.loadTransportConfig();
      const result = await requestCredentialReplace(
        { ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl },
        {
          idempotencyKey: body.idempotencyKey, operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, tenantId: req.params.tenantId,
          credentialId: req.params.credentialId, secretKind: body.secretKind,
          secretValue: typeof body.secretValue === "string" ? body.secretValue : undefined,
          apiKeyId: typeof body.apiKeyId === "string" ? body.apiKeyId : undefined,
          apiKeySecret: typeof body.apiKeySecret === "string" ? body.apiKeySecret : undefined,
          reason: body.reason, correlationId: ctx.correlationId,
        },
      );
      res.status(200).json({ operation: result.operation, replay: result.replay });
    } catch (err) {
      if (credentialOperationErrorResponse(err, res)) return;
      if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
      if (err instanceof ManagementOperationError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1A.12.5 — R3 identity actions (force-reset, mfa-reset): request (maker,
  // fresh step-up) -> decide (checker, != maker) -> execute (fresh step-up,
  // approval consumed exactly once). §9.1's default 5-minute freshness
  // applies at BOTH the request and execute steps — a maker-checker cycle
  // can span far longer than 5 minutes, so execute's step-up is expected to
  // usually be a SEPARATE, later step-up, not a reuse of the request one.
  // ───────────────────────────────────────────────────────────────────────

  function approvalErrorResponse(err: unknown, res: import("express").Response): boolean {
    if (err instanceof ApprovalNotFoundError) { res.status(404).json({ error: "APPROVAL_NOT_FOUND", message: err.message }); return true; }
    if (err instanceof ApprovalExpiredError) { res.status(409).json({ error: "APPROVAL_EXPIRED", message: err.message }); return true; }
    if (err instanceof ApprovalNotPendingError) { res.status(409).json({ error: "APPROVAL_NOT_PENDING", message: err.message }); return true; }
    if (err instanceof SelfApprovalNotAllowedError) { res.status(403).json({ error: "SELF_APPROVAL_NOT_ALLOWED", message: err.message }); return true; }
    if (err instanceof ApprovalNotApprovedError) { res.status(409).json({ error: "APPROVAL_NOT_APPROVED", message: err.message }); return true; }
    if (err instanceof ApprovalAlreadyExecutedError) { res.status(409).json({ error: "APPROVAL_ALREADY_EXECUTED", message: err.message }); return true; }
    if (err instanceof ApprovalPayloadMismatchError) { res.status(409).json({ error: "APPROVAL_PAYLOAD_MISMATCH", message: err.message }); return true; }
    if (err instanceof UnknownIdentityR3ActionError || err instanceof MissingIdentityApprovalTargetError) { res.status(400).json({ error: "IDENTITY_R3_REQUEST_INVALID", message: err.message }); return true; }
    if (err instanceof UnknownCredentialR3ActionError || err instanceof MissingCredentialApprovalTargetError) { res.status(400).json({ error: "CREDENTIAL_R3_REQUEST_INVALID", message: err.message }); return true; }
    if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return true; }
    return false;
  }

  const R3_ROUTE_SEGMENTS: Record<IdentityR3ActionKey, string> = { "force-reset": "force-reset", "mfa-reset": "mfa-reset" };

  for (const actionKey of Object.keys(IDENTITY_R3_ACTIONS) as IdentityR3ActionKey[]) {
    const { scope } = IDENTITY_R3_ACTIONS[actionKey];
    router.post(
      `/tenants/:tenantId/identities/:userId/${R3_ROUTE_SEGMENTS[actionKey]}/request`,
      requireScope(scope, deps.auditSink),
      requireStepUp(300, deps.sessionStore, deps.auditSink),
      async (req, res, next) => {
        const ctx = req.operatorContext;
        try {
          if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return; }

          const approval = await requestIdentityR3Approval(
            { approvals: deps.approvals },
            { actionKey, tenantId: req.params.tenantId, userId: req.params.userId, reason: body.reason, makerOperatorId: ctx.operatorId, correlationId: ctx.correlationId },
          );
          res.status(201).json({ approval });
        } catch (err) {
          if (approvalErrorResponse(err, res)) return;
          next(err);
        }
      },
    );
  }

  // 1A.13 — R3 credential actions (rotate, revoke): same three-phase flow as
  // identity's R3 actions above, over /credentials/:credentialId instead of
  // /identities/:userId. Rotate's request carries secretKind, overlap,
  // endpoint and the new material (audit remediation H1): all of it is bound
  // into the approval — the material only as a salted digest, never stored —
  // and the executor must resubmit identical material. See
  // credentialApprovalOperation.ts's header.
  const CREDENTIAL_R3_ROUTE_SEGMENTS: Record<CredentialR3ActionKey, string> = { rotate: "rotate", revoke: "revoke" };

  for (const actionKey of Object.keys(CREDENTIAL_R3_ACTIONS) as CredentialR3ActionKey[]) {
    const { scope } = CREDENTIAL_R3_ACTIONS[actionKey];
    router.post(
      `/tenants/:tenantId/credentials/:credentialId/${CREDENTIAL_R3_ROUTE_SEGMENTS[actionKey]}/request`,
      requireScope(scope, deps.auditSink),
      requireStepUp(300, deps.sessionStore, deps.auditSink),
      async (req, res, next) => {
        const ctx = req.operatorContext;
        try {
          if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (typeof body.reason !== "string" || body.reason.trim() === "") { res.status(400).json({ error: "REASON_REQUIRED" }); return; }
          if (actionKey === "rotate" && !requireCredentialSecretMaterial(body, res)) return;
          if (body.overlapHours !== undefined && typeof body.overlapHours !== "number") { res.status(400).json({ error: "INVALID_OVERLAP_HOURS" }); return; }

          const approval = await requestCredentialR3Approval(
            { approvals: deps.approvals },
            {
              actionKey, tenantId: req.params.tenantId, credentialId: req.params.credentialId, reason: body.reason,
              makerOperatorId: ctx.operatorId, correlationId: ctx.correlationId,
              ...(actionKey === "rotate"
                ? {
                    secretKind: body.secretKind as "webhook_secret" | "api_key_pair",
                    secretValue: typeof body.secretValue === "string" ? body.secretValue : undefined,
                    apiKeyId: typeof body.apiKeyId === "string" ? body.apiKeyId : undefined,
                    apiKeySecret: typeof body.apiKeySecret === "string" ? body.apiKeySecret : undefined,
                    overlapHours: typeof body.overlapHours === "number" ? body.overlapHours : undefined,
                    webhookEndpointId: typeof body.webhookEndpointId === "string" ? body.webhookEndpointId : undefined,
                  }
                : {}),
            },
          );
          res.status(201).json({ approval });
        } catch (err) {
          if (approvalErrorResponse(err, res)) return;
          next(err);
        }
      },
    );
  }

  function requiredScopeForApproval(approval: { requestedAction: string }): string | undefined {
    return (
      Object.values(IDENTITY_R3_ACTIONS).find((entry) => entry.action === approval.requestedAction)?.scope ??
      Object.values(CREDENTIAL_R3_ACTIONS).find((entry) => entry.action === approval.requestedAction)?.scope
    );
  }

  function isCredentialR3Approval(approval: { requestedAction: string }): boolean {
    return Object.values(CREDENTIAL_R3_ACTIONS).some((entry) => entry.action === approval.requestedAction);
  }

  // Audit remediation M8 — the checker's decision is the control maker-
  // checker exists for, so it needs the same fresh step-up as the maker's
  // request and the execution; a hijacked checker session alone must not
  // be able to approve an R3 action.
  const APPROVAL_DECISIONS = ["approve", "reject"] as const;
  for (const segment of APPROVAL_DECISIONS) {
    router.post(`/approvals/:approvalId/${segment}`, requireStepUp(300, deps.sessionStore, deps.auditSink), async (req, res, next) => {
      const ctx = req.operatorContext;
      try {
        if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }

        const approvalStore = deps.approvals;
        const current = await approvalStore.getApproval(req.params.approvalId);
        const requiredScope = requiredScopeForApproval(current);
        if (!requiredScope || !ctx.scopes.includes(requiredScope as never)) {
          res.status(403).json({ error: "SCOPE_REQUIRED", message: `Deciding this approval requires scope '${requiredScope}'.` });
          return;
        }

        const decided = await decideIdentityR3Approval(
          { approvals: deps.approvals },
          { approvalId: req.params.approvalId, checkerOperatorId: ctx.operatorId, decision: segment === "approve" ? "approved" : "rejected" },
        );
        res.status(200).json({ approval: decided });
      } catch (err) {
        if (approvalErrorResponse(err, res)) return;
        next(err);
      }
    });
  }

  // Execution is not restricted to the original maker — any operator holding
  // the approval's required scope, with their OWN fresh step-up, may execute
  // an already-approved request. That is safe only because an approval binds
  // everything the execution will do (audit remediation H1): identity R3 and
  // revoke are parameterless, and rotate's material must reproduce the
  // digest the checker approved, so an executor can carry out the approved
  // change but never substitute a different one. The approval record
  // (maker/checker/decidedAt) is the audit trail for who authorized what.
  router.post(
    "/approvals/:approvalId/execute",
    requireStepUp(300, deps.sessionStore, deps.auditSink),
    async (req, res, next) => {
      const ctx = req.operatorContext;
      try {
        if (!ctx) { res.status(403).json({ error: "NOT_AUTHENTICATED" }); return; }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.trim() === "") { res.status(400).json({ error: "IDEMPOTENCY_KEY_REQUIRED" }); return; }

        const current = await deps.approvals.getApproval(req.params.approvalId);
        const requiredScope = requiredScopeForApproval(current);
        if (!requiredScope || !ctx.scopes.includes(requiredScope as never)) {
          res.status(403).json({ error: "SCOPE_REQUIRED", message: `Executing this approval requires scope '${requiredScope}'.` });
          return;
        }

        const signingKeys = await deps.getManagementSigningKeys();
        const transportConfig = deps.loadTransportConfig();
        const approvalDeps = { approvals: deps.approvals, ledger: deps.ledger, signingKeys, transportConfig, infrakineticBaseUrl: deps.infrakineticBaseUrl };
        const executeParams = {
          approvalId: req.params.approvalId, idempotencyKey: body.idempotencyKey,
          operatorId: ctx.operatorId, operatorSessionId: ctx.operatorSessionId,
          operatorRoles: ctx.roles, operatorGrantedScopes: ctx.scopes, correlationId: ctx.correlationId,
        };
        // Dispatch by domain: identity's R3 actions (force-reset, mfa-reset)
        // are parameterless. Credential rotate needs the material resubmitted
        // (Governance never stored it); it must reproduce the digest bound at
        // request time. Kind/overlap/endpoint come from the approval itself —
        // any executor-supplied values for them are ignored.
        const result = isCredentialR3Approval(current)
          ? await executeCredentialR3Approval(approvalDeps, {
              ...executeParams,
              secretValue: typeof body.secretValue === "string" ? body.secretValue : undefined,
              apiKeyId: typeof body.apiKeyId === "string" ? body.apiKeyId : undefined,
              apiKeySecret: typeof body.apiKeySecret === "string" ? body.apiKeySecret : undefined,
            })
          : await executeIdentityR3Approval(approvalDeps, executeParams);
        res.status(200).json({ operation: result.operation, approval: result.approval, replay: result.replay });
      } catch (err) {
        if (approvalErrorResponse(err, res)) return;
        if (err instanceof UnexpectedManagementApiResponseError || err instanceof ManagementApiUnreachableError) { res.status(502).json({ error: "MANAGEMENT_API_UPSTREAM_ERROR", message: err.message }); return; }
        if (err instanceof ManagementOperationError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
        next(err);
      }
    },
  );

  router.get("/approvals", requireScope("identity.read", deps.auditSink), async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" && req.query.status.trim() !== "" ? req.query.status : undefined;
      if (status !== undefined && !["pending", "approved", "rejected", "expired"].includes(status)) {
        res.status(400).json({ error: "INVALID_STATUS" });
        return;
      }
      const tenantId = typeof req.query.tenantId === "string" && req.query.tenantId.trim() !== "" ? req.query.tenantId : undefined;
      const rawLimit = req.query.limit;
      let limit: number | undefined;
      if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed) || parsed < 1) { res.status(400).json({ error: "INVALID_LIMIT" }); return; }
        limit = parsed;
      }
      const approvals = await deps.approvals.listApprovals({ status: status as never, targetTenantId: tenantId, limit });
      res.status(200).json({ approvals });
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) { res.status(err.httpStatus).json({ error: err.code, message: err.message }); return; }
      next(err);
    }
  });

  router.get("/approvals/:approvalId", requireScope("identity.read", deps.auditSink), async (req, res, next) => {
    try {
      const approval = await deps.approvals.getApproval(req.params.approvalId);
      res.status(200).json({ approval });
    } catch (err) {
      if (approvalErrorResponse(err, res)) return;
      next(err);
    }
  });

  // Express 4 does not auto-forward rejected async promises. Async handlers
  // above explicitly call next(err), and this router-local typed boundary
  // preserves fail-closed responses for failures after authentication.
  const managementErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
    if (!(err instanceof ManagementAuthError)) {
      next(err);
      return;
    }
    const ctx = req.operatorContext;
    void Promise.resolve(
      deps.auditSink.record({
        eventType: "authz.denied",
        occurredAt: new Date().toISOString(),
        operatorId: ctx?.operatorId,
        operatorSessionId: ctx?.operatorSessionId,
        reasonCode: err.code,
        route: req.originalUrl,
        method: req.method,
        correlationId: ctx?.correlationId,
      }),
    )
      .then(() => {
        res.status(err.httpStatus).json({
          error: err.code,
          message: err.message,
          correlationId: ctx?.correlationId,
        });
      })
      .catch(next);
  };
  router.use(managementErrorHandler);

  return router;
}
