# PR #432 audit manifest: second-review remediation delta (`095ff62..` remediation head)

The seven group manifests (`manifest-g1-migrations.md` to `manifest-g6-docs.md`) cover every one of
the 394 files changed between the merge base `58e6834` and `095ff62`. This manifest covers the 46
code and test files the second-review remediation changed after `095ff62`. Documentation files
changed by the same remediation are listed in `README.md` §6. Each row was written by the engineer
who made the change. The independent review in `README.md` §8 re-read the whole PR, not only this
table.

| File | Change category | Requirements / decisions / ADRs | Behavioural and security implications | Applicable tests | Findings | Disposition | Verification evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| packages/db/migrations/0231_settlement_reads_only_its_kinds_payload.sql | migration | R01; 0217 kind isolation; ADR 0035 Am. 6 | Settlement loses EXECUTE on `job_payload`; its payload reads go through RLS (two kinds only) | job-payload-isolation "ATTACK: settlement cannot read a merchant-message job's payload"; deploy-smoke tamper | R01 | fixed | RED at 0230: `allowed`; GREEN |
| packages/db/migrations/0232_support_review_prices_like_the_resolver.sql | migration | R02; OWN-40; OD-50; 0213, 0219 | `review_plan_price` mirrors `planPriceKFor`: pinned version, explicit price, annual = monthly x 10, else NULL; request and resolution re-created with only the lookups changed; `open_plan_price` dropped | support-review-pricing (4 cases); support-review-plan-change; support-review-later-schedule; plan-expiry-files | R02 | fixed; constants-source residual recorded | RED at 0231 (2 of 4); GREEN 21/21 in the three suites |
| packages/db/migrations/0233_operator_actor_contract.sql | migration | R05; `auditActorOf` contract | Requeue actor and `requeued_by` require `^operator:[!-~]{1,255}$` | dead-job-enrolment-dead-letter "accepts a 255-character operator subject..." | R05 | fixed | RED at 0232: 255-char subject refused; GREEN |
| packages/db/migrations/0234_job_payload_live_or_dying_only.sql | migration | R07; ADR 0035 Am. 6 | `job_payload` returns only running jobs and dead payment/billing jobs; residual (bulk under one pin, per-row re-pin) stated and pinned | job-payload-isolation "returns no payload for a pending, done...", two RESIDUAL cases | R07 | fixed (narrowed) and residual documented | RED at 0233: pending payload returned; GREEN |
| packages/db/migrations/0235_refund_records_and_pack_eligibility.sql | migration | R04, R06, R09, G1-1; ADR 0024; OWN-94 (7)(8) | One row per provider refund (unique id), replay idempotent, conflicts refused; actor contract; pack "unused" judged only while the allowance equals the one recorded at credit; app insert cannot preset credit columns. Signature change: compatibility break | pack-refund (R06 x7, R04, R09 x3, G1-1); subscriptions; plan-principals; operator-process R06 HTTP replay | R04, R06, R09, G1-1 | fixed; OD-55 opened for the undecidable cases | RED probes on 0234: 300,000 replay gave 600,000; consumed pack refunded after upgrade; preset credit column allowed. GREEN 103/103 in four suites |
| packages/db/migrations/0236_dead_job_enrolment_cursor.sql | migration | R08; 0229 | Keyset cursor `dead_job_unrecorded_candidates(limit, after)`, worker only, id-only; 1-arg form delegates | dead-job-enrolment-dead-letter 0236 describe (3 cases); deploy-smoke tamper | R08 | fixed | RED probe (0235 code on 0235): healthy candidate never enrolled; GREEN |
| packages/db/migrations/0237_settlement_reads_key_fingerprints.sql | migration | G4b-2; 0120 | Settlement may SELECT the non-secret fingerprints, never write them | settlement-process "refuses to start with a vault key..."; settlement-isolation exact grants | G4b-2 | fixed | RED: process started with a wrong key; GREEN 12/12 |
| packages/db/migrations/meta/_journal.json | migration journal | migration ordering | Entries 231 to 237 appended; no entry changed | upgrade-from-main; upgrade-od51 | none | no finding | journal idx contiguous, `when` increasing |
| packages/db/src/repos/jobs.ts | repo | R01, R08, G2-1 | `pinnedPayload` chooses function or RLS read by privilege; `enrolUnrecordedDeathsPage` with cursor and untracked-failure report; reclaim isolates a failed record to its savepoint | dead-job-enrolment-pin (4), dead-job-exceptions G2-1 case, dead-letter 0236 cases | R01, R08, G2-1 | fixed | unit 4/4; integration 79/79 in the dead-job and jobs suites |
| packages/db/src/repos/subscriptions.ts | repo | R06 | `recordRefund` takes `providerRefundId`, returns `replayed` | pack-refund, subscriptions | R06 | fixed | GREEN |
| packages/db/src/repos/boot-checks.ts | repo | G4b-2 | `assertKeyEnrolled`: compare only, never enrol; names fingerprints, never keys | settlement-process | G4b-2 | fixed | GREEN |
| packages/contracts/src/billing-api.ts | contract | R03, R06 | New plan-change reason `support_review_unavailable`; `opsRefundRequest.providerRefundId` required | annual-billing-switching; ops and operator-process refund tests | R03, R06 | fixed | typecheck; tests GREEN |
| apps/api/src/billing/billing.service.ts | service | R03 | Refused review answered truthfully | annual-billing-switching "a review the database refuses..." | R03 | fixed | RED: `support_review`; GREEN 20/20 |
| apps/web/src/app/app/billing/page.tsx | web copy | R03; design system copy rules | New problem copy: "We could not set up that change. Nothing was charged and nothing was changed..." | check-ui-copy; web unit tests | none | no finding | check-ui-copy OK |
| apps/api/src/jobs/apply-no-charge-upgrade.handler.ts | job handler | G3-1; OD-51 | A set-aside outcome is rolled back; the pending ₦0 charge is withdrawn and audited; price_not_verified also ALERTs | settlement-verifies-price (2 cases) | G3-1 | fixed | RED: `paid`; GREEN 43/43 |
| apps/api/src/jobs/runner.ts | runner | R08, G2-1 | Carries the enrolment cursor; logs unrecorded reclaim deaths | jobs-lease, jobs-lanes, dead-job-enrolment-routes, settlement-process | R08, G2-1 | fixed | GREEN 42/42 |
| apps/api/src/health/ops-refund.controller.ts | controller (new) | G4a-1; OD-51.1 | Refund route: 404 before identity on a host without the operator credential | operator-plane-served.guard.test (guard order); ops.integration refunds | G4a-1 | fixed | unit 4/4; integration 56/56 |
| apps/api/src/health/ops.controller.ts | controller | G4a-1 | Refund route and operator DB removed from the class | ops.integration; dead-job-recovery | none | no finding | GREEN |
| apps/api/src/app.module.ts | module | G4a-1 | Registers `OpsRefundController` | ops.integration | none | no finding | GREEN |
| apps/api/src/operator-plane/refund-operations.ts | operation | R06 | Message names `providerRefundId`; returns `replayed` | operator-process | none | no finding | GREEN |
| apps/api/src/settlement-main.ts | entrypoint | G4b-2 | Boot refuses an unenrolled or different `VAULT_KEY` | settlement-process | G4b-2 | fixed | GREEN |
| scripts/deploy-staging.sh | deploy script | G5-1; OWN-86 | Smoke pins 0231 to 0237 (37 tags); gate applies to any compat-breaking release; 0235 in the compat list | deploy-smoke-sql (136 incl. new tampers); scripts tests 190/190 | G5-1 | fixed | smoke clauses checked one by one on a migrated database |
| packages/db/src/ops/job-payload-isolation.integration.test.ts | test | R01, R07 | Settlement denied; RESIDUAL cases pin what is not enforced | itself | none | no finding | 11/11 |
| packages/db/src/ops/dead-job-enrolment-pin.test.ts | unit test | R01 | Double answers the privilege probe; new case for the RLS read path | itself | none | no finding | 4/4 |
| packages/db/src/ops/dead-job-enrolment-dead-letter.integration.test.ts | test | R05, R08 | Actor boundary; untracked failures; cursor; overlapping passes | itself | none | no finding | GREEN |
| packages/db/src/ops/dead-job-exceptions.integration.test.ts | test | G2-1 | One unwritable record does not stop other tenants' reclaim; enrolment later records it | itself | none | no finding | GREEN |
| packages/db/src/ops/deploy-smoke-sql.integration.test.ts | test | G5-1 and every 0231-0237 guarantee | Tamper cases per guarantee and per ledger tag | itself | none | no finding | 136/136 |
| packages/db/src/ops/upgrade-from-main.integration.test.ts | test | migration compatibility | Upgrade from main's 0192 through 0237 | itself | none | no finding | GREEN |
| packages/db/src/ops/upgrade-od51.integration.test.ts | test | re-run safety | Applies and re-runs 0231 to 0237 | itself | none | no finding | GREEN |
| packages/db/src/billing/support-review-pricing.integration.test.ts | test (new) | R02 | Annual fallback, explicit annual wins, grandfathered pin, missing pricing | itself | none | no finding | 4/4 |
| packages/db/src/billing/pack-refund.integration.test.ts | test | R04, R06, R09, G1-1 | Replay, partials, conflicts, wrong business, concurrent replay, malformed id, actor, consumed pack after upgrade, ATTACKs | itself | none | no finding | GREEN |
| packages/db/src/billing/subscriptions.integration.test.ts | test | R06 | Callers pass a provider refund id | itself | none | no finding | GREEN |
| packages/db/src/billing/plan-principals.integration.test.ts | test | R06 | Callers pass a provider refund id | itself | none | no finding | GREEN |
| packages/db/src/billing/settlement-isolation.integration.test.ts | test | G4b-2 | Exact settlement grant list gains `key_fingerprints: SELECT` | itself | none | no finding | 12/12 |
| packages/db/src/billing/plan-expiry-files.allowed.ts | guard allow-list | G-62 plan-field writers | 0232 listed with its reason | plan-expiry-files | none | no finding | 58/58 |
| packages/db/src/billing/plan-expiry-files.test.ts | guard test | G-62 | 0232 pinned: plan assigned once, expiry never | itself | none | no finding | 58/58 |
| packages/db/src/privacy/retention-pr432-tables.integration.test.ts | test (new) | R10; ADR 0024 retention | Rows in all nine new tenant tables deleted with their business; neighbour untouched; list guard | itself | R10 | no defect found | 2/2 |
| apps/api/src/billing/annual-billing-switching.integration.test.ts | test | R03 | Review row asserted; refusal case | itself | none | no finding | 20/20 |
| apps/api/src/billing/settlement-verifies-price.integration.test.ts | test | G3-1 | Forged ₦0 charge now withdrawn, not paid (assertion of the defect replaced); late cycle case | itself | none | no finding | GREEN |
| apps/api/src/billing/annual-lifecycle.integration.test.ts | test | R06 | Provider refund id | itself | none | no finding | GREEN |
| apps/api/src/billing/billing-grandfathering.integration.test.ts | test | R06 | Provider refund id | itself | none | no finding | GREEN |
| apps/api/src/health/ops.integration.test.ts | test | R06 | Helper adds a provider refund id | itself | none | no finding | GREEN |
| apps/api/src/health/dead-job-recovery.integration.test.ts | test | G4a-1 | Constructor arity | itself | none | no finding | GREEN |
| apps/api/src/operator-plane/operator-process.integration.test.ts | test | R06 | HTTP replay answered `replayed: true`, recorded once | itself | none | no finding | GREEN |
| apps/api/src/auth/operator-plane-served.guard.test.ts | unit test | G4a-1 | Refund route guard order; no class-level guard | itself | none | no finding | 4/4 |
| apps/api/src/settlement/settlement-process.integration.test.ts | test | G4b-2 | Wrong key refused; enrolment as the API does | itself | none | no finding | 12/12 |

