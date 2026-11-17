# PR #432 audit manifest: G2 packages/db (non-migration: repos, schema, tests)

- Group: G2, `packages/db` repos, schema, harness and tests (migrations excluded; they are G1)
- Head: `095ff625cf35c5bb15883a27b30796bfe5e33f09` (merge base `58e6834`)
- Files reviewed: 94 (equals the 94 paths in `/tmp/claude-0/groups/g2-db.txt`)
- Method: read-only. `git diff 58e6834 095ff62` for every file. Full reads of the new and changed source: `repos/{subscriptions,billing,boot-checks,dead-jobs,events,jobs,usage,staging-tools,merchant-api,party-statements,settle,identity,webhooks,add-ons}.ts`, `testing.ts`, `preflight-subscriptions.ts`, `pricing-source.ts`, `provision.ts`, `index.ts`, `integration-setup.ts`, `schema/subscriptions.ts`, `plan-writer.fixtures.ts`, `customer.fixtures.ts`. Grants, policies and guards were checked against migrations 0020, 0194, 0206, 0210, 0217, 0223 and 0224. Callers in `apps/api` were traced where the credential mattered (`ops-alerts.ts`, `ops.controller.ts`, `runner.ts`, `billing.service.ts`, `reports.controller.ts`, `merchant-v1.controller.ts`). Tests: read each file's header and diff. All 70 test files were grepped for vacuous patterns (`.skip`/`.only`, `toBeDefined`/`toBeTruthy`, bare `rejects.toThrow()`, swallowed `.catch`) and each hit was read. Test titles from before and after the `retention` and `plan-expiry-files` splits were compared; no test was dropped. No test was run and the database was not touched.

## Per-file table

