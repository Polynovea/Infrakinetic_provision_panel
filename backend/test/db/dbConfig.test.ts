import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDbConfig } from "../../src/db/dbConfig.js";
import { DatabaseUnavailableError } from "../../src/db/errors.js";

const DB_ENV_VARS = [
  "GOVERNANCE_DB_HOST",
  "GOVERNANCE_DB_PORT",
  "GOVERNANCE_DB_NAME",
  "GOVERNANCE_DB_USER",
  "GOVERNANCE_DB_PASSWORD",
  "GOVERNANCE_DB_SSL",
  "GOVERNANCE_DB_SSL_CA_FILE",
  "GOVERNANCE_DB_SSL_SERVERNAME",
  "GOVERNANCE_DB_POOL_MAX",
] as const;

const savedEnv: Record<string, string | undefined> = {};

describe("db/dbConfig", () => {
  beforeEach(() => {
    for (const key of DB_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of DB_ENV_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("throws DatabaseUnavailableError naming the first missing required variable", () => {
    expect(() => loadDbConfig()).toThrow(DatabaseUnavailableError);
    expect(() => loadDbConfig()).toThrow(/GOVERNANCE_DB_HOST/);
  });

  it("loads a full config with sensible defaults for optional values", () => {
    process.env.GOVERNANCE_DB_HOST = "127.0.0.1";
    process.env.GOVERNANCE_DB_NAME = "polynovea_platform_governance";
    process.env.GOVERNANCE_DB_USER = "governance_app";
    process.env.GOVERNANCE_DB_PASSWORD = "test-password";

    const config = loadDbConfig();

    expect(config).toEqual({
      host: "127.0.0.1",
      port: 5432,
      database: "polynovea_platform_governance",
      user: "governance_app",
      password: "test-password",
      ssl: true,
      sslCa: undefined,
      sslServername: undefined,
      poolMax: 10,
    });
  });

  it("respects explicit overrides for port/ssl/poolMax", () => {
    process.env.GOVERNANCE_DB_HOST = "127.0.0.1";
    process.env.GOVERNANCE_DB_NAME = "db";
    process.env.GOVERNANCE_DB_USER = "u";
    process.env.GOVERNANCE_DB_PASSWORD = "p";
    process.env.GOVERNANCE_DB_PORT = "5433";
    process.env.GOVERNANCE_DB_SSL = "false";
    process.env.GOVERNANCE_DB_POOL_MAX = "5";

    const config = loadDbConfig();

    expect(config.port).toBe(5433);
    expect(config.ssl).toBe(false);
    expect(config.poolMax).toBe(5);
  });

  it("rejects an invalid GOVERNANCE_DB_SSL value", () => {
    process.env.GOVERNANCE_DB_HOST = "127.0.0.1";
    process.env.GOVERNANCE_DB_NAME = "db";
    process.env.GOVERNANCE_DB_USER = "u";
    process.env.GOVERNANCE_DB_PASSWORD = "p";
    process.env.GOVERNANCE_DB_SSL = "yes-please";

    expect(() => loadDbConfig()).toThrow(DatabaseUnavailableError);
  });

  it("rejects a non-positive GOVERNANCE_DB_POOL_MAX", () => {
    process.env.GOVERNANCE_DB_HOST = "127.0.0.1";
    process.env.GOVERNANCE_DB_NAME = "db";
    process.env.GOVERNANCE_DB_USER = "u";
    process.env.GOVERNANCE_DB_PASSWORD = "p";
    process.env.GOVERNANCE_DB_POOL_MAX = "0";

    expect(() => loadDbConfig()).toThrow(DatabaseUnavailableError);
  });

  describe("TLS trust configuration (GOVERNANCE_DB_SSL_CA_FILE / _SERVERNAME)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "governance-db-ca-test-"));
      process.env.GOVERNANCE_DB_HOST = "127.0.0.1";
      process.env.GOVERNANCE_DB_NAME = "db";
      process.env.GOVERNANCE_DB_USER = "u";
      process.env.GOVERNANCE_DB_PASSWORD = "p";
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("SSL disabled: sslCa/sslServername are not read even if set", () => {
      process.env.GOVERNANCE_DB_SSL = "false";
      process.env.GOVERNANCE_DB_SSL_SERVERNAME = "real-host.example.com";

      const config = loadDbConfig();

      expect(config.ssl).toBe(false);
      expect(config.sslCa).toBeUndefined();
      expect(config.sslServername).toBe("real-host.example.com");
    });

    it("SSL enabled with a valid CA file: reads and returns its contents", () => {
      const caPath = join(tmpDir, "ca.pem");
      writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
      process.env.GOVERNANCE_DB_SSL = "true";
      process.env.GOVERNANCE_DB_SSL_CA_FILE = caPath;

      const config = loadDbConfig();

      expect(config.ssl).toBe(true);
      expect(config.sslCa).toContain("BEGIN CERTIFICATE");
    });

    it("optional TLS servername is passed through for tunnelled connections", () => {
      process.env.GOVERNANCE_DB_SSL = "true";
      process.env.GOVERNANCE_DB_SSL_SERVERNAME = "polynovea.example.rds.amazonaws.com";

      const config = loadDbConfig();

      expect(config.sslServername).toBe("polynovea.example.rds.amazonaws.com");
    });

    it("fails closed when GOVERNANCE_DB_SSL_CA_FILE points at a file that cannot be read", () => {
      process.env.GOVERNANCE_DB_SSL = "true";
      process.env.GOVERNANCE_DB_SSL_CA_FILE = join(tmpDir, "does-not-exist.pem");

      expect(() => loadDbConfig()).toThrow(DatabaseUnavailableError);
      expect(() => loadDbConfig()).toThrow(/GOVERNANCE_DB_SSL_CA_FILE/);
    });
  });
});
