import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, exportJWK } from "jose";

import { createRequire } from "node:module";
import { AI_CONTRACT, validateAiBody, type AiContractRoute } from "../../src/management/operations/aiContract.js";
import type { ManagementSigningKeySet } from "../../src/management/managementSigningKeys.js";
import type { AiOperationDeps } from "../../src/management/operations/aiOperation.js";
import type { ManagementOperationLedger } from "../../src/management/operations/managementOperationLedger.js";
import type { DbClient } from "../../src/db/dbClient.js";

// A stateful, contract-driven fake of the module_ai owner's /management/v1 AI routes for Governance
// operation tests. It dispatches by the PUBLISHED contract's method + path (so a Governance route that
// drifts from the contract gets a 404, exactly like the real owner), validates every mutation body with
// Governance's own copy of the strict request schema, records the decoded assertion claims of every call,
// applies the requested effect to an in-memory tenant/catalog model (so the independent observation is
// meaningful) and writes a durable receipt per idempotency key.

export const TENANT = "00000000-0000-4000-8000-000000000002";
export const MODEL_ID = "00000000-0000-4000-8000-000000000030";
export const OPERATOR = "11111111-1111-4111-8111-111111111111";
export const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const MAKER = OPERATOR;
export const CHECKER = "22222222-2222-4222-8222-222222222222";
export const EXECUTOR = "33333333-3333-4333-8333-333333333333";

/** The ledger and approval tables reference governance.operators; seed the actors the tests use. */
export async function seedAiOperators(client: DbClient): Promise<void> {
  for (const [id, sub] of [[OPERATOR, "maker"], [CHECKER, "checker"], [EXECUTOR, "executor"]] as const) {
    await client.query(
      `INSERT INTO governance.operators (operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at)
       VALUES ($1, $2, $2 || '@example.invalid', 'Operator', 'active', true, now(), now())`,
      [id, sub],
    );
  }
}

const examples = (createRequire(import.meta.url)("../../src/management/contracts/aiManagement.examples.json") as { examples: Record<string, Record<string, unknown>> }).examples;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface OwnerCall { method: string; path: string; routeId?: string; body?: Record<string, unknown>; claims: Record<string, unknown> }

export interface FakeOwnerOptions {
  /** false: a mutation answers 200 but changes nothing (an owner that lies / a lost write). */
  applyEffects?: boolean;
  /** Status for reads of the tenant state (to simulate a failing observation). */
  stateStatus?: number;
  /** Force a specific status + body for a mutation route id. */
  failMutation?: Record<string, { status: number; body: unknown }>;
  /** Make fetch itself reject for a mutation route id (network failure). */
  throwOnMutation?: Record<string, Error>;
}

export interface FakeOwner {
  calls: OwnerCall[];
  mutations: () => OwnerCall[];
  state: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  catalog: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  receipts: Map<string, Record<string, unknown>>;
  fetchImpl: typeof fetch;
  options: FakeOwnerOptions;
}

const compile = (route: AiContractRoute) => {
  const names: string[] = [];
  const source = `^/management/v1${route.path.replace(/:([A-Za-z]+)/g, (_match, name: string) => { names.push(name); return "([^/]+)"; })}$`;
  return { regex: new RegExp(source), names };
};
const COMPILED = AI_CONTRACT.routes.map((route) => ({ route, ...compile(route) }));