| File | Change category | Requirements / owner decisions / ADRs | Behavioural & security implications | Applicable tests | Findings (id: severity) | Disposition | Verification evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| packages/db/src/billing/add-ons.integration.test.ts | test (modified) | ADR 0024, 0226 | Add-on holdings are now staged as the owner because no runtime role writes `business_add_ons`. The suite still tests what a holding grants. | self | none | no finding | diff read; owner staging is consistent with 0226 and the `add-ons.ts` hold() comment |
| packages/db/src/billing/entitlement-gate.integration.test.ts | test (modified) | OD-37 0196, 0210 | Plan set through `setPlanAsOwner`; grants staged as the owner. | self | none | no finding | diff read |
| packages/db/src/billing/entitlements.integration.test.ts | test (modified) | 0210 (no runtime grant writes) | Grants moved to the owner. The cross-tenant "refuses to write a grant for another business" test now fails on the 0210 privilege revoke for any target, so it no longer tests RLS WITH CHECK. | self | G2-5: MINOR | finding G2-5 | read lines 180-247 and diff |
| packages/db/src/billing/margin.integration.test.ts | test (modified) | 0210 | Worker writes to `usage_events` and `businesses` now assert refusal; `expect(row).toBeDefined()` at :93 is preceded by value checks. | self | none | no finding | diff read; :93 context read |
| packages/db/src/billing/operator-cycle-writes.integration.test.ts | test (new) | OD-51, 0221 | Proves that the operator credential holds no direct cycle-column UPDATE and that the writer records the whole cycle. Matches `/permission denied/`, so the result cannot be 'allowed'. | self | none | no finding | full file read |
| packages/db/src/billing/operator-plan-change.integration.test.ts | test (modified) | OD-37, OD-50 0207, G-62 | `setPlan` on the operator pool; standard periods and audit row. | self | none | no finding | diff skimmed; 61 expects |
| packages/db/src/billing/operator-standard-periods.integration.test.ts | test (new) | OD-50 0207 | Paid period computed by the database, trial fixed at 336 h, re-post unchanged, `trial_started_at` immutable. | self | none | no finding | header and structure read |
| packages/db/src/billing/pack-credit-terms.integration.test.ts | test (new) | 0224, OD-51.4, OD-51.7 | `usage_credit_pack` derives unit, quantity, row and amount from the charge, on a live settlement connection. Uses `test_fixture_set_plan` to stage a plan. | self | none | no finding | header read; fixture use at :115 checked |
| packages/db/src/billing/pack-purchase-identity.integration.test.ts | test (new) | OD-51.7 0214 | `purchase_id` is immutable, a replacement is the same pack only, and a purchase is credited at most once. | self | none | no finding | header read |
| packages/db/src/billing/pack-refund.integration.test.ts | test (new) | 0230, ADR 0024, OWN refund brief | Refund through the operator only; pack revoke; 7-day unused rule. | self | known R06, R09 | known R06/R09 | header read; R06/R09 not re-derived |
| packages/db/src/billing/paid-charge-cycle-binding.integration.test.ts | test (new) | OD-37 0206, 0221 | A charge is bound to its frozen cycle. Drops the harness fixture writer before testing the cycle guard, so the guard is tested for real (the exemption context is in G2-2). | self | none | no finding | header and :148-:216 read |
| packages/db/src/billing/plan-catalogue.integration.test.ts | test (modified) | G-62, 0209 | Moves to `applyFixtureCycle` and `applicationDb()` for charge opens. | self | none | no finding | diff read |
| packages/db/src/billing/plan-expiry-files.allowed.ts | test support (new) | G-62, OD-37 | The reviewed allow-list of files that may touch plan fields, split out of the test. Entries match the writers at head. | plan-expiry-files.test.ts | none | no finding | read the head of the file; entries for subscriptions.ts and testing.ts checked against source |
| packages/db/src/billing/plan-expiry-files.checker.ts | test support (new) | G-62 | Regex detector for plan-field assignments, with comment-tolerant and linear-bounded patterns. Documented limit: an object key after 2,000 chars is not seen. | plan-expiry-files.patterns.test.ts | none | no finding | read lines 1-60 |
| packages/db/src/billing/plan-expiry-files.patterns.test.ts | test (new) | G-62 | Self-tests of the detector, moved out of the main test. | self | none | no finding | titles compared with the pre-split file; none lost |
| packages/db/src/billing/plan-expiry-files.test.ts | test (rewritten) | G-62, OD-37 | Repository scan against ALLOWED and PINS; detection tests moved to patterns. | self | none | no finding | old and new `it` titles diffed: no title dropped |
| packages/db/src/billing/plan-fields-guard.integration.test.ts | test (new) | OD-37 0196, 0200 | Direct plan-field writes refused for app and worker; no setting authorises one; owner repair allowed. The header says the operator writer is "executable by the API credential only", which is stale since 0202. | self | G2-7: MINOR | finding G2-7 | read :1-:225 |
| packages/db/src/billing/plan-principals.integration.test.ts | test (new) | OD-37 0200, 0202, 0203 | Who may run each writer, on live principal connections; boot checks. The `assertNoTestFixtureWriter` test exercises only the first (plan-writer) branch. | self | G2-9: MINOR | finding G2-9 | header read; :170 read |
| packages/db/src/billing/plan-writer-boundary.integration.test.ts | test (new) | OD-37 | What each writer accepts. The bare `rejects.toThrow()` at :346 is paired with a plan-unchanged check. | self | none | no finding | header and :335-:350 read |
| packages/db/src/billing/plan-writer.fixtures.ts | fixture (new) | OD-37 | Shared harness. `seedCharge` writes as the owner charges that production never writes: reference `RKD-SUB-OD37-nnnnnn` (outside the `RKD-SUB-\d{8}-[0-9A-Z]{6}` shape), chat at 1,000 kobo, `period_start` on a first purchase, no pricing source or provider times. `outcome()` returns the error code and message, or 'allowed'. | plan-* suites | G2-8: MINOR | finding G2-8 | full file read |
| packages/db/src/billing/platform-costs.integration.test.ts | test (modified) | 0210 | `recordCostEvent` now runs on the app pool. No production caller exists, so there is no production credential mismatch. | self | none | no finding | diff read; grep found no production caller |
| packages/db/src/billing/pricing-source.integration.test.ts | test (new) | OD-51.6 0215 | Single pricing source: only the owner writes it, a charge names only the source in force, boot refuses a mismatch. | self | none | no finding | header read |
| packages/db/src/billing/settlement-event-scope.integration.test.ts | test (new) | 0223 | Settlement reaches only the events and dead-job records of its own jobs; requeue is bounded. | self | none | no finding | header read; checked against the 0223 policies |
| packages/db/src/billing/settlement-isolation.integration.test.ts | test (new) | OD-51.2/.3 0217 | Settlement grants table by table; `subscription_start_grace` rules. Drops the fixture writer inside a transaction at :204 to test the guard for real. | self | none | no finding | header and :200-:215 read |
| packages/db/src/billing/subscription-journey.integration.test.ts | test (modified) | G-62 | `applyCycle` replaced by `applyFixtureCycle`. | self | none | no finding | diff read |
| packages/db/src/billing/subscription-origin.integration.test.ts | test (modified) | OWN-33, 0167 | Fixture moves; owner-staged rows without evidence. | self | none | no finding | diff skimmed |
| packages/db/src/billing/subscription-preflight.integration.test.ts | test (new) | OD-49 0208 | The preflight lists rule-breaking periods, fails on active ones and refuses an RLS-blind role; correction through the function only. | self | none | no finding | header read |
| packages/db/src/billing/subscriptions-sweeps.integration.test.ts | test (modified) | G-62, 0217 | Fixture cycle and grace writer substitution. | self | none | no finding | diff skimmed |
| packages/db/src/billing/subscriptions.integration.test.ts | test (modified) | ADR 0024, 0230 | `refundCharge` tests replaced; refund now through the operator. | self | known R06 | known R06 | diff skimmed |
| packages/db/src/billing/support-review-later-schedule.integration.test.ts | test (new) | OD-50 0219 | A resolution keeps a later-scheduled cancellation; concurrent resolves move the plan once. | self | none | no finding | header read |
| packages/db/src/billing/support-review-plan-change.integration.test.ts | test (new) | OD-50 0213 | Request and resolve functions; paid-through date unchanged; audit once. | self | known R03 (service side) | known R03 | header read |
| packages/db/src/billing/trial-lifecycle.integration.test.ts | test (modified) | OD-50, 0206 | :186 writes `payment_failed_at` directly on the app credential. That works only because the harness fixture exempts the 0206 guard; production would refuse it with 42501. | self | G2-2: MINOR | finding G2-2 | :170-:200 read |
| packages/db/src/billing/usage-entitlement-authority.integration.test.ts | test (new) | 0222 | The database computes the ceiling and the argument can only lower it. | self | none | no finding | header and structure read |
| packages/db/src/billing/usage-meter-boundary.integration.test.ts | test (new) | OD-51.4 0216 | No runtime role rewrites counters; a refund returns only its reservation. The rolled-back-spend test at :204 passes vacuously if the handle carries no reservation, because `refundUnit` returns 0 without a query. | self | G2-6: MINOR | finding G2-6 | :190-:240 read |
| packages/db/src/billing/usage-refund-and-job-guards.integration.test.ts | test (new) | 0216, 0220, 0222 | Refund bounds; application job transition guard. `toBeTruthy` at :323 is an id-presence check. | self | none | no finding | header and :323 read |
| packages/db/src/billing/usage-reservation-backfill.integration.test.ts | test (new) | 0216/0218 | Reservation backfill on upgrade. | self | none | no finding | header read |
| packages/db/src/billing/usage-reservation-closure-tamper.integration.test.ts | test (new) | 0218, 0227 | Tampering with reservation closure is refused. | self | none | no finding | header read |
| packages/db/src/billing/usage-reservation-closure.integration.test.ts | test (new) | 0218 | A finished job closes its event's reservations. | self | none | no finding | header read |
| packages/db/src/billing/usage-trial-migrations.integration.test.ts | test (modified) | 0222 | Uses the current month because the database clamps metering to it. | self | none | no finding | diff read |
| packages/db/src/billing/usage-trial.integration.test.ts | test (modified) | OD-26, 0222 | Fixture substitutions; current-month metering. | self | none | no finding | diff skimmed |
| packages/db/src/billing/usage.integration.test.ts | test (modified) | 0216, 0222 | `resolves.toBeDefined()` at :396 asserts "no error" per unit, followed by a column check. | self | none | no finding | :385-:400 read |
| packages/db/src/channels/preview-delivery.integration.test.ts | test (modified) | 0210 | Credential and fixture adjustments. | self | none | no finding | diff skimmed |
| packages/db/src/customers/customer-sale-ownership-race.integration.test.ts | test (new) | #432 review | Proves `FOR KEY SHARE` holds the customer against a concurrent delete (55P03 under `lock_timeout`). | self | none | no finding | full file read |
| packages/db/src/customers/customer.fixtures.ts | fixture (new) | privacy tokens | Retries token collisions the way production does. | customers tests | none | no finding | full file read |
| packages/db/src/customers/customers.integration.test.ts | test (modified) | privacy | Uses the retrying fixture. | self | none | no finding | diff skimmed |
| packages/db/src/index.ts | config/export | OWN-73, OWN-77 | Exports `deadJobsRepo` and `stagingToolsRepo`. | n/a | none | no finding | diff read |
| packages/db/src/integration-setup.ts | test support (new) | OD-37 | Closes the principal pools after each file. | all integration | none | no finding | full file read |
| packages/db/src/ops/dead-job-enrolment-dead-letter.integration.test.ts | test (new) | 0229 | Backoff, dead-letter after five failures, audited requeue. | self | known R04/R05, R08, R11 | known R08/R11 | header read |
| packages/db/src/ops/dead-job-enrolment-pin.test.ts | test (new, unit) | 0225, 0228 | Statement-level proof that payload reads are pinned. The header says "the database therefore cannot refuse an unpinned payload read", which 0228 superseded (stale doc). | self | G2-7: MINOR | finding G2-7 | :1-:20 read |
| packages/db/src/ops/dead-job-enrolment-scope.integration.test.ts | test (new) | 0225, ADR 0035 Am. 1 | Discovery returns ids only; each enrolment pinned and isolated. | self | none | no finding | header read |
| packages/db/src/ops/dead-job-enrolment-settled.integration.test.ts | test (new) | OWN-73 | Enrolment skips a settled event. | self | none | no finding | header read; matches the `recordDeath` enrolOnly branch |
| packages/db/src/ops/dead-job-exceptions.integration.test.ts | test (new) | OWN-73, OWN-76, 0194 | Death record through both paths; idempotent; no payload or error copied; nothing booked. | self | none | no finding | header and :115-:270 skimmed |
| packages/db/src/ops/dead-job-late-death.integration.test.ts | test (new) | OWN-73 | Resolve and death serialise on the event row, in both orders. | self | none | no finding | header read; checked against `resolveEvent` and `recordDeath` locks |
| packages/db/src/ops/deploy-smoke-sql.integration.test.ts | test (new) | OWN-86, OD-37 | Runs the real staging smoke SQL against a migrated database, with tamper cases expecting `f`. | self | none | no finding | :1-:120 read |
| packages/db/src/ops/external-events-worker-write.integration.test.ts | test (new) | 0204 | The worker's cross-tenant event privilege is read-only. | self | none | no finding | header read |
| packages/db/src/ops/job-payload-isolation.integration.test.ts | test (new) | 0228 | The worker reads a payload only through `job_payload` under the pin. | self | known R01, R07 | known R01/R07 | header read |
| packages/db/src/ops/jobs.integration.test.ts | test (modified) | 0220, 0227, 0228 | Lease staging moved to the owner. The `claimNext(appDb)` assertion is loosened to "null or permission denied", which still fails on any leak. | self | none | no finding | diff read |
| packages/db/src/ops/operator-work-lists-privileges.integration.test.ts | test (new) | OD-47, ADR 0035 Am. 2 | Function ownership, membership and create rights, read from the catalogue. | self | none | no finding | header read |
| packages/db/src/ops/operator-work-lists.integration.test.ts | test (new) | OD-47 | Fixed-column, bounded definer lists, worker-only. | self | none | no finding | header read |
| packages/db/src/ops/ops-health.integration.test.ts | test (modified) | 0204, 0212 | Resolve now goes through `resolveExceptionAsOperator`; event recording on the app pool. | self | none | no finding | diff read |
| packages/db/src/ops/paid-launch-gate.integration.test.ts | test (new) | OWN-92 0227 | App reschedule and forged reservation binding refused. | self | none | no finding | header read |
| packages/db/src/ops/recovery-drill.integration.test.ts | test (modified) | backup/restore gate | Restores keeping ownership; definer owners survive; shell comparison catches a single wrong owner. | self | none | no finding | diff read |
| packages/db/src/ops/staging-tools.integration.test.ts | test (new) | G-119, OWN-77 0197 | Marker and test-business fence; compare-before moves; audited; single-consume fault. | self | none | no finding | header read |
| packages/db/src/ops/upgrade-from-main.integration.test.ts | test (new) | migration safety 0193-0230 | Upgrade from 0192 with seeded state; history unchanged. Seeds use owner SQL shaped like the 0192 release. | self | none | no finding | header read; `toBeTruthy` at :207 is a script-presence check |
| packages/db/src/ops/upgrade-od51.integration.test.ts | test (new) | 0213-0230 | Upgrade from 0212. | self | none | no finding | header read |
| packages/db/src/preflight-subscriptions.ts | script (new) | OD-49 0208 | Read-only preflight as an RLS-unrestricted owner; refuses a role that RLS would blind; prints ids, plan, reason and dates only (no PII). | subscription-preflight.integration.test.ts | none | no finding | full file read |
| packages/db/src/pricing-source.ts | script (new) | OD-51.6 0215 | Owner-only show/set through `rekoda_private.set_pricing_source`; checks ownership before writing. | pricing-source.integration.test.ts | none | no finding | full file read |
| packages/db/src/privacy/retention-deletion.integration.test.ts | test (new, split) | retention, 0118 | Deletion half of the retention suite (moved). | self | known R10 | known R10 | titles compared with the old retention file: none lost |
| packages/db/src/privacy/retention.integration.test.ts | test (split) | retention | 419 lines moved to retention-deletion. | self | known R10 | known R10 | `comm` of the old and new title sets is empty |
| packages/db/src/provision.ts | script (modified) | OD-37 0202, G-01 | Four runtime roles; distinct passwords enforced; all or none. | provision.integration.test.ts | none | no finding | diff read |
| packages/db/src/repos/add-ons.ts | repo (doc only) | 0226 | `hold()` is documented as callable by no runtime role. | add-ons test | none | no finding | diff read |
| packages/db/src/repos/billing.ts | repo | OD-37, OD-50 0207/0213, G-62 | `setPlan` runs on the operator pool under `withBusiness`; the date rule is judged on the database clock; `resolveSupportReview` is pinned. `setPlanAsFixture` is exported from the production barrel, but calls a function that is absent in production. | operator-plan-change, operator-standard-periods, support-review-* | none | no finding | full diff read |
| packages/db/src/repos/boot-checks.ts | repo | OD-37 0196/0202/0206, OD-51.6 | Principal and guard checks. `in_app` uses `pg_has_role(...,'USAGE')`, so a NOINHERIT member of `rekoda_app` (able to `SET ROLE`) passes `assertDatabasePrincipal`. Only two reserved writers are checked at boot (the deploy smoke checks more). The trigger list of 13 matches migrations 0196-0222. | boot-checks, plan-principals, pricing-source | G2-3: MINOR | finding G2-3 | full diff read; triggers cross-checked by grepping `CREATE TRIGGER` in 0193-0230 |
| packages/db/src/repos/dead-jobs.ts | repo (new) | OWN-73, OWN-76, ADR 0035 Am. 2 | Death record, merchant exception (payment jobs only), event flag, audit; no payload or error text; recovery is one bounded requeue. Cross-tenant reads go through definer functions; writes are pinned by `set_config` to the job's tenant. | dead-job-* suites | none | no finding | full file read; grants checked against 0194, 0217, 0223 |
| packages/db/src/repos/events.ts | repo | 0204, 0218, OWN-73, ADR 0035 Am. 2 r4 | Attribution through the definer. Operator resolve: the worker discovers the fixed column, then the app writes under the event's tenant with an audit row; the event-row lock serialises with `recordDeath`. | ops-health, external-events-worker-write, dead-job-late-death | none | no finding | full diff read |
| packages/db/src/repos/identity.ts | repo | OD-37 0203 | Trial end is computed on the database clock as `now()` + 336 h. | operator-standard-periods | none | no finding | diff read |
| packages/db/src/repos/jobs.ts | repo | OWN-73/76, 0217, 0225, 0228, 0229 | Claim filter; payload read under the pin; death record written in the same transaction as the transition. In `reclaimStalled` (:626) a failed per-record savepoint is re-thrown, so one persistent failure rolls back the whole cross-tenant reclaim pass. Swallowed failure-note at :673 (R08). | jobs, dead-job-*, job-payload-isolation | G2-1: MINOR; known R01, R07, R08, R11 | finding G2-1 | full diff read; `runner.ts:262-283` read |
| packages/db/src/repos/merchant-api.ts | repo | #432 review | `customerBelongsToBusiness` takes `FOR KEY SHARE` in the caller's transaction. | customer-sale-ownership-race | none | no finding | diff read; caller `merchant-v1.controller.ts:202` |
| packages/db/src/repos/party-statements.ts | repo | tenancy | `customerKnown` and `supplierKnown`; callers validate the UUID first, so malformed, unknown and foreign ids all get the same 404. | reports tests (apps) | none | no finding | diff read; `reports.controller.ts:334,2224` |
| packages/db/src/repos/settle.ts | repo | invariant 3 | Adds an explicit pinned-business predicate to `paymentsFor` and `reconciliationsFor` (defence in depth; the count comes from SQL). | settle tests | none | no finding | diff read |
| packages/db/src/repos/staging-tools.ts | repo (new) | G-119, OWN-77 0197 | Marker check in the same statement for designate and consume; dates only through `staging_move_date`. An armed fault on a non-staging database is never consumed. | staging-tools | none | no finding | full file read |
| packages/db/src/repos/subscriptions.ts | repo | OD-37, OD-40, OD-44, OD-50, OD-51, OWN-70 | Plan writes go through the authority-specific definers; refund through the operator (`withBusiness(operatorDb)`). `blockedRenewalCount(workerDb)` reads `subscription_charges` unpinned via the pre-existing `worker_resolve` policy, registered in the RLS exemption register (count only). | plan-*, pack-*, subscriptions*, support-review-* | known R03, R06 | known R03/R06 | full diff read; `worker_resolve` (0020) and register row :233 checked |
| packages/db/src/repos/usage.ts | repo | OD-51.4 0216, 0222, 0224 | Spend, refund and credit only through definers; the handle carries the reservation. `meterOn` keeps last month during days 1-7, but 0224's `usage_credit_pack` refuses last month. Settlement passes `usagePeriod(new Date())`, so the two disagree only across host/database clock skew at a month boundary, and the job retries. | usage-* suites, pack-credit-terms | G2-10: MINOR | finding G2-10 | full diff read; `billing.service.ts:735-790` and the 0224 header read |
| packages/db/src/repos/webhooks.ts | repo | 0212 | `queueDelivery` goes through the definer, which copies the type and payload from the outbox row. | webhook tests (apps) | none | no finding | diff read |
| packages/db/src/schema/subscriptions.ts | schema | OD-40 0193 | Adds three provider and credit time columns. The Drizzle model still omits later columns (priced_at, purchase_id, pricing_source, blocked_*); repos use raw SQL for them. | n/a | none | no finding | diff read |
| packages/db/src/stock/cross-product.integration.test.ts | test (modified) | 0222 | Fixture and credential substitutions. | self | none | no finding | diff skimmed |
| packages/db/src/tenancy/boot-checks.integration.test.ts | test (modified) | OD-37 0196 | Adds `assertRoleCannotAssumePlanWriter` (direct and indirect membership); key race now on two app pools. No case covers a NOINHERIT `rekoda_app` membership. | self | related G2-3 | finding G2-3 | diff read |
| packages/db/src/tenancy/provision.integration.test.ts | test (modified) | OD-37 0202 | Four SCRAM verifiers; shared password refused before anything is sent. | self | none | no finding | diff read |
| packages/db/src/tenancy/rls-invariants.integration.test.ts | test (modified) | 0204, 0217, 0223 | Policy-keyed exception list extended by name (seven new entries, each justified in comments). | self | none | no finding | diff read |
| packages/db/src/tenancy/tenant-fk-group-f3.integration.test.ts | test (modified) | 0210 | The worker's grant reduced to SELECT. | self | none | no finding | diff read |
| packages/db/src/tenancy/testing.integration.test.ts | test (modified) | 0215 | Teardown restores the pricing source and clears its history. | self | none | no finding | diff read |
| packages/db/src/tenancy/worker-least-privilege.integration.test.ts | test (new) | OD-51, 0210 | The worker's writes are reduced to its jobs; attacks run with the victim pin set. | self | none | no finding | header read |
| packages/db/src/testing.ts | test harness | OD-37, OD-51 | Principal pools; owner pool captured at module load; harness-only fixture writers (plan, grace, bonus) granted to the runtime roles. The plan fixture's mere presence disables the 0206 cycle guard for every role in every integration database (G2-2). `setPlanAsOwner` writes as the owner. | all integration | G2-2: MINOR | finding G2-2 | full diff read; 0206 guard body read |
| packages/db/vitest.integration.config.ts | config | OD-37 | Adds `setupFiles` for pool closing. | n/a | none | no finding | diff read |

