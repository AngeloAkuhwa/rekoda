-- OD-37 / OWN-87 (PR B, 10 Nov 2026): the plan-field writers enforce the business rules themselves.
--
-- Migration 0196 made `businesses.plan` and `plan_expires_at` writable only inside SECURITY DEFINER
-- functions owned by the NOLOGIN role `rekoda_plan_writer`, checked by a trigger on the executing
-- role. One of those functions, `subscription_write_plan(business, plan, expires)`, was general
-- purpose: its only condition was the tenant pin, so any caller that could execute it could give
-- the pinned business ANY plan value and ANY date. This migration replaces it with two writers that
-- each accept only what their caller is entitled to do, and validates every input:
--
--   subscription_apply_paid_charge(business, reference, expires) -> plan
--       The provider path (a settled Paystack charge). The PLAN comes from the charge row, never
--       from the caller. The charge must belong to the business, be `paid`, be a plan charge
--       (first_purchase, renewal or upgrade) for a known paid plan, and be neither applied
--       (`applied_period_end`) nor marked unapplied; so one paid charge can move the plan at most
--       once. A charge that was superseded as the payable link but was then paid anyway still buys
--       what it was priced for (G-104, the settlement path decides that before calling here). The renewal date must lie within 400 days of when the charge was paid.
--       EXECUTE: rekoda_app and rekoda_worker (settlement runs in the API's verify path and in the
--       worker's billing job).
--
--   subscription_operator_set_plan(business, plan, expires, actor)
--       The operator path (POST /v1/businesses/plan, `ops:billing`). The plan must be one of the
--       five known plans; a paid plan's date, when given, must lie in a sanity window (at most 400
--       days back, at most 10 years ahead; the route itself requires a future date, G-114); the
--       actor must be named and may not be `system`. EXECUTE: rekoda_app only (the operator route is served by
--       the API; no worker flow sets a plan this way).
--
--   subscription_expire_plan(business, previous, reason) is unchanged in behaviour (it already
--       took only a lapse to `expired`, guarded on the previous plan and the lapse condition); its
--       inputs are now validated and it refuses an unknown previous plan.
--
-- The trial INSERT is now guarded too: a business created by anyone but the writer role or the
-- table owner must start on `trial` with a trial end no more than 15 days away (TRIAL_DAYS is 14),
-- so the BEFORE UPDATE guard cannot be side-stepped by inserting a paid business.
--
-- The authority stays the ROLE (`current_user` inside the trigger), never a setting. The tenant pin
-- is still checked as defence in depth (and RLS still applies to the writer role), but it is not the
-- authority: the provider writer's authority is the paid charge row.
--
-- STATED LIMIT (OWN-87 report): the application and worker credentials can insert and update
-- `subscription_charges` (0020), so a caller holding one of those credentials could forge a `paid`
-- charge and then apply it. The database cannot tell legitimate application code from a stolen
-- application credential; closing that needs the settlement itself to run under a separate
-- principal (see docs/plans/PR-B-plan.md §5). This migration removes the ability to set an
-- arbitrary plan or date through a single call, and binds every provider plan change to exactly one
-- paid charge.
--
-- Rollback: none past 0196 (OWN-86). Like 0196, this is applied with the api and worker stopped
-- (`scripts/deploy-staging.sh` lists it as compatibility-breaking): a release that still calls
-- `subscription_write_plan` cannot run against it. Re-running it is safe.

-- The writer reads the charge it applies (under RLS and the tenant pin, as every role does).
GRANT SELECT ON subscription_charges TO rekoda_plan_writer;

DROP FUNCTION IF EXISTS public.subscription_write_plan(uuid, text, timestamptz);

