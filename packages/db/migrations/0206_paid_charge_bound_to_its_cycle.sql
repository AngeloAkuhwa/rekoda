-- OD-37, security re-review of PR #432 at 5772e92, finding B3: settlement's stale-charge rule and
-- the inputs it prices from live in columns the general application credential can write.
--
--   * `decidedSince` compares `businesses.plan_decided_at` with the charge's creation time, and
--     `superseded_at` on a pending charge: `rekoda_app` writes both (the merchant's scheduled change
--     and its undo legitimately move them). With them reset, an upgrade priced for the rest of one
--     cycle and paid after a renewal was applied to the new cycle: a full cycle on the higher plan
--     for the price of a few days.
--   * `cycle_started_at`, `billing_interval`, `renewal_anchor_day`, `plan_version_id`,
--     `subscription_origin` and `ever_paid_at` are what the upgrade price, the renewal price, the
--     grandfathering pin and the retention exemption are computed from. `rekoda_app` could set them
--     directly (a cycle start of yesterday makes the upgrade nearly free).
--
-- After this migration:
--   1. The provider writer binds a plan charge to the cycle it was priced for, in the database,
--      whatever any writable column says: an UPGRADE applies only while the paid-to date is still
--      the frozen `period_end` it was opened for, and sets exactly that date; a RENEWAL applies only
--      while the paid-to date is still its frozen `period_start` and ends at most one interval after
--      it. A stale charge is refused (42501), so a stolen application credential can no longer turn
--      a cheap payment into a longer or different cycle. Settlement checks the same thing first and
--      sends the payment to the operator queue as before (`subscription_decided_after_charge`).
--   2. The cycle and pricing inputs above, and the grace clock (`payment_failed_at`: cleared, it
--      stops the grace sweep and keeps a paid plan running unpaid), change only as settlement, the
--      billing operator, the plan writer or the table owner; and a business inserted by any other
--      role starts with none of them set (the insert guard of 0203, extended): a pin to an older,
--      cheaper plan version written at INSERT would otherwise price every purchase and renewal. The test harness's fixture writer (never in a deployed database;
--      the pre-start smoke and the boot check refuse a database that has it) is the only other
--      exemption, so the integration suites can keep building cycles directly.
--
-- Left writable by the application, deliberately: `pending_plan`, `pending_billing_interval`,
-- `plan_decided_at` and `plan_decided_before_pending` (the merchant's own scheduled change and its
-- undo write them, and the undo moves the decision time backwards). With (1) in place, what a
-- stolen credential can do with them is make a charge for the CURRENT cycle apply after an operator
-- decision it should have yielded to (OD-51).
--
-- Rollback: none past 0196 (OWN-86). Compatibility-breaking: the previous release writes the cycle
-- columns on `rekoda_app`; applied with the api and worker stopped like 0202 to 0205. Re-running is
-- safe.

