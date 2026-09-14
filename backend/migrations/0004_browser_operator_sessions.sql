-- Browser-facing operator authentication substrate.
--
-- The browser never stores a Cognito ID/refresh token as the application
-- session. Cognito proves the human identity once, at the backend callback;
-- Governance then issues its own opaque, HttpOnly browser session and keeps
-- only hashes of browser-held opaque values at rest.

CREATE TABLE governance.oauth_login_transactions (
  transaction_hash  TEXT PRIMARY KEY,
  state_hash        TEXT NOT NULL,
  nonce             TEXT NOT NULL,
  code_verifier     TEXT NOT NULL,
  return_path       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ
);

CREATE INDEX oauth_login_transactions_expires_at_idx
  ON governance.oauth_login_transactions (expires_at);

CREATE TABLE governance.browser_sessions (
  session_id            UUID PRIMARY KEY,
  session_token_hash    TEXT NOT NULL UNIQUE,
  csrf_token            TEXT NOT NULL,
  operator_id           UUID NOT NULL REFERENCES governance.operators (operator_id) ON DELETE CASCADE,
  cognito_sub           TEXT NOT NULL,
  cognito_token_jti     TEXT NOT NULL,
  issued_at             TIMESTAMPTZ NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  revoked_reason        TEXT,
  ip_address            TEXT,
  user_agent            TEXT
);

CREATE INDEX browser_sessions_operator_id_idx
  ON governance.browser_sessions (operator_id);

CREATE INDEX browser_sessions_expires_at_idx
  ON governance.browser_sessions (expires_at);

-- Deliberately no raw Cognito token, authorization code, refresh token or
-- browser session secret is stored in either table. OAuth code verifiers are
-- short-lived transaction material and are logically consumed once used.

-- Existing operator_sessions remains the durable revocation/step-up evidence
-- store used by authorization middleware; browser_sessions is the opaque
-- browser-session lookup surface.

-- Rollback (manual, before any browser-session deployment depends on it):
-- DROP TABLE governance.browser_sessions;
-- DROP TABLE governance.oauth_login_transactions;
