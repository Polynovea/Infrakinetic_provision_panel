import { randomUUID } from "node:crypto";

import type { ManagementSigningKeySet } from "../managementSigningKeys.js";
import type { ManagementTransportConfig } from "../managementConfig.js";
import { mintManagementAssertion } from "../managementAssertionIssuer.js";
import { callInfrakineticManagementApi } from "../managementApiClient.js";
import { UnexpectedManagementApiResponseError, MANAGEMENT_V1_PREFIX } from "./engineStateOperation.js";
import { findSecretShapedField, UnsafeAiOwnerResponseError } from "./aiQuery.js";

export const PLATFORM_INFRASTRUCTURE_RESOURCE = "platform_infrastructure";

export interface PlatformInfrastructureQueryDeps {
  signingKeys: ManagementSigningKeySet;
  transportConfig: ManagementTransportConfig;
  infrakineticBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface PlatformInfrastructureOperatorParams {
  operatorId: string;
  operatorSessionId: string;
  operatorRoles: readonly string[];
  operatorGrantedScopes: readonly string[];
  correlationId?: string;
}

export async function getPlatformInfrastructure(
  deps: PlatformInfrastructureQueryDeps,
  params: PlatformInfrastructureOperatorParams,
): Promise<Record<string, unknown>> {
  const correlationId = params.correlationId ?? randomUUID();
  const assertion = await mintManagementAssertion(deps.signingKeys, deps.transportConfig, {
    operatorId: params.operatorId,
    operatorSessionId: params.operatorSessionId,
    operatorRoles: params.operatorRoles,
    operatorGrantedScopes: params.operatorGrantedScopes,
    requestedScopes: ["runtime.read"],
    targetResourceType: PLATFORM_INFRASTRUCTURE_RESOURCE,
    targetResourceId: PLATFORM_INFRASTRUCTURE_RESOURCE,
    requestedAction: "platform.infrastructure.read",
    correlationId,
  });
  const path = `${MANAGEMENT_V1_PREFIX}/infrastructure`;
  const result = await callInfrakineticManagementApi({
    baseUrl: deps.infrakineticBaseUrl,
    path,
    assertion,
    method: "GET",
    correlationId,
    fetchImpl: deps.fetchImpl,
  });
  if (result.status !== 200) throw new UnexpectedManagementApiResponseError(result.status, path);
  const unsafe = findSecretShapedField(result.body);
  if (unsafe) throw new UnsafeAiOwnerResponseError(unsafe);
  return result.body as Record<string, unknown>;
}
