-- OD-50 (owner instruction, 11 Nov 2026, PR #432 closeout): an operator plan assignment runs
-- exactly Rekoda's standard period, computed by the database; and the trial start cannot be moved.
--
-- Until now the operator writer (`subscription_operator_set_plan`, 0200/0202/0203) refused only an
-- end LONGER than the plan's period, so an operator could also give a shorter one (a monthly plan
-- ending in 20 days). The owner's policy is the standard period, with early termination through the
-- explicit `expired` operation:
--
--   * A paid plan (chat, integrate, complete) runs exactly one billing interval from the moment the
--     writer runs: one Lagos calendar month for monthly, twelve for annual
--     (`rekoda_private.add_billing_interval`). The caller gives NO end; one that does is refused.
--     The cycle starts at that same instant, and the writer returns both, so the application
--     records the start and anchor the database used.
--   * Re-posting the plan and interval the business is already on, while that plan has not ended,
--     changes nothing and is reported as unchanged: a retried request cannot restart the cycle and
--     hand out the days already used. To start a fresh period an operator ends the plan first.
--   * A trial ends exactly 336 hours after the business's own trial start; the caller gives no end.
--     A business whose trial is already over cannot be given another one this way.
--   * `expired` ends now (no end given) or at the given time, which must not be in the future.
--
-- `trial_started_at` (the anchor of the 14 days) was writable by any credential with UPDATE on
-- `businesses`: moved forward, a later operator trial would have granted a second 14 days. It is now
-- written only at signup (the insert guard of 0203/0206 pins it to the database clock) and by the
-- table owner.
--
-- Existing rows are NOT rewritten (OD-49): this changes only what the writer accepts from now on.
--
-- Rollback: none past 0196 (OWN-86); applied with the api and worker stopped. Re-running is safe.

DROP FUNCTION IF EXISTS public.subscription_operator_set_plan(uuid, text, timestamptz, text, text);

CREATE FUNCTION public.subscription_operator_set_plan(
  p_business uuid,
  p_plan text,
  p_expires timestamptz,
  p_interval text,
  p_actor text
) RETURNS TABLE (cycle_start timestamptz, expires_at timestamptz, changed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  prev record;
  paid boolean;
  v_now timestamptz := clock_timestamp();
  v_end timestamptz;
BEGIN
  IF p_business IS NULL OR p_plan IS NULL
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
  IF p_plan <> 'expired' AND p_expires IS NOT NULL THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: a % plan runs its standard period; give no end date', p_plan
      USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT plan, plan_expires_at, pending_plan, payment_failed_at, trial_started_at,
         billing_interval, cycle_started_at
    INTO prev
  FROM public.businesses WHERE id = p_business FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: no such business' USING ERRCODE = '42501';
  END IF;

  IF paid THEN
    IF prev.plan = p_plan AND prev.billing_interval = p_interval
       AND prev.plan_expires_at IS NOT NULL AND prev.plan_expires_at > v_now THEN
      -- Already on this plan and interval, and it has not ended: nothing to do.
      RETURN QUERY SELECT prev.cycle_started_at, prev.plan_expires_at, false;
      RETURN;
    END IF;
    v_end := rekoda_private.add_billing_interval(v_now, p_interval);
  ELSIF p_plan = 'trial' THEN
    v_end := prev.trial_started_at + rekoda_private.trial_length();
    IF v_end <= v_now THEN
      RAISE EXCEPTION 'subscription_operator_set_plan: this business''s 14-day trial is already over'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    v_end := coalesce(p_expires, v_now);
    IF v_end > v_now THEN
      RAISE EXCEPTION 'subscription_operator_set_plan: an expired plan cannot end in the future'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.businesses SET plan = p_plan, plan_expires_at = v_end WHERE id = p_business;
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
      'expiresAt', to_char(v_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'billingInterval', p_interval),
    'operator');
  RETURN QUERY SELECT CASE WHEN paid THEN v_now END, v_end, true;
END $$;

ALTER FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text, text)
  OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text, text)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text, text)
  TO rekoda_billing_operator;

-- ---------------------------------------------------------------------------------------------
-- The trial start: set once at signup, then fixed.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.businesses_trial_start_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
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
