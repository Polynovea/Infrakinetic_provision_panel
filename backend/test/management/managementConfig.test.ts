import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MANAGEMENT_ASSERTION_MAX_TTL_SECONDS,
  MANAGEMENT_ASSERTION_MIN_TTL_SECONDS,
  MANAGEMENT_ASSERTION_DEFAULT_TTL_SECONDS,
  clampAssertionTtlSeconds,
  loadManagementTransportConfig,
} from "../../src/management/managementConfig.js";
import { DatabaseUnavailableError } from "../../src/db/errors.js";

const ENV_VARS = ["GOVERNANCE_MANAGEMENT_ISSUER", "GOVERNANCE_MANAGEMENT_AUDIENCE"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("management/managementConfig", () => {
  beforeEach(() => {
    for (const key of ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("throws naming the first missing variable", () => {
    expect(() => loadManagementTransportConfig()).toThrow(DatabaseUnavailableError);
    expect(() => loadManagementTransportConfig()).toThrow(/GOVERNANCE_MANAGEMENT_ISSUER/);
  });

  it("loads both values when set", () => {
    process.env.GOVERNANCE_MANAGEMENT_ISSUER = "https://governance.example";
    process.env.GOVERNANCE_MANAGEMENT_AUDIENCE = "infrakinetic-management-api";
    expect(loadManagementTransportConfig()).toEqual({
      issuer: "https://governance.example",
      audience: "infrakinetic-management-api",
    });
  });

  it("clamps TTL within the approved 60-120s window", () => {
    expect(clampAssertionTtlSeconds(undefined)).toBe(MANAGEMENT_ASSERTION_DEFAULT_TTL_SECONDS);
    expect(clampAssertionTtlSeconds(1)).toBe(MANAGEMENT_ASSERTION_MIN_TTL_SECONDS);
    expect(clampAssertionTtlSeconds(999_999)).toBe(MANAGEMENT_ASSERTION_MAX_TTL_SECONDS);
    expect(clampAssertionTtlSeconds(90)).toBe(90);
    expect(clampAssertionTtlSeconds(Number.NaN)).toBe(MANAGEMENT_ASSERTION_DEFAULT_TTL_SECONDS);
  });
});
