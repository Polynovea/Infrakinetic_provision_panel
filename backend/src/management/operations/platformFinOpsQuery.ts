import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { UnexpectedManagementApiResponseError, MANAGEMENT_V1_PREFIX } from "./engineStateOperation.js";
import { findSecretShapedField, UnsafeAiOwnerResponseError } from "./aiQuery.js";

export const PLATFORM_FINOPS_RESOURCE = "platform_finops";

export interface PlatformFinOpsQueryDeps {
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface PlatformFinOpsOperatorParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

export async function getPlatformFinOps(deps: PlatformFinOpsQueryDeps, params: PlatformFinOpsOperatorParams): Promise<Record<string, unknown>> {
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["finops.read"],
    targetResourceType: PLATFORM_FINOPS_RESOURCE,
    targetResourceId: PLATFORM_FINOPS_RESOURCE,
    requestedAction: "platform.finops.read",
    correlationId,
  });
  const path = `${MANAGEMENT_V1_PREFIX}/finops`;
  const result = await callInfrakineticManagementApi({ baseUrl: deps.infrakineticBaseUrl, path, assertion, method: "GET", correlationId, fetchImpl: deps.fetchImpl });
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  const unsafe = findSecretShapedField(result.body);
  if (unsafe) throw new UnsafeAiOwnerResponseError(unsafe);
  return result.body as Record<string, unknown>;
}
