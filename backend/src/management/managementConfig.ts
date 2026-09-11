import { DatabaseUnavailableError } from "../db/errors.js";

// 1A.4 — non-secret management-transport configuration. Separate from
// managementSigningKeys.ts (key material) so tests can exercise issuer
// logic against fixed iss/aud/TTL values without needing real keys, and
// so a future rotation of iss/aud doesn't touch key-loading code at all.

export const MANAGEMENT_ASSERTION_MIN_TTL_SECONDS = 60;
export const MANAGEMENT_ASSERTION_MAX_TTL_SECONDS = 120;
export const MANAGEMENT_ASSERTION_DEFAULT_TTL_SECONDS = 90;

// Governance is permanently Polynovea-owned — this identifies the calling
// *service*, never a caller-supplied or tenant value. Fixed in source, not
// environment-configurable, so no deployment configuration mistake or
// request parameter can ever cause Governance to assert a different actor
// identity than itself.
export const GOVERNANCE_ACTOR_IDENTITY = "polynovea-platform-governance";

export interface ManagementTransportConfig {
  issuer: string;
  audience: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new DatabaseUnavailableError(
      `Missing required environment variable ${name}. Management assertion issuance cannot start until this is configured.`,
    );
  }
  return value;
}

export function loadManagementTransportConfig(): ManagementTransportConfig {
  return {
    issuer: required("GOVERNANCE_MANAGEMENT_ISSUER"),
    audience: required("GOVERNANCE_MANAGEMENT_AUDIENCE"),
  };
}

export function clampAssertionTtlSeconds(requested: number | undefined): number {
  const value = requested ?? MANAGEMENT_ASSERTION_DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(value)) return MANAGEMENT_ASSERTION_DEFAULT_TTL_SECONDS;
  return Math.min(MANAGEMENT_ASSERTION_MAX_TTL_SECONDS, Math.max(MANAGEMENT_ASSERTION_MIN_TTL_SECONDS, Math.round(value)));
}
