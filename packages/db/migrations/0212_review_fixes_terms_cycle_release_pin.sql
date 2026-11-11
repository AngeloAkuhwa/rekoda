-- Independent review of the PR #432 remediation (11 Nov 2026, at 5a5ee75), fixed:
--
--   1. (security B1) settlement could rewrite a charge's amount, plan, period or interval AFTER the
--      0210 price check (which runs on INSERT) and settle it against the rewritten terms. What a
--      charge buys is now frozen once opened for EVERY role but the table owner, settlement
--      included (0205 froze it for everyone else).
--   2. (security I1) the upgrade price was prorated over whatever period the caller named, so a
--      period starting in 1900 made an upgrade almost free. An upgrade must now be opened for the
--      business's CURRENT cycle exactly: period_start = cycle_started_at and period_end =
--      plan_expires_at, to the millisecond, which is what `changePlan` opens.
--   3. (financial I1, runtime 1, security I2) a release took the newest reservation with enough
--      left, so two voice notes of different lengths could leave a refunded note's seconds charged,
--      and any role could release another role's consumption. A release now gives back units
--      across the CALLER'S OWN recorded reservations on the row (session role), newest first, and
--      only when they cover the whole amount; otherwise nothing changes. The journal query uses its
--      index (runtime 2).
--   4. (security M2) the grandfathering pin (`plan_version_id`) could be set to any older, cheaper
--      version by settlement or the operator, and the price check trusts it. A pin may now only be
--      kept, or set to the current version of the business's plan (the earliest when none is
--      current), which is all `writeSubscriptionState` ever writes.
--   5. (runtime 3) the staging date tool (OWN-77) moved a paid-to date or a trial end alone,
--      leaving a row 0208 calls non-conforming (and that would block the next staging deploy). It
--      now moves the cycle start, or the trial start, by the same amount.
--
-- What remains true and is stated, not hidden (OD-51 / G-126): settlement is the principal that
-- verifies a payment with the provider, so code running as settlement can still move a pending
-- charge to `paid` without provider evidence the database can see; isolating it in its own process
-- (G-126) is the fix. The meter's allowance is passed in by the application, so the meter is a
-- journalled record whose decrements are bounded by recorded consumption, not a ceiling the
-- database enforces on its own (G-131).
--
-- Rollback: none past 0196 (OWN-86); applied with the api and worker stopped. Re-running is safe.

-- ---------------------------------------------------------------------------------------------
-- 1. What a charge buys is frozen for settlement too.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_terms_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.plan IS DISTINCT FROM OLD.plan
     OR NEW.pack_id IS DISTINCT FROM OLD.pack_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.amount_k IS DISTINCT FROM OLD.amount_k
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'what a charge buys is fixed when it is opened, for every role (review B1)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_terms_frozen() FROM PUBLIC;
DROP TRIGGER IF EXISTS subscription_charges_terms_frozen ON subscription_charges;
CREATE TRIGGER subscription_charges_terms_frozen
  BEFORE UPDATE ON subscription_charges
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.subscription_charges_terms_frozen();

-- ---------------------------------------------------------------------------------------------
-- 2. An upgrade is priced for the business's current cycle, exactly.
-- ---------------------------------------------------------------------------------------------
GRANT SELECT (cycle_started_at, plan_expires_at) ON businesses TO rekoda_price_reader;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_price_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
  expected bigint;
  from_k bigint;
  to_k bigint;
  diff bigint;
  total integer;
  remaining integer;
  lo bigint;
  hi bigint;
