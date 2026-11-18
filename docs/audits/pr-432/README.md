# PR #432 second review: remediation, audit and release evidence

Status: **CODE COMPLETE, PR OPEN, NOT MERGED, NOT DEPLOYED. STAGING ACCEPTANCE PENDING. P12 NOT
APPROVED. ADR 0035 Amendment 6 NOT ACCEPTED.** Nothing in this folder authorises a merge or a
deploy.

Reviewed head before this round: `095ff625cf35c5bb15883a27b30796bfe5e33f09` (394 files, 180
commits, +46,258 / -3,555). The final head and its CI run are recorded in §7 and in the PR
description.

## 1. Contents of this folder

| File | What it is |
| --- | --- |
| `manifest-g1-migrations.md` ... `manifest-g6-docs.md` | One row per changed file at `095ff62` (394 files in seven groups): category, requirements, implications, tests, findings, disposition, evidence |
| `manifest-remediation-delta.md` | One row per code and test file the remediation changed after `095ff62` (two rounds) |
| `commit-register.md` | One row per commit `58e6834..095ff62` (180), with migration amendments, test weakening checks and reconciliation |
| `commit-register-remediation.md` | One row per commit after `095ff62` (numbered 181 onward) |
| `documentation-audit.md` | The documentation audit: every canonical document, runbook and ADR traced to code, and 18 numbered corrections |
| `final-review-a-financial.md`, `-b-security.md`, `-c-runtime-tests-docs.md` | Independent read-only reviews of the first remediation round, by risk domain |
| `final-review-d-fresh.md` | A fresh independent review of the final implementation, with a confirmation table for every earlier finding |

## 2. The owner's findings R01 to R18: dispositions

| ID | Finding | Disposition | Where |
| --- | --- | --- | --- |
| R01 BLOCKING | Settlement could read any job kind's payload through `job_payload()` | **Fixed**: settlement has no EXECUTE; it reads payloads through its RLS-limited SELECT (two kinds) | 0231; `jobs.ts` `pinnedPayload` |
| R02 | Support-review pricing lacked the annual fallback; grandfathered versions compared at open prices | **Fixed**: `review_plan_price` mirrors `planPriceKFor` (pinned version, explicit price wins, annual = monthly x 10, else NULL); paid-through date kept | 0232 |
| R03 | `support_review` answered when no review was recorded | **Fixed**: `support_review_unavailable`; an existing test that asserted the defect corrected | `billing.service.ts` |
| R04/R05 | Operator actor capped at 200 characters | **Fixed** in every operator function and actor column: `^operator:[!-~]{1,255}$` (or `system:<name>` where a system writer acts) | 0233, 0235, 0239 |
| R06 | Refund replay inflated the refunded amount | **Fixed**: one row per provider refund (unique id), replay idempotent, conflicts refused, partials recorded up to the charge; no money moves | 0235 |
| R07 | `job_payload` guarantees overstated | **Fixed and stated exactly**: running and dying jobs only (0234), the worker cannot revive a job (0238); residual (bulk under one pin, per-row re-pin, claiming any pending job) pinned by RESIDUAL tests and written in ADR 0035 Am. 6 | 0234, 0238 |
| R08 | Failure-tracking errors swallowed; starvation | **Fixed**: reported by SQLSTATE; keyset cursor; overlapping passes tested | 0236 |
| R09 | Pack "unused" judged by current entitlement | **Fixed conservatively**: refused unless the allowance is unchanged since the credit, judged by recorded history; undecidable cases to the owner (OD-55) | 0235, 0240 |
| R10 | Retention coverage of new tables | **Verified, no defect**: every new tenant table deleted with real rows; neighbour untouched | `retention-pr432-tables` |
| R11 | Application credential forging operator audit identities | **Existing boundary, not new**: `rekoda_app` has held INSERT on `audit_events` since 0001; format now enforced, identity not (OD-54) | OD-54 |
| R12/R13 | Pending-charge reconciliation; same-charge duplicate-payment recovery | **NOT BUILT, open owner decisions OD-53 (4) and (5), recorded as PAID-LAUNCH BLOCKERS** (they do not block test-mode staging) | `REKODA_LAUNCH_READINESS.md` |
| R14-R18 | PR description, register, Amendment 6, migration count, OWN-92 status | **Corrected** (docs commit `e37c9aa` and later; PR description rewritten for the final head) | docs |