## Second round (after the independent reviews A, B and C; `6cf9d45..` final head)

Files changed after `6cf9d45` (code and tests; documentation is listed in `README.md` §6). Files
already in the table above appear again only where this round changed them.

| File | Change category | Requirements / decisions / ADRs | Behavioural and security implications | Applicable tests | Findings | Disposition | Verification evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| packages/db/migrations/0238_worker_job_transitions.sql | migration | B-1; R07; ADR 0035 Am. 6 | Worker state changes limited to pending->running, running->done/pending/dead, dead->pending (payment/billing only) | job-payload-isolation "ATTACK: the worker cannot move a done or dead message job..."; smoke tamper x2 | B-1 | fixed | RED at 0237: allowed; GREEN |
| packages/db/migrations/0239_operator_actor_columns.sql | migration | B-2; R04/R05/R11; OD-54 | CHECK `operator:<1-255>` (or `system:<name>`) on seven actor columns; `unapplied_resolved_by` NOT VALID (exists on main) | operator-actor-columns (7); smoke tamper | B-2 | fixed for format; identity residual is OD-54 | RED at 0238: malformed allowed; GREEN 7/7 |
| packages/db/migrations/0240_pack_refund_allowance_history.sql | migration | A-1; R09; OD-55 | `business_allowance_changes` by trigger on plan/plan_version_id and add-on holdings; refund refused after any change since the credit | pack-refund A-1 cases (2); retention-pr432-tables; smoke tamper x2 | A-1 | fixed | RED at 0239: both refunded; GREEN 31/31 in three suites |
| packages/db/migrations/0233_operator_actor_contract.sql | migration (comment) | docs truth | Header names 0235, not 0234; no SQL change | none | C-minor | fixed | diff is comment-only |
| packages/db/migrations/meta/_journal.json | journal | ordering | Entries 238 to 240 appended | upgrade tests | none | no finding | contiguous |
| packages/db/src/repos/jobs.ts | repo | I1; G2-1 | Reclaim selects stalled jobs `FOR UPDATE SKIP LOCKED`, then moves each with its record in one savepoint; a failed record leaves the job running and retried | dead-job-reclaim-isolation (2); dead-job-enrolment-pin (4); jobs suites | I1 | fixed | RED (previous code): death committed without record; GREEN |
| packages/db/src/repos/subscriptions.ts | repo | A-3 | `noChargeWithdrawn`: the worker's withdrawal audit row | retry-and-zero-charge A-3 | none | no finding | GREEN |
| apps/api/src/billing/billing.service.ts | service | A-3 | `awaitNoCharge` answers applied / withdrawn / pending; withdrawn -> `upgrade_withdrawn` | retry-and-zero-charge "is answered upgrade_withdrawn" | A-3 | fixed | RED: processing; GREEN |
| packages/contracts/src/billing-api.ts | contract | A-3 | New reason `upgrade_withdrawn` | typecheck; above | none | no finding | GREEN |
| apps/web/src/app/app/billing/page.tsx | web copy | A-3 | "That change could not be made in time, so your plan has not changed. Nothing was charged..." | check-ui-copy | none | no finding | OK |
| apps/api/src/jobs/runner.ts | runner | I1 | Warning text for jobs not moved | jobs suites | none | no finding | GREEN |
| scripts/deploy-staging.sh | deploy script | 0238-0240; G5-1 | Ledger 40 tags; new checks; runbook heading reference | deploy-smoke-sql suites; scripts 454/454 | none | no finding | smoke `t` on a migrated database |
| scripts/deploy-staging-compat.test.mjs | script test | G5-1 (I7) | Releases carrying only 0228/0230/0235 run the smoke; a failing smoke starts nothing | itself | I7 | fixed | RED with the old gate: 6 failures; GREEN 36/36 |
| packages/db/src/ops/deploy-smoke-sql-second-review.integration.test.ts | test | 0231-0240 | Compile error fixed (`migrationText`); tampers for 0238-0240 | itself | C BLOCKING (compile) | fixed | typecheck; GREEN |
| packages/db/src/ops/job-payload-isolation.integration.test.ts | test | B-1 | ATTACK case | itself | none | no finding | GREEN |
| packages/db/src/ops/operator-actor-columns.integration.test.ts | test (new) | B-2 | Seven columns: 255-char accepted, 256 and malformed refused, system actor where allowed | itself | none | no finding | 7/7 |
| packages/db/src/ops/dead-job-reclaim-isolation.integration.test.ts | test | I1, G2-1 | Unwritable job stays running; recovering record reopened with its job | itself | none | no finding | 2/2 |
| packages/db/src/ops/dead-job-enrolment-pin.test.ts | unit test | statement shapes | Mock answers the stalled list and per-job moves; no payload in cross-tenant steps | itself | none | no finding | 4/4 |
| packages/db/src/billing/pack-refund.integration.test.ts | test | A-1 | Down-and-back plan; add-on holding change | itself | none | no finding | GREEN |
| packages/db/src/privacy/retention-pr432-tables.integration.test.ts | test | R10 | Adds `business_allowance_changes` | itself | B-6 (list guard circular) | MINOR recorded | 2/2 |
| packages/db/src/ops/upgrade-od51.integration.test.ts, upgrade-from-main.integration.test.ts | tests | migration compatibility | Through 0240 | themselves | none | no finding | GREEN |
| apps/api/src/billing/billing-paying.integration.test.ts | test | R03 | Open-ended plan case asserted the defect; now the truthful answer and no review row | itself | R03 | fixed | GREEN |
| apps/api/src/billing/retry-and-zero-charge.integration.test.ts | test | A-3 | Withdrawn-within-wait case | itself | none | no finding | GREEN |

