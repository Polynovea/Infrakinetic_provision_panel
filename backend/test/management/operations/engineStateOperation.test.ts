import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK } from "jose";

import { buildMigratedPgMemClient } from "../../helpers/pgMemDb.js";
import { ManagementOperationLedger } from "../../../src/management/operations/managementOperationLedger.js";
import {
  requestEngineStateChange,
  recoverEngineState,
  UnknownEngineError,
  MissingRecoveryIntentError,
  ManagementApiUnreachableError,
} from "../../../src/management/operations/engineStateOperation.js";
import { MissingReasonError, IdempotencyConflictError } from "../../../src/management/operations/managementOperationErrors.js";
import type { DbClient } from "../../../src/db/dbClient.js";
import type { ManagementSigningKeySet } from "../../../src/management/managementSigningKeys.js";
import type { ManagementTransportConfig } from "../../../src/management/managementConfig.js";
import type { EngineStateOperationDeps } from "../../../src/management/operations/engineStateOperation.js";

const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function seedOperator(client: DbClient) {
  await client.query(
    `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
     VALUES ($1, 'sub-1', 'a@example.invalid', 'A', 'active', true, now(), now())`,
    [OPERATOR_ID],
  );
}

async function buildFixtureSigningKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { activeKid: "test-kid", activePrivateKey: privateKey, publicJwks: [jwk] };
}

const TRANSPORT_CONFIG: ManagementTransportConfig = {
  issuer: "https://governance.test.invalid",
  audience: "infrakinetic-management-api-test",
};

// A canonical-engine + alias map matching enough of the real catalog shape
// (module_ai, plus one alias) for these tests — NOT importing CRM's real
// catalog (hard rule), just enough fixture surface to drive the fake below.
const CANONICAL_ENGINES = new Set(["module_ai", "module_billing"]);
const ALIAS_TO_CANONICAL: Record<string, string> = { ai: "module_ai" };

interface FakeCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface FakeInfrakineticOptions {
  /** If set, the Nth verify-GET (1-indexed, counting only verify-GETs) returns this instead of the real store value. */
  forceVerifyStateOnCall?: { call: number; state: string; reason?: string | null };
  /** If set, the Nth verify-GET throws instead of responding. */
  failVerifyOnCall?: number;
  /** If set, the mutation PUT throws an outcome-ambiguous network error instead of responding. */
  failMutation?: boolean;
}

function buildFakeInfrakinetic(
  initial: Record<string, { state: string; reason: string | null }> = {},
  options: FakeInfrakineticOptions = {},
) {
  const store = new Map<string, { state: string; reason: string | null }>(Object.entries(initial));
  const calls: FakeCall[] = [];
  let putCount = 0;
  let verifyGetCount = 0;

  function jsonResponse(status: number, body: unknown): Response {
    return {
      status,
      json: async () => body,
    } as Response;
  }

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET") as string;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, body });

    const getMatch = url.pathname.match(/^\/management\/v1\/engines\/([^/]+)\/state$/);
    const putMatch = url.pathname.match(/^\/management\/v1\/engine-state\/([^/]+)$/);

    if (getMatch) {
      const requested = decodeURIComponent(getMatch[1]);
      const canonical = ALIAS_TO_CANONICAL[requested] ?? requested;
      if (!CANONICAL_ENGINES.has(canonical)) {
        return jsonResponse(404, { error: "UNKNOWN_ENGINE_KEY", engineKey: requested });
      }
      // Distinguish the resolve-GET (called with the raw alias/engine before
      // any mutation) from a verify-GET (always called with the canonical
      // key, after at least one PUT has already happened this test) well
      // enough for the force/fail hooks: only count as a "verify" call once
      // a mutation has occurred for this engine.
      const isPostMutationRead = putCount > 0;
      if (isPostMutationRead) {
        verifyGetCount += 1;
        if (options.failVerifyOnCall === verifyGetCount) {
          throw new Error("simulated network failure on effective-state verification");
        }
        if (options.forceVerifyStateOnCall?.call === verifyGetCount) {
          return jsonResponse(200, {
            engineKey: canonical,
            state: options.forceVerifyStateOnCall.state,
            reason: options.forceVerifyStateOnCall.reason ?? null,
          });
        }
      }
      const current = store.get(canonical) ?? { state: "operational", reason: null };
      return jsonResponse(200, { engineKey: canonical, state: current.state, reason: current.reason });
    }

    if (putMatch && method === "PUT") {
      const canonical = decodeURIComponent(putMatch[1]);
      if (!CANONICAL_ENGINES.has(canonical)) {
        return jsonResponse(404, { error: "UNKNOWN_ENGINE_KEY", engineKey: canonical });
      }
      if (options.failMutation) {
        throw new Error("simulated network failure on mutation call");
      }
      const previous = store.get(canonical) ?? { state: "operational", reason: null };
      const desiredState = body?.desiredState as string;
      const reason = (body?.reason as string) ?? null;
      putCount += 1;
      store.set(canonical, { state: desiredState, reason });
      return jsonResponse(200, {
        canonicalEngine: canonical,
        commandId: body?.commandId ?? null,
        idempotencyKey: body?.idempotencyKey ?? null,
        previousState: previous,
        requestedState: desiredState,
        resultingState: store.get(canonical),
        operatorId: OPERATOR_ID,
        correlationId: "fake-corr",
        executedAt: new Date().toISOString(),
      });
    }

    return jsonResponse(404, { error: "not_found" });
  }) as typeof fetch;

  return { fetchImpl, calls, store, putCountRef: () => putCount };
}

