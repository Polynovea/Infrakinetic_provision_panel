// Typed rejection reasons for the management-auth boundary. Every negative
// case the 1A.2 spec requires (malformed / expired / bad signature / wrong
// issuer / wrong audience / missing role / missing scope / insufficient
// privilege / disabled or revoked operator / revoked session) has its own
// class so tests assert on *why* a request was rejected, not just that it
// was, and so the audit sink records a stable machine-readable reason_code.

export abstract class ManagementAuthError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// --- Authentication (identity of the caller) -------------------------------

export class MissingTokenError extends ManagementAuthError {
  readonly code = "TOKEN_MISSING";
  readonly httpStatus = 401;
  constructor() {
    super("No management bearer token was presented.");
  }
}

export class MalformedTokenError extends ManagementAuthError {
  readonly code = "TOKEN_MALFORMED";
  readonly httpStatus = 401;
  constructor(reason: string) {
    super(`Management bearer token is malformed: ${reason}`);
  }
}

export class ExpiredTokenError extends ManagementAuthError {
  readonly code = "TOKEN_EXPIRED";
  readonly httpStatus = 401;
  constructor() {
    super("Management bearer token has expired.");
  }
}

export class InvalidSignatureError extends ManagementAuthError {
  readonly code = "TOKEN_INVALID_SIGNATURE";
  readonly httpStatus = 401;
  constructor() {
    super("Management bearer token signature could not be verified.");
  }
}

export class WrongIssuerError extends ManagementAuthError {
  readonly code = "TOKEN_WRONG_ISSUER";
  readonly httpStatus = 401;
  constructor() {
    super("Management bearer token issuer is not the configured operator pool.");
  }
}

export class WrongAudienceError extends ManagementAuthError {
  readonly code = "TOKEN_WRONG_AUDIENCE";
  readonly httpStatus = 401;
  constructor() {
    super("Management bearer token audience is not the configured operator app client.");
  }
}

export class WrongTokenUseError extends ManagementAuthError {
  readonly code = "TOKEN_WRONG_USE";
  readonly httpStatus = 401;
  constructor(actual: unknown) {
    super(`Management bearer token must be a Cognito ID token (token_use='id'); received '${String(actual)}'.`);
  }
}

// --- Operator/session state --------------------------------------------------

export class OperatorNotProvisionedError extends ManagementAuthError {
  readonly code = "OPERATOR_NOT_PROVISIONED";
  readonly httpStatus = 403;
  constructor() {
    super("Token subject is not a recognized platform operator.");
  }
}

export class OperatorDisabledError extends ManagementAuthError {
  readonly code = "OPERATOR_DISABLED";
  readonly httpStatus = 403;
  constructor(status: string) {
    super(`Operator account is ${status}.`);
  }
}

export class OperatorMfaRequiredError extends ManagementAuthError {
  readonly code = "OPERATOR_MFA_REQUIRED";
  readonly httpStatus = 403;
  constructor() {
    super("Platform operator is not marked as MFA-enrolled in the Governance directory.");
  }
}

export class SessionRevokedError extends ManagementAuthError {
  readonly code = "SESSION_REVOKED";
  readonly httpStatus = 403;
  constructor() {
    super("Operator session has been revoked (logged out).");
  }
}

export class BearerAuthDisabledError extends ManagementAuthError {
  readonly code = "BEARER_AUTH_DISABLED";
  readonly httpStatus = 401;
  constructor() {
    super("Raw operator bearer authentication is disabled in this environment; use the Governance browser session.");
  }
}

export class InsufficientPrivilegeError extends ManagementAuthError {
  readonly code = "INSUFFICIENT_PRIVILEGE";
  readonly httpStatus = 403;
  constructor(detail: string) {
    super(`Operator record grants privilege beyond its role ceiling: ${detail}`);
  }
}

// --- Authorization (per-route decisions, thrown by authorize.ts) -----------

export class MissingRoleError extends ManagementAuthError {
  readonly code = "ROLE_REQUIRED";
  readonly httpStatus = 403;
  constructor(role: string) {
    super(`Route requires role '${role}'.`);
  }
}

export class MissingScopeError extends ManagementAuthError {
  readonly code = "SCOPE_REQUIRED";
  readonly httpStatus = 403;
  constructor(scope: string) {
    super(`Route requires scope '${scope}'.`);
  }
}

export class StepUpRequiredError extends ManagementAuthError {
  readonly code = "STEP_UP_REQUIRED";
  readonly httpStatus = 403;
  constructor() {
    super("Route requires a fresh step-up verification.");
  }
}

export class StepUpNotConfiguredError extends ManagementAuthError {
  readonly code = "STEP_UP_NOT_CONFIGURED";
  readonly httpStatus = 501;
  constructor() {
    super("Real operator step-up verification is not configured yet; caller-asserted step-up is never accepted.");
  }
}

export class ConfigurationError extends ManagementAuthError {
  readonly code = "IDENTITY_PROVIDER_MISCONFIGURED";
  readonly httpStatus = 500;
  constructor(message: string) {
    super(message);
  }
}
