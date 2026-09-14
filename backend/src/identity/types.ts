import type { Role, Scope } from "./roles.js";

export type OperatorStatus = "active" | "disabled" | "revoked";

// The governance-owned operator record. cognitoSub is the only field that
// ties this to the external identity provider; everything privilege-bearing
// (status/roles/scopes) is authoritative here, never trusted from the IdP
// token itself. See docs/1A.2_status.md "Why authorization is not derived
// from the Cognito token" for the full rationale.
export interface OperatorRecord {
  operatorId: string;
  cognitoSub: string;
  email: string;
  displayName: string;
  status: OperatorStatus;
  roles: readonly Role[];
  scopes: readonly Scope[];
  mfaEnrolled: boolean;
  createdAt: string;
  disabledAt?: string;
  disabledReason?: string;
}

export interface StepUpState {
  verifiedAt: string;
  method: string;
}

export interface OperatorSessionRecord {
  sessionId: string;
  operatorId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedReason?: string;
  stepUp?: StepUpState;
}

// Request-scoped authorization context attached by requireManagementApiAuth.
// Authentication (identity + session) and authorization (role/scope checks)
// are deliberately separate: this object carries authenticated facts only —
// nothing here decides whether a given route may proceed. That decision is
// made per-route by the authorize.ts middleware reading this context.
export interface OperatorContext {
  operatorId: string;
  cognitoSub: string;
  operatorSessionId: string;
  email: string;
  roles: readonly Role[];
  scopes: readonly Scope[];
  correlationId: string;
  authenticatedAt: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operatorContext?: OperatorContext;
      operatorAuthMethod?: "bearer" | "browser-session";
      browserSessionCsrfToken?: string;
    }
  }
}
