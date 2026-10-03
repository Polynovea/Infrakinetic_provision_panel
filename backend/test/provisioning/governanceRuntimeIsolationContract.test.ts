import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Phase 1A.19 Governance runtime isolation contract", () => {
  const source = readFileSync(new URL("../../ecosystem.config.cjs", import.meta.url), "utf8");
  const unit = readFileSync(new URL("../../ops/systemd/pm2-polynovea-governance.service", import.meta.url), "utf8");

  it("keeps Governance in its own PM2 process and applies a memory restart ceiling", () => {
    expect(source).toContain('name: "polynovea-governance-api"');
    expect(source).toContain('exec_mode: "fork"');
    expect(source).toContain('max_memory_restart: "256M"');
    expect(source).toContain('GOVERNANCE_API_PORT: "4101"');
    expect(source).toContain('INFRAKINETIC_MANAGEMENT_BASE_URL: "http://127.0.0.1:4001"');
    expect(source).toContain('error_file: "/var/log/polynovea-governance/governance-api-error.log"');
    expect(unit).toContain("User=polynovea-governance");
    expect(unit).toContain("Group=polynovea-governance");
    expect(unit).toContain("PM2_HOME=/var/lib/polynovea-governance/.pm2");
  });
});
