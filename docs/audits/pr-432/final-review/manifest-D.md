# Manifest D: packages/db outside migrations (PR #432, head 198d37a, base 58e6834)

| path                                                                         | reviewed | findings |
| ---------------------------------------------------------------------------- | -------- | -------- |
| packages/db/src/billing/add-ons.integration.test.ts                          | reviewed | none     |
| packages/db/src/billing/entitlement-gate.integration.test.ts                 | reviewed | none     |
| packages/db/src/billing/entitlements.integration.test.ts                     | reviewed | none     |
| packages/db/src/billing/margin.integration.test.ts                           | reviewed | none     |
| packages/db/src/billing/operator-cycle-writes.integration.test.ts            | reviewed | none     |
| packages/db/src/billing/operator-plan-change.integration.test.ts             | reviewed | none     |
| packages/db/src/billing/operator-standard-periods.integration.test.ts        | reviewed | none     |
| packages/db/src/billing/pack-credit-terms.integration.test.ts                | reviewed | none     |
| packages/db/src/billing/pack-purchase-identity.integration.test.ts           | reviewed | none     |
| packages/db/src/billing/pack-refund-concurrency.integration.test.ts          | reviewed | none     |
| packages/db/src/billing/pack-refund-natural-expiry.integration.test.ts       | reviewed | none     |
| packages/db/src/billing/pack-refund.integration.test.ts                      | reviewed | none     |
| packages/db/src/billing/paid-charge-cycle-binding.integration.test.ts        | reviewed | none     |
| packages/db/src/billing/plan-catalogue.integration.test.ts                   | reviewed | none     |
| packages/db/src/billing/plan-expiry-files.allowed.ts                         | reviewed | none     |
| packages/db/src/billing/plan-expiry-files.checker.ts                         | reviewed | none     |
| packages/db/src/billing/plan-expiry-files.patterns.test.ts                   | reviewed | none     |
| packages/db/src/billing/plan-expiry-files.test.ts                            | reviewed | none     |
| packages/db/src/billing/plan-fields-guard.integration.test.ts                | reviewed | none     |
| packages/db/src/billing/plan-principals.integration.test.ts                  | reviewed | none     |
| packages/db/src/billing/plan-writer-boundary.integration.test.ts             | reviewed | D-4      |
| packages/db/src/billing/plan-writer.fixtures.ts                              | reviewed | none     |
| packages/db/src/billing/platform-costs.integration.test.ts                   | reviewed | none     |
| packages/db/src/billing/pricing-source.integration.test.ts                   | reviewed | none     |
| packages/db/src/billing/settlement-event-scope.integration.test.ts           | reviewed | none     |
| packages/db/src/billing/settlement-isolation.integration.test.ts             | reviewed | none     |
| packages/db/src/billing/subscription-journey.integration.test.ts             | reviewed | none     |
| packages/db/src/billing/subscription-origin.integration.test.ts              | reviewed | none     |
| packages/db/src/billing/subscription-preflight.integration.test.ts           | reviewed | none     |
| packages/db/src/billing/subscriptions-sweeps.integration.test.ts             | reviewed | none     |
| packages/db/src/billing/subscriptions.integration.test.ts                    | reviewed | none     |
| packages/db/src/billing/support-review-later-schedule.integration.test.ts    | reviewed | none     |
| packages/db/src/billing/support-review-plan-change.integration.test.ts       | reviewed | none     |
| packages/db/src/billing/support-review-pricing.integration.test.ts           | reviewed | none     |
| packages/db/src/billing/trial-lifecycle.integration.test.ts                  | reviewed | none     |
| packages/db/src/billing/usage-entitlement-authority.integration.test.ts      | reviewed | none     |
| packages/db/src/billing/usage-meter-boundary.integration.test.ts             | reviewed | none     |
| packages/db/src/billing/usage-refund-and-job-guards.integration.test.ts      | reviewed | none     |
| packages/db/src/billing/usage-reservation-backfill.integration.test.ts       | reviewed | none     |
| packages/db/src/billing/usage-reservation-closure-tamper.integration.test.ts | reviewed | none     |
| packages/db/src/billing/usage-reservation-closure.integration.test.ts        | reviewed | none     |
| packages/db/src/billing/usage-trial-migrations.integration.test.ts           | reviewed | none     |
| packages/db/src/billing/usage-trial.integration.test.ts                      | reviewed | none     |
| packages/db/src/billing/usage.integration.test.ts                            | reviewed | D-6      |
| packages/db/src/channels/preview-delivery.integration.test.ts                | reviewed | none     |
| packages/db/src/customers/customer-sale-ownership-race.integration.test.ts   | reviewed | none     |
| packages/db/src/customers/customer.fixtures.ts                               | reviewed | none     |
| packages/db/src/customers/customers.integration.test.ts                      | reviewed | none     |
| packages/db/src/index.ts                                                     | reviewed | none     |
| packages/db/src/integration-setup.ts                                         | reviewed | none     |
| packages/db/src/ops/dead-job-enrolment-dead-letter.integration.test.ts       | reviewed | none     |
| packages/db/src/ops/dead-job-enrolment-pin.test.ts                           | reviewed | none     |
| packages/db/src/ops/dead-job-enrolment-scope.integration.test.ts             | reviewed | none     |
| packages/db/src/ops/dead-job-enrolment-settled.integration.test.ts           | reviewed | none     |
| packages/db/src/ops/dead-job-exceptions.integration.test.ts                  | reviewed | none     |
| packages/db/src/ops/dead-job-late-death.integration.test.ts                  | reviewed | none     |
| packages/db/src/ops/dead-job-reclaim-isolation.integration.test.ts           | reviewed | none     |
| packages/db/src/ops/deploy-smoke-sql-closeout.integration.test.ts            | reviewed | none     |
| packages/db/src/ops/deploy-smoke-sql-second-review.integration.test.ts       | reviewed | none     |
| packages/db/src/ops/deploy-smoke-sql.fixtures.ts                             | reviewed | none     |
| packages/db/src/ops/deploy-smoke-sql.integration.test.ts                     | reviewed | none     |
| packages/db/src/ops/external-events-worker-write.integration.test.ts         | reviewed | none     |
| packages/db/src/ops/job-payload-isolation.integration.test.ts                | reviewed | none     |
| packages/db/src/ops/jobs.integration.test.ts                                 | reviewed | none     |
| packages/db/src/ops/operator-actor-columns.integration.test.ts               | reviewed | none     |
| packages/db/src/ops/operator-work-lists-privileges.integration.test.ts       | reviewed | none     |
| packages/db/src/ops/operator-work-lists.integration.test.ts                  | reviewed | none     |
| packages/db/src/ops/ops-health.integration.test.ts                           | reviewed | none     |
| packages/db/src/ops/paid-launch-gate.integration.test.ts                     | reviewed | none     |
| packages/db/src/ops/recovery-drill.integration.test.ts                       | reviewed | none     |
| packages/db/src/ops/settlement-job-transitions.integration.test.ts           | reviewed | none     |
| packages/db/src/ops/staging-tools.integration.test.ts                        | reviewed | none     |
| packages/db/src/ops/upgrade-from-main.integration.test.ts                    | reviewed | none     |
| packages/db/src/ops/upgrade-od51.integration.test.ts                         | reviewed | none     |
| packages/db/src/ops/usage-bind-event-job.integration.test.ts                 | reviewed | none     |
| packages/db/src/preflight-subscriptions.ts                                   | reviewed | none     |
| packages/db/src/pricing-source.ts                                            | reviewed | D-1      |
| packages/db/src/privacy/retention-deletion.integration.test.ts               | reviewed | D-2, D-4 |
| packages/db/src/privacy/retention-pr432-tables.integration.test.ts           | reviewed | none     |
| packages/db/src/privacy/retention.integration.test.ts                        | reviewed | none     |
| packages/db/src/provision.ts                                                 | reviewed | none     |
| packages/db/src/repos/add-ons.ts                                             | reviewed | none     |
| packages/db/src/repos/billing.ts                                             | reviewed | none     |
| packages/db/src/repos/boot-checks.ts                                         | reviewed | D-1      |
| packages/db/src/repos/dead-jobs.ts                                           | reviewed | D-5      |
| packages/db/src/repos/events.ts                                              | reviewed | none     |
| packages/db/src/repos/identity.ts                                            | reviewed | none     |
| packages/db/src/repos/jobs.ts                                                | reviewed | D-5      |
| packages/db/src/repos/merchant-api.ts                                        | reviewed | none     |
| packages/db/src/repos/party-statements.ts                                    | reviewed | none     |
| packages/db/src/repos/settle.ts                                              | reviewed | none     |
| packages/db/src/repos/staging-tools.ts                                       | reviewed | none     |
| packages/db/src/repos/subscriptions.ts                                       | reviewed | none     |
| packages/db/src/repos/usage.ts                                               | reviewed | D-7      |
| packages/db/src/repos/webhooks.ts                                            | reviewed | none     |
| packages/db/src/stock/cross-product.integration.test.ts                      | reviewed | none     |
| packages/db/src/tenancy/boot-checks.integration.test.ts                      | reviewed | none     |
| packages/db/src/tenancy/provision.integration.test.ts                        | reviewed | none     |
| packages/db/src/tenancy/rls-invariants.integration.test.ts                   | reviewed | none     |
| packages/db/src/tenancy/tenant-fk-group-f3.integration.test.ts               | reviewed | none     |
| packages/db/src/tenancy/testing.integration.test.ts                          | reviewed | none     |
| packages/db/src/tenancy/worker-least-privilege.integration.test.ts           | reviewed | none     |
| packages/db/src/testing.ts                                                   | reviewed | D-3      |
| packages/db/vitest.integration.config.ts                                     | reviewed | none     |

