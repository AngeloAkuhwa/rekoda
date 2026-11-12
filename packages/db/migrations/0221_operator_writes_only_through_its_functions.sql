-- OD-51 (independent database review of `208c919`, IMPORTANT): the billing operator changes a
-- subscription only through its two audited database operations.
--
-- `subscription_operator_set_plan` (0207) wrote `plan` and `plan_expires_at`, and the application
-- then wrote the rest of the cycle (plan version, cycle start, renewal anchor, interval, origin,
-- grace clock, paid history, decision time) as the billing operator. 0211 granted the operator
-- those twelve columns for that write, so whoever held the operator credential could also write
-- them on their own: stop a grace clock, move the renewal anchor or switch the interval with no
-- audit row and none of 0207's rules, and backdate `plan_decided_at` to before a support review
-- was requested, which defeated 0219's refusal.
--
-- After this migration the writer records the whole cycle itself, in the same statement sequence,
-- from its own values (the values the application computed from what the writer returned, now
-- computed in SQL), and the operator holds no UPDATE on `businesses` but `updated_at` (PostgreSQL
-- lets a role lock a row FOR UPDATE only with some UPDATE right on the table, and the operator
-- path locks the business before it calls the writer; the column carries no meaning). Its only writes are
-- the two functions: the standard-period assignment and the support-review resolution (0213),
-- both audited.
--
-- Two minors from the same review, in the same release:
--   * the reservation-closing trigger (0218, 0220) runs as `rekoda_usage_writer` and saw only the
--     reservations visible under the session's tenant pin, so a job marked done with no pin, or
--     under another business's pin, closed nothing and raised nothing. The trigger now pins the
--     job's own business for its one statement and restores the session's pin afterwards, so it
--     closes by the job's business whatever the caller pinned. No policy is widened: the role
--     still sees only the pinned tenant's reservations, and the pin it sets is the row's own;
--   * the worker could still requeue a DEAD settlement job (0217 allowed dead to pending). Nothing
--     legitimate needs that (an operator's recovery runs on the application credential), so the
--     worker may now only leave a dead settlement job dead.
--
-- Compatibility: BREAKING for a release older than this one (its operator path writes the cycle
-- columns directly); it ships in the same stopped release as 0216 to 0220. Rollback: none past
-- 0196 (OWN-86). Re-running is safe.

-- The writer's owner records the cycle now.
GRANT UPDATE (cycle_started_at, renewal_anchor_day, billing_interval, pending_billing_interval,
              subscription_origin, last_grace_reminder_day, ever_paid_at)
  ON businesses TO rekoda_plan_writer;

CREATE OR REPLACE FUNCTION public.subscription_operator_set_plan(
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
  -- The rest of the cycle, from this function's own values (0221). It used to be written by the
  -- application as the operator, which needed the operator to hold these columns directly.
  UPDATE public.businesses b SET
    plan_version_id = CASE WHEN NOT paid THEN b.plan_version_id ELSE coalesce(
      (SELECT v.id FROM public.plan_versions v WHERE v.id = b.plan_version_id AND v.plan_id = p_plan),
      (SELECT v.id FROM public.plan_versions v
        WHERE v.plan_id = p_plan AND v.effective_from <= v_now
          AND (v.effective_to IS NULL OR v.effective_to > v_now)
        ORDER BY v.version DESC LIMIT 1),
      (SELECT v.id FROM public.plan_versions v WHERE v.plan_id = p_plan ORDER BY v.version LIMIT 1))
      END,
    cycle_started_at = CASE WHEN paid THEN v_now END,
    -- The day of the month the cycle renews on, read in Lagos (UTC+1, no daylight saving).
    renewal_anchor_day = CASE WHEN paid
      THEN extract(day FROM (v_end + interval '1 hour') AT TIME ZONE 'UTC')::smallint END,
    pending_plan = NULL,
    billing_interval = CASE WHEN paid THEN p_interval ELSE 'monthly' END,
    pending_billing_interval = NULL,
    subscription_origin = CASE WHEN paid THEN 'operator' END,
    payment_failed_at = NULL,
    last_grace_reminder_day = NULL,
    ever_paid_at = CASE WHEN paid THEN coalesce(b.ever_paid_at, now()) ELSE b.ever_paid_at END,
    plan_decided_at = clock_timestamp(),
    plan_decided_before_pending = NULL,
    updated_at = now()
  WHERE b.id = p_business;
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
-- CREATE OR REPLACE keeps the owner (rekoda_plan_writer) and the EXECUTE grant (operator only).

-- The operator writes nothing directly.
REVOKE UPDATE ON businesses FROM rekoda_billing_operator;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT column_name
    FROM information_schema.column_privileges
    WHERE grantee = 'rekoda_billing_operator' AND table_schema = 'public'
      AND table_name = 'businesses' AND privilege_type = 'UPDATE'
  LOOP
    EXECUTE format('REVOKE UPDATE (%I) ON public.businesses FROM rekoda_billing_operator',
      r.column_name);
  END LOOP;
END $$;
-- Only so the operator path can lock the business row before the writer runs.
GRANT UPDATE (updated_at) ON businesses TO rekoda_billing_operator;

-- An earlier draft of this migration (da1a3cb, never on main) created this policy. The drop is a
-- no-op safety net for a fresh or never-drafted database; one that applied the draft does not re-run
-- 0221 and keeps the policy, which the pre-start smoke refuses. Reset such a database.
DROP POLICY IF EXISTS usage_writer_sees_reservations ON usage_reservations;

-- The closing trigger closes by the job's business, whatever the session pinned. Otherwise the
-- function of 0220.
CREATE OR REPLACE FUNCTION rekoda_private.jobs_close_event_reservations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_event uuid;
  v_pin text := current_setting('app.business_id', true);
BEGIN
  BEGIN
    v_event := (NEW.payload ->> 'eventId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW; -- not an event id: a job that is not about an event holds no reservation
  END;
  IF v_event IS NULL THEN
    RETURN NEW;
  END IF;
  -- The job's own business, for this one statement, then whatever the caller had pinned.
  PERFORM set_config('app.business_id', NEW.business_id::text, true);
  UPDATE public.usage_reservations
  SET closed_at = now()
  WHERE business_id = NEW.business_id AND event_id = v_event AND closed_at IS NULL;
  PERFORM set_config('app.business_id', coalesce(v_pin, ''), true);
  RETURN NEW;
END $$;
-- CREATE OR REPLACE keeps the owner (rekoda_usage_writer) and the revoked EXECUTE of 0218.

-- The worker never requeues a settlement job; it may only leave a dead one dead.
DROP POLICY IF EXISTS worker_leaves_settlement_jobs ON jobs;
CREATE POLICY worker_leaves_settlement_jobs ON jobs AS RESTRICTIVE FOR UPDATE TO rekoda_worker
  USING (kind NOT IN ('billing.process', 'billing.apply_no_charge') OR state = 'dead')
  WITH CHECK (kind NOT IN ('billing.process', 'billing.apply_no_charge') OR state = 'dead');