BEGIN
  IF pg_has_role(session_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.currency IS DISTINCT FROM 'NGN' THEN
    RAISE EXCEPTION 'a charge is in NGN (brief 5.6)' USING ERRCODE = '42501';
  END IF;
  SELECT plan, plan_version_id, cycle_started_at, plan_expires_at INTO b
  FROM public.businesses WHERE id = NEW.business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a charge belongs to a business' USING ERRCODE = '42501';
  END IF;

  IF NEW.kind IN ('first_purchase', 'renewal') THEN
    expected := rekoda_private.plan_price_minor(NEW.plan, b.plan_version_id,
                                                coalesce(NEW.billing_interval, 'monthly'));
    IF expected IS NULL OR NEW.amount_k IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'the % charge is not at the catalogue price for % (%): expected %, got %',
        NEW.kind, NEW.plan, coalesce(NEW.billing_interval, 'monthly'), expected, NEW.amount_k
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind = 'add_on' THEN
    SELECT up.price_minor INTO expected
    FROM public.usage_packs up
    WHERE up.pack_id = NEW.pack_id AND up.currency = 'NGN'
      AND up.effective_from <= now() AND (up.effective_to IS NULL OR up.effective_to > now())
    ORDER BY up.version DESC LIMIT 1;
    IF expected IS NULL OR NEW.amount_k IS DISTINCT FROM expected
       OR coalesce(NEW.quantity, 1) <> 1 THEN
      RAISE EXCEPTION 'the pack charge is not at the catalogue price for %: expected %, got %',
        NEW.pack_id, expected, NEW.amount_k USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind = 'upgrade' THEN
    from_k := rekoda_private.plan_price_minor(b.plan, b.plan_version_id, 'monthly');
    to_k := rekoda_private.plan_price_minor(NEW.plan, b.plan_version_id, 'monthly');
    diff := to_k - from_k;
    IF from_k IS NULL OR to_k IS NULL OR diff <= 0
       OR NEW.period_start IS NULL OR NEW.period_end IS NULL THEN
      RAISE EXCEPTION 'an upgrade is to a dearer plan within a known cycle (brief 5.6)'
        USING ERRCODE = '42501';
    END IF;
    -- The cycle it upgrades is the business's own (review I1): `changePlan` opens it for
    -- cycle_started_at .. plan_expires_at, carried through a JavaScript Date (milliseconds).
    IF b.cycle_started_at IS NULL OR b.plan_expires_at IS NULL
       OR date_trunc('milliseconds', NEW.period_start) IS DISTINCT FROM date_trunc('milliseconds', b.cycle_started_at)
       OR date_trunc('milliseconds', NEW.period_end) IS DISTINCT FROM date_trunc('milliseconds', b.plan_expires_at) THEN
      RAISE EXCEPTION 'an upgrade is priced for the business''s current cycle (review I1)'
        USING ERRCODE = '42501';
    END IF;
    total := greatest(0, floor(extract(epoch FROM (NEW.period_end - NEW.period_start)) / 86400)::int);
    remaining := greatest(0, floor(extract(epoch FROM (NEW.period_end - clock_timestamp())) / 86400)::int);
    IF total <= 0 THEN
      lo := 0;
      hi := 0;
    ELSE
      -- One day either side: the application prorates on its own clock (planChangeCharge's
      -- `now`), which is the database's within seconds; never a back-dated upgrade.
      lo := floor(diff * least(greatest(remaining - 1, 0), total)::numeric / total)::bigint;
      hi := floor(diff * least(remaining + 1, total)::numeric / total)::bigint;
    END IF;
    IF NEW.amount_k < lo OR NEW.amount_k > hi THEN
      RAISE EXCEPTION 'the upgrade is not at its prorated catalogue price: expected % to %, got %',
        lo, hi, NEW.amount_k USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'unknown charge kind %', NEW.kind USING ERRCODE = '42501';
END $$;
-- CREATE OR REPLACE keeps the owner (rekoda_price_reader) and the trigger of 0210.

-- ---------------------------------------------------------------------------------------------
-- 3. A release gives back the caller's own recorded consumption, across reservations.
-- ---------------------------------------------------------------------------------------------
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
  left_to_give integer := p_n;
  r record;
  take integer;
BEGIN
  IF p_business IS NULL OR p_period IS NULL OR p_unit IS NULL OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_release: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_release: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  -- The meter row first, as every consume does, so two releases (or a release and a consume)
  -- queue on one lock instead of crossing on the journal rows.
  PERFORM 1 FROM public.usage_counters
   WHERE business_id = p_business AND period = p_period::char(7) AND unit = p_unit FOR UPDATE;
  IF (SELECT coalesce(sum(n - released_n), 0) FROM public.usage_reservations
       WHERE business_id = p_business AND period = p_period::char(7) AND unit = p_unit
         AND released_n < n AND reserved_by = session_user
         AND reserved_at > clock_timestamp() - interval '35 days') < p_n THEN
    RETURN false;
  END IF;
  FOR r IN
    SELECT id, n - released_n AS open FROM public.usage_reservations
     WHERE business_id = p_business AND period = p_period::char(7) AND unit = p_unit
       AND released_n < n AND reserved_by = session_user
       AND reserved_at > clock_timestamp() - interval '35 days'
     ORDER BY reserved_at DESC, id
  LOOP
    EXIT WHEN left_to_give = 0;
    take := least(r.open, left_to_give);
    UPDATE public.usage_reservations
       SET released_n = released_n + take, released_at = clock_timestamp(), released_by = session_user
     WHERE id = r.id;
    left_to_give := left_to_give - take;
  END LOOP;
  UPDATE public.usage_counters
     SET used = greatest(used - p_n, 0), updated_at = now()
   WHERE business_id = p_business AND period = p_period::char(7) AND unit = p_unit;
  RETURN true;
END $$;
-- CREATE OR REPLACE keeps the owner (rekoda_meter_writer) and the grants of 0209.

DROP INDEX IF EXISTS usage_reservations_open_ix;
CREATE INDEX IF NOT EXISTS usage_reservations_open_ix
  ON usage_reservations (business_id, period, unit, reserved_by, reserved_at DESC)
  WHERE released_n < n;

-- ---------------------------------------------------------------------------------------------
-- 4. The grandfathering pin: kept, or the current version of the business's plan.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.businesses_plan_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_has_role(session_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.plan_version_id IS NULL OR NEW.plan_version_id = coalesce(
       (SELECT v.id FROM public.plan_versions v
         WHERE v.plan_id = NEW.plan AND v.effective_from <= now()
           AND (v.effective_to IS NULL OR v.effective_to > now())
         ORDER BY v.version DESC LIMIT 1),
       (SELECT v.id FROM public.plan_versions v WHERE v.plan_id = NEW.plan
         ORDER BY v.version LIMIT 1)) THEN
    RETURN NEW;
  END IF;
  -- The test harness's fixture writer (never in a deployed database; 0206) stages older pins.
  IF to_regprocedure('public.test_fixture_set_plan(uuid, text, timestamptz)') IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a plan-version pin is kept or set to the current version of the plan (review M2)'
    USING ERRCODE = '42501';
