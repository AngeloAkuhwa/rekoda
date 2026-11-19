# Manifest E1 (PR #432, merge base 58e6834, head 198d37a)

apps/api/src/channels/catalogue-sync.integration.test.ts | reviewed | none
apps/api/src/channels/customer-route.integration.test.ts | reviewed | none
apps/api/src/channels/meta-business-email.integration.test.ts | reviewed | none
apps/api/src/channels/meta-catalogue-order-1.integration.test.ts | reviewed | none
apps/api/src/channels/meta-catalogue-order-pool.integration.test.ts | reviewed | none
apps/api/src/channels/meta-chat-entitlement-1.integration.test.ts | reviewed | none
apps/api/src/channels/meta-chat-entitlement-2.integration.test.ts | reviewed | none
apps/api/src/channels/meta-chat-entitlement-3.integration.test.ts | reviewed | none
apps/api/src/channels/meta-consent-trial.integration.test.ts | reviewed | none
apps/api/src/channels/meta-cross-product.integration.test.ts | reviewed | none
apps/api/src/channels/meta-customer-thread.integration.test.ts | reviewed | none
apps/api/src/channels/meta-forwarded-order.integration.test.ts | reviewed | none
apps/api/src/channels/meta-g68-codex-review.integration.test.ts | reviewed | none
apps/api/src/channels/meta-g68-review.integration.test.ts | reviewed | none
apps/api/src/channels/meta-lost-message.fixtures.ts | reviewed | none
apps/api/src/channels/meta-order-ingress.integration.test.ts | reviewed | none
apps/api/src/channels/meta-preview-expiry-1.integration.test.ts | reviewed | none
apps/api/src/channels/meta-purchase-truth-2.integration.test.ts | reviewed | none
apps/api/src/channels/meta-purchase-truth-3.integration.test.ts | reviewed | none
apps/api/src/channels/meta-receipt-photo-1.integration.test.ts | reviewed | none
apps/api/src/channels/meta-reminder-reply-receipts.integration.test.ts | reviewed | none
apps/api/src/channels/meta-reminder-reply.fixtures.ts | reviewed | none
apps/api/src/channels/meta-reminder-reply.integration.test.ts | reviewed | none
apps/api/src/channels/meta-voice-note-1.integration.test.ts | reviewed | none
apps/api/src/channels/meta-webhook.fixtures.ts | reviewed | none
apps/api/src/channels/meta.sender-templates.test.ts | reviewed | none
apps/api/src/channels/meta.sender.fixtures.ts | reviewed | none
apps/api/src/channels/meta.sender.test.ts | reviewed | none
apps/api/src/channels/meta.sender.ts | reviewed | none
apps/api/src/channels/sender.ts | reviewed | none
apps/api/src/channels/stranger-sweep.integration.test.ts | reviewed | none
apps/api/src/channels/template-report.test.ts | reviewed | none
apps/api/src/channels/template-report.ts | reviewed | none
apps/api/src/channels/template-slots.test.ts | reviewed | none
apps/api/src/channels/template-slots.ts | reviewed | none
apps/api/src/channels/usage-row-probe.fixtures.ts | reviewed | none
apps/api/src/channels/waba-templates-pool.integration.test.ts | reviewed | none
apps/api/src/channels/waba-templates.integration.test.ts | reviewed | none
apps/api/src/channels/waba-templates.service.ts | reviewed | none
apps/api/src/health/business-object-authorisation-records.integration.test.ts | reviewed | none
apps/api/src/health/business-object-authorisation-writes.integration.test.ts | reviewed | none
apps/api/src/health/business-object-authorisation.integration.test.ts | reviewed | none
apps/api/src/health/dead-job-enrolment-routes.integration.test.ts | reviewed | none
apps/api/src/health/dead-job-recovery.integration.test.ts | reviewed | none
apps/api/src/health/dead-job-recovery.service.ts | reviewed | none
apps/api/src/health/dead-job-resolve-atomic.integration.test.ts | reviewed | none
apps/api/src/health/dead-jobs.controller.ts | reviewed | none
apps/api/src/health/ops-alerts.ts | reviewed | none
apps/api/src/health/ops-blocked-renewals.integration.test.ts | reviewed | none
apps/api/src/health/ops-charges.fixtures.ts | reviewed | none
apps/api/src/health/ops-idor-harness.ts | reviewed | none
apps/api/src/health/ops-object-authorisation-staging.integration.test.ts | reviewed | none
apps/api/src/health/ops-object-authorisation.integration.test.ts | reviewed | none
apps/api/src/health/ops-refund.controller.ts | reviewed | none
apps/api/src/health/ops.controller.ts | reviewed | E1-1, E1-5
apps/api/src/health/ops.integration.test.ts | reviewed | none
apps/api/src/health/staging-boot-check.ts | reviewed | none
apps/api/src/health/staging-boot.integration.test.ts | reviewed | none
apps/api/src/health/staging-tools.controller.ts | reviewed | none
apps/api/src/health/staging-tools.integration.test.ts | reviewed | none
apps/api/src/health/staging-tools.service.ts | reviewed | none
apps/api/src/health/stuck-job-alert.integration.test.ts | reviewed | none
apps/api/src/jobs/apply-no-charge-upgrade.handler.ts | reviewed | none
apps/api/src/jobs/customer-message.handler.ts | reviewed | none
apps/api/src/jobs/inbound-message.handler.ts | reviewed | none
apps/api/src/jobs/initiate-blocked-renewal.handler.ts | reviewed | E1-4
apps/api/src/jobs/jobs-chat-roles-1.integration.test.ts | reviewed | none
apps/api/src/jobs/jobs-chat-roles-3.integration.test.ts | reviewed | E1-2
apps/api/src/jobs/jobs-lease.integration.test.ts | reviewed | none
apps/api/src/jobs/jobs.fixtures.ts | reviewed | none
apps/api/src/jobs/jobs.module.ts | reviewed | none
apps/api/src/jobs/process-billing-charge-instant.test.ts | reviewed | none
apps/api/src/jobs/process-billing-charge.handler.ts | reviewed | none
apps/api/src/jobs/queue.service.ts | reviewed | none
apps/api/src/jobs/runner.ts | reviewed | E1-3

