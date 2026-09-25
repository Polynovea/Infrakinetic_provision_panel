import { describe, expect, it } from "vitest";

import { buildSafeSnapshot, redactSecretShapedFields, EVIDENCE_SNAPSHOT_VERSION } from "../../../src/management/operations/evidence.js";

describe("management/operations/evidence", () => {
  it("redacts fields whose key looks secret-shaped", () => {
    const out = redactSecretShapedFields({
      password: "hunter2",
      apiKey: "sk_live_abc",
      credential_pem: "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
      note: "safe field",
    }) as Record<string, unknown>;
    expect(out.password).toBe("[redacted]");
    expect(out.apiKey).toBe("[redacted]");
    expect(out.credential_pem).toBe("[redacted]");
    expect(out.note).toBe("safe field");
  });

  it("redacts values that look secret-shaped even under an innocuous key", () => {
    const out = redactSecretShapedFields({
      detail: "-----BEGIN RSA PRIVATE KEY-----\nMIIB...==\n-----END RSA PRIVATE KEY-----",
      jwtLooking: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123signature",
    }) as Record<string, unknown>;
    expect(out.detail).toBe("[redacted]");
    expect(out.jwtLooking).toBe("[redacted]");
  });

  // Audit remediation L3.
  it("keeps exact known-safe credential metadata keys, while look-alikes and nested material stay redacted", () => {
    const out = redactSecretShapedFields({
      credentialId: "cred-1",
      secretKind: "api_key_pair",
      resultingSecrets: [{ kind: "api_key_secret", version: 2, status: "active", maskedHint: "****cret", secret: "raw" }],
      secretValue: "raw-material",
      credential_pem: "x",
    }) as Record<string, unknown>;
    expect(out.credentialId).toBe("cred-1");
    expect(out.secretKind).toBe("api_key_pair");
    expect(out.resultingSecrets).toEqual([{ kind: "api_key_secret", version: 2, status: "active", maskedHint: "****cret", secret: "[redacted]" }]);
    expect(out.secretValue).toBe("[redacted]");
    expect(out.credential_pem).toBe("[redacted]");
  });

  it("drops contact PII (1A.8 boundary): email/phone keys, and email-shaped values under any key", () => {
    const out = redactSecretShapedFields({ email: "a@b.example", phone: "+911234", contact: "someone@tenant.example", name: "A" }) as Record<string, unknown>;
    expect(out.email).toBe("[redacted]");
    expect(out.phone).toBe("[redacted]");
    expect(out.contact).toBe("[redacted]");
    expect(out.name).toBe("A");
  });

  it("redacts nested secret fields", () => {
    const out = redactSecretShapedFields({ user: { name: "A", secret: "x" } }) as { user: { secret: string; name: string } };
    expect(out.user.secret).toBe("[redacted]");
    expect(out.user.name).toBe("A");
  });

  it("bounds array length rather than dumping unbounded arrays", () => {
    const big = Array.from({ length: 200 }, (_, i) => i);
    const out = redactSecretShapedFields(big) as number[];
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it("buildSafeSnapshot is versioned and hashable", () => {
    const snap = buildSafeSnapshot({ quota: 10 });
    expect(snap.version).toBe(EVIDENCE_SNAPSHOT_VERSION);
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.data).toEqual({ quota: 10 });
  });

  it("buildSafeSnapshot produces the same hash for equal (safe) data regardless of key order", () => {
    const a = buildSafeSnapshot({ z: 1, a: 2 });
    const b = buildSafeSnapshot({ a: 2, z: 1 });
    expect(a.hash).toBe(b.hash);
  });

  it("buildSafeSnapshot never leaks a secret-shaped value into its hash input", () => {
    const withSecret = buildSafeSnapshot({ quota: 10, password: "hunter2" });
    const withoutSecret = buildSafeSnapshot({ quota: 10, password: "[redacted]" });
    expect(withSecret.hash).toBe(withoutSecret.hash);
    expect(JSON.stringify(withSecret.data)).not.toContain("hunter2");
  });
});
