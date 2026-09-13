import { describe, expect, it } from "vitest";

import { canonicalStringify, computeSafePayloadHash } from "../../../src/management/operations/canonicalHash.js";

describe("management/operations/canonicalHash", () => {
  it("produces the same string for objects built with different key insertion order", () => {
    const a = { z: 1, a: 2, m: { y: 1, b: 2 } };
    const b = { a: 2, z: 1, m: { b: 2, y: 1 } };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("treats array order as significant", () => {
    expect(canonicalStringify([1, 2, 3])).not.toBe(canonicalStringify([3, 2, 1]));
  });

  it("computeSafePayloadHash is deterministic for equal scopes regardless of key order", () => {
    const h1 = computeSafePayloadHash({
      requestedAction: "platform.engine-state.set",
      targetTenantId: null,
      targetEngine: "module_ai",
      payload: { desiredState: "enabled", quota: 10 },
    });
    const h2 = computeSafePayloadHash({
      requestedAction: "platform.engine-state.set",
      targetTenantId: null,
      targetEngine: "module_ai",
      payload: { quota: 10, desiredState: "enabled" },
    });
    expect(h1).toBe(h2);
  });

  it("binds the hash to requestedAction — a different action changes the hash even with the same payload", () => {
    const scope = { targetTenantId: null, targetEngine: "module_ai", payload: { desiredState: "enabled" } };
    const h1 = computeSafePayloadHash({ ...scope, requestedAction: "platform.engine-state.set" });
    const h2 = computeSafePayloadHash({ ...scope, requestedAction: "platform.engine-state.disable-globally" });
    expect(h1).not.toBe(h2);
  });

  it("binds the hash to targetEngine — a different engine changes the hash", () => {
    const scope = { requestedAction: "x", targetTenantId: null, payload: {} };
    const h1 = computeSafePayloadHash({ ...scope, targetEngine: "module_ai" });
    const h2 = computeSafePayloadHash({ ...scope, targetEngine: "module_billing" });
    expect(h1).not.toBe(h2);
  });

  it("binds the hash to targetTenantId — platform-wide (null) differs from tenant-scoped", () => {
    const scope = { requestedAction: "x", targetEngine: "module_ai", payload: {} };
    const h1 = computeSafePayloadHash({ ...scope, targetTenantId: null });
    const h2 = computeSafePayloadHash({ ...scope, targetTenantId: "11111111-1111-4111-8111-111111111111" });
    expect(h1).not.toBe(h2);
  });

  it("binds the hash to the payload contents", () => {
    const scope = { requestedAction: "x", targetTenantId: null, targetEngine: "module_ai" };
    const h1 = computeSafePayloadHash({ ...scope, payload: { desiredState: "enabled" } });
    const h2 = computeSafePayloadHash({ ...scope, payload: { desiredState: "disabled" } });
    expect(h1).not.toBe(h2);
  });
});
