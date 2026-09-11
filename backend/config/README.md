# `config/operators.seed.json`

This is **not** test fixture data — it is the 1A.2 interim `OperatorDirectory`
backing store, read by `src/index.ts` at server boot
(`InMemoryOperatorDirectory`). It ships empty (`[]`); nothing in it is
synthetic or demo data. The automated test suite never reads this file — it
builds its own in-memory `OperatorRecord`s (`test/helpers/operators.ts`), so
editing this file has zero effect on `npm test`.

Entries are added by `backend/scripts/bootstrap_operator.mjs`, never by hand,
so every addition is idempotent, audited (`config/operator_bootstrap_audit.jsonl`),
and refuses ambiguous/duplicate state. See that script's header comment and
`docs/1A.2_status.md` "Bootstrap mechanism" for the full rationale.

This remains a known, documented interim limitation: without the 1A.3
Governance database, disabling/adding an operator requires editing this file
and redeploying. It is not a substitute for real persistence — it is the
narrowest thing that lets 1A.2's auth boundary be exercised for real before
1A.3 exists.

Contains no secrets — `cognitoSub`, `email`, `displayName`, `roles`, `scopes`
are identifiers and authorization state, not credentials. Never add a
password, token, or MFA secret to this file.
