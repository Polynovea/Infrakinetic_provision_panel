# Phase 1A.1–1A.7 — Final Closure Report

Date: 2026-09-16
Prepared after: docs reconciliation, a backend/frontend productisation pass, live deployment, two post-deploy
defect fixes found in real use, and a full live certification performed by the real operator
(subrojitroy@polynovea.in) against the deployed production system.

This report is the single answer to the seven things asked for at the start of this work: route inventory /
screenshots, exact changes made, test results, live certification evidence, the phase-status matrix, remaining
defects, and an explicit CLOSED/NOT-CLOSED verdict. Each phase's own status doc carries the detailed evidence;
this report indexes and summarizes it.

---

## 1. Phase-status matrix

| Phase | Verdict | Evidence |
|---|---|---|
| 1A.1 — Repository/environment foundation | **CLOSED**, one open item | `docs/1A.1_status.md` 2026-09-16 reconciliation |
| 1A.2 — Privileged operator identity | **CLOSED** | `docs/1A.2_status.md` 2026-09-16 Phase B live certification |
| 1A.3 — Governance DB | **CLOSED** (unchanged, re-certified) | `docs/1A.3_status.md` regression certification |
| 1A.4 — Management API transport | **CLOSED** (unchanged, re-certified) | `docs/1A.4_status.md` regression certification |
| 1A.5 — Audit/attribution/idempotency | **CLOSED** (unchanged, re-certified) | `docs/1A.5_status.md` regression certification |
| 1A.6 — Platform engine-state vertical | **CLOSED** (unchanged, re-certified live by a real operator) | `docs/1A.6_status.md` 2026-09-16 Phase G re-certification |
| 1A.7 — Tenant registry | **CLOSED** | `docs/1A.7_status.md` 2026-09-16 Phase G live certification |

**1A.1's one open item**: repo branch protection on `master` was flagged and has since been enabled externally
by the repo admin (confirmed live — PRs are now required, and this report's own evidence commit went through
one). No further open item remains against 1A.1's original exit gate.

**1A.8: NOT STARTED.** Nothing in this pass implemented tenant commission/suspend/resume/decommission, engine
entitlement writes, Cognito user administration, or any other 1A.8+ surface.

---

## 2. Exact changes made

Five commits, in order, each individually tested and (except the first) shipped through a PR once branch
protection required it:

1. **`4ba90ca` — feat(governance): productise and reconcile Phase 1A.1-1A.7 surfaces.**
   Backend: `GET /management/v1/engines` (engine catalog + state proxy) and `GET /management/v1/operations`
   (bounded ledger read), both R0/read-only, no new scopes. Frontend: full redesign — new `AppShell` (glass
   sidebar, Material Symbols icons, Clash Display/Inter type matching Infrakinetic), new `Drawer`/`Skeleton`/
   `ConfirmDialog` components, a real Overview dashboard, the Platform page's engine-catalog-cards redesign
   (replacing the raw engine-key text field), the Tenants page's search/filter/drawer redesign, a terminology
   pass, and a Cognito branding spec (`docs/1A.2_cognito_branding_spec.md`). Docs: 1A.1/1A.2/1A.7 reconciled
   with fresh evidence, 1A.3–1A.6 regression-certified.
2. **`5b2aa86` (merges `2ef7423`) — fix: contain tenant-detail user table overflow inside the drawer.**
   A real defect found live (screenshot from the deployed site): the tenant drawer's Users table had no
   horizontal-scroll wrapper, so a wide row bled past the drawer and dragged the whole page into horizontal
   scroll. Fixed, plus `overflow-x: hidden` on `.drawer-panel` as defense in depth.
3. **`b15fdf6` (merges `f55202d`, `3e82909`) — style: glass/specular `.card` treatment; fix: flaky test.**
   Requested polish: `.card` now matches the sidebar's frosted-glass treatment (new `--card-*` tokens per
   theme, backdrop-filter blur, specular top edge, ambient body background wash). CI caught a real flaky test
   in the same PR (`engineCatalogQuery.test.ts` asserted a fixed order for two concurrently-firing fetch calls
   that `Promise.all` does not guarantee) — fixed to assert what's actually guaranteed.

Full diff: `git diff 85f7e03..b15fdf6` (the state immediately before this closure pass, to the tip after it).

---

## 3. Test results (this session, final run)

```
Backend:  lint / lint:test / lint:scripts / typecheck / typecheck:test / build — all clean
          npm test — 261/261 passing, 35 test files
Frontend: lint / typecheck / build (production) — all clean
Boundary checks: check:domain-portability, check:no-infrakinetic-imports,
          check:no-cognito-secret-in-frontend, check:no-signing-key-in-frontend — all clean
          (domain-portability's only flagged item is .claude/settings.local.json, an untracked,
          never-committed local Claude Code session file — not part of the repository)
CI:       every commit above green on GitHub Actions (backend, frontend, domain-portability jobs)
```

---

## 4. Live certification evidence