END $$;
ALTER FUNCTION rekoda_private.businesses_plan_version_guard() OWNER TO rekoda_price_reader;
REVOKE ALL ON FUNCTION rekoda_private.businesses_plan_version_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS businesses_plan_version_guard ON businesses;
CREATE TRIGGER businesses_plan_version_guard
  BEFORE UPDATE OF plan_version_id ON businesses
  FOR EACH ROW
  WHEN (OLD.plan_version_id IS DISTINCT FROM NEW.plan_version_id)
  EXECUTE FUNCTION rekoda_private.businesses_plan_version_guard();

-- ---------------------------------------------------------------------------------------------
-- 5. The staging date tool keeps the row conforming (OWN-77 with OD-49).
-- ---------------------------------------------------------------------------------------------
GRANT UPDATE (cycle_started_at, trial_started_at) ON businesses TO rekoda_plan_writer;

CREATE OR REPLACE FUNCTION public.staging_move_date(
  p_business uuid,
  p_field text,
  p_expected timestamptz,
  p_new timestamptz,
  p_operator text,
  p_reason text,
  p_reverts uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
-- `public` stays on the path (after pg_catalog, before nothing writable by others): a trigger fired
-- by the writer's UPDATE (release_trial_month_rows, 0176) names its tables unqualified and runs with
-- this path. Every table this function names is schema-qualified; PUBLIC holds no CREATE on public.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_plan text;
  v_current timestamptz;
  v_action uuid;
  v_revert record;
BEGIN
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'staging_move_date: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staging_environment) THEN
    RAISE EXCEPTION 'staging_move_date: this database is not marked as staging' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staging_test_businesses WHERE business_id = p_business) THEN
    RAISE EXCEPTION 'staging_move_date: not a designated test business' USING ERRCODE = '42501';
  END IF;
  IF p_operator IS NULL OR length(p_operator) < 3 OR p_reason IS NULL OR length(p_reason) < 4 THEN
    RAISE EXCEPTION 'staging_move_date: operator and reason are required' USING ERRCODE = '22023';
  END IF;

  SELECT plan,
         CASE WHEN p_field IN ('trial_end', 'paid_to') THEN plan_expires_at ELSE payment_failed_at END
    INTO v_plan, v_current
    FROM public.businesses WHERE id = p_business FOR UPDATE;

  IF p_field = 'trial_end' AND v_plan IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION 'staging_move_date: trial_end needs a business on its trial' USING ERRCODE = '22023';
  ELSIF p_field = 'paid_to' AND (v_plan IN ('trial', 'expired') OR v_current IS NULL) THEN
    RAISE EXCEPTION 'staging_move_date: paid_to needs a dated paid plan' USING ERRCODE = '22023';
  ELSIF p_field = 'grace_clock' AND v_current IS NULL THEN
    RAISE EXCEPTION 'staging_move_date: grace_clock needs a renewal in grace' USING ERRCODE = '22023';
  ELSIF p_field NOT IN ('trial_end', 'paid_to', 'grace_clock') THEN
    RAISE EXCEPTION 'staging_move_date: unknown field' USING ERRCODE = '22023';
  END IF;

  -- Compared to the millisecond: the API carries instants as ISO 8601 with milliseconds, so a value
  -- a SQL writer stored with microseconds must still match the value an operator read back.
  IF date_trunc('milliseconds', v_current) IS DISTINCT FROM date_trunc('milliseconds', p_expected) THEN
    RAISE EXCEPTION 'staging_move_date: the value changed since it was read' USING ERRCODE = '40001';
  END IF;

  IF p_reverts IS NULL THEN
    IF p_new IS NULL OR p_new < now() - interval '90 days' OR p_new > now() + interval '90 days' THEN
      RAISE EXCEPTION 'staging_move_date: the new value must be within 90 days of now'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    -- A revert puts back exactly what a move of this business replaced, once.
    SELECT * INTO v_revert FROM public.staging_tool_actions
     WHERE id = p_reverts AND business_id = p_business AND action = 'move_date';
    IF NOT FOUND OR v_revert.field IS DISTINCT FROM p_field
       OR date_trunc('milliseconds', v_revert.after_value)
            IS DISTINCT FROM date_trunc('milliseconds', p_expected)
       OR date_trunc('milliseconds', v_revert.before_value)
            IS DISTINCT FROM date_trunc('milliseconds', p_new) THEN
      RAISE EXCEPTION 'staging_move_date: not a revert of that move' USING ERRCODE = '22023';
    END IF;
    -- Exactly, not to the millisecond: the value must still be precisely what the move wrote, so a
    -- change within the same millisecond by another writer is never overwritten.
    IF v_current IS DISTINCT FROM v_revert.after_value THEN
      RAISE EXCEPTION 'staging_move_date: the value changed since it was read' USING ERRCODE = '40001';
    END IF;
    -- The exact stored value comes back, at full precision, not the caller's millisecond copy.
    p_new := v_revert.before_value;
  END IF;

  -- OD-49 (0208): a moved date keeps the row one Rekoda's durations allow. Moving a paid plan's
  -- paid-to date moves its cycle start by the same amount, and moving a trial's end moves its start,
  -- so the staged business is one a real business could be (a cycle ending in the past is a cycle
  -- that ran out, not one that ended before it began; a moved trial is still 14 days long). A move
  -- to or from an unset date shifts nothing.
  IF p_field = 'grace_clock' THEN
    UPDATE public.businesses SET payment_failed_at = p_new WHERE id = p_business;
  ELSIF p_field = 'paid_to' THEN
    UPDATE public.businesses
       SET plan_expires_at = p_new,
           cycle_started_at = cycle_started_at + coalesce(p_new - v_current, interval '0')
     WHERE id = p_business;
  ELSE
    UPDATE public.businesses
       SET plan_expires_at = p_new,
           trial_started_at = trial_started_at + coalesce(p_new - v_current, interval '0')
     WHERE id = p_business;
  END IF;

  INSERT INTO public.staging_tool_actions
    (business_id, operator, action, field, before_value, after_value, reason, outcome,
     reverts_action_id)
  VALUES (p_business, p_operator, CASE WHEN p_reverts IS NULL THEN 'move_date' ELSE 'revert_date' END,
          p_field, v_current, p_new, p_reason, 'applied', p_reverts)
  RETURNING id INTO v_action;
  RETURN v_action;
END $$;-- CREATE OR REPLACE keeps the owner (rekoda_plan_writer) and the grants of 0197.