CREATE OR REPLACE FUNCTION public.subscription_apply_paid_charge(
  p_business uuid,
  p_reference text,
  p_expires timestamptz
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c record;
  current_end timestamptz;
  base timestamptz;
BEGIN
  IF p_business IS NULL OR p_reference IS NULL OR length(p_reference) < 1
     OR p_expires IS NULL THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT business_id, kind, plan, status, paid_at, applied_period_end, unapplied_at,
         period_start, period_end,
         coalesce(billing_interval, 'monthly') AS billing_interval
    INTO c
  FROM public.subscription_charges
  WHERE reference = p_reference;
  IF NOT FOUND OR c.business_id IS DISTINCT FROM p_business THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: no such charge for this business'
      USING ERRCODE = '42501';
  END IF;
  IF c.status IS DISTINCT FROM 'paid' OR c.paid_at IS NULL
     OR c.kind NOT IN ('first_purchase', 'renewal', 'upgrade')
     OR c.plan IS NULL OR c.plan NOT IN ('chat', 'integrate', 'complete')
     OR c.applied_period_end IS NOT NULL OR c.unapplied_at IS NOT NULL THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: the charge is not a paid, unapplied plan charge'
      USING ERRCODE = '42501';
  END IF;
  -- Row-locked: settlement already holds the business row, and the check and the write below must
  -- see the same paid-to date.
  SELECT plan_expires_at INTO current_end FROM public.businesses WHERE id = p_business FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: no such business' USING ERRCODE = '42501';
  END IF;
  -- B3: a renewal or an upgrade buys the cycle it was priced for, read from the charge's frozen
  -- period (0205), never from a column the application can write. Compared at millisecond
  -- precision, the precision the application stores dates at.
  IF c.kind = 'upgrade' THEN
    IF c.period_end IS NULL OR current_end IS NULL
       OR date_trunc('milliseconds', current_end) <> date_trunc('milliseconds', c.period_end)
       OR date_trunc('milliseconds', p_expires) <> date_trunc('milliseconds', c.period_end) THEN
      RAISE EXCEPTION 'subscription_apply_paid_charge: the upgrade was priced for another cycle'
        USING ERRCODE = '42501';
    END IF;
  ELSIF c.kind = 'renewal' THEN
    IF c.period_start IS NULL OR current_end IS NULL
       OR date_trunc('milliseconds', current_end) <> date_trunc('milliseconds', c.period_start) THEN
      RAISE EXCEPTION 'subscription_apply_paid_charge: the renewal was priced for another cycle'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  -- A renewal continues from the cycle it renews; an upgrade keeps the cycle it upgrades (bound
  -- above); a first purchase starts at payment: what is left of a trial does not carry into it.
  base := CASE WHEN c.kind = 'renewal' THEN greatest(c.paid_at, c.period_start)
               WHEN c.kind = 'upgrade' THEN greatest(c.paid_at, c.period_end)
               ELSE c.paid_at END;
  IF p_expires <= c.paid_at
     OR p_expires > rekoda_private.add_billing_interval(base, c.billing_interval) + interval '3 days' THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: the renewal date is outside the charge''s % period',
      c.billing_interval USING ERRCODE = '22023';
  END IF;
  UPDATE public.subscription_charges
  SET applied_period_start = coalesce(applied_period_start, clock_timestamp()),
      applied_period_end = p_expires
  WHERE reference = p_reference AND business_id = p_business AND status = 'paid'
    AND applied_period_end IS NULL AND unapplied_at IS NULL
    AND kind IN ('first_purchase', 'renewal', 'upgrade') AND plan IN ('chat', 'integrate', 'complete');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: the charge is not a paid, unapplied plan charge'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.businesses SET plan = c.plan, plan_expires_at = p_expires WHERE id = p_business;
  RETURN c.plan;
END $$;
-- CREATE OR REPLACE keeps the owner (rekoda_plan_writer) and the grants of 0202.

CREATE OR REPLACE FUNCTION rekoda_private.businesses_cycle_fields_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user IN ('rekoda_settlement', 'rekoda_billing_operator', 'rekoda_plan_writer')
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  -- The integration harness's fixture writer, installed by the table owner in test databases only.
  -- A deployed database never has it: the pre-start smoke and the api's boot check refuse one that
  -- does, and both refuse a runtime role that can create a function in `public`.
  IF to_regprocedure('public.test_fixture_set_plan(uuid, text, timestamptz)') IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a subscription''s cycle and pricing inputs change only through settlement or the billing operator (OD-37)'
    USING ERRCODE = '42501';
END $$;

REVOKE ALL ON FUNCTION rekoda_private.businesses_cycle_fields_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_cycle_fields_guard ON businesses;
CREATE TRIGGER businesses_cycle_fields_guard
  BEFORE UPDATE OF billing_interval, cycle_started_at, subscription_origin, renewal_anchor_day,
    plan_version_id, ever_paid_at, payment_failed_at ON businesses
  FOR EACH ROW
  WHEN (OLD.billing_interval IS DISTINCT FROM NEW.billing_interval
        OR OLD.cycle_started_at IS DISTINCT FROM NEW.cycle_started_at
        OR OLD.subscription_origin IS DISTINCT FROM NEW.subscription_origin
        OR OLD.renewal_anchor_day IS DISTINCT FROM NEW.renewal_anchor_day
        OR OLD.plan_version_id IS DISTINCT FROM NEW.plan_version_id
        OR OLD.ever_paid_at IS DISTINCT FROM NEW.ever_paid_at
        OR OLD.payment_failed_at IS DISTINCT FROM NEW.payment_failed_at)
  EXECUTE FUNCTION rekoda_private.businesses_cycle_fields_guard();

-- A business inserted by the application (signup) starts on its trial with no cycle, pin, origin,
-- paid history or grace clock: those are written later, only by the roles above. Replaces the 0203
-- function; the trigger of 0200 is unchanged.
CREATE OR REPLACE FUNCTION rekoda_private.businesses_plan_fields_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'rekoda_plan_writer' THEN
    RETURN NEW;
  END IF;
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.plan IS DISTINCT FROM 'trial' OR NEW.plan_expires_at IS NULL
     OR NEW.trial_started_at IS DISTINCT FROM now()
     OR NEW.plan_expires_at <= now()
     OR NEW.plan_expires_at > now() + interval '336 hours' THEN
    RAISE EXCEPTION
      'a new business starts on its 14-day trial; plan and plan_expires_at change only through the subscription writers (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.billing_interval IS DISTINCT FROM 'monthly'
     OR NEW.cycle_started_at IS NOT NULL OR NEW.subscription_origin IS NOT NULL
     OR NEW.renewal_anchor_day IS NOT NULL OR NEW.plan_version_id IS NOT NULL
     OR NEW.ever_paid_at IS NOT NULL OR NEW.payment_failed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'a new business starts with no cycle, plan version, origin, paid history or grace clock (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION rekoda_private.businesses_plan_fields_insert_guard() FROM PUBLIC;