## Findings

No BLOCKING or IMPORTANT finding in this group. Every finding below is MINOR.

### G2-1: MINOR. A persistent failure on one tenant blocks the whole reclaim pass

- **Where:** `packages/db/src/repos/jobs.ts:620-637` (`reclaimStalled`), with `apps/api/src/jobs/runner.ts:263-283`.
- **What:** Each death record is written in its own savepoint. The comment says a failure "rolls back only itself, not the whole cross-tenant pass", but the error is then re-thrown out of `tx.transaction`, so the outer `db.transaction` rolls back every job the pass reclaimed, in every tenant. `runner.reclaim()` then throws before the dead-job enrolment and before `this.companion.reclaim()`.
- **Failure scenario:** one payment job's death record keeps failing, for example a lock wait under a statement timeout on `external_events FOR UPDATE`, or a constraint violation from a hand-edited row. Every reclaim pass then aborts. Stalled jobs of all tenants stay `running` and are never returned to the queue, and the settlement companion's reclaim never runs while the worker's pass keeps failing.
- **Suggested fix:** do not re-throw per record. Either roll that job's transition back to `running` in its own savepoint (so it is retried next pass while the others commit), or record the failure through the 0229-style dead-letter path. Report the failure count after the loop. Also run the companion reclaim in a `finally`.
- **Confidence:** medium. The mechanism is certain; how often a persistent failure happens is speculative.

