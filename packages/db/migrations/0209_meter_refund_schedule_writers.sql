-- The PR #432 remediation brief (owner, 11 Nov 2026) §5.3 and §5.4: the remaining billing columns
-- the general application credential could write directly are moved behind narrow, validated
-- database functions. A holder of `rekoda_app` or `rekoda_worker` alone can no longer:
--
--   * lower metered consumption (`usage_counters.used`) except by releasing a consumption that was
--     actually recorded, once, for at most what it took, within 35 days (one meter row is one
--     calendar month or one trial); every reservation and release is journalled;
--   * write a counter row at all, or raise its pack credit (`bonus`, settlement only, as before);
--   * invent or alter a refund on a subscription charge: `refunded_amount_k`, `refunded_at` and the
--     move to `refunded` are written only by `subscription_record_refund`, run by the billing
--     operator, bounded by what was actually paid, with the verified operator actor and a reason,
--     and audited in the same statement; the provider fields (`provider_reference`,
--     `failure_reason`) are settlement's;
--   * write the merchant's scheduled change (`pending_plan`, `pending_billing_interval`,
--     `plan_decided_at`, `plan_decided_before_pending`) except through
--     `subscription_schedule_plan` (a cheaper plan than the current one, or a cancellation, on a
--     paid business, or the undo) and `subscription_schedule_interval` (monthly, annual or the
--     undo, on a paid business). The functions carry the exact statements the repository ran
--     (G-104 supersession and revival included), so the merchant's schedule and undo behave as
--     before; the decision times are the database's own clock, never the caller's.
--
-- New NOLOGIN role `rekoda_meter_writer` owns the meter functions and is the only role holding
-- INSERT/UPDATE on `usage_counters` and `usage_reservations`. No runtime role is a member of it.
--
-- Rollback: none past 0196 (OWN-86). Compatibility-breaking (the previous release writes these
-- columns directly on `rekoda_app`): applied with the api and worker stopped like 0202 to 0208.
-- Re-running is safe.

-- ---------------------------------------------------------------------------------------------
-- 1. The meter writer role.
-- ---------------------------------------------------------------------------------------------
DO $$ BEGIN
  CREATE ROLE rekoda_meter_writer NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE rekoda_meter_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$
DECLARE
  offender text;
BEGIN
  SELECT r.member INTO offender
  FROM unnest(ARRAY['rekoda_app', 'rekoda_worker', 'rekoda_settlement', 'rekoda_billing_operator'])
    AS r(member)
  WHERE pg_has_role(r.member, 'rekoda_meter_writer', 'MEMBER')
  LIMIT 1;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0209: % is a member of rekoda_meter_writer; revoke it first', offender
      USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 2. The consumption journal.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  period       char(7) NOT NULL,
  unit         text NOT NULL,
  n            integer NOT NULL CHECK (n > 0),
  released_n   integer NOT NULL DEFAULT 0 CHECK (released_n >= 0 AND released_n <= n),
  reserved_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The login role that asked, not the function owner (session_user inside SECURITY DEFINER).
  reserved_by  text NOT NULL DEFAULT session_user,
  released_at  timestamptz,
  released_by  text
);
CREATE INDEX IF NOT EXISTS usage_reservations_open_ix
  ON usage_reservations (business_id, period, unit, reserved_at DESC)
  WHERE released_n < n;

ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON usage_reservations;
CREATE POLICY tenant_isolation ON usage_reservations
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

REVOKE ALL ON usage_reservations FROM PUBLIC, rekoda_app, rekoda_worker;
GRANT SELECT ON usage_reservations TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON usage_reservations TO rekoda_meter_writer;