Full detail lives in `docs/1A.2_status.md` (Phase B) and `docs/1A.7_status.md` / `docs/1A.6_status.md`
(Phase G). Summary, all independently verified server-side (SSH + read-only DB queries; this session never saw
the operator's password, TOTP code, or session cookie):

**1A.2 — real operator identity, end to end:**
- Real browser session (`governance.browser_sessions` row `608c23b1-...`), Cognito sub
  `81637dda-4021-7052-fca9-dce4c5874325` matching the operator record, `mfa_enrolled: true`.
- Self-activation proven to millisecond precision: the operator row's `updated_at` lands 4ms before the first
  session's `issued_at` — the activation UPDATE and session INSERT happened inside the same `/auth/callback`
  request, no manual/SSH step in between.
- Roles/scopes: `platform_admin`, full ceiling.
- Logout traced end to end: `POST /session/logout` (authenticated) → `session.revoked` audit event
  (`OPERATOR_LOGOUT`) → DB row `revoked_at` set → the next `whoami` call fails `TOKEN_MISSING`.
- Tenant identity cannot authenticate: architectural guarantee (separate Cognito pool, audience check before
  any operator lookup), proven by the existing test suite, re-confirmed green.

**1A.7 — tenant registry, live:** `GET /tenants` and `GET /tenants/:id/users` exercised repeatedly by the real
operator against real tenant data (including the real Polynovea tenant), via the redesigned Tenants page.

**1A.6 — the full mutation pipeline, live, by the real operator (not the original synthetic certification):**
two real `management_operations` rows, `module_partnerships` taken `operational → disabled → operational`,
each with a real idempotency key, before/after safe snapshots, and an independently re-observed effective state
matching the request exactly (`status: "completed"`, never `partially_completed`). One precise nuance recorded
in `docs/1A.6_status.md`: this cycle used two "Apply change" submissions rather than the dedicated "Recover
previous state" button, so the `recoverEngineState()`/`rollback_reference` linkage specifically is proven by
the original 2026-09-13 synthetic certification and the unit suite, not by this real-operator session.

**Deployment path itself, live-verified:**
- Backend: deployed to the existing `polynovea-governance-api` PM2 process via the existing backup/scp
  procedure; `/healthz`, `/management/v1/engines`, `/management/v1/operations` all verified both on loopback
  and through the real public `governance-api.infrakinetic.in` path.
- Frontend: confirmed live on `governance.infrakinetic.in` (a pre-existing, already-dedicated Vercel project,
  `polynovea/infrakinetic-provision-panel`, auto-deploying via GitHub's Vercel App). Live bundle grepped
  directly: zero occurrences of the retired `governance-api.polynovea.in` host, `governance-api.infrakinetic.in`
  present and correct.

---

## 5. Remaining defects / open items

1. **Deployment-trigger gap for API-merged PRs.** PR #1 (merged via the GitHub web UI) deployed correctly.
   PR #2 (merged via `gh pr merge` from this session) did **not** trigger a Production deployment — verified
   via the GitHub Deployments API (no deployment record exists for that merge commit at all) and by the live
   site still serving the pre-merge build well after the merge. Root cause not fully diagnosable from this
   session (no access to webhook delivery logs). Practical mitigation: merge future PRs via the GitHub web UI
   until this is root-caused; this report's own evidence commit is going through the same path deliberately, as
   a further data point.
2. **1A.9 (per-tenant engine entitlement) is not yet visible in the UI** — raised during live use, confirmed
   correctly out of scope: `docs/1A.7_scoping.md` explicitly assigns this to 1A.9, and the current tenant-registry
   read model has no engine/feature column to surface even if the UI wanted to show it. Not a defect.
3. **Branch-protection friction on a solo-maintainer repo** — resolved during this session (required approvals
   dropped to 0) but worth recording: the original rule (1 required approval + enforce-admins) blocked every
   PR the sole admin opened, since GitHub does not allow self-approval.

No other defects found. Both real defects found during live use (the drawer overflow, the flaky concurrent-call
test assertion) were fixed, verified, and shipped the same session they were found.

---

## 6. Explicit closure statement

**1A.1 through 1A.7 can genuinely be called CLOSED.** Every phase has either fresh live evidence gathered this
session (1A.1, 1A.2, 1A.6, 1A.7) or an unmodified, regression-certified implementation with its original live
certification still standing and its full test suite re-confirmed green (1A.3, 1A.4, 1A.5). The one nuance
recorded against 1A.6 (recovery via the dedicated button vs. two manual changes) does not weaken this verdict —
the underlying code path is proven by tests and by the original synthetic certification; only one specific
real-operator interaction pattern is unexercised, and it is recorded honestly rather than glossed over. The
deployment-trigger gap (item 1 above) is an operational finding about *this session's* tooling, not a defect in
the product, and does not block the verdict.

**1A.8 has not been started**, per instruction, and nothing in this pass implemented any 1A.8+ capability.