### G2-2: MINOR. The harness fixture disables the 0206 cycle guard database-wide in tests

- **Where:** `packages/db/src/testing.ts:193-203` installs `test_fixture_set_plan`. The guard is `migrations/0206_paid_charge_bound_to_its_cycle.sql:140`; the example usage is `packages/db/src/billing/trial-lifecycle.integration.test.ts:186`.
- **What:** `businesses_cycle_fields_guard` returns NEW for any role whenever `public.test_fixture_set_plan` exists. The harness installs that function in every integration database, so the app and worker credentials may write `payment_failed_at`, `cycle_started_at`, `billing_interval`, `plan_version_id` and the other guarded columns in every suite. The exceptions are the three tests that drop it: `paid-charge-cycle-binding`, `settlement-isolation` and `deploy-smoke-sql`. `trial-lifecycle:186` relies on this, writing `payment_failed_at` on the app credential; production refuses that write with 42501.
- **Failure scenario:** a future production code path on `rekoda_app` or `rekoda_worker` writes a guarded cycle column (as the still-unwired `planCatalogueRepo.pinPlanVersion` would). Every db and api integration test passes, and production fails with 42501 at the first real call. This is a structural false-negative for the guard.
- **Suggested fix:** have the fixture definer write the whole cycle itself. It already runs as `rekoda_plan_writer`, which the guard exempts by role, so the guard's existence-of-function exemption can be removed. Stage grace through `startGraceForTest` instead of a direct UPDATE.
- **Confidence:** high on the mechanism. No current production path was found that is affected.

