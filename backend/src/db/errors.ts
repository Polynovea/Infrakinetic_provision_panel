import { ManagementAuthError } from "../identity/errors.js";

// Thrown by the DB layer when GOVERNANCE_DB_* is not configured, or when a
// query cannot reach the database. Deliberately a ManagementAuthError
// subclass — not because a database outage is an auth decision, but because
// every current caller (PostgresOperatorDirectory/PostgresSessionStore, both
// invoked from inside requireManagementApiAuth's try block) already has a
// single, audited, typed-error-to-HTTP-response path built for exactly this
// shape (identity/errors.ts + middleware/requireManagementApiAuth.ts's
// `fail()` helper). Reusing it means a DB outage fails closed with a typed,
// audited, machine-readable response instead of falling through to
// Express's generic 500 handler — consistent with every other dependency
// failure in this codebase (compare ConfigurationError for the equivalent
// Cognito-side case).
export class DatabaseUnavailableError extends ManagementAuthError {
  readonly code = "GOVERNANCE_DB_UNAVAILABLE";
  readonly httpStatus = 503;
  constructor(message: string) {
    super(message);
  }
}
