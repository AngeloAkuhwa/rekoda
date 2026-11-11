-- OD-51 (owner instruction, 11 Nov 2026, PR #432 closeout): the billing-operator principal holds
-- exactly what an operator plan change needs, not every right of the application.
--
-- `rekoda_billing_operator` (0202) was a member of `rekoda_app` with INHERIT, so its credential
-- carried every ordinary application right: read and write any tenant row it pins. Its only use is
-- `POST /v1/businesses/plan` (`billingRepo.setPlan`): lock and read the business, run the operator
-- writer, and record the rest of the subscription state on the business row. A leak of that one
-- credential therefore exposed the whole estate. After this migration it can:
--
--   * read `businesses` (under the tenant pin, as every policy requires) and the plan catalogue's
--     `plan_versions` (the version a paid plan is pinned to);
--   * update only the subscription columns `writeSubscriptionState` records beside the writer;
--   * run `subscription_operator_set_plan` (unchanged: EXECUTE for this role alone).
--
-- It no longer inherits `rekoda_app`. The cycle and plan guards (0196, 0206, 0207) still apply to
-- it as before. `rekoda_settlement` keeps its membership: it is held by the worker process only
-- (0209), which already holds the application credential, and it reads and writes across the
-- billing, usage, event and audit tables a settlement touches; narrowing it to exact grants is
-- recorded as a known limitation in OD-51.
--
-- Rollback: none past 0196 (OWN-86); applied with the api and worker stopped. Re-running is safe.

REVOKE rekoda_app FROM rekoda_billing_operator;

GRANT USAGE ON SCHEMA public TO rekoda_billing_operator;
GRANT SELECT ON businesses, plan_versions TO rekoda_billing_operator;
GRANT UPDATE (plan_version_id, cycle_started_at, renewal_anchor_day, pending_plan,
              billing_interval, pending_billing_interval, subscription_origin, payment_failed_at,
              last_grace_reminder_day, ever_paid_at, plan_decided_at, plan_decided_before_pending,
              updated_at)
  ON businesses TO rekoda_billing_operator;
