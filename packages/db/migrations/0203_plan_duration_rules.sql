-- Owner review of PR #432 (11 Nov 2026), item 3: the plan writers enforce Rekoda's ACTUAL
-- subscription durations, replacing the sanity windows of 0200 (a 10-year paid ceiling, a 15-day
-- trial insert, open-ended paid plans and trials of any length).
--
--   monthly plan   ends no later than one calendar month after it starts
--   annual plan    ends no later than twelve calendar months after it starts (OWN-40: annual is
--                  twelve months of service)
--   trial          ends no later than 14 days after the business's trial started (OWN-27); a
--                  second trial cannot be granted by moving the date
--   expired        carries an end at or before now, never a future date
--
-- One source of truth for the lengths. The application computes every date with
-- `@rekoda/core` (`addInterval`: Lagos wall-clock calendar months, the month's last day when it is
-- shorter; `TRIAL_DAYS = 14`). The database cannot import that code, so it holds the SAME rule as
-- two small functions below, used only to REFUSE a date beyond it; the parity test
-- (packages/db/src/billing/plan-duration-rules.integration.test.ts) pins them to the core
-- functions on month ends, leap days and year ends, so the two cannot drift silently. Core drops
-- seconds when it adds a month; these keep them, so a core date is never later than the bound.
--
-- What changes for callers (each one checked, see docs/plans/PR-B-plan.md, "Plan durations"):
--   * POST /v1/businesses/plan (the only operator path) now names the interval of a paid plan
--     (`billingInterval`, monthly by default); with no `expiresAt` the API fills in exactly one
--     period (paid), the business's own trial end (trial) or now (expired). An operator can no
--     longer create an open-ended paid plan, a paid plan longer than its interval, a trial past
--     the 14 days, or an `expired` plan with a future date: all are refused with 400.
--   * Signup computes the trial end on the database clock (`now() + 14 days`, the same instant as
--     `trial_started_at`), so the insert guard is exact rather than 15 days.
--   * The provider writer's window becomes one billing interval of the charge (plus the at most
--     three days a month-end renewal anchor restores, e.g. 28 Feb to 31 Mar) after the payment, or,
--     for a renewal or an upgrade, after the current paid-to date when that is later; the date must
--     be after the payment.
--   * `subscription_expire_plan` clamps the end to now when a plan lapses early, so an expired
--     plan never keeps a future end.
--
-- Existing rows are NOT rewritten. A business already on an open-ended paid plan, a long trial or
-- an expired plan with a future end keeps it until an operator or a renewal moves it; the next
-- write must satisfy the rules. The read-only query that lists them is in docs/runbooks/deploy.md.
--
-- Rollback: none past 0196 (OWN-86); applied with the api and worker stopped. Re-running is safe.

CREATE OR REPLACE FUNCTION rekoda_private.trial_length()
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT interval '14 days' $$;

