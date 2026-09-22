-- Phase 1A.12.4 — real operator step-up. §9 of PlatformRectification/
-- Phase1A.12_Ground_Truth_and_Scoping_2026-09-22.md: `POST /management/v1/
-- session/step-up` has always intentionally refused any caller-asserted
-- step-up (STEP_UP_NOT_CONFIGURED) — this table backs the real mechanism
-- that replaces it, a dedicated forced-fresh-Cognito-reauth OAuth
-- transaction bound to the CURRENT Governance browser session, separate
-- from governance.oauth_login_transactions (0004) because a step-up
-- transaction must never be able to mint a brand-new session the way a
-- login transaction does — its only effect on success is annotating an
-- EXISTING operator_sessions row (recordStepUp) that the transaction was
-- itself created from.

CREATE TABLE governance.step_up_transactions (
  transaction_hash        TEXT PRIMARY KEY,
  state_hash               TEXT NOT NULL,
  nonce                    TEXT NOT NULL,
  code_verifier            TEXT NOT NULL,
  bound_operator_session_id UUID NOT NULL,
  bound_cognito_sub        TEXT NOT NULL,
  return_path              TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL,
  expires_at               TIMESTAMPTZ NOT NULL,
  consumed_at              TIMESTAMPTZ
);

CREATE INDEX step_up_transactions_expires_at_idx
  ON governance.step_up_transactions (expires_at);

-- No raw Cognito token, authorization code, or browser session secret is
-- stored here — same discipline as 0004's oauth_login_transactions. The
-- code verifier is short-lived PKCE transaction material only.

-- Rollback (manual, before any deployment depends on it):
-- DROP TABLE governance.step_up_transactions;
