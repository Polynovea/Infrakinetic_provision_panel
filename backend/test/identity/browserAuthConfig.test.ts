import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigurationError } from "../../src/identity/errors.js";
import { browserAuthAppearsConfigured, loadBrowserAuthConfig } from "../../src/identity/browserAuthConfig.js";

const ENV_VARS = [
  "GOVERNANCE_COGNITO_DOMAIN",
  "GOVERNANCE_COGNITO_APP_CLIENT_ID",
  "GOVERNANCE_COGNITO_APP_CLIENT_SECRET",
  "GOVERNANCE_COGNITO_REDIRECT_URI",
  "GOVERNANCE_FRONTEND_ORIGIN",
  "NODE_ENV",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function setFullConfig(): void {
  process.env.GOVERNANCE_COGNITO_DOMAIN = "https://polynovea-governance.auth.ap-south-1.amazoncognito.com";
  process.env.GOVERNANCE_COGNITO_APP_CLIENT_ID = "test-client-id";
  process.env.GOVERNANCE_COGNITO_APP_CLIENT_SECRET = "test-client-secret";
  process.env.GOVERNANCE_COGNITO_REDIRECT_URI = "https://governance-api.example.test/auth/callback";
  process.env.GOVERNANCE_FRONTEND_ORIGIN = "https://governance.example.test";
}

describe("identity/browserAuthConfig", () => {
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

  it("requires GOVERNANCE_COGNITO_APP_CLIENT_SECRET even when every other value is set", () => {
    setFullConfig();
    delete process.env.GOVERNANCE_COGNITO_APP_CLIENT_SECRET;
    expect(() => loadBrowserAuthConfig()).toThrow(ConfigurationError);
    expect(() => loadBrowserAuthConfig()).toThrow(/GOVERNANCE_COGNITO_APP_CLIENT_SECRET/);
  });

  it("loads the secret onto the config once every required value is present", () => {
    setFullConfig();
    const config = loadBrowserAuthConfig();
    expect(config.appClientSecret).toBe("test-client-secret");
  });

  it("browserAuthAppearsConfigured() is false while the secret is missing, true once set", () => {
    setFullConfig();
    delete process.env.GOVERNANCE_COGNITO_APP_CLIENT_SECRET;
    expect(browserAuthAppearsConfigured()).toBe(false);

    process.env.GOVERNANCE_COGNITO_APP_CLIENT_SECRET = "test-client-secret";
    expect(browserAuthAppearsConfigured()).toBe(true);
  });
});
