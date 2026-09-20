import { randomUUID, timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, RequestHandler, Response } from "express";

import { DatabaseUnavailableError } from "../db/errors.js";
import type { AuditSink } from "../identity/auditSink.js";
import type { OperatorContext } from "../identity/types.js";

// Phase 1A.11 — a SEPARATE, narrowly-scoped auth boundary for exactly one
// capability: the public self-service signup path mounted at
// /public-onboarding/v1/commission (routes/publicOnboarding/index.ts).
// Decision log 2026-09-19 ("Q1 — Public self-service signup"): the browser
// must never hold X-Platform-Key or any other general provisioning
// credential, and the service identity used to enter Governance must be
// "narrowly scoped to public onboarding, not a general provisioning
// credential". Two deliberate design choices make that concrete:
//
//   1. This is NOT requireManagementApiAuth. That boundary is Cognito/MFA/
//      human-operator-session shaped (identity/roles.ts's ROLE_SCOPE_CEILING
//      cross-check, session revocation, step-up) — reusing or extending it
//      for a machine caller would either weaken those human-operator
//      invariants or bolt an awkward "is this a robot" branch onto a
//      security-critical path that has none today. A brand-new, small,
//      independently-auditable middleware is safer than widening that one.
//   2. Narrowness is enforced by HARDCODING scopes/roles below, never by
//      trusting anything the caller sends. Even if
//      PUBLIC_ONBOARDING_SERVICE_KEY leaked, the caller can reach only this
//      one route with this hardcoded, fixed scope set — there is no config
//      path that widens it, unlike X-Platform-Key (shared by ~35 unrelated
//      Infrakinetic jobs plus the entire legacy /admin surface).
//
// CORRECTED 2026-09-19 (pre-commit review): the scope set is
// ["tenants.commission", "tenants.read"], not commission alone.
// routes/publicOnboarding/index.ts's post-commission step reads the fresh
// tenant registry entry to surface the real trial_ends_at (never a locally
// fabricated date) — that read mints an assertion requesting tenants.read,
// and mintManagementAssertion() throws ScopeNotGrantedError for any
// requested scope not in operatorGrantedScopes. Commission-only would have
// made that read silently fail (caught, trialEndsAt null) on every real
// request, not just in a misconfigured one. tenants.read is still narrow —
// it grants no suspend/resume/decommission/entitlement/engine-state
// capability, only "commission a tenant, then read tenant registry
// entries" (needed to read arbitrary OTHER tenants' registry rows too,
// which this identity could technically do since Infrakinetic's own
// GET /tenants/:id has no per-caller tenant restriction — a real but
// low-severity widening versus reading only the one just-created tenant;
// narrowing that further would require a new Infrakinetic-side
// capability that does not exist today).
//
// The operator identity attached to every request here is the fixed
// system-operator row seeded by migrations/0007_public_onboarding_service_
// operator.sql — required because governance.management_operations.
// operator_id is a NOT NULL FK into governance.operators (0003); this path
// still produces real, auditable ledger entries, just attributed to a
// permanent system identity instead of a human.
//
// This is a static shared secret (same timingSafeEqual discipline as
// Infrakinetic's requirePlatformKey), which is an intentional, bounded
// trade-off: it is held ONLY in Infrakinetic's backend environment,
// server-to-server, NEVER reaches a browser, and its blast radius is
// capped by (1) above to a single low-privilege action — the property that
// was actually missing from X-Platform-Key, not "being a static secret"
// per se.

export const PUBLIC_ONBOARDING_SYSTEM_OPERATOR_ID = "00000000-0000-0000-0000-0000000000f0";
const PUBLIC_ONBOARDING_SCOPES = ["tenants.commission", "tenants.read"] as const;
// Deliberately empty, not a fabricated entry in identity/roles.ts's human-
// operator Role catalog — this identity is authorized entirely by the
// hardcoded scope above and this middleware's own gate, never by a role/
// ROLE_SCOPE_CEILING lookup (that machinery is requireManagementApiAuth's,
// which this boundary intentionally does not go through — see header).
const PUBLIC_ONBOARDING_ROLES: readonly never[] = [];

export interface PublicOnboardingServiceAuthDeps {
  auditSink: AuditSink;
}

// A credential capable of commissioning tenants is not "any non-empty
// string" — this is a floor, not a strength guarantee (it does not check
// character-class diversity), but it rejects the obviously-weak/placeholder
// values that showed up unnoticed elsewhere in this codebase's history
// (e.g. real, short, English-word-shaped secrets). 32 chars matches the
// shortest reasonable output of `openssl rand -hex 16` — the .env.example
// entry recommends `openssl rand -hex 32` (64 chars), well above this floor.
const MIN_SERVICE_KEY_LENGTH = 32;

function requiredServiceKey(): string {
  const value = process.env.PUBLIC_ONBOARDING_SERVICE_KEY;
  if (!value || value.trim() === "") {
    throw new DatabaseUnavailableError(
      "Missing required environment variable PUBLIC_ONBOARDING_SERVICE_KEY. The public onboarding boundary cannot start until this is configured.",
    );
  }
  if (value.length < MIN_SERVICE_KEY_LENGTH) {
    throw new DatabaseUnavailableError(
      `PUBLIC_ONBOARDING_SERVICE_KEY is too short (${value.length} chars, minimum ${MIN_SERVICE_KEY_LENGTH}) to be a credential capable of commissioning tenants. Generate a real secret, e.g. 'openssl rand -hex 32'.`,
    );
  }
  return value;
}

function extractServiceKey(req: Request): string | undefined {
  const header = req.header("x-onboarding-service-key");
  return header && header.trim() !== "" ? header.trim() : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requirePublicOnboardingServiceAuth(deps: PublicOnboardingServiceAuthDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = req.header("x-correlation-id")?.trim() || randomUUID();
    const route = req.originalUrl;
    const method = req.method;

    const fail = async (httpStatus: number, code: string, message: string) => {
      await deps.auditSink.record({
        eventType: "auth.failure",
        occurredAt: new Date().toISOString(),
        operatorId: PUBLIC_ONBOARDING_SYSTEM_OPERATOR_ID,
        reasonCode: code,
        route,
        method,
        correlationId,
      });
      res.status(httpStatus).json({ error: code, message, correlationId });
    };

    try {
      const expected = requiredServiceKey();
      const provided = extractServiceKey(req);
      if (!provided || !safeEqual(provided, expected)) {
        await fail(403, "ONBOARDING_SERVICE_KEY_INVALID", "Missing or invalid X-Onboarding-Service-Key.");
        return;
      }

      const operatorContext: OperatorContext = {
        operatorId: PUBLIC_ONBOARDING_SYSTEM_OPERATOR_ID,
        cognitoSub: "system:public-onboarding-service",
        operatorSessionId: randomUUID(),
        email: "system+public-onboarding@polynovea.internal",
        roles: PUBLIC_ONBOARDING_ROLES,
        scopes: PUBLIC_ONBOARDING_SCOPES,
        correlationId,
        authenticatedAt: new Date().toISOString(),
      };
      req.operatorContext = operatorContext;

      await deps.auditSink.record({
        eventType: "auth.success",
        occurredAt: operatorContext.authenticatedAt,
        operatorId: operatorContext.operatorId,
        operatorSessionId: operatorContext.operatorSessionId,
        route,
        method,
        correlationId,
      });

      next();
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) {
        res.status(err.httpStatus).json({ error: err.code, message: err.message, correlationId });
        return;
      }
      next(err);
    }
  };
}
