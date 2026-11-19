# Manifest B: migrations 0221-0245 (PR #432, head 198d37a, read-only review)

packages/db/migrations/0221_operator_writes_only_through_its_functions.sql | reviewed | none
packages/db/migrations/0222_usage_entitlement_in_the_database.sql | reviewed | B-2
packages/db/migrations/0223_settlement_scope_and_dead_job_requeue.sql | reviewed | none
packages/db/migrations/0224_pack_credit_derives_from_the_charge.sql | reviewed | none
packages/db/migrations/0225_dead_job_enrolment_discovery.sql | reviewed | none
packages/db/migrations/0226_settlement_holds_no_add_on.sql | reviewed | B-2
packages/db/migrations/0227_paid_launch_gate.sql | reviewed | none
packages/db/migrations/0228_worker_reads_no_payload_across_tenants.sql | reviewed | none
packages/db/migrations/0229_dead_job_enrolment_dead_letter.sql | reviewed | none
packages/db/migrations/0230_refund_through_the_operator.sql | reviewed | B-1
packages/db/migrations/0231_settlement_reads_only_its_kinds_payload.sql | reviewed | none
packages/db/migrations/0232_support_review_prices_like_the_resolver.sql | reviewed | none
packages/db/migrations/0233_operator_actor_contract.sql | reviewed | none
packages/db/migrations/0234_job_payload_live_or_dying_only.sql | reviewed | none
packages/db/migrations/0235_refund_records_and_pack_eligibility.sql | reviewed | B-1
packages/db/migrations/0236_dead_job_enrolment_cursor.sql | reviewed | none
packages/db/migrations/0237_settlement_reads_key_fingerprints.sql | reviewed | none
packages/db/migrations/0238_worker_job_transitions.sql | reviewed | none (name check superseded by 0241)
packages/db/migrations/0239_operator_actor_columns.sql | reviewed | none
packages/db/migrations/0240_pack_refund_allowance_history.sql | reviewed | B-1
packages/db/migrations/0241_final_review_guards.sql | reviewed | none
packages/db/migrations/0242_settlement_job_transitions.sql | reviewed | B-3
packages/db/migrations/0243_refund_judges_the_allowance_after_the_counter_lock.sql | reviewed | B-1
packages/db/migrations/0244_refund_refuses_across_a_time_boundary.sql | reviewed | B-1
packages/db/migrations/0245_usage_binds_only_to_the_events_own_job.sql | reviewed | none

## Findings

### B-1 IMPORTANT: a pack credited before 0193 is refunded as "never credited": no revocation, no seven-day or unused rule, partial refunds allowed

- Where: 0244_refund_refuses_across_a_time_boundary.sql:157 (the live definition; the same gate at
  0230:399, and in 0235, 0240 and 0243). The pack rules run only under
  `IF c.kind = 'add_on' AND c.units_credited_at IS NOT NULL`.
- Why: `units_credited_at` was added in 0193 (`0193_charge_provider_times.sql:33`) with no backfill
  (grep: no migration sets it outside `usage_credit_pack`). Main (0192) credits packs by writing
  `usage_counters.bonus` directly (`git show 58e6834:packages/db/src/repos/usage.ts`, around line 194). So on any
  database upgraded from 0192, every pack that was paid and credited before the upgrade has
  `units_credited_at IS NULL`. The upgrade test seeds exactly that row (`RKD-ADD-20261105-MAINCR`,
  paid, with bonus 100, in `packages/db/src/ops/upgrade-from-main.integration.test.ts:137`). No test
  refunds it.