-- `usage_counters`: readable as before; written only by the functions below (and by the plan
-- writer's trial-release trigger, 0176, and the retention erasure, which keep their grants).
REVOKE INSERT, UPDATE, DELETE ON usage_counters FROM rekoda_app, rekoda_worker;
GRANT SELECT, INSERT, UPDATE ON usage_counters TO rekoda_meter_writer;

-- ---------------------------------------------------------------------------------------------
-- 3. Consume, release, credit.
-- ---------------------------------------------------------------------------------------------
-- Spend `p_n` units against `p_allowance + bonus`, atomically (the statement `reserveUnit` ran,
-- docs/metering-v1.md §2). Returns the reservation, or NULL when the allowance is exhausted.
CREATE OR REPLACE FUNCTION public.usage_reserve(
  p_business uuid,
  p_period text,
  p_unit text,
  p_allowance integer,
  p_n integer
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  got integer;
  rid uuid;
BEGIN
  IF p_business IS NULL OR p_period IS NULL OR length(p_period) <> 7 OR p_unit IS NULL
     OR p_allowance IS NULL OR p_allowance < 0 OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_reserve: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_reserve: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.usage_counters AS c (business_id, period, unit, used)
  SELECT p_business, p_period::char(7), p_unit, p_n
  WHERE p_n <= p_allowance
     OR EXISTS (SELECT 1 FROM public.usage_counters
                WHERE business_id = p_business AND period = p_period::char(7) AND unit = p_unit)
  ON CONFLICT (business_id, period, unit) DO UPDATE
    SET used = c.used + p_n, updated_at = now()
    WHERE c.used + p_n <= p_allowance + c.bonus
  RETURNING c.used INTO got;
  IF got IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.usage_reservations (business_id, period, unit, n)
  VALUES (p_business, p_period::char(7), p_unit, p_n)
  RETURNING id INTO rid;
  RETURN rid;
END $$;

-- Give back `p_n` units of a recorded consumption on exactly this meter row: the most recent
-- reservation there with at least that much left, recorded within 35 days. Returns false (and
-- changes nothing) when no such consumption exists: a release is never a free decrement.
CREATE OR REPLACE FUNCTION public.usage_release(
  p_business uuid,
  p_period text,
  p_unit text,
  p_n integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rid uuid;
BEGIN
  IF p_business IS NULL OR p_period IS NULL OR p_unit IS NULL OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_release: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_release: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO rid FROM public.usage_reservations
  WHERE business_id = p_business AND period = p_period::char(7) AND unit = p_unit
    AND n - released_n >= p_n AND reserved_at > clock_timestamp() - interval '35 days'
  ORDER BY reserved_at DESC
  LIMIT 1
  FOR UPDATE;
  IF rid IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.usage_reservations
  SET released_n = released_n + p_n, released_at = clock_timestamp(), released_by = session_user
  WHERE id = rid;
  UPDATE public.usage_counters
  SET used = greatest(used - p_n, 0), updated_at = now()
  WHERE business_id = p_business AND period = p_period::char(7) AND unit = p_unit;
  RETURN true;
END $$;

-- Pack units (ADR 0024): settlement only, in the transaction that settles the paid pack. The
-- 0202 bonus guard still refuses a raise by anyone but settlement or the owner.
CREATE OR REPLACE FUNCTION public.usage_credit_bonus(
  p_business uuid,
  p_period text,
  p_unit text,
  p_n integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_business IS NULL OR p_period IS NULL OR length(p_period) <> 7 OR p_unit IS NULL
     OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_credit_bonus: invalid input' USING ERRCODE = '22023';
  END IF;
  IF session_user <> 'rekoda_settlement'
     AND NOT pg_has_role(session_user, (SELECT relowner FROM pg_class
                                        WHERE oid = 'public.usage_counters'::regclass), 'USAGE') THEN
    RAISE EXCEPTION 'usage_credit_bonus: only settlement credits pack units (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_credit_bonus: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.usage_counters AS c (business_id, period, unit, bonus)
  VALUES (p_business, p_period::char(7), p_unit, p_n)
  ON CONFLICT (business_id, period, unit) DO UPDATE SET bonus = c.bonus + p_n, updated_at = now();
END $$;

-- The bonus guard (0202) runs as the current user, which inside the function is the meter writer:
-- it must recognise the settlement session that called it.
CREATE OR REPLACE FUNCTION rekoda_private.usage_counters_bonus_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'rekoda_settlement'
     OR (current_user = 'rekoda_meter_writer' AND session_user = 'rekoda_settlement')
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.bonus > 0)
     OR (TG_OP = 'UPDATE' AND NEW.bonus > OLD.bonus) THEN
    RAISE EXCEPTION 'pack units are credited only by settlement (OD-37)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.usage_reserve(uuid, text, text, integer, integer)',
    'public.usage_release(uuid, text, text, integer)',
    'public.usage_credit_bonus(uuid, text, text, integer)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO rekoda_meter_writer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.usage_reserve(uuid, text, text, integer, integer)
  TO rekoda_app, rekoda_worker;
GRANT EXECUTE ON FUNCTION public.usage_release(uuid, text, text, integer)
  TO rekoda_app, rekoda_worker;
GRANT EXECUTE ON FUNCTION public.usage_credit_bonus(uuid, text, text, integer)
  TO rekoda_settlement;

-- ---------------------------------------------------------------------------------------------
-- 4. Subscription refunds: the billing operator, bounded, audited.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subscription_record_refund(
  p_business uuid,
  p_reference text,
  p_amount_k bigint,
  p_actor text,
  p_reason text
) RETURNS TABLE (status text, refunded_amount_k bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  why text := nullif(btrim(p_reason), '');
  r record;
BEGIN
  IF p_business IS NULL OR p_reference IS NULL OR p_amount_k IS NULL OR p_amount_k < 1
     OR p_actor IS NULL OR p_actor !~ '^operator:[!-~]{1,255}$'
     OR why IS NULL OR length(why) > 500 OR why ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'subscription_record_refund: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_record_refund: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  UPDATE public.subscription_charges c SET
    refunded_amount_k = c.refunded_amount_k + p_amount_k,
    status = CASE WHEN c.refunded_amount_k + p_amount_k >= c.amount_k THEN 'refunded' ELSE c.status END,
    refunded_at = clock_timestamp(),
    updated_at = now()
  WHERE c.reference = p_reference AND c.business_id = p_business
    AND c.status IN ('paid', 'refunded') AND c.paid_at IS NOT NULL
    -- Never more than was actually taken: what settlement recorded as paid, and never more than
    -- the charge itself (the 0020 CHECK).
    AND c.refunded_amount_k + p_amount_k <= least(c.amount_k, coalesce(c.paid_amount_k, c.amount_k))
  RETURNING c.status, c.refunded_amount_k INTO r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_record_refund: that charge cannot be refunded by that amount'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.audit_events
    (business_id, actor, entity, entity_id, action, new_value, reason, source_type)
  VALUES (p_business, p_actor, 'subscription_charge', p_reference, 'refunded',
          jsonb_build_object('amountK', p_amount_k, 'reason', why, 'status', r.status),
          why, 'operator');
  status := r.status;
  refunded_amount_k := r.refunded_amount_k;
  RETURN NEXT;
END $$;

GRANT UPDATE (refunded_amount_k, status, refunded_at, updated_at) ON subscription_charges
  TO rekoda_plan_writer;
ALTER FUNCTION public.subscription_record_refund(uuid, text, bigint, text, text)
  OWNER TO rekoda_plan_writer;
REVOKE ALL ON FUNCTION public.subscription_record_refund(uuid, text, bigint, text, text)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.subscription_record_refund(uuid, text, bigint, text, text)
  TO rekoda_billing_operator;

-- The refund and provider columns, by role. Settlement records the provider's answer; only the
-- refund writer records a refund; the owner repairs.
CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_refund_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF (NEW.refunded_amount_k IS DISTINCT FROM OLD.refunded_amount_k
      OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at
      OR (NEW.status = 'refunded' AND OLD.status IS DISTINCT FROM 'refunded'))
     AND current_user IS DISTINCT FROM 'rekoda_plan_writer' THEN
    RAISE EXCEPTION 'a refund is recorded only through subscription_record_refund (brief 5.3)'
      USING ERRCODE = '42501';
  END IF;
  IF (NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
      OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason)
     AND current_user IS DISTINCT FROM 'rekoda_settlement' THEN
    RAISE EXCEPTION 'the provider''s answer on a charge is settlement''s to record (brief 5.3)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_refund_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS subscription_charges_refund_guard ON subscription_charges;
CREATE TRIGGER subscription_charges_refund_guard
  BEFORE UPDATE OF refunded_amount_k, refunded_at, status, provider_reference, failure_reason
  ON subscription_charges
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.subscription_charges_refund_guard();

-- ---------------------------------------------------------------------------------------------
-- 5. The merchant's scheduled change: validated writers; the columns guarded.
-- ---------------------------------------------------------------------------------------------
-- The monthly price a business pays for `p_plan` today: its pinned version when the pin belongs to
-- that plan (grandfathering), otherwise the plan's current version. NULL when the catalogue has no
-- open NGN monthly price for it.
CREATE OR REPLACE FUNCTION rekoda_private.plan_monthly_price_minor(p_plan text, p_pin uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pp.amount_minor
  FROM public.plan_prices pp
  WHERE pp.currency = 'NGN' AND pp.billing_interval = 'monthly'
    AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
    AND pp.plan_version_id = coalesce(
      (SELECT v.id FROM public.plan_versions v WHERE v.id = p_pin AND v.plan_id = p_plan),
      (SELECT v.id FROM public.plan_versions v
       WHERE v.plan_id = p_plan AND v.effective_from <= now()
         AND (v.effective_to IS NULL OR v.effective_to > now())
       ORDER BY v.version DESC LIMIT 1))
  ORDER BY pp.effective_from DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION rekoda_private.plan_monthly_price_minor(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rekoda_private.plan_monthly_price_minor(text, uuid) TO rekoda_plan_writer;
GRANT SELECT ON plan_prices, plan_versions TO rekoda_plan_writer;

-- `schedulePlanChange` (ADR 0024, G-104), moved into the database whole. `p_plan` NULL is the
-- undo; otherwise a CHEAPER paid plan than the one the business is on (a downgrade at the next
-- renewal) or `expired` (a cancellation at the end of the cycle). The business must be on a paid
-- plan. The statements and their order are the repository's, unchanged.
CREATE OR REPLACE FUNCTION public.subscription_schedule_plan(p_business uuid, p_plan text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
  from_k bigint;
  to_k bigint;
BEGIN
  IF p_business IS NULL OR (p_plan IS NOT NULL AND p_plan NOT IN ('chat', 'integrate', 'complete', 'expired')) THEN
    RAISE EXCEPTION 'subscription_schedule_plan: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_schedule_plan: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  -- Business row first, then charge rows: the order settlement uses (G-104).
  SELECT plan, plan_version_id INTO b FROM public.businesses WHERE id = p_business FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_schedule_plan: no such business' USING ERRCODE = '42501';
  END IF;
  IF p_plan IS NOT NULL THEN
    IF b.plan NOT IN ('chat', 'integrate', 'complete') THEN
      RAISE EXCEPTION 'subscription_schedule_plan: only a paid plan schedules a change'
        USING ERRCODE = '22023';
    END IF;
    IF p_plan <> 'expired' THEN
      from_k := rekoda_private.plan_monthly_price_minor(b.plan, b.plan_version_id);
      to_k := rekoda_private.plan_monthly_price_minor(p_plan, NULL);
      IF from_k IS NULL OR to_k IS NULL OR to_k >= from_k THEN
        RAISE EXCEPTION 'subscription_schedule_plan: only a cheaper plan waits for the renewal; an upgrade is paid now'
          USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  IF p_plan IS NULL THEN
    -- Undo. A renewal opened while the change was pending was priced for the pending plan.
    UPDATE public.subscription_charges c SET superseded_at = clock_timestamp(), updated_at = now()
    FROM public.businesses bb
    WHERE bb.id = p_business AND c.business_id = bb.id
      AND bb.pending_plan IS NOT NULL
      AND c.status = 'pending' AND c.superseded_at IS NULL
      AND c.kind = 'renewal' AND c.plan IS NOT NULL AND c.plan <> bb.plan
      AND c.created_at > coalesce(bb.plan_decided_at, '-infinity'::timestamptz);
    -- A charge only stale because of the schedule is current again (see the repository's note).
    UPDATE public.subscription_charges c SET superseded_at = NULL, updated_at = now()
    FROM public.businesses bb
    WHERE bb.id = p_business AND c.business_id = bb.id
      AND bb.pending_plan IS NOT NULL
      AND c.status = 'pending' AND c.superseded_at IS NOT NULL
      AND c.unapplied_at IS NULL AND c.abandoned_at IS NULL AND c.plan IS NOT NULL
      AND bb.plan_decided_at IS NOT NULL AND bb.plan_decided_before_pending IS NOT NULL
      AND c.created_at >= bb.plan_decided_before_pending AND c.created_at < bb.plan_decided_at
      AND c.superseded_at >= bb.plan_decided_at
      AND (c.kind <> 'renewal'
        OR c.billing_interval IS NOT DISTINCT FROM coalesce(bb.pending_billing_interval, bb.billing_interval))
      AND NOT EXISTS (
        SELECT 1 FROM public.subscription_charges o
        WHERE o.business_id = c.business_id AND o.id <> c.id
          AND o.status = 'pending' AND o.superseded_at IS NULL
          AND o.kind = c.kind
          AND (CASE WHEN c.kind = 'upgrade' THEN o.plan = c.plan
                    ELSE o.period_start IS NOT DISTINCT FROM c.period_start END));
    UPDATE public.businesses SET pending_plan = NULL,
      plan_decided_at = CASE WHEN pending_plan IS NULL
        THEN plan_decided_at ELSE plan_decided_before_pending END,
      plan_decided_before_pending = NULL,
      updated_at = now()
    WHERE id = p_business;
    RETURN;
  END IF;
  -- Replacing a pending change with a different one is a new decision.
  UPDATE public.subscription_charges c SET superseded_at = clock_timestamp(), updated_at = now()
  FROM public.businesses bb
  WHERE bb.id = p_business AND c.business_id = bb.id
    AND bb.pending_plan IS NOT NULL AND bb.pending_plan IS DISTINCT FROM p_plan
    AND c.status = 'pending' AND c.superseded_at IS NULL
    AND c.kind = 'renewal' AND c.plan IS NOT NULL AND c.plan <> bb.plan
    AND c.created_at > coalesce(bb.plan_decided_at, '-infinity'::timestamptz);
  UPDATE public.businesses SET pending_plan = p_plan,
    plan_decided_before_pending = CASE WHEN pending_plan IS NULL
      THEN plan_decided_at ELSE plan_decided_before_pending END,
    plan_decided_at = CASE WHEN pending_plan IS DISTINCT FROM p_plan
      THEN clock_timestamp() ELSE plan_decided_at END,
    updated_at = now()
  WHERE id = p_business;
END $$;

-- `scheduleIntervalChange` (G-110, OWN-40): monthly, annual or the undo (NULL), on a paid
-- business; a renewal priced on the interval it moves away from is withdrawn (G-105).
CREATE OR REPLACE FUNCTION public.subscription_schedule_interval(p_business uuid, p_interval text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_plan text;
BEGIN
  IF p_business IS NULL OR (p_interval IS NOT NULL AND p_interval NOT IN ('monthly', 'annual')) THEN
    RAISE EXCEPTION 'subscription_schedule_interval: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_schedule_interval: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT plan INTO current_plan FROM public.businesses WHERE id = p_business FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_schedule_interval: no such business' USING ERRCODE = '42501';
  END IF;
  IF p_interval IS NOT NULL AND current_plan NOT IN ('chat', 'integrate', 'complete') THEN
    RAISE EXCEPTION 'subscription_schedule_interval: only a paid plan schedules an interval switch'
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.businesses SET pending_billing_interval = p_interval, updated_at = now()
  WHERE id = p_business;
  UPDATE public.subscription_charges c
  SET superseded_at = clock_timestamp(), abandoned_at = clock_timestamp(), updated_at = now()
  FROM public.businesses bb
  WHERE bb.id = p_business AND c.business_id = bb.id
    AND c.kind = 'renewal' AND c.status = 'pending' AND c.superseded_at IS NULL
    AND c.billing_interval IS DISTINCT FROM coalesce(bb.pending_billing_interval, bb.billing_interval);
END $$;

GRANT UPDATE (pending_plan, pending_billing_interval, plan_decided_at, plan_decided_before_pending,
              updated_at) ON businesses TO rekoda_plan_writer;
GRANT UPDATE (superseded_at, abandoned_at, updated_at) ON subscription_charges TO rekoda_plan_writer;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.subscription_schedule_plan(uuid, text)',
    'public.subscription_schedule_interval(uuid, text)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO rekoda_plan_writer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, rekoda_worker, rekoda_billing_operator', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO rekoda_app, rekoda_settlement', f);
  END LOOP;
END $$;

-- The scheduling columns, by role: the writers above (the plan writer), settlement and the
-- billing operator (which write a whole new subscription state), and the owner.
CREATE OR REPLACE FUNCTION rekoda_private.businesses_schedule_fields_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user IN ('rekoda_settlement', 'rekoda_billing_operator', 'rekoda_plan_writer')
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF to_regprocedure('public.test_fixture_set_plan(uuid, text, timestamptz)') IS NOT NULL THEN
    RETURN NEW; -- the integration harness only; refused in a deployed database (0206)
  END IF;
  RAISE EXCEPTION 'a scheduled plan or interval change goes through subscription_schedule_plan or subscription_schedule_interval (brief 5.4)'
    USING ERRCODE = '42501';
END $$;

REVOKE ALL ON FUNCTION rekoda_private.businesses_schedule_fields_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS businesses_schedule_fields_guard ON businesses;
CREATE TRIGGER businesses_schedule_fields_guard
  BEFORE UPDATE OF pending_plan, pending_billing_interval, plan_decided_at, plan_decided_before_pending
  ON businesses
  FOR EACH ROW
  WHEN (OLD.pending_plan IS DISTINCT FROM NEW.pending_plan
        OR OLD.pending_billing_interval IS DISTINCT FROM NEW.pending_billing_interval
        OR OLD.plan_decided_at IS DISTINCT FROM NEW.plan_decided_at
        OR OLD.plan_decided_before_pending IS DISTINCT FROM NEW.plan_decided_before_pending)
  EXECUTE FUNCTION rekoda_private.businesses_schedule_fields_guard();
