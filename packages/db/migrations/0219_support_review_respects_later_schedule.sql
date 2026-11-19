-- OD-50, review follow-up (independent review of `2b602b0`): resolving a support-reviewed upgrade
-- no longer overrides a plan change the merchant scheduled AFTER asking for it.
--
-- `subscription_operator_resolve_review` (0213) clears `pending_plan` when it moves the plan: a
-- downgrade scheduled against the old plan goes with the upgrade. That is right for a schedule
-- made BEFORE the merchant asked to upgrade. It was wrong for one made AFTER: a merchant who asked
-- for an upgrade, then scheduled a cancellation while waiting for support, had the cancellation
-- silently removed when an operator resolved the older request, and would have been renewed on a
-- dearer plan they had decided against. The audit row kept the old value, but nothing stopped it.
--
-- The function now refuses in that case (the review is stale: the merchant's later decision
-- stands), exactly as it already refuses when the plan or the paid-through date moved after the
-- request. Scheduling stamps `plan_decided_at` (G-104), which is compared with the review's
-- `requested_at`. Everything else about the function is unchanged: no date parameter, the
-- paid-through date never written, one audit row, a repeat changes nothing.
--
-- Rollback: additive (one function re-created with one more refusal). Re-running is safe.

CREATE OR REPLACE FUNCTION public.subscription_operator_resolve_review(
  p_business uuid,
  p_plan text,
  p_actor text,
  p_reason text
) RETURNS TABLE (review_id uuid, previous_plan text, expires_at timestamptz, changed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
  r record;
  v_now timestamptz := clock_timestamp();
  v_from_price bigint;
  v_to_price bigint;
  v_pin uuid;
BEGIN
  IF p_business IS NULL OR p_plan IS NULL OR p_plan NOT IN ('chat', 'integrate', 'complete')
     OR p_actor IS NULL OR p_actor !~ '^operator:[!-~]{1,255}$'
     OR p_reason IS NULL OR length(btrim(p_reason)) < 1 OR length(p_reason) > 500 THEN
    RAISE EXCEPTION 'subscription_operator_resolve_review: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_operator_resolve_review: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT plan, plan_expires_at, pending_plan, plan_decided_at, billing_interval, cycle_started_at,
         plan_version_id
    INTO b
  FROM public.businesses WHERE id = p_business FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_operator_resolve_review: no such business' USING ERRCODE = '42501';
  END IF;

  -- A repeat of a review already resolved onto this plan and this paid-through date: nothing to do.
  SELECT id, from_plan INTO r
  FROM public.plan_change_reviews
  WHERE business_id = p_business AND status = 'resolved' AND to_plan = p_plan
    AND paid_through IS NOT DISTINCT FROM b.plan_expires_at
  ORDER BY resolved_at DESC LIMIT 1;
  IF FOUND AND b.plan = p_plan THEN
    RETURN QUERY SELECT r.id, r.from_plan, b.plan_expires_at, false;
    RETURN;
  END IF;

  SELECT id, from_plan, to_plan, paid_through, requested_at INTO r
  FROM public.plan_change_reviews
  WHERE business_id = p_business AND status = 'open' FOR UPDATE;
  IF NOT FOUND OR r.to_plan <> p_plan THEN
    RAISE EXCEPTION 'subscription_operator_resolve_review: no open support review asks for this plan'
      USING ERRCODE = '22023';
  END IF;
  IF b.plan NOT IN ('chat', 'integrate', 'complete') THEN
    RAISE EXCEPTION 'subscription_operator_resolve_review: a % plan has no paid-through date to keep', b.plan
      USING ERRCODE = '22023';
  END IF;
  IF b.plan_expires_at IS NULL OR b.plan_expires_at <= v_now THEN
    RAISE EXCEPTION 'subscription_operator_resolve_review: the paid period has ended'
      USING ERRCODE = '22023';
  END IF;
  IF b.plan <> r.from_plan OR b.plan_expires_at <> r.paid_through THEN
    RAISE EXCEPTION 'subscription_operator_resolve_review: the subscription changed after the review was requested'
      USING ERRCODE = '22023';
  END IF;
  -- The merchant's later word wins (0219). A cancellation or a downgrade scheduled AFTER the
  -- upgrade was asked for is a newer decision about the same subscription; resolving the older
  -- request would clear it and leave the merchant renewing on a dearer plan they had decided
  -- against. One scheduled BEFORE the request was overtaken by the request itself, and is cleared
  -- below as it always was.
  IF b.pending_plan IS NOT NULL AND b.plan_decided_at IS NOT NULL
     AND b.plan_decided_at > r.requested_at THEN
    RAISE EXCEPTION 'subscription_operator_resolve_review: the merchant scheduled a plan change after asking for this review'
      USING ERRCODE = '22023';
  END IF;
  v_from_price := rekoda_private.open_plan_price(b.plan, b.billing_interval);
  v_to_price := rekoda_private.open_plan_price(p_plan, b.billing_interval);
  IF v_from_price IS NULL OR v_to_price IS NULL OR v_to_price <= v_from_price THEN
    RAISE EXCEPTION 'subscription_operator_resolve_review: the reviewed plan is not an upgrade'
      USING ERRCODE = '22023';
  END IF;

  -- The plan-version pin of the new plan, as the subscription writer picks it: the version in
  -- force when the cycle began, else the plan's first.
  SELECT coalesce(
    (SELECT v.id FROM public.plan_versions v
     WHERE v.plan_id = p_plan AND v.effective_from <= coalesce(b.cycle_started_at, v_now)
       AND (v.effective_to IS NULL OR v.effective_to > coalesce(b.cycle_started_at, v_now))
     ORDER BY v.version DESC LIMIT 1),
    (SELECT v.id FROM public.plan_versions v WHERE v.plan_id = p_plan ORDER BY v.version LIMIT 1))
  INTO v_pin;

  -- `plan_expires_at` is not written: the paid-through date stays exactly what the merchant paid
  -- for. Nor are the cycle start, the interval, the anchor day, the origin or the trial start.
  UPDATE public.businesses SET
    plan = p_plan,
    plan_version_id = v_pin,
    pending_plan = NULL,                 -- a downgrade scheduled against the old plan goes with it
    plan_decided_at = v_now,             -- a decision: plan charges opened before it are stale (G-104)
    plan_decided_before_pending = NULL,
    updated_at = v_now
  WHERE id = p_business;
  UPDATE public.plan_change_reviews SET
    status = 'resolved', resolved_at = v_now, resolved_by = p_actor, reason = p_reason,
    updated_at = v_now
  WHERE id = r.id;
  INSERT INTO public.audit_events
    (business_id, actor, entity, entity_id, action, old_value, new_value, reason, source_type)
  VALUES (
    p_business, p_actor, 'business', p_business::text, 'plan_changed',
    jsonb_build_object(
      'plan', b.plan,
      'expiresAt', to_char(b.plan_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'pendingPlan', b.pending_plan),
    jsonb_build_object(
      'plan', p_plan,
      'expiresAt', to_char(b.plan_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'billingInterval', b.billing_interval,
      'supportReview', r.id::text,
      'paidThroughKept', true),
    p_reason, 'operator');
  RETURN QUERY SELECT r.id, b.plan, b.plan_expires_at, true;
END $$;
-- CREATE OR REPLACE keeps the owner (rekoda_plan_writer) and the grants of 0213.
