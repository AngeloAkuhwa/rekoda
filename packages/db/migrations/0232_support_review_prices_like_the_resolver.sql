-- Second independent review of PR #432 (R02, IMPORTANT; Codex P2 on 0213): the support-review
-- pricing path prices a plan exactly as the billing price resolver does.
--
-- `rekoda_private.open_plan_price` (0213) read only an explicit price row of the OPEN catalogue
-- version. Two consequences:
--   * an annual subscriber whose version publishes no annual row got NULL, and the request and the
--     resolution both refused the upgrade as "not an upgrade", although `planPriceKFor`
--     (`apps/api/src/billing/plan-terms.ts`) charges such a version monthly x 10 (OWN-40);
--   * a grandfathered merchant was compared at today's open prices, not at the version they are
--     pinned to, so the database could disagree with the application about whether a change is
--     an upgrade at all.
--
-- `rekoda_private.review_plan_price(business, plan, interval, at)` mirrors the application's
-- resolver exactly (`planCatalogueRepo.versionForBusiness` then `priceAt`):
--   1. the version: the business's pinned version when it is a version of that plan, else the
--      plan's version in force at `at` (highest version number);
--   2. the price: that version's NGN row for the interval in force at `at` (latest
--      effective_from); an explicit annual price always wins;
--   3. for `annual` only, when the version has no annual row in force: its monthly price x 10
--      (OWN-40), in integer kobo;
--   4. otherwise NULL (missing pricing), which both callers refuse, as before.
-- `subscription_request_plan_review` and `subscription_operator_resolve_review` are re-created
-- from their current bodies (0213 and 0219) with only the two price lookups changed; owners,
-- grants, the 0219 later-schedule rule and the paid-through-date preservation are unchanged.
-- `open_plan_price` has no other caller and is dropped.
--
-- Known boundary (recorded in the OD-41 row): under the `constants` pricing source the application
-- prices from code constants while this function reads the catalogue; the seeded catalogue carries
-- the same figures, so the two agree unless an operator publishes a catalogue version that differs
-- from the constants while the source is still `constants`.
--
-- Not a compatibility break: the previous release (main, 0192) has neither function. Re-running is
-- safe. Rollback: re-apply 0213's `open_plan_price` and 0219's bodies.

CREATE OR REPLACE FUNCTION rekoda_private.review_plan_price(
  p_business uuid,
  p_plan text,
  p_interval text,
  p_at timestamptz
) RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH version AS (
    SELECT coalesce(
      (SELECT pv.id
       FROM public.businesses b JOIN public.plan_versions pv ON pv.id = b.plan_version_id
       WHERE b.id = p_business AND pv.plan_id = p_plan),
      (SELECT v.id FROM public.plan_versions v
       WHERE v.plan_id = p_plan
         AND v.effective_from <= p_at AND (v.effective_to IS NULL OR v.effective_to > p_at)
       ORDER BY v.version DESC
       LIMIT 1)) AS id
  ),
  priced AS (
    SELECT p.billing_interval, p.amount_minor,
           row_number() OVER (PARTITION BY p.billing_interval ORDER BY p.effective_from DESC) AS n
    FROM public.plan_prices p JOIN version ON p.plan_version_id = version.id
    WHERE p.currency = 'NGN'
      AND p.effective_from <= p_at AND (p.effective_to IS NULL OR p.effective_to > p_at)
  )
  SELECT coalesce(
    (SELECT amount_minor FROM priced WHERE n = 1 AND billing_interval = p_interval),
    CASE WHEN p_interval = 'annual'
         THEN (SELECT amount_minor * 10 FROM priced WHERE n = 1 AND billing_interval = 'monthly')
    END)
$$;
REVOKE ALL ON FUNCTION rekoda_private.review_plan_price(uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rekoda_private.review_plan_price(uuid, text, text, timestamptz)
  TO rekoda_plan_writer;

CREATE OR REPLACE FUNCTION public.subscription_request_plan_review(p_business uuid, p_plan text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  v_from_price := rekoda_private.review_plan_price(p_business, b.plan, b.billing_interval, v_now);
  v_to_price := rekoda_private.review_plan_price(p_business, p_plan, b.billing_interval, v_now);
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
END $function$;

CREATE OR REPLACE FUNCTION public.subscription_operator_resolve_review(p_business uuid, p_plan text, p_actor text, p_reason text)
 RETURNS TABLE(review_id uuid, previous_plan text, expires_at timestamp with time zone, changed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  v_from_price := rekoda_private.review_plan_price(p_business, b.plan, b.billing_interval, v_now);
  v_to_price := rekoda_private.review_plan_price(p_business, p_plan, b.billing_interval, v_now);
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
END $function$;

DROP FUNCTION IF EXISTS rekoda_private.open_plan_price(text, text);
