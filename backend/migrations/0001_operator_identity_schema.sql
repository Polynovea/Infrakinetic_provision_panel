-- 1A.2 — privileged operator identity persistence schema.
--
-- STATUS: authored, NOT applied. There is no Governance database yet — a
-- separate Postgres database/role is 1A.3's deliverable (master plan
-- §18/§64 "1A.3 — Governance DB"). This file exists now because 1A.2's
-- application code (src/identity/operatorDirectory.ts,
-- src/identity/sessionStore.ts) is written against exactly this shape, so
-- 1A.3 can stand up the real database and swap the in-memory adapters for
-- Postgres-backed ones without changing the auth boundary. Proven locally
-- via an in-memory Postgres engine (pg-mem) in
-- test/migrations/0001_operator_identity_schema.test.ts — this is schema
-- verification, not a claim that it has been applied anywhere.
--
-- No tenant business data, no Infrakinetic table, no shared credential
-- appears here (README.md hard rules #2/#3/#8).

CREATE TABLE operators (
  operator_id      UUID PRIMARY KEY,
  cognito_sub      TEXT NOT NULL UNIQUE,
  email            TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
  mfa_enrolled     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL,
  disabled_at      TIMESTAMPTZ,
  disabled_reason  TEXT,
  CONSTRAINT operators_disabled_fields_consistent CHECK (
    (status = 'active' AND disabled_at IS NULL)
    OR (status <> 'active' AND disabled_at IS NOT NULL)
  )
);

-- Explicit per-operator role grants. A role by itself grants nothing; it is
-- the ceiling operator_scopes rows are validated against (see roles.ts
-- ROLE_SCOPE_CEILING, enforced at request time by requireManagementApiAuth,
-- and here at rest by operator_scopes_role_permitted below).
CREATE TABLE operator_roles (
  operator_id  UUID NOT NULL REFERENCES operators (operator_id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN (
    'platform_viewer', 'platform_operator', 'provisioning_operator',
    'identity_operator', 'security_operator', 'finops_operator',
    'platform_admin', 'break_glass'
  )),
  granted_at   TIMESTAMPTZ NOT NULL,
  granted_by   UUID REFERENCES operators (operator_id),
  PRIMARY KEY (operator_id, role)
);

-- Explicit per-operator scope grants (master plan §15: "use explicit
-- scopes, not role checks alone"). The application cross-validates this
-- against operator_roles' permitted ceiling; a row here that exceeds every
-- granted role's ceiling is a data-integrity bug the app rejects at
-- request time (InsufficientPrivilegeError), not a normal state to design
-- around at the schema level, so it is not re-enforced with a CHECK here
-- (that ceiling lives in application code and can change without a
-- migration; the schema only constrains scope to the known vocabulary).
CREATE TABLE operator_scopes (
  operator_id  UUID NOT NULL REFERENCES operators (operator_id) ON DELETE CASCADE,
  scope        TEXT NOT NULL CHECK (scope IN (
    'tenants.read', 'tenants.commission', 'tenants.suspend',
    'engines.read', 'engines.entitlement.write', 'engines.platform_state.write', 'engines.release.write',
    'identity.read', 'identity.recovery', 'identity.disable', 'identity.mfa_reset',
    'credentials.metadata.read', 'credentials.submit', 'credentials.rotate', 'credentials.revoke',
    'ai.read', 'ai.entitlement.write', 'ai.quota.write', 'ai.provider_policy.write', 'ai.emergency_suspend',
    'payments.adapters.read', 'payments.adapters.certify', 'payments.adapters.approve', 'payments.adapters.revoke',
    'integrations.read', 'integrations.manage',
    'runtime.read', 'runtime.repair.request',
    'finops.read', 'finops.policy.write',
    'audit.read'
  )),
  granted_at   TIMESTAMPTZ NOT NULL,
  granted_by   UUID REFERENCES operators (operator_id),
  PRIMARY KEY (operator_id, scope)
);

-- One row per verified operator token ("session" = the Cognito token's own
-- jti — 1A.2 does not mint a separate management assertion; see
-- docs/1A.2_status.md). Presence of a row is not meaningful on its own;
-- revoked_at is what requireManagementApiAuth checks.
CREATE TABLE operator_sessions (
  session_id       UUID PRIMARY KEY,
  operator_id      UUID NOT NULL REFERENCES operators (operator_id) ON DELETE CASCADE,
  issued_at        TIMESTAMPTZ NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  revoked_reason   TEXT,
  step_up_at       TIMESTAMPTZ,
  step_up_method   TEXT,
  ip_address       TEXT,
  user_agent       TEXT
);

CREATE INDEX operator_sessions_operator_id_idx ON operator_sessions (operator_id);

-- Authentication/authorization decision log for the management-auth
-- boundary (append-only; no UPDATE/DELETE path in application code). This
-- is narrower than the full immutable operator action ledger from §19,
-- which 1A.5 owns — this table only ever records "who did/didn't get past
-- requireManagementApiAuth/authorize.ts and why", not privileged actions
-- themselves.
CREATE TABLE operator_auth_audit_log (
  id                   BIGSERIAL PRIMARY KEY,
  occurred_at          TIMESTAMPTZ NOT NULL,
  event_type           TEXT NOT NULL CHECK (event_type IN (
    'auth.success', 'auth.failure', 'authz.denied',
    'session.revoked', 'session.step_up_recorded'
  )),
  operator_id          UUID REFERENCES operators (operator_id),
  operator_session_id  UUID,
  reason_code          TEXT,
  route                TEXT,
  method               TEXT,
  correlation_id       UUID,
  ip_address           TEXT,
  detail               JSONB
);

CREATE INDEX operator_auth_audit_log_operator_id_idx ON operator_auth_audit_log (operator_id);
CREATE INDEX operator_auth_audit_log_occurred_at_idx ON operator_auth_audit_log (occurred_at);