Further defects found by the audit and reviews and fixed in this round: G1-1, G2-1, G2-7, G3-1,
G4a-1, G4b-2, G5-1, G5-4; reviewers' B-1, B-2, A-1, A-3, I1, I7, D-1, D-2, D-4; a date-dependent
test (`subscription-journey`), a CI compile failure (run 44203109258), a test-harness key-enrolment
order dependence (run 44209538852) and an enrolment over-count under overlapping passes (run
44211911106: two passes could both lock one candidate; the second's insert was a no-op but was
counted; no duplicate record was ever written). Every Codex finding on
the PR (0228 settlement kinds, 0213 annual fallback, 0230 actor length) is resolved (review D,
confirmation table).

## 3. Outstanding owner decisions

- **P12**: the merge itself, on the exact head you review. **ADR 0035 Amendment 6** acceptance.
- **OD-53** (1) refund authority, (2) merchant wording for a duplicate payment, (3) the seven-day
  prior-month metering default, (4) daily reconciliation of pending charges against Paystack
  verify, (5) the duplicate-payment operator surface and record-only refund. (4) and (5) are
  paid-launch blockers, not built.
- **OD-54**: audit integrity of app-plane operator actions (move them to the operator process, or
  accept the boundary for the first cohort).
- **OD-55**: pack refunds the automatic rule cannot decide (allowance changed, ADR 0024 rows the
  public `/refunds` page promises, packs credited before 0230) and the refund-order race (refund in
  Paystack first, recording refused later). Recommendation: a reserve-first flow before paid
  launch; until then pack refunds are owner-supervised.
- **OD-56**: which interval decides an annual subscriber's upgrade (application monthly, database
  the cycle's interval; they agree under the approved catalogue).

## 4. Residual risks and limitations

- The worker credential is trusted with every tenant's jobs: it can claim any pending job and read
  its payload, and re-pin per row to read every running or dying payload (ADR 0035 Am. 6). Not
  database-enforceable without removing its function.
- Operator identity on app-plane routes is asserted by the API, not the database (OD-54).
- Under the `constants` pricing source the support-review functions read the catalogue (seeded
  with the same figures).
- MINORs deferred with reasons in the OD-41 row of `REKODA_LAUNCH_READINESS.md` (among them G3-4:
  no merchant notice after the wait when a zero-priced upgrade is withdrawn later; B-6: the
  retention list guard is circular; D-5: the smoke checks the 0239 constraints exist, not their
  patterns).
- Databases that applied earlier drafts of PR #432 migrations must be rebuilt (CR-1).
- Verification limits: no Docker deployment smoke, no Playwright and no backup/restore drill were
  run in this environment; those ran in CI (Deployment (Docker), End-to-end, the scripts' backup
  tests) and on staging only after deploy. No live Paystack, Meta or Resend call was made.

## 5. Regression evidence (RED before GREEN)

