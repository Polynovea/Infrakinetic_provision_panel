import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { MANAGEMENT_V1_PREFIX, UnexpectedManagementApiResponseError, type PlatformEngineState } from "./engineStateOperation.js";

// 1A.1–1A.7 closure pass — the engine catalog + per-engine platform state,
// read-only (R0). Before this, the Platform page required an operator to
// type a raw engine key ("module_migration") by hand — there was no engine
// catalog UI at all, even though Infrakinetic has exposed
// GET /management/v1/engines/catalog and GET /management/v1/engines/:key/state
// as live read routes since 1A.4/1A.6. This module is the first thing on
// Governance's own backend that actually calls them. Shape mirrors
// tenantRegistryQuery.ts exactly: mint-then-call, no ledger entry (a read
// needs none of R0's idempotency/audit machinery — see that file's header),
// sanitized DTO, freshness envelope.

export interface EngineCatalogQueryDeps {
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  /** Infrakinetic's bare origin — this module adds the /management/v1 prefix itself. */
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface EngineCatalogQueryParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

export interface EngineCatalogEntry {
  engineKey: string;
  label: string;
  aliases: readonly string[];
  state: PlatformEngineState | "unknown";
  reason: string | null;
}

interface FreshnessEnvelope {
  observedAt: string;
  source: string;
  freshness: string;
}

export type EngineCatalogResult = FreshnessEnvelope & { engines: EngineCatalogEntry[] };

// No single engine is involved in listing the catalog itself; target_engine
// is a required claim on every management assertion
// (managementAssertionIssuer.ts), so this fixed, honest sentinel stands in —
// same technique tenantRegistryQuery.ts uses for its own catalog-shaped read.
const ENGINE_CATALOG_TARGET = "engine-catalog";

interface CatalogEntryBody {
  engineKey: string;
  label: string;
  aliases: readonly string[];
}
interface CatalogResponseBody {
  engines: CatalogEntryBody[];
}
interface StateResponseBody {
  engineKey: string;
  state: string;
  reason: string | null;
}

export async function listEngineCatalog(
  deps: EngineCatalogQueryDeps,
  params: EngineCatalogQueryParams,
): Promise<EngineCatalogResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const mint = (requestedAction: string, targetEngine: string): Promise<string> =>
    mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
      operatorId: params.operatorId,
      operatorSessionId: params.operatorSessionId,
      operatorRoles: params.operatorRoles,
      operatorGrantedScopes: params.operatorGrantedScopes,
      requestedScopes: ["engines.read"],
      targetEngine,
      requestedAction,
      correlationId,
    });

  const call = (assertion: string, path: string) =>
    callInfrakineticManagementApi({
      baseUrl: deps.infrakineticBaseUrl,
      path,
      assertion,
      method: "GET",
      correlationId,
      fetchImpl: deps.fetchImpl,
    });

  const catalogPath = `${MANAGEMENT_V1_PREFIX}/engines/catalog`;
  const catalogAssertion = await mint("engines.catalog.read", ENGINE_CATALOG_TARGET);
  const catalogResult = await call(catalogAssertion, catalogPath);
  if (catalogResult.status !== 200) {
    throw new UnexpectedManagementApiResponseError(catalogResult.status, catalogPath);
  }
  const catalog = (catalogResult.body as CatalogResponseBody).engines;

  // Per-engine state reads run independently, in parallel. One engine's
  // state read failing must never take down the whole catalog view (master
  // plan §61: "unknown is not green") — it surfaces as state: "unknown"
  // with the failure recorded as its reason, never as a thrown error that
  // would blank the entire Platform page over one bad read.
  const engines = await Promise.all(
    catalog.map(async (entry): Promise<EngineCatalogEntry> => {
      try {
        const statePath = `${MANAGEMENT_V1_PREFIX}/engines/${encodeURIComponent(entry.engineKey)}/state`;
        const stateAssertion = await mint("engines.state.read", entry.engineKey);
        const stateResult = await call(stateAssertion, statePath);
        if (stateResult.status !== 200) {
          return { ...entry, state: "unknown", reason: `state read returned HTTP ${stateResult.status}` };
        }
        const stateBody = stateResult.body as StateResponseBody;
        const state: PlatformEngineState | "unknown" =
          stateBody.state === "operational" || stateBody.state === "degraded" || stateBody.state === "disabled"
            ? stateBody.state
            : "unknown";
        return { ...entry, state, reason: stateBody.reason };
      } catch (err) {
        return { ...entry, state: "unknown", reason: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  return {
    engines,
    observedAt: new Date().toISOString(),
    source: "infrakinetic-live",
    freshness: "live",
  };
}
