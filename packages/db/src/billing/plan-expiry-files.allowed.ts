/**
 * The reviewed list of files that may mention `businesses.plan_expires_at` (G-62, OD-37). Split out
 * of `plan-expiry-files.test.ts` so that file stays under the test-layout size limit; the test
 * re-exports it.
 */
import type { Entry } from './plan-expiry-files.checker.js';

export const ALLOWED: Readonly<Record<string, Entry>> = {
  'packages/db/src/repos/subscriptions.ts': {
    role: 'writer',
    why: 'writeSubscriptionState sets plan and expiry through the 0200 writer its authority names (subscription_apply_paid_charge for a paid charge, subscription_operator_set_plan for an operator, test_fixture_set_plan in test databases only) beside the rest of the cycle in one transaction (G-62); expireSubscription lapses through subscription_expire_plan; the same file reads the date for sweeps and renewals.',
  },
  'packages/db/migrations/0196_plan_fields_guard.sql': {
    role: 'migration',
    why: 'OD-37: the plan writer role, the first two SECURITY DEFINER writers (0200 replaces the general one) and the trigger that refuses any other change to plan or plan_expires_at.',
  },
  'packages/db/src/testing.ts': {
    role: 'writer',
    why: 'OD-37: setPlanAsOwner, which writes AS THE TABLE OWNER (the migration and repair exemption the 0196 trigger allows), and test_fixture_set_plan, a writer the test harness installs in test databases only (never a migration) for applyFixtureCycle. @rekoda/db/testing is never imported by production code.',
  },
  'packages/db/migrations/0197_staging_test_business_tools.sql': {
    role: 'migration',
    why: "OWN-77: staging_move_date, owned by rekoda_plan_writer, moves a designated staging test business's date (marker, designation, compare-before, 90-day bounds, audited).",
  },
  'packages/db/src/repos/staging-tools.ts': {
    role: 'caller',
    why: 'OWN-77: reads the date for the compare-before and calls staging_move_date; holds no UPDATE of its own.',
  },
  'packages/db/src/billing/plan-expiry-files.allowed.ts': {
    role: 'definition',
    why: "this guard's reviewed list, which names the column in each reason.",
  },
  'packages/db/src/billing/plan-expiry-files.checker.ts': {
    role: 'definition',
    why: "this guard's own patterns and checks, which name the column to find it.",
  },
  'apps/api/src/health/ops-idor-harness.ts': {
    role: 'reader',
    why: 'object-level authorisation tests (PR B): snapshots plan and plan_expires_at with a SELECT before and after a refused request to prove nothing changed. Used only by the object-authorisation integration tests; it holds no UPDATE.',
  },
  'packages/db/src/repos/dead-jobs.ts': {
    role: 'reader',
    why: 'OWN-76: the operator queue reads the plan and paid-to date of a business whose billing job died.',
  },
  'packages/contracts/src/billing-api.ts': {
    role: 'reader',
    why: 'wire shapes that carry the paid-to date to the billing page and the operator queue.',
  },
  'packages/db/src/repos/identity.ts': {
    role: 'writer',
    why: 'createBusinessWithOwner inserts the new business with its 14-day trial expiry; the trial clock starts exactly once, here.',
  },
  'packages/db/src/repos/billing.ts': {
    role: 'caller',
    why: 'setPlan (operator plan change) reads the date and passes it in the state object to writeSubscriptionState; it holds no UPDATE of its own (fixed in #281).',
  },
  'packages/db/src/repos/retention.ts': {
    role: 'reader',
    why: 'selects lapsed businesses by the date for the retention sweep; its one UPDATE on businesses sets retention_notified_at, not the expiry.',
    writesOtherColumns: true,
  },
  'packages/db/src/repos/usage.ts': {
    role: 'reader',
    why: 'reads plan and date to decide whether a trial is still running.',
  },
  'packages/db/src/schema/tenancy.ts': {
    role: 'definition',
    why: 'the Drizzle column definition.',
  },
  'packages/core/src/billing.ts': {
    role: 'reader',
    why: 'pure rules over a cycle value (no IO): decides whether a cycle is a standard monthly one.',
  },
  'apps/api/src/billing/billing.service.ts': {
    role: 'reader',
    why: 'derives renewal and trial state from the stored date; every write goes through the repo.',
  },
  'apps/api/src/billing/billing-checkout.service.ts': {
    role: 'reader',
    why: 'checks whether the cycle has ended before offering checkout.',
  },
  'apps/api/src/health/ops.controller.ts': {
    role: 'reader',
    why: 'shows the renewal date in the operator subscription view.',
  },
  'packages/db/migrations/0000_init.sql': {
    role: 'migration',
    why: 'creates the column (applied; immutable).',
  },
  'packages/db/migrations/0017_trial_expiry.sql': {
    role: 'migration',
    why: 'one-off backfill of the trial expiry for existing rows, plus the index (applied; immutable).',
  },
  'packages/db/migrations/0020_subscriptions.sql': {
    role: 'migration',
    why: 'subscription columns and constraints (applied; immutable).',
  },
  'packages/db/migrations/0022_retention.sql': {
    role: 'migration',
    why: 'retention sweep function reads the date (applied; immutable).',
  },
  'packages/db/migrations/0109_security_hardening.sql': {
    role: 'migration',
    why: 'function definition reads the date (applied; immutable).',
  },
  'packages/db/migrations/0118_tenant_scoped_retention_users.sql': {
    role: 'migration',
    why: 'retention function reads the date (applied; immutable).',
  },
  'packages/db/migrations/0122_pending_object_deletions.sql': {
    role: 'migration',
    why: 'retention function reads the date (applied; immutable).',
  },
  'packages/db/migrations/0160_ever_paid.sql': {
    role: 'migration',
    why: 'ever-paid backfill reads the date (applied; immutable).',
  },
  'packages/db/migrations/0161_retention_lock_business.sql': {
    role: 'migration',
    why: 'retention function reads the date (applied; immutable).',
  },
  'packages/db/migrations/0194_dead_job_exceptions.sql': {
    role: 'migration',
    why: 'OD-47: dead_job_ops_queue reads the paid-to date of a business whose billing job died; read-only, worker-only function.',
  },
  'packages/db/migrations/0195_renewal_blocked.sql': {
    role: 'migration',
    why: 'OD-47: blocked_renewals_ops reads the paid-to date beside a blocked renewal; read-only, worker-only function.',
  },
  'packages/db/migrations/0198_blocked_renewal_close_order.sql': {
    role: 'migration',
    why: 'OD-47: replaces blocked_renewals_ops (0195) with an optional close-order argument; it still only reads the paid-to date beside a blocked renewal, in a read-only, worker-only function. It writes no plan field.',
  },
  'packages/db/migrations/0199_blocked_renewal_close_cursor.sql': {
    role: 'migration',
    why: 'OWN-70/OWN-87: blocked_renewals_close_batch reads the paid-to date beside a blocked renewal for the durable close cursor; read-only, worker-only function. It writes no plan field.',
  },
  'packages/db/migrations/0200_plan_writer_boundary.sql': {
    role: 'migration',
    why: 'OD-37/OWN-87: replaces the general subscription_write_plan with subscription_apply_paid_charge (plan from a paid, unapplied charge) and subscription_operator_set_plan (validated operator input), revalidates subscription_expire_plan, and guards the INSERT; all owned by rekoda_plan_writer.',
  },
  'packages/db/migrations/0203_plan_duration_rules.sql': {
    role: 'migration',
    why: 'OWN-89: re-creates subscription_operator_set_plan (with the interval and Rekoda durations), subscription_apply_paid_charge (one billing interval) and subscription_expire_plan (clamps a future end), all owned by rekoda_plan_writer, and the exact 14-day insert guard.',
  },
  'packages/db/migrations/0206_paid_charge_bound_to_its_cycle.sql': {
    role: 'migration',
    why: 'OD-37 B3: re-creates subscription_apply_paid_charge (owned by rekoda_plan_writer) so an upgrade or a renewal applies only to the cycle its charge was priced for, and guards the cycle and pricing inputs on businesses.',
  },
  'packages/db/src/billing/plan-writer.fixtures.ts': {
    role: 'reader',
    why: 'OD-37 boundary suites: reads plan and plan_expires_at back as the owner to assert what the writers did; writes neither.',
  },
  'packages/db/migrations/0181_sweep_trial_candidates.sql': {
    role: 'migration',
    why: 'trial-notice candidate function reads the date (applied; immutable).',
  },
};