### G2-3: MINOR. `assertDatabasePrincipal` misses a NOINHERIT `rekoda_app` membership; reserved-writer coverage is narrow

- **Where:** `packages/db/src/repos/boot-checks.ts:111` (`pg_has_role(current_user,'rekoda_app','USAGE')`) and `:212-219`.
- **What:** `USAGE` is false for a NOINHERIT membership, but the principal can still `SET ROLE rekoda_app`, so it acts with all of the application's rights. Every other membership check in the same query uses `MEMBER`. Separately, `assertRoleHoldsNoReservedWriter` checks EXECUTE only on the two plan writers. A later `GRANT EXECUTE` to `rekoda_app` on `subscription_record_refund` (0230), `subscription_operator_resolve_review` (0213) or `usage_credit_pack` (0216) is caught by the deploy-time smoke but not on boot.
- **Failure scenario:** an administrator runs `GRANT rekoda_app TO rekoda_settlement` with NOINHERIT. Settlement still boots, and a settlement-credential holder runs `SET ROLE rekoda_app` and gains tenant-wide application rights, which OD-51 says it no longer holds.
- **Suggested fix:** use `'MEMBER'` for `in_app`, and extend the boot check to the full reserved-function list the smoke uses.
- **Confidence:** high, but the trigger needs an administrative mis-grant.

