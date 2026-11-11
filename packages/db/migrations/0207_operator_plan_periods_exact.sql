-- OD-50 (owner ruling, 11 Nov 2026, the PR #432 remediation brief §4): the generic operator plan
-- writer assigns Rekoda's STANDARD periods only. An operator no longer chooses any date.
--
--   monthly plan   ends exactly one calendar month (Lagos wall clock) after the change
--   annual plan    ends exactly twelve calendar months after the change
--   trial          ends exactly 14 days (336 hours) after the business's ORIGINAL trial start; a
--                  trial that has already ended cannot be re-opened by an operator
--   expired        the explicit early-termination operation: the entitlement ends now, a reason
--                  is required and audited, and nothing is refunded or credited
--
-- Before (0203): the operator supplied `p_expires` and the writer refused only a date LONGER than
-- the rule, so a shorter active paid period (a monthly plan ending in 20 days) was accepted and was
-- the implicit way to end a plan early. That is withdrawn: an early end is `expired`, with a
-- reason, and a custom or aligned period would be a separately defined, separately authorised
-- operation (none exists).
--
-- The writer now computes the end itself on the database clock (`now()`, the transaction start)
-- and returns it; the API reads the same value first from `subscription_operator_period_end`
-- (same function, same transaction, same `now()`) to write the rest of the cycle beside it, and
-- checks the writer's answer against it. The rule is still `rekoda_private.add_billing_interval`
-- and `rekoda_private.trial_length` (0203), pinned to `@rekoda/core` by the parity test.
--
-- Every REFUSED operator plan change is recorded too (brief §5.1): the API writes the refusal in a
-- separate transaction through `operator_record_refusal`, into `rekoda_private.operator_refusals`
-- (not a tenant table: the business may not exist). Only the billing operator may write it; no
-- runtime role may read or change it directly.
--
-- Rollback: none past 0196 (OWN-86). Compatibility-breaking for the operator route only (the
-- previous release calls the five-argument writer with a date, which no longer exists): applied
-- with the api and worker stopped like 0202 to 0206. Re-running is safe.

-- ---------------------------------------------------------------------------------------------
-- 1. The standard end of an operator plan change, on the database clock.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subscription_operator_period_end(
  p_business uuid,
  p_plan text,
  p_interval text
) RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  started timestamptz;
BEGIN
  IF p_business IS NULL OR p_plan IS NULL
     OR p_plan NOT IN ('trial', 'expired', 'chat', 'integrate', 'complete') THEN
    RAISE EXCEPTION 'subscription_operator_period_end: invalid input' USING ERRCODE = '22023';
  END IF;
  IF (p_plan IN ('chat', 'integrate', 'complete')) IS DISTINCT FROM (p_interval IS NOT NULL)
     OR (p_interval IS NOT NULL AND p_interval NOT IN ('monthly', 'annual')) THEN
    RAISE EXCEPTION 'subscription_operator_period_end: a paid plan names its interval; trial and expired do not'
      USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_operator_period_end: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  -- Milliseconds: the API carries the value as a JavaScript Date and hands it back unchanged.
  IF p_plan = 'expired' THEN
    RETURN date_trunc('milliseconds', now());
  END IF;
  IF p_plan = 'trial' THEN
    SELECT trial_started_at INTO started FROM public.businesses WHERE id = p_business;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    RETURN date_trunc('milliseconds', started + rekoda_private.trial_length());
  END IF;
  RETURN date_trunc('milliseconds', rekoda_private.add_billing_interval(now(), p_interval));
END $$;

ALTER FUNCTION public.subscription_operator_period_end(uuid, text, text) OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.subscription_operator_period_end(uuid, text, text)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.subscription_operator_period_end(uuid, text, text)
  TO rekoda_billing_operator;

-- ---------------------------------------------------------------------------------------------
-- 2. The operator writer: no date argument; the standard period, or an audited early end.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.subscription_operator_set_plan(uuid, text, timestamptz, text, text);

CREATE OR REPLACE FUNCTION public.subscription_operator_set_plan(
  p_business uuid,
  p_plan text,
  p_interval text,
  p_actor text,
  p_reason text
) RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  prev record;
  ends timestamptz;
  why text := nullif(btrim(p_reason), '');
BEGIN
  IF p_business IS NULL OR p_plan IS NULL
     OR p_plan NOT IN ('trial', 'expired', 'chat', 'integrate', 'complete')
     OR p_actor IS NULL OR p_actor !~ '^operator:[!-~]{1,255}$'
     OR (why IS NOT NULL AND (length(why) > 500 OR why ~ '[[:cntrl:]]')) THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_plan = 'expired' AND why IS NULL THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: ending a plan early needs a reason'
      USING ERRCODE = '22023';
  END IF;
  -- Validates the interval and the tenant pin, and gives the standard end.
  ends := public.subscription_operator_period_end(p_business, p_plan, p_interval);
  SELECT plan, plan_expires_at, pending_plan, payment_failed_at, trial_started_at,
         cycle_started_at, billing_interval
    INTO prev
  FROM public.businesses WHERE id = p_business FOR UPDATE;
  IF NOT FOUND OR ends IS NULL THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: no such business' USING ERRCODE = '42501';
  END IF;
  IF p_plan = 'trial' AND ends <= clock_timestamp() THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: the business''s 14-day trial has ended; a trial cannot be re-opened'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.businesses SET plan = p_plan, plan_expires_at = ends WHERE id = p_business;
  INSERT INTO public.audit_events
    (business_id, actor, entity, entity_id, action, old_value, new_value, reason, source_type)
  VALUES (
    -- One action for every operator move (the audit trail and the 0167 origin backfill read it);
    -- an early end is the move to `expired`, and carries its reason.
    p_business, p_actor, 'business', p_business::text, 'plan_changed',
    jsonb_build_object(
      'plan', prev.plan,
      'expiresAt', to_char(prev.plan_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'cycleStartedAt',
        to_char(prev.cycle_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'billingInterval', prev.billing_interval,
      'pendingPlan', prev.pending_plan,
      'paymentFailedAt',
        to_char(prev.payment_failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    jsonb_build_object(
      'plan', p_plan,
      'expiresAt', to_char(ends AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'billingInterval', p_interval),
    why,
    'operator');
  RETURN ends;
END $$;

ALTER FUNCTION public.subscription_operator_set_plan(uuid, text, text, text, text)
  OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.subscription_operator_set_plan(uuid, text, text, text, text)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.subscription_operator_set_plan(uuid, text, text, text, text)
  TO rekoda_billing_operator;

-- ---------------------------------------------------------------------------------------------
-- 3. Refused operator plan changes are recorded.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rekoda_private.operator_refusals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- No foreign key: a refusal for a business that does not exist is recorded as asked.
  business_id uuid,
  actor text NOT NULL,
  action text NOT NULL,
  refusal text NOT NULL,
  refused_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON rekoda_private.operator_refusals FROM PUBLIC;
ALTER TABLE rekoda_private.operator_refusals OWNER TO rekoda_plan_writer;

CREATE OR REPLACE FUNCTION public.operator_record_refusal(
  p_business uuid,
  p_actor text,
  p_action text,
  p_refusal text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_actor IS NULL OR p_actor !~ '^operator:[!-~]{1,255}$'
     OR p_action IS NULL OR p_action !~ '^[a-z_]{1,64}$'
     OR p_refusal IS NULL OR length(p_refusal) < 1 THEN
    RAISE EXCEPTION 'operator_record_refusal: invalid input' USING ERRCODE = '22023';
  END IF;
  INSERT INTO rekoda_private.operator_refusals (business_id, actor, action, refusal)
  VALUES (p_business, p_actor, p_action,
          -- Bounded, single line: a refusal message is ours, but never trust its length.
          left(regexp_replace(p_refusal, '[[:cntrl:]]+', ' ', 'g'), 500));
END $$;

ALTER FUNCTION public.operator_record_refusal(uuid, text, text, text) OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.operator_record_refusal(uuid, text, text, text)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.operator_record_refusal(uuid, text, text, text)
  TO rekoda_billing_operator;

-- ---------------------------------------------------------------------------------------------
-- 4. The trial start is fixed at signup. It is what the trial's 14 days are counted from, so a
--    caller able to move it could re-open a trial through the operator writer above. Only the
--    table owner (a repair) and the plan writer (the staging date tool, OWN-77) may change it;
--    no runtime role may, the billing operator and settlement included.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.businesses_trial_start_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'rekoda_plan_writer'
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a business''s trial start is fixed at signup (OD-50)' USING ERRCODE = '42501';
END $$;

REVOKE ALL ON FUNCTION rekoda_private.businesses_trial_start_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_trial_start_guard ON businesses;
CREATE TRIGGER businesses_trial_start_guard
  BEFORE UPDATE OF trial_started_at ON businesses
  FOR EACH ROW
  WHEN (OLD.trial_started_at IS DISTINCT FROM NEW.trial_started_at)
  EXECUTE FUNCTION rekoda_private.businesses_trial_start_guard();