- Failure scenario: after the upgrade, an operator calls
  `subscription_record_refund(biz, 'RKD-ADD-20261105-MAINCR', 250000, 'unused_add_on', 'operator:x', 'rf_1')`.
  The charge is `paid` and `refunded + amount <= amount_k`, so the call takes the uncredited branch.
  It records `refunded` with `revoked_units = 0`. The 100 bonus units stay on the meter even though
  the money is back with the merchant. No seven-day window, no "unused" test and no owner referral
  (OD-55) apply. A partial refund of the same pack (for example 100,000) is also accepted, which the
  owner ruling recorded in 0230's header ("Partial refunds of a used pack are NOT approved") forbids.
  This contradicts 0230's own header ("A pack credited before 0230 has no recorded credit and is
  refused with a message to settle it by hand") and the PR README §3 OD-55 entry ("packs credited
  before 0230" are undecidable and owner-supervised).
- Reachability: it needs a database upgraded from 0192 that holds main-era pack purchases (staging,
  or any production that sold packs) plus an operator refund. The operator process is the intended
  caller.
- Suggested fix: in `subscription_record_refund`, also refuse with 22023 and the OD-55 wording
  ("settle it by hand") when `kind = 'add_on' AND pack_id IS NOT NULL AND units_credited_at IS NULL
AND unapplied_at IS NULL`. After 0193, a paid pack is either credited in the settlement transaction
  or set aside with `unapplied_at` (`applySettledCharge`). The only other case, an unresolvable pack,
  is rare and also belongs with the owner. Add a regression test that refunds the MAINCR row after
  the upgrade.

### B-2 MINOR (latent): settlement can re-pin `businesses.plan_version_id`, which `usage_entitlement` trusts as the sold version

- Where: 0222_usage_entitlement_in_the_database.sql:121-132 (the pinned version is used when it is a
  version of the plan). The grant that makes this possible is outside this batch: 0217:144 gives
  settlement UPDATE on `plan_version_id`, and the 0206 cycle guard allows it. 0226's rationale covers
  the same class.
- Scenario: once the owner publishes a second version of a plan with a larger allowance (or keeps a
  grandfathered larger one), a holder of the settlement credential can `UPDATE businesses SET
plan_version_id = <that version>` under any pin. This raises the metered ceiling with no paid
  charge behind it, which is the hole 0226 closed for add-on holdings. Not reachable today: 0105
  seeds one version per plan. 0222's header claim that the ceiling comes from "state no runtime role
  can write" is overstated.
- Fix: in the cycle guard, allow settlement to set `plan_version_id` only to the version the
  settled charge's own cycle resolves. Alternatively, record this residual in OD-51 alongside 0226.

### B-3 MINOR: 0242 still lets settlement keep a job from ever dying

- Where: 0242_settlement_job_transitions.sql:47-48 (`running -> pending` with
  `attempts IN (OLD.attempts, OLD.attempts - 1)`).
- Scenario: settlement can repeat claim (+1) and deferral (-1) indefinitely, with run_at at most 10
  minutes ahead. The job never reaches max_attempts, so no dead-job record is written. The header
  says this harm ("the job would then never die") is closed. Impact is small, because the same
  credential can already move `running -> done` without settling.
- Fix: correct the header to say what the guard bounds. Optionally require that a deferral leaves
  `locked_*` cleared and that run_at moves forward.

Checked with no finding: SECURITY DEFINER owners, pinned search_path and REVOKE FROM PUBLIC on every
function created in 0221-0245. Grants on the new tables (refunds, pack_credit_entitlements,
business_allowance_changes, dead_job_enrolment_failures), which are all FORCE RLS with the tenant
policy and revoke from app, worker, settlement and operator. The worker column grant (0228) with no
UPDATE on `kind`, so a dead job cannot be relabelled to make job_payload return it. The worker,
application and settlement transition guards are privilege-based, not name-based, after 0241 and 0242. The lock order for refund vs credit vs reserve (charge, then counter; no cycle). Refund
idempotency and the cross-tenant unique conflict (0235). 0239 actor patterns against every
`system:` writer in code (all lower-case). PostgreSQL 16 for `pg_input_is_valid` (0245, compose and
CI). The 0235 FK target `subscription_charges (business_id, id)` exists (0173).