| Finding | RED test | RED result | Fix |
| --- | --- | --- | --- |
| R01 | job-payload-isolation "ATTACK: settlement cannot read a merchant-message job's payload" | at 0230: allowed | 0231 |
| R02 | support-review-pricing (annual fallback; grandfathered) | at 0231: 22023 not an upgrade | 0232 |
| R03 | billing-paying "a review the database refuses is not answered as a support review" | `support_review` | `bab4045` |
| R05 | dead-job-enrolment-dead-letter "accepts a 255-character operator subject" | at 0232: refused | 0233 |
| R07 | job-payload-isolation "returns no payload for a pending, done or non-payment dead job" | at 0233: returned | 0234 |
| R06 | probe on 0234: one 300,000 refund recorded twice | 600,000 recorded | 0235 |
| R09 | probe on 0234: pack consumed on Chat, then upgrade | refunded | 0235 |
| G1-1 | pack-refund "a new pending charge with credited_* set is refused" | at 0234: allowed | 0235 |
| R08 | probe (0235 code): healthy candidate behind three untrackable failures | never enrolled | 0236 |
| G2-1 / I1 | dead-job-reclaim-isolation (previous code) | other tenant not reclaimed; death committed without its record | `8e263c5` |
| G4b-2 | settlement-process "refuses to start with a vault key the database did not enrol" | started | 0237 |
| G3-1 | settlement-verifies-price (cycle ended; forged ₦0) | recorded `paid` | `e5b2bd2` |
| A-3 | retry-and-zero-charge "is answered upgrade_withdrawn" | `processing` | `22645f3` |
| B-1 | job-payload-isolation "the worker cannot move a done or dead message job back" | at 0237: allowed | 0238 |
| B-2 | operator-actor-columns (7 columns) | at 0238: malformed allowed | 0239 |
| A-1 | pack-refund "consumed while the plan was lower"; add-on holding change | at 0239: refunded | 0240 |
| G5-1 / I7 | deploy-staging-compat "a release carrying only 0228/0230/0235 runs the smoke" | old gate: 6 failures | `1376d7e`, `69d2065` |
| subscription-journey | the existing journey test at Lagos month-end | expected 1, got undefined | `6cf9d45` |
| CI 44209538852 (1) | api shard 2/2: billing-grace, meta-consent-trial, meta-purchase-truth-3 after a file that enrolled another key | `KeyFingerprintMismatch` | `df1319d` (harness only) |
| CI 44211911106 | dead-job-enrolment-settled: insert-only record over an existing one; settled event | `expected undefined to be false` | `91de525` |

No test was skipped, removed or weakened to pass. Three existing assertions were changed because
they asserted a defect (R03 open-ended plan, G3-1 forged ₦0 charge recorded as paid) or a refusal
now made earlier by a stronger layer (0238 before the 0217 policy, which is still asserted).

## 6. Documentation changed

ADR 0035 (Amendment 6, still PROPOSED), ADR 0034 (cross-reference), the RLS exemption register,
`REKODA_LAUNCH_READINESS.md` (OD-41, OD-51, OD-53 status, OD-54, OD-55, OD-56), `HANDOFF.md`,
`REKODA_CURRENT_STATE.md`, `REKODA_OWNER_DECISIONS.md` (status lines only), `REKODA_REFERENCE_MANIFEST.md`,
`TEST_MAP.md`, `plans/PR-B-plan.md`, runbooks (deploy, staging-first-deploy-pr-b, staging-acceptance-handoff,
billing-duplicate-payments, incident, backup-restore, README), `CLAUDE.md` (two factual lines), `README.md`.

## 7. Final verification (local, Node 24.22.3, PostgreSQL 16, fresh database migrated 0000 to 0240, 241 migrations)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | ok |
| `pnpm turbo typecheck lint test build --force` (at `738d8cb`) | 24/24 tasks |
| Architectural guards: boundaries, openapi, retired-claims, staging-deploy, ui-copy, env-example, deploy, node-version | all OK |
| `node --test scripts/*.test.mjs` | 454/454, 0 skipped |
| db integration, full, serial (at `083b8e1`, fresh database) | 2241/2241 (165 files) |
| api integration, full, serial (at `738d8cb`; later commits change no api code) | 2808/2808 (188 files) |
| Deploy smoke SQL (both suites), upgrade from main 0192 to 0240, re-run of 0231 to 0240 | included in db integration; GREEN |
| Foreign-owner migrations, Docker deployment, Playwright, gitleaks | CI on the final head |
