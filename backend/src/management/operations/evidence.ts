import { canonicalize, sha256Hex, canonicalStringify } from "./canonicalHash.js";

// 1A.5 — safe evidence snapshots (master plan §19/§60, instruction #9).
// Before/after state recorded on a management_operations row must be
// useful for audit, bounded, deterministic, free of raw credentials or
// secrets, free of unnecessary tenant business data, hashable, and
// versioned. This module is the one place that decides what is safe to
// keep — callers pass whatever shape they have; buildSafeSnapshot() strips
// it down rather than trusting the caller to have already redacted it.

export const EVIDENCE_SNAPSHOT_VERSION = "1A.5-evidence.v1";

// Key names that are never safe to retain verbatim, regardless of which
// route or engine produced the evidence. Matched case-insensitively against
// the LAST path segment of a key (so "user.password" and "PASSWORD" both
// match), which is deliberately broader than any one engine's own field
// list — a false-positive redaction (dropping a harmless field whose name
// happens to match) is an acceptable cost; a false negative (a secret
// slipping through) is not.
const SECRET_KEY_PATTERN = /(password|secret|token|api[_-]?key|private[_-]?key|credential|pem|authorization|cookie|otp|mfa[_-]?code)/i;

// Audit remediation L3 — the pattern above is deliberately broad, but it was
// wiping the 1A.13 credential evidence itself (credentialId, secretKind,
// resultingSecrets — identifiers and masked metadata, never material). These
// EXACT key names are known-safe control metadata and are kept; their
// nested values are still redacted recursively (resultingSecrets' entries
// are kind/version/status/maskedHint). Anything merely resembling them
// (e.g. credential_pem, secretValue) still matches the pattern.
const SAFE_METADATA_KEYS = new Set(["credentialId", "secretKind", "resultingSecrets", "resultingSecret", "webhookEndpointId"]);

// Audit remediation L3 — the 1A.8 PII boundary (admin/user email never
// enters ledger evidence) was only honoured by callers remembering it;
// identity results carried the tenant user's email into `result` and the
// after-state snapshot. Contact PII is now dropped here, centrally.
const PII_KEY_PATTERN = /^(e-?mail|email_?address|phone|phone_?number|mobile)$/i;
const EMAIL_VALUE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isSecretShapedKey(key: string): boolean {
  if (SAFE_METADATA_KEYS.has(key)) return false;
  return SECRET_KEY_PATTERN.test(key) || PII_KEY_PATTERN.test(key);
}

// Looks secret-shaped by VALUE, not just by key name — catches an
// unlabelled field that happens to hold a PEM block or a long bearer-looking
// token, which a key-name filter alone would miss.
function isSecretShapedValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return true; // JWT-shaped
  if (EMAIL_VALUE_PATTERN.test(value)) return true; // contact PII under any key name
  return false;
}

const REDACTED = "[redacted]";

function redact(value: unknown, depth: number): unknown {
  if (depth > 8) return "[truncated:max-depth]"; // bounded, per instruction #9
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return isSecretShapedValue(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    const bounded = value.slice(0, 50); // bounded — do not dump unbounded arrays into evidence
    return bounded.map((item) => redact(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretShapedKey(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface SafeSnapshot {
  version: string;
  hash: string;
  data: unknown;
}

// Builds a bounded, redacted, deterministic, versioned snapshot suitable for
// before_state_safe_snapshot/after_state_safe_snapshot. Does NOT accept a
// raw request body or a raw database row as-is — callers are expected to
// have already picked the specific fields worth recording (per instruction
// #9: "do not solve this by dumping entire request bodies or database rows
// into JSON"); this function's job is the safety net (redaction + bounding
// + hashing + versioning), not field selection.
export function buildSafeSnapshot(data: unknown): SafeSnapshot {
  const safeData = redact(canonicalize(data), 0);
  return {
    version: EVIDENCE_SNAPSHOT_VERSION,
    hash: sha256Hex(canonicalStringify(safeData)),
    data: safeData,
  };
}

// Standalone redaction, for evidence that is logged/recorded outside a full
// SafeSnapshot envelope (e.g. approval_evidence).
export function redactSecretShapedFields(data: unknown): unknown {
  return redact(canonicalize(data), 0);
}
