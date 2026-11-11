-- G-127 (OWN-90 §5.2, 11 Nov 2026): `rekoda_settlement` and `rekoda_billing_operator` stop
-- inheriting `rekoda_app` (0202 granted it with INHERIT TRUE) and hold EXACTLY what their
-- transactions touch. A stolen settlement or operator credential is then no longer also a general
-- application credential: neither can read or write a tenant's sales, invoices, customers, stock,
-- ledger, documents, messages or vault rows, open conversations, or send anything.
--
-- What each principal does, and so holds (every write still under the tenant pin and RLS, and still
-- through the guards and writers of 0196 to 0210):
--
--   rekoda_settlement  (billing.process; the owner's plan change and pack purchase; the renewal
--                      sweep's charge opening)
--     reads    the business's subscription row, its charges and their attempts, its meters, add-on
--              holdings and entitlements, the price catalogue, its audit rows, its billing job and
--              the provider event the job names
--     writes   the subscription cycle columns of `businesses`; its charges (open, settle, retire);
--              charge attempts; audit rows; its own job's completion; add-on holdings (0202);
--              pack credit (usage_credit_bonus, 0209); the provider writer (0202)
--   rekoda_billing_operator  (POST /v1/businesses/plan; POST /v1/ops/refund)
--     reads    the business's subscription row, its charges, its audit rows, the price catalogue
--     writes   the subscription cycle columns of `businesses`; the operator writer, the refund
--              writer and the refusal log (0203, 0207, 0209)
--
-- Neither may: SET ROLE to anything (no memberships at all), create in `public`, bypass RLS, or act
-- as a table owner. The privilege-matrix test (packages/db/src/billing/principal-grants.integration
-- .test.ts) pins the exact table and column grants, so any later widening is a reviewed change.
--
-- Rollback: `GRANT rekoda_app TO rekoda_settlement, rekoda_billing_operator WITH INHERIT TRUE, SET
-- FALSE` restores 0202's shape. Compatibility-breaking for nothing that runs on these principals
-- today (every path was exercised by the integration suites); applied with the api and worker
-- stopped like 0202 to 0210. Re-running is safe.

DO $$
BEGIN
  IF pg_has_role('rekoda_settlement', 'rekoda_app', 'MEMBER') THEN
    REVOKE rekoda_app FROM rekoda_settlement;
  END IF;
  IF pg_has_role('rekoda_billing_operator', 'rekoda_app', 'MEMBER') THEN
    REVOKE rekoda_app FROM rekoda_billing_operator;
  END IF;
  -- A membership granted by another grantor (made by hand) survives REVOKE by this role: refuse.
  IF pg_has_role('rekoda_settlement', 'rekoda_app', 'MEMBER')
     OR pg_has_role('rekoda_billing_operator', 'rekoda_app', 'MEMBER') THEN
    RAISE EXCEPTION 'migration 0211: a principal still holds rekoda_app; revoke it by its grantor first'
      USING ERRCODE = '42501';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO rekoda_settlement, rekoda_billing_operator;

-- The price catalogue: read only, for both.
GRANT SELECT ON plan_versions, plan_prices, plan_version_entitlements, allowance_versions,
  usage_packs, add_ons, add_on_grants, entitlements TO rekoda_settlement, rekoda_billing_operator;

-- Settlement.
GRANT SELECT ON businesses, subscription_charges, subscription_charge_attempts, usage_counters,
  business_add_ons, business_entitlements, audit_events, jobs, external_events
  TO rekoda_settlement;
GRANT UPDATE (billing_interval, cycle_started_at, subscription_origin, renewal_anchor_day,
  plan_version_id, ever_paid_at, payment_failed_at, last_grace_reminder_day, pending_plan,
  pending_billing_interval, plan_decided_at, plan_decided_before_pending, updated_at)
  ON businesses TO rekoda_settlement;
-- Charges are settlement's table (0205): every column it moves is guarded by role in 0202/0205/0209.
GRANT UPDATE ON subscription_charges TO rekoda_settlement;
GRANT INSERT, UPDATE ON subscription_charge_attempts TO rekoda_settlement;
GRANT INSERT ON audit_events TO rekoda_settlement;
-- The provider event its billing job processes: marked processed, with the outcome (events.markProcessed).
GRANT UPDATE (processed_at, error) ON external_events TO rekoda_settlement;
-- A recovered billing job closes its dead-job record in the same transaction (deadJobs.noteJobDone).
GRANT SELECT, UPDATE (status, closed_at, closed_by, resolution, updated_at) ON dead_job_exceptions
  TO rekoda_settlement;
-- Its own billing job's completion (the runner marks the job done in the handler's transaction).
GRANT UPDATE (state, locked_at, locked_by, updated_at) ON jobs TO rekoda_settlement;

-- The renewal sweep applies a scheduled cancellation on settlement (it decides under the same lock
-- that would open the renewal): the expiry writer, already the application's and the worker's.
GRANT EXECUTE ON FUNCTION public.subscription_expire_plan(uuid, text, text) TO rekoda_settlement;

-- The billing operator.
GRANT SELECT ON businesses, subscription_charges, audit_events TO rekoda_billing_operator;
GRANT UPDATE (billing_interval, cycle_started_at, subscription_origin, renewal_anchor_day,
  plan_version_id, ever_paid_at, payment_failed_at, last_grace_reminder_day, pending_plan,
  pending_billing_interval, plan_decided_at, plan_decided_before_pending, updated_at)
  ON businesses TO rekoda_billing_operator;
