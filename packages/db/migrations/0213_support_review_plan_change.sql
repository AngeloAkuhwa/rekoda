-- OD-50 (owner instruction, 12 Nov 2026, PR #432): a support-reviewed upgrade keeps the merchant's
-- existing paid-through date, through its own narrow, audited operation.
--
-- 0207 made every operator plan assignment run Rekoda's standard period from now, so the operator
-- handling a mid-cycle upgrade that the product sends to support review (OWN-33/OWN-34: a cycle
-- that is not a provider-bought standard month is never prorated automatically) could only give a
-- full new period or end the plan. This migration adds the missing operation WITHOUT giving an
-- operator a date to choose:
--
--   1. `plan_change_reviews` records the merchant's own refused upgrade. The application cannot
--      write the table: a row is made only by `subscription_request_plan_review`, which checks the
--      facts itself (an active paid plan with a future paid-through date, a dearer paid target) and
--      freezes the plan and the paid-through date the request was made against. A client flag
--      never makes an assignment a "support review": the open row does.
--   2. `subscription_operator_resolve_review` (EXECUTE: `rekoda_billing_operator` only) moves the
--      business to the reviewed plan. It takes NO date. It requires the open review for exactly
--      that plan, the business still on the plan and paid-through date the review froze, and that
--      date still in the future; it then writes `plan` and never touches `plan_expires_at`,
--      `trial_started_at`, the cycle start, the interval or the renewal anchor. A trial, an expired
--      plan, a lapsed (grace) cycle and a cycle that has since renewed or been moved are refused.
--      A repeat of a resolved review changes nothing and says so. One audit row per change:
--      actor, previous plan, new plan, the paid-through date kept, the review and the reason.
--
-- The standard-period writer (`subscription_operator_set_plan`, 0207), the trial-start guard and
-- the `expired` operation are unchanged.
--
-- Rollback: additive (a new table and two new functions); the previous release ignores them.
-- Re-running is safe.

CREATE TABLE IF NOT EXISTS plan_change_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  from_plan text NOT NULL CHECK (from_plan IN ('chat', 'integrate', 'complete')),
  to_plan text NOT NULL CHECK (to_plan IN ('chat', 'integrate', 'complete')),
  -- The paid-through date the request was made against; the resolution keeps exactly this.
  paid_through timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'superseded')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_plan <> to_plan),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND reason IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS plan_change_reviews_one_open
  ON plan_change_reviews (business_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS plan_change_reviews_business_ix
  ON plan_change_reviews (business_id, requested_at);

ALTER TABLE plan_change_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_change_reviews FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON plan_change_reviews
    USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
    WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Read by the application (the merchant's billing page) and the operator; written by neither.
REVOKE ALL ON plan_change_reviews FROM PUBLIC, rekoda_app, rekoda_worker;
GRANT SELECT ON plan_change_reviews TO rekoda_app, rekoda_billing_operator;
GRANT SELECT, INSERT ON plan_change_reviews TO rekoda_plan_writer;
GRANT UPDATE (status, resolved_at, resolved_by, reason, updated_at)
  ON plan_change_reviews TO rekoda_plan_writer;
-- The resolution writes the rest of the subscription state the move implies, in the same call.
GRANT SELECT ON plan_versions, plan_prices TO rekoda_plan_writer;
GRANT UPDATE (plan_version_id, plan_decided_before_pending) ON businesses TO rekoda_plan_writer;

-- The open catalogue price of a paid plan on an interval, in minor units (kobo); NULL when none.
CREATE OR REPLACE FUNCTION rekoda_private.open_plan_price(p_plan text, p_interval text)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.amount_minor
  FROM public.plan_versions v
  JOIN public.plan_prices p ON p.plan_version_id = v.id
  WHERE v.plan_id = p_plan AND v.effective_to IS NULL
    AND p.billing_interval = p_interval AND p.effective_to IS NULL AND p.currency = 'NGN'
$$;
REVOKE ALL ON FUNCTION rekoda_private.open_plan_price(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rekoda_private.open_plan_price(text, text) TO rekoda_plan_writer;

-- ---------------------------------------------------------------------------------------------
-- 1. The merchant's refused upgrade, recorded.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subscription_request_plan_review(
  p_business uuid,
  p_plan text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
  existing record;
  v_now timestamptz := clock_timestamp();
  v_from_price bigint;
  v_to_price bigint;
  v_id uuid;
BEGIN
  IF p_business IS NULL OR p_plan IS NULL OR p_plan NOT IN ('chat', 'integrate', 'complete') THEN
    RAISE EXCEPTION 'subscription_request_plan_review: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_request_plan_review: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT plan, plan_expires_at, billing_interval INTO b
  FROM public.businesses WHERE id = p_business FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_request_plan_review: no such business' USING ERRCODE = '42501';
  END IF;
  IF b.plan NOT IN ('chat', 'integrate', 'complete')
     OR b.plan_expires_at IS NULL OR b.plan_expires_at <= v_now THEN
    RAISE EXCEPTION 'subscription_request_plan_review: only an active paid plan with a paid-through date can be reviewed'
      USING ERRCODE = '22023';
  END IF;
  v_from_price := rekoda_private.open_plan_price(b.plan, b.billing_interval);
  v_to_price := rekoda_private.open_plan_price(p_plan, b.billing_interval);
  IF p_plan = b.plan OR v_from_price IS NULL OR v_to_price IS NULL OR v_to_price <= v_from_price THEN
    RAISE EXCEPTION 'subscription_request_plan_review: the requested plan is not an upgrade'
      USING ERRCODE = '22023';
  END IF;
  SELECT id, from_plan, to_plan, paid_through INTO existing
  FROM public.plan_change_reviews WHERE business_id = p_business AND status = 'open' FOR UPDATE;
  IF FOUND THEN
    IF existing.from_plan = b.plan AND existing.to_plan = p_plan
       AND existing.paid_through = b.plan_expires_at THEN
      RETURN existing.id; -- the same request, asked again
    END IF;
    UPDATE public.plan_change_reviews SET status = 'superseded', updated_at = v_now
    WHERE id = existing.id;
  END IF;
  INSERT INTO public.plan_change_reviews (business_id, from_plan, to_plan, paid_through, requested_at)
  VALUES (p_business, b.plan, p_plan, b.plan_expires_at, v_now)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 2. The operator's resolution: the reviewed plan, the paid-through date exactly as it is.
-- ---------------------------------------------------------------------------------------------
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
  SELECT plan, plan_expires_at, pending_plan, billing_interval, cycle_started_at, plan_version_id
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

  SELECT id, from_plan, to_plan, paid_through INTO r
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

ALTER FUNCTION public.subscription_request_plan_review(uuid, text) OWNER TO rekoda_plan_writer;
ALTER FUNCTION public.subscription_operator_resolve_review(uuid, text, text, text)
  OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.subscription_request_plan_review(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_operator_resolve_review(uuid, text, text, text)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.subscription_request_plan_review(uuid, text) TO rekoda_app;
GRANT EXECUTE ON FUNCTION public.subscription_operator_resolve_review(uuid, text, text, text)
  TO rekoda_billing_operator;