## Findings

### E1-1 MINOR: apps/api/src/health/ops.controller.ts:160 (GET /v1/ops/health alerts)

Scenario: the OWN-70 block-close pass keeps failing (or its lease is abandoned). `collectOpsSnapshot` (ops-alerts.ts) feeds `blockCloseFailed` / `blockCloseStalled` to `evaluateOpsAlerts`, so the webhook sink pages `billing.renewal_block_close_failing` / `_stalled`. The health route builds its own snapshot with `billing: { blockedRenewals }` only, so an operator polling `/v1/ops/health` sees no such alert, although the route's doc says its alerts are "judged the same way the alert pass judges it".
Fix: build the route's alert input from `collectOpsSnapshot(this.workerDb)` (or also read `blockCloseCursorStatus`), and add a test asserting the two agree.

### E1-2 MINOR (test weakened): apps/api/src/jobs/jobs-chat-roles-3.integration.test.ts:142

"refunds the original month once when a retry crosses the month boundary (G-57)". At the merge base the reservation was in 2026-09 and the retry ran in 2026-10, so the test showed the refund going back to September. Now (0222: the database picks the row by its own clock, and the fake timers move only the JS `Date`) both attempts meter the real current month (`spentRow = usagePeriod(new Date())`). That means the reservation month and the retry month are the same row. If a regression refunded to "the database's current month at refund time" instead of the reservation's recorded row, this test would still pass. It still shows the refund ignores the caller's `usagePeriod(receivedAt)` ('2026-09'), but the cross-month part is no longer exercised, and the name overstates it.
Fix: test the boundary at the database layer (for example, rewrite the recorded reservation row to the previous period as owner before the retry, then assert the refund lands there and the current row is untouched), or rename the test to what it now proves.

### E1-3 MINOR (development/test arrangement only): apps/api/src/jobs/runner.ts:158 (`runOnce` companion fall-through)

Scenario: a non-production worker with SETTLEMENT_DATABASE_URL and `workerConcurrency` = N. The companion settlement runner starts N lanes of its own (`startLanes`). On top of that, every one of the main runner's N lanes calls `companion.runOnce()` whenever its own queue is empty. That allows up to 2N concurrent settlement claims and handler transactions on a settlement pool sized `workerConcurrency + 1` (db.module.ts:162). Handlers hold one connection, and heartbeats and claims queue behind them. This is not a deadlock, but heartbeats can be delayed under a burst, and the concurrency differs from the production settlement process the arrangement is meant to stand in for.
Fix: don't fall through when the companion runs its own lanes (only fall through in `runOnce`-driven tests), or size the dev settlement pool to 2N+1.

### E1-4 MINOR: apps/api/src/jobs/initiate-blocked-renewal.handler.ts:67 (`gate_closed`)

Scenario: the close pass closes a block (gate open) and enqueues `billing.renewal_initiate`. Before the job runs, the gate closes again (key rotated, §47 confirmation removed). The job records `gate_closed` and completes. The block is already resolved and the job is a per-charge singleton, so nothing re-initiates the payment when the gate reopens. There is no log/ALERT line either (unlike `unavailable`). The merchant can still pay from the billing page once the gate is open, so no money is at risk. But the "fresh payment is started once the gate opens" promise (OD-44) silently fails to happen in this case.
Fix: emit an ALERT line on `gate_closed`, or defer/retry (JobDeferred) while the gate is closed, so OD-44 initiation happens when it reopens.

### E1-5 MINOR: apps/api/src/health/ops.controller.ts:663 (`POST /v1/ops/exceptions/:id/resolve`)

Scenario: `deadJobsRepo.openJobForEvent` is checked, and then `events.resolveExceptionAsOperator` runs in a separate transaction. A payment job for that event that dies (markFailed writes the dead-job record and flags the event) between the two calls leaves the event resolved while its dead-job record and merchant exception stay open. That is the inconsistency the guard exists to prevent. The window is milliseconds and needs an operator acting at the moment of death.
Fix: re-check for an open dead job inside the resolve transaction, after the event row's FOR UPDATE.