### G2-4: withdrawn (folded into G2-3)

### G2-5: MINOR. The cross-tenant entitlement-write test can no longer fail on an RLS regression

- **Where:** `packages/db/src/billing/entitlements.integration.test.ts:232-247`.
- **What:** since 0210 the app credential holds no write on grants at all, so `rejects.toThrow()` passes for its own business and for another business alike. The test titled "refuses to write a grant for another business" no longer exercises WITH CHECK. The owner pool now writes grants, and nothing proves cross-tenant refusal for the role that does write.
- **Suggested fix:** assert the specific error (42501 permission denied). Add a cross-tenant write attempt by the actual writing role (the owner under a foreign pin, if owner RLS is forced), or drop the misleading title.
- **Confidence:** high.

### G2-6: MINOR. The rolled-back-spend refund test can pass vacuously

- **Where:** `packages/db/src/billing/usage-meter-boundary.integration.test.ts:204-215`.
- **What:** if `reserveUnit` returned a handle without a reservation (refused, or a regression that stops recording reservations), `refundUnit` returns 0 without querying the database. The assertion `toBe(0)` then passes for the wrong reason.
- **Suggested fix:** add `expect(usageRepo.reservationOf(handle!)).not.toBeNull()` before the refund.
- **Confidence:** high.

### G2-7: MINOR. Stale claims in test headers