describe("management/operations/engineStateOperation", () => {
  let client: DbClient;
  let ledger: ManagementOperationLedger;
  let signingKeys: ManagementSigningKeySet;

  beforeEach(async () => {
    const built = buildMigratedPgMemClient();
    client = built.client;
    ledger = new ManagementOperationLedger(client);
    await seedOperator(client);
    signingKeys = await buildFixtureSigningKeys();
  });

  function baseDeps(fetchImpl: typeof fetch, infrakineticBaseUrl = "http://fake-infra.test"): EngineStateOperationDeps {
    return { ledger, signingKeys, transportConfig: TRANSPORT_CONFIG, infrakineticBaseUrl, fetchImpl };
  }

  function baseParams(overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: "engine-op-1",
      operatorId: OPERATOR_ID,
      operatorSessionId: SESSION_ID,
      operatorRoles: ["platform_admin"],
      operatorGrantedScopes: ["engines.read", "engines.platform_state.write"],
      engineKeyOrAlias: "module_ai",
      desiredState: "disabled" as const,
      reason: "incident INC-1",
      recoveryIntent: "restore once provider status page is green",
      ...overrides,
    };
  }

  it("unknown engine is rejected before any ledger operation is created", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    await expect(
      requestEngineStateChange(baseDeps(fetchImpl), baseParams({ engineKeyOrAlias: "not_a_real_engine" })),
    ).rejects.toBeInstanceOf(UnknownEngineError);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
  });

  it("a network failure on Step 1's resolve-read (before any ledger reservation) is a clean ManagementApiUnreachableError, not an uncaught throw, and creates no ledger row", async () => {
    const unreachableFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      requestEngineStateChange(baseDeps(unreachableFetch), baseParams()),
    ).rejects.toBeInstanceOf(ManagementApiUnreachableError);
    const ops = await client.query("SELECT * FROM governance.management_operations");
    expect(ops.rows).toHaveLength(0);
  });

  it("outcome-ambiguous network failure on the mutation call -> partially_completed, not failed (1A.10.1)", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } }, { failMutation: true });
    const { operation } = await requestEngineStateChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("partially_completed");
    expect((operation.partialFailureState as { stage?: string })?.stage).toBe("mutation-call");
  });

  it("connection never established (DNS/connection-refused) on the mutation call -> unambiguous failed (1A.10.1)", async () => {
    const { fetchImpl: resolveFetch } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } });
    let mutationAttempted = false;
    const neverConnectsOnMutation = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/management/v1/engine-state/")) {
        mutationAttempted = true;
        throw Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
      }
      return resolveFetch(input, init);
    }) as unknown as typeof fetch;

    const { operation } = await requestEngineStateChange(baseDeps(neverConnectsOnMutation), baseParams());
    expect(mutationAttempted).toBe(true);
    expect(operation.status).toBe("failed");
    expect((operation.partialFailureState as { stage?: string })?.stage).toBe("mutation-call-never-dispatched");
  });

  it("an alias is canonicalized before the ledger and Infrakinetic ever see it", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } });
    const { operation } = await requestEngineStateChange(baseDeps(fetchImpl), baseParams({ engineKeyOrAlias: "ai" }));
    expect(operation.targetEngine).toBe("module_ai");
    expect(calls.find((c) => c.method === "PUT")?.path).toBe("/management/v1/engine-state/module_ai");
  });

  it("disabling without recoveryIntent is rejected client-side, before any network call", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic();
    await expect(
      requestEngineStateChange(baseDeps(fetchImpl), baseParams({ recoveryIntent: undefined })),
    ).rejects.toBeInstanceOf(MissingRecoveryIntentError);
    expect(calls).toHaveLength(0);
  });

  it("missing reason on an R4 (disable) request is rejected by the 1A.5 ledger", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } });
    await expect(
      requestEngineStateChange(baseDeps(fetchImpl), baseParams({ reason: "" })),
    ).rejects.toBeInstanceOf(MissingReasonError);
  });

  it("captures the real before-state, independently observed, not merely asserted", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({ module_ai: { state: "degraded", reason: "prior incident" } });
    const { operation } = await requestEngineStateChange(baseDeps(fetchImpl), baseParams());
    const before = operation.beforeStateSafeSnapshot as { data: { state: string; reason: string } };
    expect(before.data).toMatchObject({ state: "degraded", reason: "prior incident" });
  });

  it("completes only after independent effective confirmation, calling setPlatformEngineState via PUT exactly once", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } });
    const { operation, replay } = await requestEngineStateChange(baseDeps(fetchImpl), baseParams());

    expect(replay).toBe(false);
    expect(operation.status).toBe("completed");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    // resolve-GET, PUT, verify-GET — independent effective read-back is a
    // distinct call from the PUT's own response.
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
  });

  it("carries correlation id through to the final operation, and a caller-supplied causation id", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } });
    const correlationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const causationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const { operation } = await requestEngineStateChange(
      baseDeps(fetchImpl),
      baseParams({ correlationId, causationId }),
    );
    expect(operation.correlationId).toBe(correlationId);
    expect(operation.causationId).toBe(causationId);
  });

  it("same idempotency key + same request replays safely — no second call to Infrakinetic at all", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } });
    const deps = baseDeps(fetchImpl);
    const first = await requestEngineStateChange(deps, baseParams());
    const callsAfterFirst = calls.length;
    const second = await requestEngineStateChange(deps, baseParams());

    expect(second.replay).toBe(true);
    expect(second.operation.operationId).toBe(first.operation.operationId);
    // Only the resolve-GET is allowed on replay (harmless, read-only) — no
    // second PUT, no second verify-GET.
    expect(calls.length).toBeLessThanOrEqual(callsAfterFirst + 1);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("same key + different desired state conflicts, without ever calling the mutation route again", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } });
    const deps = baseDeps(fetchImpl);
    await requestEngineStateChange(deps, baseParams());
    await expect(
      requestEngineStateChange(deps, baseParams({ desiredState: "degraded", recoveryIntent: undefined })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("concurrent duplicate requests collapse to exactly one real mutation call", async () => {
    const { fetchImpl, calls } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } });
    const deps = baseDeps(fetchImpl);
    const [a, b] = await Promise.all([requestEngineStateChange(deps, baseParams()), requestEngineStateChange(deps, baseParams())]);
    expect(a.operation.operationId).toBe(b.operation.operationId);
    expect([a.replay, b.replay].sort()).toEqual([false, true]);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("represents an effective-state mismatch as partially_completed, not a false 'completed'", async () => {
    const { fetchImpl } = buildFakeInfrakinetic(
      { module_ai: { state: "operational", reason: null } },
      { forceVerifyStateOnCall: { call: 1, state: "operational" } }, // PUT claims disabled, independent read disagrees
    );
    const { operation } = await requestEngineStateChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("partially_completed");
    expect(operation.partialFailureState).toMatchObject({
      stage: "effective-mismatch",
      expected: "disabled",
      observed: "operational",
    });
  });

  it("represents a partial failure when the independent effective read itself fails", async () => {
    const { fetchImpl } = buildFakeInfrakinetic(
      { module_ai: { state: "operational", reason: null } },
      { failVerifyOnCall: 1 },
    );
    const { operation } = await requestEngineStateChange(baseDeps(fetchImpl), baseParams());
    expect(operation.status).toBe("partially_completed");
    expect((operation.partialFailureState as { stage: string }).stage).toBe("effective-observation");
  });

  it("safe evidence contains no secret-shaped metadata even if the caller supplies some", async () => {
    const { fetchImpl } = buildFakeInfrakinetic({ module_ai: { state: "operational", reason: null } });
    const { operation } = await requestEngineStateChange(
      baseDeps(fetchImpl),
      baseParams({ metadata: { note: "fine", apiKey: "sk_should_not_persist" } }),
    );
    const raw = JSON.stringify(operation);
    expect(raw).not.toContain("sk_should_not_persist");
  });

  describe("recoverEngineState", () => {
    it("restores the ACTUAL prior state (degraded), not blindly operational, and attaches a rollback reference", async () => {
      const { fetchImpl, calls } = buildFakeInfrakinetic({ module_ai: { state: "degraded", reason: "prior incident" } });
      const deps = baseDeps(fetchImpl);
      const disableResult = await requestEngineStateChange(deps, baseParams());
      expect(disableResult.operation.status).toBe("completed");

      const recovery = await recoverEngineState(deps, ledger, {
        originalOperationId: disableResult.operation.operationId,
        idempotencyKey: "recovery-op-1",
        operatorId: OPERATOR_ID,
        operatorSessionId: SESSION_ID,
        operatorRoles: ["platform_admin"],
        operatorGrantedScopes: ["engines.read", "engines.platform_state.write"],
        reason: "incident resolved",
      });

      expect(recovery.operation.status).toBe("completed");
      expect(recovery.operation.result).toMatchObject({ requestedState: "degraded" });
      expect(recovery.operation.causationId).toBe(disableResult.operation.operationId);

      const original = await ledger.getOperation(disableResult.operation.operationId);
      expect(original.rollbackReference).toMatchObject({ recoveryOperationId: recovery.operation.operationId });

      const putCalls = calls.filter((c) => c.method === "PUT");
      expect(putCalls).toHaveLength(2); // disable, then recover
      expect(putCalls[1].body?.desiredState).toBe("degraded");
    });
  });
});
