import type { OperatorRecord } from "../../src/identity/types.js";

export function activeAdminOperator(overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    operatorId: "11111111-1111-4111-8111-111111111111",
    cognitoSub: "fixture-sub-admin",
    email: "admin@example.invalid",
    displayName: "Test Admin",
    status: "active",
    roles: ["platform_admin"],
    scopes: ["audit.read", "tenants.read"],
    mfaEnrolled: true,
    createdAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

export function activeViewerOperator(overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    operatorId: "22222222-2222-4222-8222-222222222222",
    cognitoSub: "fixture-sub-viewer",
    email: "viewer@example.invalid",
    displayName: "Test Viewer",
    status: "active",
    roles: ["platform_viewer"],
    scopes: ["tenants.read"],
    mfaEnrolled: true,
    createdAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

export function disabledOperator(overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    ...activeViewerOperator(),
    operatorId: "33333333-3333-4333-8333-333333333333",
    cognitoSub: "fixture-sub-disabled",
    status: "disabled",
    disabledAt: "2026-09-11T00:00:00.000Z",
    disabledReason: "test fixture",
    ...overrides,
  };
}

/** The exact shape bootstrapOperatorDb.ts creates: disabled, mfaEnrolled=false, awaiting a first MFA'd login. */
export function pendingMfaOperator(overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    ...activeAdminOperator(),
    operatorId: "66666666-6666-4666-8666-666666666666",
    cognitoSub: "fixture-sub-pending-mfa",
    status: "disabled",
    mfaEnrolled: false,
    disabledAt: "2026-09-15T00:00:00.000Z",
    disabledReason: "Pending real TOTP MFA enrollment (bootstrap-created, not yet verified)",
    ...overrides,
  };
}

export function revokedOperator(overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    ...activeViewerOperator(),
    operatorId: "44444444-4444-4444-8444-444444444444",
    cognitoSub: "fixture-sub-revoked",
    status: "revoked",
    disabledAt: "2026-09-11T00:00:00.000Z",
    disabledReason: "test fixture",
    ...overrides,
  };
}

/** Carries a scope its role does not permit — must trip InsufficientPrivilegeError. */
export function overPrivilegedOperator(overrides: Partial<OperatorRecord> = {}): OperatorRecord {
  return {
    ...activeViewerOperator(),
    operatorId: "55555555-5555-4555-8555-555555555555",
    cognitoSub: "fixture-sub-over-privileged",
    roles: ["platform_viewer"],
    scopes: ["tenants.read", "tenants.commission"], // platform_viewer's ceiling excludes this
    ...overrides,
  };
}