- **Where:** `packages/db/src/ops/dead-job-enrolment-pin.test.ts:6-8` says "the database therefore cannot refuse an unpinned payload read", but 0228 makes it refuse one (`job_payload`; the worker holds no column SELECT). `packages/db/src/billing/plan-fields-guard.integration.test.ts:9` says the operator writer is "executable by the API credential only", but since 0202 only `rekoda_billing_operator` may run it.
- **Failure scenario:** none at runtime. Reviewers reading the headers get the wrong boundary.
- **Suggested fix:** update both headers.
- **Confidence:** high.

### G2-8: MINOR. `seedCharge` writes charge shapes production never writes

- **Where:** `packages/db/src/billing/plan-writer.fixtures.ts:112-140`.
- **What:** charges are written as the owner, bypassing every guard, with:
  - reference `RKD-SUB-OD37-000001`, which fails the production reference shape `^RKD-SUB-\d{8}-[0-9A-Z]{6}`;
  - a chat plan at 1,000 kobo;
  - `period_start` and `period_end` set on a `first_purchase`;
  - no `priced_at` source, `pricing_source` or `provider_paid_at`.
- **Failure scenario:** a test built on this fixture that reaches code keyed on the reference shape (`deadJobs.referenceOf`, the 0194 CHECK) or on the price silently takes a different branch. For example, the reference is recorded as null instead of the value. The writer-boundary assertions themselves still hold.
- **Suggested fix:** generate references in the production shape and use catalogue prices, or document the fixture's intentional deviations.
- **Confidence:** medium (no current false pass identified).

