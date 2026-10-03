import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Phase 1A.19 Governance runtime isolation contract", () => {
  const source = readFileSync(new URL("../../ecosystem.config.cjs", import.meta.url), "utf8");

  it("keeps Governance in its own PM2 process and applies a memory restart ceiling", () => {
    expect(source).toContain('name: "polynovea-governance-api"');
    expect(source).toContain('exec_mode: "fork"');
    expect(source).toContain('max_memory_restart: "256M"');
  });
});