Depth note: production files (repos/*, provision, preflight-subscriptions, pricing-source, testing, index, integration-setup, vitest config) were read line by line against the base and the migrations they call (0194, 0206, 0217, 0221, 0235). Test files were reviewed by diff, with particular attention to removed or loosened assertions (`git diff | grep '^-.*expect'`) and to how each test stages its preconditions. No test was executed in this environment (no database).

## Findings

No BLOCKING or IMPORTANT findings.

### D-1 MINOR: the table-owner check uses USAGE, so it misses a non-inheriting membership

- Where: packages/db/src/repos/boot-checks.ts:124 (`in_table_owner`), packages/db/src/pricing-source.ts:93.
- Failure scenario: someone runs `GRANT <table owner> TO rekoda_app WITH INHERIT FALSE` (PostgreSQL 16+), or creates a NOINHERIT role. `pg_has_role(..., 'USAGE')` is false, so `assertRoleHoldsNoReservedWriter` and `assertDatabasePrincipal` both pass. The role can still `SET ROLE` to the owner. Every OD-37 guard exempts the owner (0206: `pg_has_role(current_user, relowner, 'USAGE')` is true after the SET ROLE), so that role can then write plan and cycle fields directly. The neighbouring checks (`in_settlement`, `in_plan_writer`, `in_usage_writer`) already use MEMBER. Only reachable through a misconfiguration; this is defence in depth.
- Fix: use `'MEMBER'` for `in_table_owner`. For the pricing-source owner check, USAGE is the correct semantics; leave it as it is.

### D-2 MINOR: the retention "nothing left anywhere" scan is blind to row-level security

- Where: packages/db/src/privacy/retention-deletion.integration.test.ts:147-172. The code was moved from retention.integration.test.ts, where the same pattern existed at the base.
- Failure scenario: the leftover scan lists tables and counts rows as `rekoda_worker` with no pin. Every table that has only the 0001 `tenant_isolation` policy (customers, invoices, ledger_entries and so on) returns 0 to an unpinned worker. A retention regression that left a merchant's customers behind would therefore still pass `expect(leftovers).toEqual([])`. `information_schema` also hides tables the worker holds no privilege on. The R10 suite (retention-pr432-tables) counts as the owner, so the new tables are covered. The general claim is not.
- Fix: run the table list and the counts on `ownerDb`, which is already open in this file.

### D-3 MINOR: the harness fixture writer turns off the 0206 cycle-fields guard for every integration suite

- Where: packages/db/src/testing.ts:~150-203 (`installTestFixtureWriter`), together with 0206:140. The guard returns NEW whenever `public.test_fixture_set_plan` exists.
- Failure scenario: every db and api integration database has the function. A production code path on `rekoda_app` that writes a guarded column (`plan_version_id`, `cycle_started_at`, `billing_interval`, `subscription_origin`, `renewal_anchor_day`, `ever_paid_at`, `payment_failed_at`) therefore passes the whole suite and fails with 42501 only in production. Example: wiring the existing `planCatalogueRepo.pinPlanVersion` on the application credential. Only the dedicated guard tests (paid-charge-cycle-binding, settlement-isolation, deploy-smoke) drop the function first.
- Fix: key the exemption on something only the fixture call sets, such as a transaction GUC set inside the fixture functions or `current_user = 'rekoda_plan_writer'` (the fixture is SECURITY DEFINER owned by it). Alternatively, add one CI pass of the api billing suites with the fixture dropped.

### D-4 MINOR: two privilege-refusal assertions accept any error

- Where: packages/db/src/billing/plan-writer-boundary.integration.test.ts:346; packages/db/src/privacy/retention-deletion.integration.test.ts:308.
- Failure scenario: `.rejects.toThrow()` also passes on a typo, a missing function or a different error. The refusal it claims to prove is not pinned.
- Fix: match `{ cause: { code: '42501' } }`, as the rest of the PR's boundary tests do.

### D-5 MINOR: the reclaim and a lease-expired but still-running handler take two rows in opposite order

- Where: packages/db/src/repos/jobs.ts (`reclaimStalled`: jobs row FOR UPDATE, then `recordDeath`); packages/db/src/repos/dead-jobs.ts:117 (external_events FOR UPDATE).
- Failure scenario: a `payment.process` handler on its last attempt overruns its lease. Its transaction has already written the event's `processed_at` and holds that row. It then calls `markDone`, which needs the jobs row. Meanwhile the reclaim has locked the jobs row and, in `recordDeath`, waits on the event. PostgreSQL detects the deadlock and aborts one side. Either way the outcome is safe: the reclaim savepoint is reported unrecorded and retried, or the handler rolls back and the job dies with its record. The deadlock does produce error noise and a spurious E-F4 "unrecorded" report.
- Fix: none required. Optionally lock the event before the jobs row in the reclaim, or skip events that are already locked (`FOR UPDATE SKIP LOCKED`, then leave the job for the next pass).

### D-6 MINOR: the month-dependent test period comes from the host clock at module load

- Where: packages/db/src/billing/usage.integration.test.ts:56. Other suites that use `usagePeriod(new Date())` follow the same pattern.
- Failure scenario: since 0222 the database meters on its own Lagos month. A run that crosses midnight at a Lagos month end, or a host clock slightly off the database's, makes `usageFor(PERIOD)` read a different row from the one that was spent. The result is a flaky failure, not a false pass.
- Fix: read the month from the database (`to_char(now() AT TIME ZONE 'Africa/Lagos','YYYY-MM')`), as pack-refund-concurrency does.

### D-7 MINOR: the client's meter-row rule for a pack credit disagrees with usage_credit_pack

- Where: packages/db/src/repos/usage.ts:98 (`meterOn`, used by `creditPack`); 0235 `usage_credit_pack`, which accepts only the current Lagos month ("never last month").
- Failure scenario: `creditPack` passes `meterOn(plan, usagePeriod(when), unit)`, which keeps the previous month during days 1 to 7. Settlement passes `when = new Date()`, so the two agree unless the API host's clock and the database's clock straddle a Lagos month boundary. In that case the database raises 42501, the billing job fails and retries, and it succeeds once the clocks agree. The rule applied to credits is one the database never accepts.
- Fix: give `creditPack` its own row rule (trial row or current month) without the seven-day carry-over, or read the month from the database.
