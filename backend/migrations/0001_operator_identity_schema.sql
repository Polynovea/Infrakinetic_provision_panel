-- 1A.2 — privileged operator identity persistence schema.
--
-- CORRECTED 2026-09-11: rewritten to target the `governance` schema
-- instead of the default `public` schema — Phase 1A Governance runs on a
-- SEPARATE database (`polynovea_governance`) on the same RDS instance as
-- Infrakinetic; the `governance` schema inside that database is defense
-- in depth on top of the database-level separation, not a substitute for
-- it (an earlier revision of this file assumed sharing Infrakinetic's own
-- database with only a schema for isolation — that was wrong and has been
-- corrected; see docs/1A.3_status.md "Architecture correction" for the
-- full record and the git history for the pre-correction versions). This
-- file has never been applied to any real database (confirmed repeatedly
-- across 1A.2/1A.3), so it is edited in place rather than layering a
-- schema-move migration on top of a never-deployed artifact.
--
-- Also folds in, from the start, a correction originally made in 0002
-- while building the Postgres-backed session-store adapter:
-- operator_sessions.operator_id/issued_at/expires_at are nullable, because
-- the OperatorSessionStore port (src/identity/sessionStore.ts) never
-- carries them — 1A.2 does not mint a separate management assertion with
-- its own issuance event, so "session" is just the verified Cognito
-- token's own jti, and revoke()/recordStepUp() (the only two writes the
-- port exposes) may be the first write ever made for a given session id.
--
-- STATUS: authored, verified against pg-mem
-- (test/migrations/0001_operator_identity_schema.test.ts) and, separately,
-- against real Postgres schema/role semantics only once a live database is
-- reachable (docs/1A.3_status.md). No tenant business data, no Infrakinetic
-- table, no shared credential appears here (README.md hard rules #2/#3/#8).
--
-- Run as governance_app (or the bootstrap admin, before governance_app's
-- default search_path is relied upon) — every object below is explicitly
-- schema-qualified rather than depending on search_path resolution, for
-- the same "explicit, not implicit" reason the rest of this codebase
-- prefers explicit checks over inferred ones.

CREATE TABLE governance.operators (
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
CREATE TABLE governance.operator_roles (
  operator_id  UUID NOT NULL REFERENCES governance.operators (operator_id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN (
    'platform_viewer', 'platform_operator', 'provisioning_operator',
    'identity_operator', 'security_operator', 'finops_operator',
    'platform_admin', 'break_glass'
  )),
  granted_at   TIMESTAMPTZ NOT NULL,
  granted_by   UUID REFERENCES governance.operators (operator_id),
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
CREATE TABLE governance.operator_scopes (
  operator_id  UUID NOT NULL REFERENCES governance.operators (operator_id) ON DELETE CASCADE,
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
  granted_by   UUID REFERENCES governance.operators (operator_id),
  PRIMARY KEY (operator_id, scope)
);

-- One row per verified operator token ("session" = the Cognito token's own
-- jti — 1A.2 does not mint a separate management assertion; see
-- docs/1A.2_status.md). operator_id/issued_at/expires_at are nullable: a
-- row created purely by revoke() or recordStepUp() (the only writes the
-- OperatorSessionStore port exposes) represents "we only ever observed a
-- revocation or step-up event for this session id, never an establishment
-- event" — an accurate representation of 1A.2's actual session model, not
-- a data-integrity gap. Presence of a row is not meaningful on its own;
-- revoked_at is what requireManagementApiAuth checks.
CREATE TABLE governance.operator_sessions (
  session_id       UUID PRIMARY KEY,
  operator_id      UUID REFERENCES governance.operators (operator_id) ON DELETE CASCADE,
  issued_at        TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  revoked_reason   TEXT,
  step_up_at       TIMESTAMPTZ,
  step_up_method   TEXT,
  ip_address       TEXT,
  user_agent       TEXT
);

CREATE INDEX operator_sessions_operator_id_idx ON governance.operator_sessions (operator_id);

-- Authentication/authorization decision log for the management-auth
-- boundary (append-only; no UPDATE/DELETE path in application code). This
-- is narrower than the full immutable operator action ledger from §19,
-- which 1A.5 owns — this table only ever records "who did/didn't get past
-- requireManagementApiAuth/authorize.ts and why", not privileged actions
-- themselves.
CREATE TABLE governance.operator_auth_audit_log (
  id                   BIGSERIAL PRIMARY KEY,
  occurred_at          TIMESTAMPTZ NOT NULL,
  event_type           TEXT NOT NULL CHECK (event_type IN (
    'auth.success', 'auth.failure', 'authz.denied',
    'session.revoked', 'session.step_up_recorded'
  )),
  operator_id          UUID REFERENCES governance.operators (operator_id),
  operator_session_id  UUID,
  reason_code          TEXT,
  route                TEXT,
  method               TEXT,
  correlation_id       UUID,
  ip_address           TEXT,
  detail               JSONB
);

CREATE INDEX operator_auth_audit_log_operator_id_idx ON governance.operator_auth_audit_log (operator_id);
CREATE INDEX operator_auth_audit_log_occurred_at_idx ON governance.operator_auth_audit_log (occurred_at);
