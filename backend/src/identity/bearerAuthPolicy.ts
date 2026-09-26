// Audit remediation L8 — raw operator bearer authentication (a Cognito ID
// token in `Authorization: Bearer`) is an explicitly controlled capability,
// not an ambient second login path.
//
// - test / development: allowed (the test harness and the local DevSignIn
//   flow depend on it; the frontend only offers DevSignIn outside
//   production).
// - production: DISABLED unless GOVERNANCE_OPERATOR_BEARER_AUTH is exactly
//   "enabled-for-tooling". This is a non-browser tooling mode (e.g. a
//   scripted certification run) — the Governance UI always uses the
//   __Host- browser session. Any other value, including "true"/"1" or a
//   typo, is treated as ambiguous and fails closed.
//
// When enabled, the bearer path keeps every existing check: token
// verification, operator lookup, active status, MFA-enrolled, server-side
// session revocation and the role scope ceiling.

export const OPERATOR_BEARER_AUTH_ENV = "GOVERNANCE_OPERATOR_BEARER_AUTH";
export const OPERATOR_BEARER_AUTH_ENABLED_VALUE = "enabled-for-tooling";

export function isOperatorBearerAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return true;
  return env[OPERATOR_BEARER_AUTH_ENV] === OPERATOR_BEARER_AUTH_ENABLED_VALUE;
}