### G2-9: MINOR. Two of the three `assertNoTestFixtureWriter` branches are untested

- **Where:** `packages/db/src/billing/plan-principals.integration.test.ts:170`.
- **What:** the harness installs all three fixtures, so the first branch (`test_fixture_set_plan`) always throws first. The `test_fixture_credit_bonus` and `test_fixture_start_grace` refusals are never exercised.
- **Failure scenario:** a regression that removes or breaks those branches (typo in the signature string) ships green, and a database holding only the bonus fixture would boot in production. The deploy smoke still drops and checks the functions.
- **Suggested fix:** in a rolled-back transaction, drop the plan fixture and assert the bonus message; drop the bonus fixture too and assert the grace message.
- **Confidence:** high.

### G2-10: MINOR. `creditPack` meter-row rule disagrees with 0224 across a month boundary

- **Where:** `packages/db/src/repos/usage.ts:95-99` (`meterOn`), used by `creditPack` (`:220-234`).
- **What:** on days 1-7 the client keeps last month's row when asked for it, but 0224's `usage_credit_pack` refuses last month outright.
- **Failure scenario:** settlement passes `usagePeriod(new Date())` on the settlement host. If that clock trails the database's across the Lagos month boundary, the host names last month, the database refuses, the settlement transaction rolls back and the job retries. The retry normally succeeds, so the cost is a retry. The real risk is the divergence of the two rules if a caller ever passes the charge's own period.
- **Suggested fix:** in `creditPack`, never apply the seven-day carry-back. Use `meterRowFor`-style logic clamped to the current month, or let the database choose the row.
- **Confidence:** medium.

### Known items touched by this group (not re-derived)

- **R01, R07:** `jobs.ts` `pinnedPayload` and `job-payload-isolation.integration.test.ts`.
- **R03:** `subscriptions.requestPlanReview` returns null on refusal; the service-side mapping lives in `apps/api`.
- **R06:** `subscriptions.recordRefund` and `pack-refund.integration.test.ts`.
- **R08:** `jobs.ts:673` `.catch(() => undefined)`.
- **R09:** `pack-refund.integration.test.ts`.
- **R10:** retention suites.
- **R11:** `jobs.requeueEnrolment` takes the actor from the caller.
