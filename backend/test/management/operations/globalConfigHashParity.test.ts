import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { contentHashOf, packageSigningInput, snapshotHashOf } from "../../../src/management/operations/globalConfigRestoreOperation.js";

// Phase 1A.14 — the same parity vector Infrakinetic pins in
// api-server/src/globalConfig/__tests__/hashParity.test.js. The literals are
// Infrakinetic's outputs; Governance must reproduce them with its own
// canonicalizer, or owner-signed packages would not verify here.

const CONTRACT = { classKey: "payment_provider_catalog", classSchemaVersion: "c".repeat(64), naturalKey: ["provider_key", "adapter_version"] };
const ROWS = [
  { provider_key: "stripe", adapter_version: "1.0.0", display_name: "Stripe", capabilities: { refunds: true, a: [1, "x", null] }, configuration_schema: { required: ["k"] }, status: "certified", manifest_hash: "a".repeat(64) },
  { provider_key: "razorpay", adapter_version: "1.0.0", display_name: "Razorpay — ₹", capabilities: {}, configuration_schema: {}, status: "retired", manifest_hash: "b".repeat(64) },
];

describe("global config hash parity vector (shared with Infrakinetic)", () => {
  it("reproduces Infrakinetic's content hash, snapshot hash and signing input", () => {
    const header = {
      packageFormat: "polynovea.global-config-package.v1", packageId: "00000000-0000-4000-8000-000000000001", classKey: "payment_provider_catalog",
      classSchemaVersion: "c".repeat(64), sourceEnvironment: "synthetic", producedAt: "2026-09-27T00:00:00.000Z",
      producedBy: { kind: "owner-export", ownerEngine: "payments" }, rowCount: 2, contentHash: contentHashOf(ROWS),
    };
    expect(contentHashOf(ROWS)).toBe("3192b2576fd3d0754b658f52722f36fd663b8a43d0a1913ca73289d71ae20fa5");
    expect(snapshotHashOf(CONTRACT, ROWS)).toBe("eef8b85a0d1b378adce0ab32d11235519d6561b0c40dc79ccd29694235576371");
    expect(createHash("sha256").update(packageSigningInput(header)).digest("hex")).toBe("2615610e09cbc3598a41a27f7ad6e505220f47bc3dd1464c5d1f5d7a454fe273");
  });
});