export function createFakeOwner(options: FakeOwnerOptions = {}): FakeOwner {
  const state = clone(examples.TenantAiState) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const catalog = clone(examples.AiCatalog) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const receipts = new Map<string, Record<string, unknown>>();
  const calls: OwnerCall[] = [];
  const owner: FakeOwner = { calls, mutations: () => calls.filter((call) => call.method !== "GET"), state, catalog, receipts, fetchImpl: undefined as never, options };

  const json = (status: number, body: unknown) => ({ status, json: async () => body }) as Response;

  const apply = (route: AiContractRoute, params: Record<string, string>, body: Record<string, any>): Record<string, unknown> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const result: Record<string, unknown> = { action: route.action, replay: false, commandStatus: "completed" };
    if (options.applyEffects === false) return result;
    switch (route.id) {
      case "tenant.suspend": state.emergency = { state: "suspended", reason: body.reason, recoveryIntent: body.recoveryIntent, operationId: "00000000-0000-4000-8000-0000000000aa", since: "2026-02-01T00:00:00.000Z" }; break;
      case "tenant.resume": state.emergency = { state: "none", reason: null, recoveryIntent: null, operationId: "00000000-0000-4000-8000-0000000000ab", since: "2026-02-02T00:00:00.000Z" }; break;
      case "tenant.planes.set": state.rootPolicy.allowedPlanes = [...body.planes]; break;
      case "tenant.commissioning-mode.set": state.rootPolicy.commissioningMode = body.mode; break;
      case "tenant.billing-anchor.set": state.rootPolicy.billingAnchorDay = body.billingAnchorDay; break;
      case "tenant.capability.commission": {
        const cap = state.capabilities.find((c: any) => c.capabilityKey === params.capabilityKey && c.plane === body.plane); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (cap) cap.commissioning.commissioned = body.state === "commissioned";
        break;
      }
      case "tenant.quota.set": {
        const existing = state.quotas.find((q: any) => q.policyKey === params.policyKey); // eslint-disable-line @typescript-eslint/no-explicit-any
        const next = { ...(existing ?? clone(state.quotas[0])), policyKey: params.policyKey, hard: body.policy.hardLimit, enabled: body.policy.enabled ?? true };
        state.quotas = [...state.quotas.filter((q: any) => q.policyKey !== params.policyKey), next]; // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      }
      case "tenant.quota.remove": state.quotas = state.quotas.filter((q: any) => q.policyKey !== params.policyKey); break; // eslint-disable-line @typescript-eslint/no-explicit-any
      case "tenant.quota.grace.grant": {
        const quota = state.quotas.find((q: any) => q.policyKey === params.policyKey) ?? { ...clone(state.quotas[0]), policyKey: params.policyKey }; // eslint-disable-line @typescript-eslint/no-explicit-any
        quota.overage = { mode: "grace", graceActiveForWindow: true, graceLimit: body.graceLimit, graceExpiresAt: body.expiresAt };
        state.quotas = [...state.quotas.filter((q: any) => q.policyKey !== params.policyKey), quota]; // eslint-disable-line @typescript-eslint/no-explicit-any
        break;
      }
      case "provider.state.set": {
        const provider = catalog.providers.find((p: any) => p.providerKey === params.providerKey); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (provider) provider.status = body.status; else catalog.providers.push({ ...clone(catalog.providers[0]), providerKey: params.providerKey, status: body.status });
        break;
      }
      case "model.lifecycle.set": for (const p of catalog.providers) for (const m of p.models) if (m.modelId === params.modelId) m.lifecycle = body.lifecycle; break;
      case "model.certification.set": for (const p of catalog.providers) for (const m of p.models) if (m.modelId === params.modelId) { m.certification = body.certification; m.certificationEvidenceRef = body.evidenceRef; } break;
      case "tenant.credential.revoke": {
        const ref = state.credentialRefs.find((c: any) => c.refId === params.refId); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (ref) { ref.status = "revoked"; ref.revokedAt = "2026-02-01T00:00:00.000Z"; } else state.credentialRefs.push({ refId: params.refId, providerKey: "nvidia_nim_byo", version: 1, status: "revoked", maskedHint: "…abcd", createdAt: "2026-01-01T00:00:00.000Z", revokedAt: "2026-02-01T00:00:00.000Z" });
        result.credential = { refId: params.refId, providerKey: "nvidia_nim_byo", version: 1, status: "revoked", maskedHint: "…abcd", createdAt: "2026-01-01T00:00:00.000Z", revokedAt: "2026-02-01T00:00:00.000Z" };
        break;
      }
      case "tenant.model-policy.set": result.decision = body.decision; break;
      default: break;
    }
    return result;
  };

  owner.fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const claims = decodeJwt(auth.replace(/^Bearer /, "")) as Record<string, unknown>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const call: OwnerCall = { method, path: url.pathname + url.search, body, claims };
    calls.push(call);

    const match = COMPILED.filter((entry) => entry.route.method === method).map((entry) => ({ entry, m: entry.regex.exec(url.pathname) })).find((x) => x.m);
    if (!match || !match.m) return json(404, { error: "NO_SUCH_ROUTE" });
    const { route } = match.entry;
    call.routeId = route.id;
    const params = Object.fromEntries(match.entry.names.map((name, index) => [name, decodeURIComponent(match.m![index + 1] as string)]));

    if (claims.requested_action !== route.action || !(claims.scopes as string[]).includes(route.scope)) return json(403, { error: "SCOPE_OR_ACTION_MISMATCH" });

    if (route.kind === "read") {
      if (route.id === "tenant.state.read") return options.stateStatus && options.stateStatus !== 200 ? json(options.stateStatus, { error: "FAIL" }) : json(200, { ...clone(state), tenantId: params.tenantId });
      if (route.id === "catalog.read") return json(200, clone(catalog));
      if (route.id === "tenant.credentials.read") return json(200, { tenantId: params.tenantId, credentials: clone(state.credentialRefs), observedAt: "2026-02-01T00:00:00.000Z", source: "infrakinetic-live", freshness: "live" });
      if (route.id === "admin-command.read") {
        const receipt = receipts.get(params.idempotencyKey);
        return receipt ? json(200, { command: receipt, observedAt: "2026-02-01T00:00:00.000Z", source: "infrakinetic-live", freshness: "live" }) : json(404, { error: "UNKNOWN_AI_ADMIN_COMMAND" });
      }
      return json(200, clone(examples[route.response as string] ?? {}));
    }

    if (options.throwOnMutation?.[route.id]) throw options.throwOnMutation[route.id];
    const violations = validateAiBody(route, body ?? {});
    if (violations.length > 0) return json(400, { error: "INVALID_REQUEST", details: violations });
    if (route.approval === "maker_checker" && !claims.approval) return json(403, { error: "APPROVAL_REQUIRED" });
    if (route.id === "tenant.commissioning-mode.preview") return json(200, { ...clone(examples.AiCommissioningModePreview), tenantId: params.tenantId, targetMode: body?.mode });
    const forced = options.failMutation?.[route.id];
    if (forced) return json(forced.status, forced.body);

    const result = apply(route, params, (body ?? {}) as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
    const target = { type: route.binding.resource && route.binding.resource !== "receipt" ? route.binding.resource.type : "tenant", id: route.id === "tenant.model-policy.set" ? `${body?.providerKey}/${body?.modelKey ?? "*"}` : Object.values(params)[Object.values(params).length - 1] ?? "" };
    receipts.set(String(body?.idempotencyKey), {
      idempotencyKey: body?.idempotencyKey, commandId: "00000000-0000-4000-8000-0000000000c1", action: route.action,
      tenantId: params.tenantId ?? null, target, reason: body?.reason, operatorId: claims.operator_id,
      approval: claims.approval ? { approvalId: (claims.approval as any).approval_id, makerOperatorId: (claims.approval as any).maker_operator_id, checkerOperatorId: (claims.approval as any).checker_operator_id } : null, // eslint-disable-line @typescript-eslint/no-explicit-any
      status: "completed", result, createdAt: "2026-02-01T00:00:00.000Z", completedAt: "2026-02-01T00:00:00.000Z",
    });
    return json(200, { commandId: "00000000-0000-4000-8000-0000000000c1", ...result, operatorId: claims.operator_id, approvalId: (claims.approval as any)?.approval_id ?? null, correlationId: claims.correlation_id, executedAt: "2026-02-01T00:00:00.000Z" }); // eslint-disable-line @typescript-eslint/no-explicit-any
  }) as typeof fetch;

  return owner;
}

export async function testSigningKeys(): Promise<ManagementSigningKeySet> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "k"; jwk.alg = "RS256"; jwk.use = "sig";
  return { activeKid: "k", activePrivateKey: privateKey, publicJwks: [jwk] };
}

export async function aiDeps(ledger: ManagementOperationLedger, owner: FakeOwner): Promise<AiOperationDeps> {
  return {
    ledger,
    signingKeys: await testSigningKeys(),
    transportConfig: { issuer: "https://governance.test.invalid", audience: "infrakinetic-management-api-test" },
    infrakineticBaseUrl: "https://infrakinetic.test.invalid",
    fetchImpl: owner.fetchImpl,
  };
}

export const AI_SCOPES = ["ai.read", "ai.entitlement.write", "ai.quota.write", "ai.provider_policy.write", "ai.emergency_suspend", "credentials.revoke", "finops.policy.write"];

export const operator = (operatorId = OPERATOR, scopes: readonly string[] = AI_SCOPES) => ({
  operatorId, operatorSessionId: SESSION, operatorRoles: ["platform_admin"], operatorGrantedScopes: scopes,
});