-- `from` plus one billing interval in Lagos wall-clock calendar months, the target month's last
-- day when it is shorter (`@rekoda/core` addInterval with no anchor day). Unknown interval: NULL,
-- which every caller treats as a refusal.
CREATE OR REPLACE FUNCTION rekoda_private.add_billing_interval(p_from timestamptz, p_interval text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ((p_from AT TIME ZONE 'Africa/Lagos')
          + CASE p_interval WHEN 'monthly' THEN interval '1 month'
                            WHEN 'annual' THEN interval '12 months' END)
         AT TIME ZONE 'Africa/Lagos'
$$;

REVOKE ALL ON FUNCTION rekoda_private.trial_length() FROM PUBLIC;
REVOKE ALL ON FUNCTION rekoda_private.add_billing_interval(timestamptz, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA rekoda_private TO rekoda_plan_writer;
GRANT EXECUTE ON FUNCTION rekoda_private.trial_length() TO rekoda_plan_writer;
GRANT EXECUTE ON FUNCTION rekoda_private.add_billing_interval(timestamptz, text) TO rekoda_plan_writer;

-- ---------------------------------------------------------------------------------------------
-- The operator writer: plan, interval, end and actor, all validated; it writes its own audit row.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.subscription_operator_set_plan(uuid, text, timestamptz, text);

CREATE OR REPLACE FUNCTION public.subscription_operator_set_plan(
  p_business uuid,
  p_plan text,
  p_expires timestamptz,
  p_interval text,
  p_actor text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  prev record;
  paid boolean;
BEGIN
  IF p_business IS NULL OR p_plan IS NULL OR p_expires IS NULL
     OR p_plan NOT IN ('trial', 'expired', 'chat', 'integrate', 'complete')
     OR p_actor IS NULL OR p_actor !~ '^operator:[!-~]{1,255}$' THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: invalid input' USING ERRCODE = '22023';
  END IF;
  paid := p_plan IN ('chat', 'integrate', 'complete');
  IF paid IS DISTINCT FROM (p_interval IS NOT NULL)
     OR (p_interval IS NOT NULL AND p_interval NOT IN ('monthly', 'annual')) THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: a paid plan names its interval; trial and expired do not'
      USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT plan, plan_expires_at, pending_plan, payment_failed_at, trial_started_at INTO prev
  FROM public.businesses WHERE id = p_business FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: no such business' USING ERRCODE = '42501';
  END IF;
  IF paid AND (p_expires <= clock_timestamp()
               OR p_expires > rekoda_private.add_billing_interval(clock_timestamp(), p_interval)) THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: a % plan ends in the future and within one % period',
      p_plan, p_interval USING ERRCODE = '22023';
  END IF;
  IF p_plan = 'trial' AND p_expires > prev.trial_started_at + rekoda_private.trial_length() THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: a trial ends within 14 days of the business''s trial start'
      USING ERRCODE = '22023';
  END IF;
  IF p_plan = 'expired' AND p_expires > clock_timestamp() THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: an expired plan cannot end in the future'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.businesses SET plan = p_plan, plan_expires_at = p_expires WHERE id = p_business;
  INSERT INTO public.audit_events
    (business_id, actor, entity, entity_id, action, old_value, new_value, source_type)
  VALUES (
    p_business, p_actor, 'business', p_business::text, 'plan_changed',
    jsonb_build_object(
      'plan', prev.plan,
      'expiresAt', to_char(prev.plan_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'pendingPlan', prev.pending_plan,
      'paymentFailedAt',
        to_char(prev.payment_failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    jsonb_build_object(
      'plan', p_plan,
      'expiresAt', to_char(p_expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'billingInterval', p_interval),
    'operator');
END $$;

ALTER FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text, text)
  OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text, text)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text, text)
  TO rekoda_billing_operator;

-- ---------------------------------------------------------------------------------------------
-- The provider writer: unchanged in what it may apply (one paid, unapplied plan charge of the
-- pinned business, claimed in the same statement); the end it may set is now one billing
-- interval of that charge.
-- ---------------------------------------------------------------------------------------------
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
  SELECT plan_expires_at INTO current_end FROM public.businesses WHERE id = p_business;
  -- A renewal continues the cycle it renews and an upgrade keeps the cycle it upgrades, so either may
  -- end one interval after the current paid-to date when that is later than the payment. A first
  -- purchase starts at payment: what is left of a trial does not carry into the paid cycle.
  base := CASE WHEN c.kind IN ('renewal', 'upgrade')
               THEN greatest(c.paid_at, coalesce(current_end, c.paid_at))
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: no such business' USING ERRCODE = '42501';
  END IF;
  RETURN c.plan;
END $$;
-- CREATE OR REPLACE keeps the owner (rekoda_plan_writer) and the grants of 0202.

-- ---------------------------------------------------------------------------------------------
-- A lapse never leaves a future end behind.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subscription_expire_plan(
  p_business uuid,
  p_previous text,
  p_reason text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_business IS NULL OR p_previous IS NULL OR p_reason IS NULL
     OR p_previous NOT IN ('trial', 'expired', 'chat', 'integrate', 'complete') THEN
    RAISE EXCEPTION 'subscription_expire_plan: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_expire_plan: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  IF p_reason NOT IN ('grace', 'cancelled') OR p_previous IN ('trial', 'expired') THEN
    RETURN false;
  END IF;
  UPDATE public.businesses
  SET plan = 'expired', pending_plan = NULL, plan_decided_at = clock_timestamp(), updated_at = now(),
      -- The paid-to date stays as history when it has passed (the usual case: a lapse follows the
      -- end of the cycle or of grace); a future one is brought back to now.
      plan_expires_at = least(coalesce(plan_expires_at, clock_timestamp()), clock_timestamp())
  WHERE id = p_business AND plan = p_previous
    AND CASE WHEN p_reason = 'grace' THEN payment_failed_at IS NOT NULL
             ELSE pending_plan = 'expired' END;
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------------------------------------
-- A new business starts on a trial of exactly the trial length, on the database clock.
-- ---------------------------------------------------------------------------------------------
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
     OR NEW.plan_expires_at > now() + interval '14 days' THEN
    RAISE EXCEPTION
      'a new business starts on its 14-day trial; plan and plan_expires_at change only through the subscription writers (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
