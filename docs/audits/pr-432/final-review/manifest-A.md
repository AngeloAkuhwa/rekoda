# Manifest A: migrations 0193-0220, migration meta, subscriptions schema (PR #432, head 198d37a, base 58e6834)

packages/db/migrations/0193_charge_provider_times.sql | reviewed | none
packages/db/migrations/0194_dead_job_exceptions.sql | reviewed | none
packages/db/migrations/0195_renewal_blocked.sql | reviewed | none
packages/db/migrations/0196_plan_fields_guard.sql | reviewed | A-M1
packages/db/migrations/0197_staging_test_business_tools.sql | reviewed | none
packages/db/migrations/0198_blocked_renewal_close_order.sql | reviewed | none
packages/db/migrations/0199_blocked_renewal_close_cursor.sql | reviewed | none
packages/db/migrations/0200_plan_writer_boundary.sql | reviewed | A-M1
packages/db/migrations/0201_blocked_renewal_close_heartbeat.sql | reviewed | none
packages/db/migrations/0202_settlement_and_operator_principals.sql | reviewed | none (gaps superseded by 0205/0209/0217)
packages/db/migrations/0203_plan_duration_rules.sql | reviewed | A-M1
packages/db/migrations/0204_external_events_worker_least_privilege.sql | reviewed | none
packages/db/migrations/0205_charge_terms_belong_to_settlement.sql | reviewed | none
packages/db/migrations/0206_paid_charge_bound_to_its_cycle.sql | reviewed | none
packages/db/migrations/0207_operator_standard_periods.sql | reviewed | none
packages/db/migrations/0208_subscription_period_preflight.sql | reviewed | none
packages/db/migrations/0209_settlement_verifies_the_price.sql | reviewed | none
packages/db/migrations/0210_worker_least_privilege.sql | reviewed | A-I1
packages/db/migrations/0211_operator_principal_least_privilege.sql | reviewed | none (operator direct cycle-column grants superseded by 0221)
packages/db/migrations/0212_closeout_review_fixes.sql | reviewed | none
packages/db/migrations/0213_support_review_plan_change.sql | reviewed | none (pricing superseded by 0232)
packages/db/migrations/0214_pack_purchase_identity.sql | reviewed | none
packages/db/migrations/0215_pricing_source_authority.sql | reviewed | none
packages/db/migrations/0216_usage_meter_boundary.sql | reviewed | A-M3 (unbound pack quantity superseded by 0224)
packages/db/migrations/0217_settlement_isolation.sql | reviewed | none
packages/db/migrations/0218_usage_reservation_closure.sql | reviewed | none (bind-to-any-event superseded by 0245)
packages/db/migrations/0219_support_review_respects_later_schedule.sql | reviewed | none
packages/db/migrations/0220_job_row_and_grace_review_fixes.sql | reviewed | none (inheriting-role gap in app job guard superseded by 0227)
packages/db/migrations/meta/_journal.json | reviewed | none (246 entries, idx contiguous 0..245, tags match files, `when` monotonic)
packages/db/src/schema/subscriptions.ts | reviewed | A-M2

## Findings

### A-I1 IMPORTANT: the 0210 retention-notice guard refuses the retention sweep's own claim after the sweep's first minute

- Where: packages/db/migrations/0210_worker_least_privilege.sql:161-182 (`businesses_retention_notice_guard`: `NEW.retention_notified_at >= clock_timestamp() - interval '1 minute'`), and its caller apps/api/src/privacy/retention-sweep.ts:73-79 and :137-139 (`sweepRetention(deps, now = new Date())`; the warn loop sends every candidate's WhatsApp notice, then calls `retentionRepo.claimRetentionNotice(tx, businessId, now)` with the SWEEP'S START TIME). packages/db/src/repos/retention.ts:146-158 writes that value verbatim.
- Failure scenario: a six-hourly retention pass has enough due candidates (or one slow Meta send) that more than 60 s pass between sweep start and a claim. The notice has already been sent to the merchant and its UTILITY cost recorded; the claim UPDATE then raises 42501 ("never backdated"). The claim is outside the send's try/catch, so the exception aborts `warn()`, `sweepRetention` throws, `runRetentionPass` logs "retention sweep failed", and `erase()` does not run in that pass. The merchant whose claim failed is not recorded as warned, so the next pass (6 h later) sends the deletion warning again (and again each pass while it stays beyond the first minute's worth of candidates); deletions due under the 90/30-day policy are starved until the warn backlog drains a minute at a time. An app-host clock running more than 60 s behind the database clock breaks every claim. The renewal sweep was fixed for the same pattern (renewal-sweep.ts:150 takes a fresh `pricedAt`), the retention sweep was not. Tests miss it: retention-sweep.integration.test.ts always passes `new Date()` with an instant fake sender, and retention.integration.test.ts switches to the owner connection for old times.
- Suggested fix: stamp the notice with the database clock in `claimRetentionNotice` (`SET retention_notified_at = clock_timestamp()`; the sweep's `now` stays the eligibility cutoff), or pass `new Date()` per claim; add a regression test that runs the warn stage with a `now` more than 60 s old (or a sender that delays) and asserts the claim succeeds and erase still runs.

### A-M1 MINOR: `subscription_expire_plan` does not check the lapse condition it is described as guarding

- Where: 0196:85-110, 0200:239-266, 0203:228-256 (current definition; not redefined later in the PR).
- Failure scenario: with the application or worker credential, for a pinned business: `reason='grace'` succeeds on day 1 of grace (only `payment_failed_at IS NOT NULL` is checked, not that the 7-day grace elapsed); `reason='cancelled'` succeeds after writing `pending_plan='expired'` (an application-writable column) on a plan mid-cycle, and since 0203 the future paid-through date is clamped to now, so the paid days are erased. No gain for the caller, but a paid entitlement is ended early outside the honest sweep. This is a stolen-credential integrity gap, not reachable through honest code.
- Suggested fix: require `plan_expires_at <= clock_timestamp()` for `cancelled`, and `payment_failed_at <= clock_timestamp() - interval '7 days'` (the core grace length) for `grace`, or record it as a stated limit in OD-37/OD-51.

### A-M2 MINOR: Drizzle schema left out most of the columns this batch adds

- Where: packages/db/src/schema/subscriptions.ts:77-82 adds the three 0193 columns only; `blocked_*` (0195), `blocked_close_failed_at` (0198), `priced_at` (0209), `purchase_id` (0214) and `pricing_source` (0215) are missing (the older drift, for example `applied_period_*`, was already there before the PR). The repositories use raw SQL, so nothing breaks today, but a typed Drizzle select or insert of `subscriptionCharges` does not see these guarded columns.
- Suggested fix: add the columns to the table definition, or state in the file that the table is partial and raw SQL is required.

### A-M3 MINOR: the 0216 backfill gives a reservation to every historical message, not only in-flight ones

- Where: 0216:441-472. `reserved_units` is never cleared when an attempt succeeds (events.ts:139-145), so the loop inserts one `usage_reservations` row per unit for every event ever recorded, all in the migration transaction, with `created_at = now()` (so they are not trimmed for 90 days). 0218 closes them in the same release, so this is a cost, not a hole: the migration's run time and the downtime it needs grow with message history.
- Suggested fix: restrict the backfill to events whose job is still pending, running or dead (the set 0218 leaves open), or record the expected run time in the deploy runbook.
