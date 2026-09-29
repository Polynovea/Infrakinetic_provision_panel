import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// 1A.15 final closure — the operator UI derives the address of a NEW root quota policy client-side
// (frontend/components/AiActions.tsx quotaPolicyKey). The owner never parses a key: a PUT recomputes it from the
// body and refuses a mismatch, so a wrong derivation can only be refused, never mis-applied. There is no frontend
// test runner, so this test transpiles that exact function and holds it to the owner's published examples and the
// owner's documented format:  <scopeType>:<scopeKey|*>:<plane|*>:<period>:<limitType>:<usageUnit|*>

type Policy = { scopeType: string; scopeKey?: string | null; aiPlane?: string | null; period: string; limitType: string; usageUnit?: string | null };

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, "../../../frontend/components/AiActions.tsx"), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("const KEY_PART");
const endMarker = source.indexOf("\n}\n", source.indexOf("export function quotaPolicyKey"));
if (start < 0 || endMarker < 0) throw new Error("quotaPolicyKey not found in frontend/components/AiActions.tsx");
const js = ts.transpileModule(`${source.slice(start, endMarker + 3).replace("export function quotaPolicyKey", "function quotaPolicyKey")}\nreturn quotaPolicyKey;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const quotaPolicyKey = new Function(js)() as (policy: Policy) => string | null;

const examples = (createRequire(import.meta.url)("../../src/management/contracts/aiManagement.examples.json") as { examples: Record<string, any> }).examples; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("client-derived quota policy key", () => {
  it("reproduces every policy key the owner publishes in its examples (rows without a unit)", () => {
    const quotas = examples.TenantAiState.quotas as Array<{ policyKey: string; scope: { type: string; key: string | null; plane: string | null }; period: string; limitType: string }>;
    expect(quotas.length).toBeGreaterThan(0);
    for (const quota of quotas) {
      expect(quotaPolicyKey({ scopeType: quota.scope.type, scopeKey: quota.scope.key, aiPlane: quota.scope.plane, period: quota.period, limitType: quota.limitType })).toBe(quota.policyKey);
    }
  });

  it("matches the owner's documented format, with * for every absent optional part", () => {
    expect(quotaPolicyKey({ scopeType: "capability", scopeKey: "platform.ai_extended_probe", aiPlane: "extended", period: "daily", limitType: "requests" })).toBe("capability:platform.ai_extended_probe:extended:daily:requests:*");
    expect(quotaPolicyKey({ scopeType: "tenant", period: "monthly", limitType: "tokens" })).toBe("tenant:*:*:monthly:tokens:*");
    expect(quotaPolicyKey({ scopeType: "tenant", scopeKey: "", aiPlane: null, period: "billing_period", limitType: "units", usageUnit: "pages" })).toBe("tenant:*:*:billing_period:units:pages");
    expect(quotaPolicyKey({ scopeType: "model", scopeKey: "nvidia_nim/chat_default", period: "weekly", limitType: "cost" })).toBe("model:nvidia_nim/chat_default:*:weekly:cost:*");
  });

  it("never produces an address from a part the owner would not accept", () => {
    expect(quotaPolicyKey({ scopeType: "tenant", period: "daily", limitType: "requests", scopeKey: "has space" })).toBeNull();
    expect(quotaPolicyKey({ scopeType: "tenant", period: "daily", limitType: "requests", scopeKey: "a:b" })).toBeNull();
    expect(quotaPolicyKey({ scopeType: "", period: "daily", limitType: "requests" })).toBeNull();
    expect(quotaPolicyKey({ scopeType: "tenant", period: "daily", limitType: "requests", usageUnit: "x".repeat(129) })).toBeNull();
    expect(quotaPolicyKey({ scopeType: "tenant", period: "daily", limitType: "requests", aiPlane: "../etc" })).not.toBeNull(); // '/' and '.' are legal key characters; the owner scopes it to the tenant's own rows
  });
});