## Third round (CI runs 44209538852 and 44211911106; `df1319d..` final head)

| File | Category | Requirement | Implication | Tests | Finding | Disposition | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| packages/db/src/testing.ts | test harness | CI 44209538852 issue 1 | `resetKeyEnrolment()` deletes every `key_fingerprints` row on the owner connection; test-only, no production path | every integration file (through the setup files) | file-order dependence on the first-enrolled key | fixed | 90/90 across 5 file-shuffle seeds; production fingerprint check unchanged |
| packages/db/src/integration-setup.ts, apps/api/src/integration-setup.ts | test harness | as above | Each file starts with no enrolled key, so `createApp` enrols its own; the settlement wrong-key refusal test still enrols and then refuses | settlement-process "refuses to start with a vault key the database did not enrol" (kept) | as above | fixed | shard 2/2 reproduced RED, GREEN after |
| apps/api/src/billing/billing.service.ts | service | CI 44209538852 issue 2; OWN-33, OWN-34, OD-50, R03 | An open-ended operator plan (no expiry) answers `support_review` without requesting a review row (OWN-34: custom cycles are never prorated; OD-50: a review needs a paid-through date); a review the database refuses still answers `support_review_unavailable` (R03 kept) | billing-paying open-ended case; retry-and-zero-charge R03 case | reconciliation | fixed | GREEN |
| apps/api/src/billing/billing-paying.integration.test.ts | test | as above | Open-ended case asserts `support_review`, no review row, no charge, subscription unchanged (stronger than before) | itself | none | no finding | GREEN |
| packages/db/src/repos/dead-jobs.ts | repo | CI 44211911106 | `recordDeath` returns whether it opened or reopened a record (false for a settled event, an existing record or a non-payment kind) | dead-job-enrolment-settled (2 new RED cases) | over-count of enrolments under overlapping passes | fixed | RED: `expected undefined to be false/true`; GREEN |
| packages/db/src/repos/jobs.ts | repo | as above | `enrolDeath` returns `recordDeath`'s result, so a pass counts only records it wrote | dead-job-enrolment-dead-letter "overlapping passes" (15/15 repeated runs) | as above | fixed | GREEN |
| packages/db/src/ops/dead-job-enrolment-settled.integration.test.ts | test | as above | Settled-after-pick case now also asserts `false`; new insert-only-over-existing case | itself | none | no finding | GREEN |
