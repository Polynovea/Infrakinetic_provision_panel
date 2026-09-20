import { describe, expect, it } from "vitest";

import { deterministicUuidFrom } from "../../src/management/deterministicId.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("management/deterministicId", () => {
  it("produces a valid, UUID-shaped string with version 5 and RFC 4122 variant bits", () => {
    expect(deterministicUuidFrom("some-idempotency-key")).toMatch(UUID_RE);
  });

  it("is deterministic — the same seed always produces the same id", () => {
    const a = deterministicUuidFrom("idem-abc");
    const b = deterministicUuidFrom("idem-abc");
    expect(a).toBe(b);
  });

  it("different seeds produce different ids", () => {
    const a = deterministicUuidFrom("idem-abc");
    const b = deterministicUuidFrom("idem-xyz");
    expect(a).not.toBe(b);
  });
});
