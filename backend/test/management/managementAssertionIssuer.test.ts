import { describe, expect, it } from "vitest";
import { jwtVerify, importJWK } from "jose";

import {
  mintManagementAssertion,
  ScopeNotGrantedError,
} from "../../src/management/managementAssertionIssuer.js";
import {
  GOVERNANCE_ACTOR_IDENTITY,
  MANAGEMENT_ASSERTION_MAX_TTL_SECONDS,
  MANAGEMENT_ASSERTION_MIN_TTL_SECONDS,
} from "../../src/management/managementConfig.js";
import { buildTestKeySet } from "./testKeys.js";

const CONFIG = { issuer: "https://governance.test.invalid", audience: "infrakinetic-management-api-test" };

const BASE_PARAMS = {
  operatorId: "operator-1",
  operatorSessionId: "session-1",
  operatorRoles: ["platform_operator"],
  operatorGrantedScopes: ["engines.read", "tenants.read"],
  requestedScopes: ["engines.read"],
  targetEngine: "module_billing",
  requestedAction: "engines.catalog.read",
};

describe("management/managementAssertionIssuer", () => {
  it("mints a JWT that verifies against the signing key's own public JWK", async () => {
    const keys = await buildTestKeySet();
    const token = await mintManagementAssertion(keys, CONFIG, { ...BASE_PARAMS });

    const publicKey = await importJWK(keys.publicJwks[0], "RS256");
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
      issuer: CONFIG.issuer,
      audience: CONFIG.audience,
    });

    expect(protectedHeader.kid).toBe(keys.activeKid);
    expect(payload.operator_id).toBe("operator-1");
    expect(payload.operator_session_id).toBe("session-1");
    expect(payload.roles).toEqual(["platform_operator"]);
    expect(payload.scopes).toEqual(["engines.read"]);
    expect(payload.actor_tenant_id).toBe(GOVERNANCE_ACTOR_IDENTITY);
    expect(payload.target_engine).toBe("module_billing");
    expect(payload.target_resource_type).toBe("engine");
    expect(payload.target_resource_id).toBe("module_billing");
    expect(payload.requested_action).toBe("engines.catalog.read");
    expect(typeof payload.jti).toBe("string");
    expect(typeof payload.correlation_id).toBe("string");
    expect(payload.target_tenant_id).toBeUndefined();
  });

  it("mints a generic tenant target without inventing target_engine", async () => {
    const keys = await buildTestKeySet();
    const token = await mintManagementAssertion(keys, CONFIG, {
      ...BASE_PARAMS,
      operatorGrantedScopes: ["tenants.suspend"],
      requestedScopes: ["tenants.suspend"],
      targetEngine: undefined,
      targetResourceType: "tenant",
      targetResourceId: "11111111-1111-4111-8111-111111111111",
      requestedAction: "tenant.suspend",
    });
    const publicKey = await importJWK(keys.publicJwks[0], "RS256");
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["RS256"] });
    expect(payload.target_engine).toBeUndefined();
    expect(payload.target_resource_type).toBe("tenant");
    expect(payload.target_resource_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("rejects missing, partial, or conflicting management target addresses", async () => {
    const keys = await buildTestKeySet();
    await expect(
      mintManagementAssertion(keys, CONFIG, { ...BASE_PARAMS, targetEngine: undefined }),
    ).rejects.toThrow(/address is required/);
    await expect(
      mintManagementAssertion(keys, CONFIG, { ...BASE_PARAMS, targetEngine: undefined, targetResourceType: "tenant" }),
    ).rejects.toThrow(/must be supplied together/);
    await expect(
      mintManagementAssertion(keys, CONFIG, {
        ...BASE_PARAMS,
        targetResourceType: "tenant",
        targetResourceId: "tenant-x",
      }),
    ).rejects.toThrow(/conflicts/);
  });

  it("carries target_tenant_id only when explicitly provided", async () => {
    const keys = await buildTestKeySet();
    const token = await mintManagementAssertion(keys, CONFIG, {
      ...BASE_PARAMS,
      targetTenantId: "tenant-abc",
    });
    const publicKey = await importJWK(keys.publicJwks[0], "RS256");
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["RS256"] });
    expect(payload.target_tenant_id).toBe("tenant-abc");
  });

  it("preserves a caller-supplied correlation_id instead of generating a new one", async () => {
    const keys = await buildTestKeySet();
    const token = await mintManagementAssertion(keys, CONFIG, {
      ...BASE_PARAMS,
      correlationId: "corr-fixed-1",
    });
    const publicKey = await importJWK(keys.publicJwks[0], "RS256");
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["RS256"] });
    expect(payload.correlation_id).toBe("corr-fixed-1");
  });

  it("rejects requesting a scope the operator was not granted (never widens)", async () => {
    const keys = await buildTestKeySet();
    await expect(
      mintManagementAssertion(keys, CONFIG, {
        ...BASE_PARAMS,
        requestedScopes: ["engines.platform_state.write"],
      }),
    ).rejects.toThrow(ScopeNotGrantedError);
  });

  it("rejects a call requesting zero scopes", async () => {
    const keys = await buildTestKeySet();
    await expect(
      mintManagementAssertion(keys, CONFIG, { ...BASE_PARAMS, requestedScopes: [] }),
    ).rejects.toThrow(/zero scopes/);
  });

  it("clamps an excessive TTL down to the approved maximum", async () => {
    const keys = await buildTestKeySet();
    const token = await mintManagementAssertion(keys, CONFIG, { ...BASE_PARAMS, ttlSeconds: 999_999 });
    const publicKey = await importJWK(keys.publicJwks[0], "RS256");
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["RS256"] });
    expect((payload.exp as number) - (payload.iat as number)).toBe(MANAGEMENT_ASSERTION_MAX_TTL_SECONDS);
  });

  it("clamps a too-short TTL up to the approved minimum", async () => {
    const keys = await buildTestKeySet();
    const token = await mintManagementAssertion(keys, CONFIG, { ...BASE_PARAMS, ttlSeconds: 1 });
    const publicKey = await importJWK(keys.publicJwks[0], "RS256");
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ["RS256"] });
    expect((payload.exp as number) - (payload.iat as number)).toBe(MANAGEMENT_ASSERTION_MIN_TTL_SECONDS);
  });
});
