-- Phase 1A.11 — reserved system-operator row for the public self-service
-- signup boundary (decision log 2026-09-19: public signup is an approved
-- product path; the browser must never hold X-Platform-Key or any other
-- general provisioning credential; Infrakinetic's new public signup route
-- calls this boundary server-to-server, authenticated by a narrow,
-- dedicated shared secret checked by requirePublicOnboardingServiceAuth.ts
-- — never by requireManagementApiAuth, never by a human operator session).
--
-- governance.management_operations.operator_id is NOT NULL REFERENCES
-- governance.operators (0003), so every ledger entry the new boundary
-- creates needs a real row here to satisfy that FK. This is that row: a
-- permanent, well-known identity (fixed UUID, same "reserved sentinel"
-- convention as Infrakinetic's RESERVED_PLATFORM_TENANT_ID), never a real
-- human, never logged into via Cognito. cognito_sub is a non-Cognito
-- sentinel string — it can never collide with a real Cognito sub (which is
-- always a UUID) and the unique constraint still holds.
--
-- Deliberately does NOT grant operator_roles/operator_scopes rows: this
-- identity never passes through requireManagementApiAuth/authorize.ts (the
-- human-operator role/scope-ceiling machinery), so those tables would be
-- unused metadata here, not a real grant. The new boundary hardcodes
-- exactly one capability (tenants.commission) in application code — see
-- that middleware's own header for why narrowness is enforced there, not
-- by a role.
--
-- CORRECTED 2026-09-19 (pre-commit review): mfa_enrolled is FALSE, not
-- TRUE. This identity never performs MFA and never authenticates through
-- the human-operator system at all — recording TRUE would fabricate
-- evidence of a security property that never actually happened, purely to
-- resemble a human operator row. requireManagementApiAuth's own
-- OperatorMfaRequiredError check is irrelevant here (this identity never
-- reaches that middleware), so FALSE has no functional effect either way —
-- it is set honestly, not for enforcement.

INSERT INTO governance.operators (
  operator_id, cognito_sub, email, display_name, status, mfa_enrolled, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-0000000000f0',
  'system:public-onboarding-service',
  'system+public-onboarding@polynovea.internal',
  'Public Onboarding Service (system)',
  'active',
  FALSE,
  now(),
  now()
);
