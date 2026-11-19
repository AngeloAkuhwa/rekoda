-- OD-49 (owner instruction, 11 Nov 2026, PR #432 closeout): a release preflight for subscription
-- records that Rekoda's duration rules (0203, 0207) would not accept, and an explicit, audited
-- correction for one of them.
--
-- 0203 and 0207 deliberately do not rewrite rows written before them. A query that lists such rows
-- is not a release check, so this adds one rule, in one place, and two owner-only functions on it:
--
--   rekoda_private.subscription_period_violation(...)  the reason a subscription's dates break the
--       rules, or NULL. One rule for both functions below:
--         paid_open_ended            a paid plan with no end
--         paid_no_cycle_start        a paid plan with no cycle start, so its length cannot be checked
--         paid_unknown_interval      a paid plan whose interval is neither monthly nor annual
--         paid_ends_before_start     a paid plan that ends at or before its own cycle start
--         paid_longer_than_interval  a paid plan ending after the last instant of the Lagos calendar
--                                    month one interval after its cycle start (the month's end
--                                    allows the anchor-day clamp of a renewal: a cycle that started
--                                    on 28 February, anchored to the 31st, renews on 31 March)
--         trial_open_ended           a trial with no end
--         trial_longer_than_14_days  a trial ending more than 336 hours after its own start (one
--                                    minute allowed: before 0203 signup set the end on the API's
--                                    clock and the start on the database's)
--         expired_future_end         an expired plan whose end is still in the future
--         unknown_plan               a plan Rekoda does not sell
--       Shorter-than-standard paid periods written before 0207 grant nothing extra and are not
--       listed.
--
--   rekoda_private.subscription_period_preflight(now)  READ-ONLY. Every business whose dates break
--       the rule, with `active` (a paid plan or a trial that has not ended, or has no end) or
--       `inactive` (ended, or expired), the reason, and the dates. The release preflight
--       (packages/db/src/preflight-subscriptions.ts) fails when any ACTIVE row is listed; inactive
--       rows are reported and never block a release on their own.
--
--   rekoda_private.correct_subscription_period(business, new_end, actor, reason)  the ONLY sanctioned
--       correction. It changes nothing on its own initiative: an operator gives the corrected end
--       and a written reason, the business must currently be listed as active, the new end must
--       itself satisfy the rule (and be in the future for a paid plan or a trial), and the original
--       and corrected values, the actor and the reason are written to the audit trail in the same
--       transaction. It never changes the plan or its status.
--
-- All three run only as the table owner (the release operator, through the migrate job's owner
-- credential); no runtime role can execute them. Nothing here modifies a row on its own.
--
-- Rollback: dropping the three functions is safe; nothing depends on them. Re-running is safe.

CREATE OR REPLACE FUNCTION rekoda_private.paid_period_bound(p_start timestamptz, p_interval text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT ((date_trunc('month', (p_start AT TIME ZONE 'Africa/Lagos')
            + CASE p_interval WHEN 'monthly' THEN interval '1 month'
                              WHEN 'annual' THEN interval '12 months' END)
           + interval '1 month' - interval '1 microsecond')
          AT TIME ZONE 'Africa/Lagos')
$$;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_period_violation(
  p_plan text,
  p_expires timestamptz,
  p_cycle_start timestamptz,
  p_interval text,
  p_trial_start timestamptz,
  p_now timestamptz
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_plan IN ('chat', 'integrate', 'complete') THEN
      CASE
        WHEN p_expires IS NULL THEN 'paid_open_ended'
        WHEN p_cycle_start IS NULL THEN 'paid_no_cycle_start'
        WHEN p_interval IS NULL OR p_interval NOT IN ('monthly', 'annual') THEN 'paid_unknown_interval'
        WHEN p_expires <= p_cycle_start THEN 'paid_ends_before_start'
        WHEN p_expires > rekoda_private.paid_period_bound(p_cycle_start, p_interval)
          THEN 'paid_longer_than_interval'
      END
    WHEN p_plan = 'trial' THEN
      CASE
        WHEN p_expires IS NULL THEN 'trial_open_ended'
        WHEN p_expires > p_trial_start + interval '336 hours' + interval '1 minute'
          THEN 'trial_longer_than_14_days'
      END
    WHEN p_plan = 'expired' THEN
      CASE WHEN p_expires IS NOT NULL AND p_expires > p_now THEN 'expired_future_end' END
    ELSE 'unknown_plan'
  END
$$;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_period_preflight(
  p_now timestamptz DEFAULT now()
) RETURNS TABLE (
  business_id uuid,
  plan text,
  status text,
  reason text,
  plan_expires_at timestamptz,
  cycle_started_at timestamptz,
  billing_interval text,
  trial_started_at timestamptz
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT b.id, b.plan::text,
         CASE WHEN b.plan IN ('chat', 'integrate', 'complete', 'trial')
                   AND (b.plan_expires_at IS NULL OR b.plan_expires_at > p_now)
              THEN 'active' ELSE 'inactive' END,
         v.reason, b.plan_expires_at, b.cycle_started_at, b.billing_interval::text,
         b.trial_started_at
  FROM public.businesses b
  CROSS JOIN LATERAL (
    SELECT rekoda_private.subscription_period_violation(
      b.plan::text, b.plan_expires_at, b.cycle_started_at, b.billing_interval::text,
      b.trial_started_at, p_now) AS reason) v
  WHERE v.reason IS NOT NULL
  ORDER BY 3, b.id
$$;

CREATE OR REPLACE FUNCTION rekoda_private.correct_subscription_period(
  p_business uuid,
  p_new_end timestamptz,
  p_actor text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  prev record;
  v_now timestamptz := clock_timestamp();
  v_was text;
  v_after text;
BEGIN
  IF p_business IS NULL OR p_new_end IS NULL
     OR p_actor IS NULL OR p_actor !~ '^operator:[!-~]{1,255}$'
     OR p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'correct_subscription_period: a business, a new end, an operator actor and a written reason (10+ characters) are required'
      USING ERRCODE = '22023';
  END IF;
  SELECT plan, plan_expires_at, cycle_started_at, billing_interval, trial_started_at INTO prev
  FROM public.businesses WHERE id = p_business FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correct_subscription_period: no such business' USING ERRCODE = '22023';
  END IF;
  IF NOT (prev.plan IN ('chat', 'integrate', 'complete', 'trial')
          AND (prev.plan_expires_at IS NULL OR prev.plan_expires_at > v_now)) THEN
    RAISE EXCEPTION 'correct_subscription_period: only an active paid plan or trial is corrected here'
      USING ERRCODE = '22023';
  END IF;
  v_was := rekoda_private.subscription_period_violation(prev.plan, prev.plan_expires_at,
    prev.cycle_started_at, prev.billing_interval, prev.trial_started_at, v_now);
  IF v_was IS NULL THEN
    RAISE EXCEPTION 'correct_subscription_period: this subscription already satisfies the rules'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_end <= v_now THEN
    RAISE EXCEPTION 'correct_subscription_period: the corrected end must be in the future; end a plan with the expired operation'
      USING ERRCODE = '22023';
  END IF;
  v_after := rekoda_private.subscription_period_violation(prev.plan, p_new_end,
    prev.cycle_started_at, prev.billing_interval, prev.trial_started_at, v_now);
  IF v_after IS NOT NULL THEN
    RAISE EXCEPTION 'correct_subscription_period: the corrected end still breaks the rules (%)', v_after
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.businesses SET plan_expires_at = p_new_end, updated_at = now() WHERE id = p_business;
  INSERT INTO public.audit_events
    (business_id, actor, entity, entity_id, action, old_value, new_value, reason, source_type)
  VALUES (
    p_business, p_actor, 'business', p_business::text, 'subscription_period_corrected',
    jsonb_build_object('plan', prev.plan, 'violation', v_was,
      'expiresAt', to_char(prev.plan_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    jsonb_build_object('plan', prev.plan,
      'expiresAt', to_char(p_new_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    btrim(p_reason), 'operator');
END $$;

REVOKE ALL ON FUNCTION rekoda_private.paid_period_bound(timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rekoda_private.subscription_period_violation(text, timestamptz, timestamptz, text, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION rekoda_private.subscription_period_preflight(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION rekoda_private.correct_subscription_period(uuid, timestamptz, text, text) FROM PUBLIC;
