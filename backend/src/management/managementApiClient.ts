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
  method?: "GET" | "PUT";
  /** JSON-serializable request body. 1A.6's mutation-specific fields only —
   * never identity/routing fields, which the assertion already carries
   * (see engineStateOperation.ts's header for why). */
  body?: unknown;
  correlationId?: string;
  fetchImpl?: typeof fetch;
}

export interface ManagementApiCallResult {
  status: number;
  body: unknown;
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

  const response = await doFetch(url, { method, headers, body: requestBody });
  const body = await response.json().catch(() => undefined);
  return { status: response.status, body };
}
