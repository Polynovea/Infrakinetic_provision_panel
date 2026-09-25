// 1A.4 — the ONLY place Governance's backend calls Infrakinetic's
// `/management/v1/*`. Deliberately thin: it takes an already-minted
// assertion (see managementAssertionIssuer.ts) and attaches it as a Bearer
// token — it never sees signing key material, never mints anything
// itself, and never runs in a browser context (server-only module, no
// import from `frontend/`; see scripts/check_no_signing_key_in_frontend.mjs
// for the structural proof this and the issuer/keys modules stay
// server-side).
//
// Not wired into any real route yet (1A.4 does not deploy or exercise a
// live call) — this proves the outbound shape is real code, ready for the
// bounded live-read procedure recorded in docs/1A.4_status.md, not a
// placeholder to be redesigned later.

export interface ManagementApiCallParams {
  baseUrl: string;
  path: string;
  assertion: string;
  method?: "GET" | "PUT" | "POST";
  /** JSON-serializable request body. 1A.6's mutation-specific fields only —
   * never identity/routing fields, which the assertion already carries
   * (see engineStateOperation.ts's header for why). */
  body?: unknown;
  correlationId?: string;
  fetchImpl?: typeof fetch;
  /** Overall deadline for the call; defaults to MANAGEMENT_API_TIMEOUT_MS. */
  timeoutMs?: number;
}

// Audit remediation L2 — the outbound call had no deadline, so a hung owner
// call parked its operation in 'running' indefinitely. 30s comfortably
// covers the slowest owner command (commission: provisioning + Cognito +
// email enqueue) while staying well inside the assertion's 120s TTL. A
// timeout fires AFTER dispatch, so isNeverDispatchedNetworkError() below
// does not match it: callers record it as outcome-ambiguous
// (partially_completed) and reconciliation resolves it from the owner
// receipt — never as a plain, retryable failure.
export const MANAGEMENT_API_TIMEOUT_MS = 30_000;

export interface ManagementApiCallResult {
  status: number;
  body: unknown;
}

// 1A.10.1 — shared classification of a mutation-call network failure,
// promoted here from tenantLifecycleOperation.ts (1A.8) so every operation
// module that performs a mutating call through this client applies the same
// distinction. A connection that never established (DNS failure, connection
// refused) is unambiguous: no owner-side mutation could possibly have been
// dispatched, so callers may treat it as a plain failure, safe to retry
// immediately. Anything else (a timeout or reset AFTER a connection
// existed) is outcome-ambiguous — the owner side may already have executed
// — and callers must treat it as partially_completed, never retried with a
// fresh idempotency key without first reading the durable owner-side
// receipt (see docs/Phase1A.10_Ground_Truth_and_Scoping §1.1/§3.1).
const NEVER_DISPATCHED_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EADDRNOTAVAIL"]);

export function isNeverDispatchedNetworkError(err: unknown): boolean {
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  const code = cause && typeof cause === "object" && "code" in cause ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && NEVER_DISPATCHED_ERROR_CODES.has(code);
}

export async function callInfrakineticManagementApi(params: ManagementApiCallParams): Promise<ManagementApiCallResult> {
  const doFetch = params.fetchImpl ?? fetch;
  const url = new URL(params.path, params.baseUrl).toString();
  const headers: Record<string, string> = {
    authorization: `Bearer ${params.assertion}`,
    accept: "application/json",
  };
  if (params.correlationId) headers["x-correlation-id"] = params.correlationId;

  const method = params.method ?? "GET";
  let requestBody: string | undefined;
  if (params.body !== undefined) {
    headers["content-type"] = "application/json";
    requestBody = JSON.stringify(params.body);
  }

  // One signal covers both the request and reading the response body.
  const signal = AbortSignal.timeout(params.timeoutMs ?? MANAGEMENT_API_TIMEOUT_MS);
  const response = await doFetch(url, { method, headers, body: requestBody, signal });
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body };
}