CREATE OR REPLACE FUNCTION public.subscription_apply_paid_charge(
  p_business uuid,
  p_reference text,
  p_expires timestamptz
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
-- `public` stays on the path (after pg_catalog): a trigger fired by the writer's UPDATE
-- (release_trial_month_rows, 0176) names its tables unqualified. Every table named here is
-- schema-qualified; PUBLIC holds no CREATE on public.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c record;
BEGIN
  IF p_business IS NULL OR p_reference IS NULL OR length(p_reference) NOT BETWEEN 1 AND 64
     OR p_expires IS NULL THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT business_id, kind, plan, status, paid_at, applied_period_end, unapplied_at
    INTO c
  FROM public.subscription_charges
  WHERE reference = p_reference;
  IF NOT FOUND OR c.business_id IS DISTINCT FROM p_business THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: no such charge for this business'
      USING ERRCODE = '42501';
  END IF;
  IF c.status IS DISTINCT FROM 'paid'
     OR c.kind NOT IN ('first_purchase', 'renewal', 'upgrade')
     OR c.plan IS NULL OR c.plan NOT IN ('chat', 'integrate', 'complete')
     OR c.applied_period_end IS NOT NULL OR c.unapplied_at IS NOT NULL THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: the charge is not a paid, unapplied plan charge'
      USING ERRCODE = '42501';
  END IF;
  IF p_expires < coalesce(c.paid_at, clock_timestamp()) - interval '400 days'
     OR p_expires > coalesce(c.paid_at, clock_timestamp()) + interval '400 days' THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: the renewal date is outside the charge''s cycle'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.businesses SET plan = c.plan, plan_expires_at = p_expires WHERE id = p_business;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_apply_paid_charge: no such business' USING ERRCODE = '42501';
  END IF;
  RETURN c.plan;
END $$;

CREATE OR REPLACE FUNCTION public.subscription_operator_set_plan(
  p_business uuid,
  p_plan text,
  p_expires timestamptz,
  p_actor text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_business IS NULL OR p_plan IS NULL
     OR p_plan NOT IN ('trial', 'expired', 'chat', 'integrate', 'complete')
     OR p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 200 OR p_actor ILIKE 'system%' THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: invalid input' USING ERRCODE = '22023';
  END IF;
  -- A sanity window on a paid plan's date (open-ended is allowed): not more than 400 days in the
  -- past and not more than 10 years ahead, so a garbage date cannot be stored. The stricter rule
  -- that an operator gives a paid plan a FUTURE date (G-114) is the operator route's input rule
  -- and is enforced there (POST /v1/businesses/plan).
  IF p_plan IN ('chat', 'integrate', 'complete') AND p_expires IS NOT NULL
     AND (p_expires < clock_timestamp() - interval '400 days'
          OR p_expires > clock_timestamp() + interval '10 years') THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: the expiry is outside the accepted window'
      USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.businesses SET plan = p_plan, plan_expires_at = p_expires WHERE id = p_business;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_operator_set_plan: no such business' USING ERRCODE = '42501';
  END IF;
END $$;

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
  -- The same race-safe condition as before: somebody who paid, or undid the cancel, between the
  -- caller's read and this write keeps their plan.
  UPDATE public.businesses
  SET plan = 'expired', pending_plan = NULL, plan_decided_at = clock_timestamp(), updated_at = now()
  WHERE id = p_business AND plan = p_previous
    AND CASE WHEN p_reason = 'grace' THEN payment_failed_at IS NOT NULL
             ELSE pending_plan = 'expired' END;
  RETURN FOUND;
END $$;

ALTER FUNCTION public.subscription_apply_paid_charge(uuid, text, timestamptz) OWNER TO rekoda_plan_writer;
ALTER FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text) OWNER TO rekoda_plan_writer;
ALTER FUNCTION public.subscription_expire_plan(uuid, text, text) OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.subscription_apply_paid_charge(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subscription_expire_plan(uuid, text, text) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text)
    FROM rekoda_worker;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
GRANT EXECUTE ON FUNCTION public.subscription_apply_paid_charge(uuid, text, timestamptz)
  TO rekoda_app, rekoda_worker;
GRANT EXECUTE ON FUNCTION public.subscription_operator_set_plan(uuid, text, timestamptz, text)
  TO rekoda_app;
GRANT EXECUTE ON FUNCTION public.subscription_expire_plan(uuid, text, text)
  TO rekoda_app, rekoda_worker;

-- A new business starts on its trial unless the writer role or the table owner creates it.
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
  IF NEW.plan IS DISTINCT FROM 'trial'
     OR (NEW.plan_expires_at IS NOT NULL AND NEW.plan_expires_at > now() + interval '15 days') THEN
    RAISE EXCEPTION
      'a new business starts on its trial; plan and plan_expires_at change only through the subscription writers (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS businesses_plan_fields_insert_guard ON businesses;
CREATE TRIGGER businesses_plan_fields_insert_guard
  BEFORE INSERT ON businesses
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.businesses_plan_fields_insert_guard();
