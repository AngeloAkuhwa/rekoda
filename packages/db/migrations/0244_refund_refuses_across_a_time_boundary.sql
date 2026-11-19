-- PR #432 closeout round G (owner instruction, 18 Nov 2026, "natural allowance expiry during a
-- refund"): a credited pack's refund also refuses when the allowance changed by TIME alone.
--
-- 0243 judged the allowance after the counter lock but, as its header stated, through
-- `usage_entitlement` (0222), which evaluates against `now()`: the refund transaction's START. Three
-- things change the allowance by the passing of time, with no write the history (0240, 0241) sees:
--   * a trial's `plan_expires_at` passing (the trial reads `expired`, which sells nothing);
--   * a catalogue version of the plan taking effect or ending, for a business whose pin does not
--     choose a version of that plan (a trial has no pin);
--   * an add-on holding's `started_at` or `ends_at` passing (`endHolding` writes a future end: a
--     cancellation that takes effect at the period's close).
-- Reproduced deterministically at 0243 (packages/db/src/billing/
-- pack-refund-natural-expiry.integration.test.ts):
--   1. a refund that started before a holding's end (or a trial's expiry) and waited for the charge
--      row judged the allowance as it was at its start, while consumption that started after the
--      boundary metered against the lower allowance, spent pack units and committed: the spent pack
--      was refunded in full and its units revoked;
--   2. an allowance that dips and comes back by time alone (a holding ends, the next starts later)
--      is equal at the credit and at the refund, so consumption in the dip that spent the pack was
--      likewise refunded as unused.
--
-- The refund now also refuses, for the owner (OD-55, unchanged wording), when any such boundary
-- falls in (credit, clock_timestamp()], the clock read after the counter lock: every consumption
-- counted in `used` committed before the lock was granted, so it started, and judged its own
-- allowance, inside that window; none can commit after it until the refund ends. The lower end is
-- the earliest of the credit's recorded entitlement time, the credit and this transaction's start,
-- so the instant `pack_credit_entitlements` was judged at, and the one `usage_entitlement` is judged
-- at here, are both inside it. With no boundary in the window the allowance was constant across it,
-- so the existing equality check is then a check of the whole interval.
--
-- Why not evaluate `usage_entitlement` at the clock instead: equality at a later instant still
-- misses a dip (case 2), and changing `usage_entitlement` itself would change what every consumer
-- meters. Rejected: replacing `now()` with `clock_timestamp()` globally (it would let two statements
-- of one consumption disagree about the allowance).
--
-- Nothing else changes: lock order (the charge, then the counter), owner, grants, signature, result
-- and every message are those of 0243. The new function is owned by the migration owner, not
-- SECURITY DEFINER, executable by no runtime role (it runs inside the refund, as its owner), and
-- requires the caller's tenant pin like the functions it mirrors.
-- Not a compatibility break: additive (a new private function; the refund replaced in place, same
-- signature). Re-running is safe; re-running 0235, 0240 or 0243 afterwards would put back the
-- earlier definition (the pre-start smoke pins this one by the md5 of its body).

CREATE OR REPLACE FUNCTION rekoda_private.pack_allowance_boundary_between(
  p_business uuid,
  p_unit text,
  p_from timestamptz,
  p_to timestamptz
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
BEGIN
  IF p_business IS NULL OR p_unit IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'pack_allowance_boundary_between: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'pack_allowance_boundary_between: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT plan, plan_expires_at, plan_version_id INTO b
  FROM public.businesses WHERE id = p_business;
  IF NOT FOUND THEN
    RETURN true; -- nothing to judge by: never "unchanged"
  END IF;
  -- Each rule below is the one `usage_entitlement` (0222) applies at an instant; a value it reads
  -- changes exactly at these boundaries, so none in (p_from, p_to] means none changed.
  -- A trial past its date reads `expired`.
  IF b.plan = 'trial' AND b.plan_expires_at > p_from AND b.plan_expires_at <= p_to THEN
    RETURN true;
  END IF;
  -- The version in force, for the plan (and `expired`, for a trial), unless the pin chooses one.
  IF EXISTS (
    SELECT 1 FROM public.plan_versions pv
    WHERE (pv.plan_id = b.plan OR (b.plan = 'trial' AND pv.plan_id = 'expired'))
      AND NOT EXISTS (SELECT 1 FROM public.plan_versions pin
                      WHERE pin.id = b.plan_version_id AND pin.plan_id = pv.plan_id)
      AND ((pv.effective_from > p_from AND pv.effective_from <= p_to)
        OR (pv.effective_to > p_from AND pv.effective_to <= p_to))) THEN
    RETURN true;
  END IF;
  -- A holding that grants this unit every month, starting or ending.
  IF EXISTS (
    SELECT 1 FROM public.business_add_ons h
    JOIN public.add_on_grants g ON g.add_on_id = h.add_on_id AND g.version = h.version
    WHERE h.business_id = p_business
      AND g.grant_kind = 'MONTHLY_UNITS' AND g.unit = p_unit
      AND ((h.started_at > p_from AND h.started_at <= p_to)
        OR (h.ends_at > p_from AND h.ends_at <= p_to))) THEN
    RETURN true;
  END IF;
  RETURN false;
END $$;

REVOKE ALL ON FUNCTION rekoda_private.pack_allowance_boundary_between(uuid, text, timestamptz, timestamptz)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.subscription_record_refund(p_business uuid, p_reference text, p_amount bigint, p_reason text, p_actor text, p_provider_refund text)
 RETURNS TABLE(status text, refunded_k bigint, revoked_units integer, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  c record;
  m record;
  r record;
  e record;
  v_ceiling bigint;
  v_revoked integer := 0;
  v_status text;
BEGIN
  IF p_business IS NULL OR p_reference IS NULL OR p_amount IS NULL OR p_amount < 1
     OR p_actor IS NULL OR p_actor !~ '^operator:[!-~]{1,255}$'
     OR p_provider_refund IS NULL OR p_provider_refund !~ '^[A-Za-z0-9_.:-]{1,100}$'
     OR p_reason IS NULL OR p_reason NOT IN ('duplicate_charge', 'incorrect_amount',
       'service_failure', 'unused_add_on', 'suspension_error') THEN
    RAISE EXCEPTION 'subscription_record_refund: a business, a reference, a positive amount, an operator:<subject> actor, the provider refund id and one of the ADR 0024 reasons are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'subscription_record_refund: the business is not the pinned tenant'
      USING ERRCODE = '42501';
  END IF;
  SELECT id, kind, s.status, amount_k, refunded_amount_k, units_credited_at, credited_units,
         credited_unit, credited_period, units_revoked_at INTO c
  FROM public.subscription_charges s
  WHERE business_id = p_business AND reference = p_reference
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription_record_refund: that charge cannot be refunded by that amount'
      USING ERRCODE = '22023';
  END IF;

  -- One provider refund is recorded once (R06). Read after the charge lock, so a concurrent call for
  -- this charge has committed or rolled back its row by now.
  SELECT charge_id, amount_k, x.revoked_units INTO r
  FROM public.subscription_refunds x
  WHERE x.provider = 'paystack' AND x.provider_refund_id = p_provider_refund;
  IF FOUND THEN
    IF r.charge_id = c.id AND r.amount_k = p_amount THEN
      RETURN QUERY SELECT c.status, c.refunded_amount_k, r.revoked_units, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'subscription_record_refund: that provider refund is already recorded with another charge or amount'
      USING ERRCODE = '22023';
  END IF;

  IF c.status NOT IN ('paid', 'refunded') OR c.refunded_amount_k + p_amount > c.amount_k THEN
    RAISE EXCEPTION 'subscription_record_refund: that charge cannot be refunded by that amount'
      USING ERRCODE = '22023';
  END IF;

  IF c.kind = 'add_on' AND c.units_credited_at IS NOT NULL THEN
    -- A credited pack: a full refund of an unused pack within seven days, its units revoked.
    IF c.units_revoked_at IS NOT NULL OR c.refunded_amount_k <> 0 OR p_amount <> c.amount_k THEN
      RAISE EXCEPTION 'subscription_record_refund: a credited pack is refunded only once, in full (a partial refund of a pack is not approved)'
        USING ERRCODE = '22023';
    END IF;
    IF c.units_credited_at < now() - interval '7 days' THEN
      RAISE EXCEPTION 'subscription_record_refund: a pack is refundable only within seven days of its credit'
        USING ERRCODE = '22023';
    END IF;
    IF c.credited_units IS NULL OR c.credited_unit IS NULL OR c.credited_period IS NULL THEN
      RAISE EXCEPTION 'subscription_record_refund: this pack was credited before its units were recorded (0230); settle it by hand'
        USING ERRCODE = '22023';
    END IF;
    SELECT used, bonus INTO m FROM public.usage_counters
    WHERE business_id = p_business AND period = c.credited_period AND unit = c.credited_unit
    FOR UPDATE;
    -- 0243 (review A of the closeout round, IMPORTANT): the allowance is judged AFTER the counter
    -- lock. Read before it, a downgrade or holding change committing while this refund waited for
    -- the counter, and consumption that then spent pack units under the lower allowance, were both
    -- invisible: the pack looked unused and was refunded. Every consumption
    -- that committed before this lock was granted is now in `used`, and any allowance change it
    -- relied on committed before it, so the next statement's fresh snapshot sees that change.
    -- R09: "unused" is judged against the allowance the pack was credited beside, and only while the
    -- allowance is still exactly that; a changed allowance is the owner's decision (OD-55).
    SELECT entitlement, recorded_at INTO e FROM public.pack_credit_entitlements WHERE charge_id = c.id;
    IF NOT FOUND
       OR public.usage_entitlement(p_business, c.credited_unit) IS DISTINCT FROM e.entitlement
       -- 0240 (A-1): equal now is not unchanged throughout. Any change of the plan, its version or
       -- an add-on holding after the credit (a downgrade and back, a holding ended and restarted)
       -- could have made consumption need the pack, so the rule cannot decide.
       OR EXISTS (SELECT 1 FROM public.business_allowance_changes a
                  WHERE a.business_id = p_business AND a.changed_at >= c.units_credited_at)
       -- 0244: nor did it change by TIME alone. A trial's expiry, a catalogue version taking effect
       -- or ending, and an add-on holding starting or ending write nothing, so the history above
       -- cannot see them; and `usage_entitlement` reads them at this transaction's start, which can
       -- be long before this point when the refund waited for a lock. Any such boundary between the
       -- credit and now (the clock, read after the counter lock, so it is later than the start of
       -- every consumption counted in `used`) could have made consumption need the pack.
       OR rekoda_private.pack_allowance_boundary_between(p_business, c.credited_unit,
            least(now(), e.recorded_at, c.units_credited_at), clock_timestamp()) THEN
      RAISE EXCEPTION 'subscription_record_refund: the plan allowance for this unit is not the one the pack was credited beside, so whether the pack was used cannot be shown; this refund needs an owner decision (OD-55)'
        USING ERRCODE = '22023';
    END IF;
    v_ceiling := e.entitlement::bigint + coalesce(m.bonus, 0) - c.credited_units;
    IF coalesce(m.used, 0) > v_ceiling THEN
      RAISE EXCEPTION 'subscription_record_refund: the pack has been used; a used pack is not refundable'
        USING ERRCODE = '22023';
    END IF;
    UPDATE public.usage_counters
    SET bonus = greatest(bonus - c.credited_units, 0), updated_at = now()
    WHERE business_id = p_business AND period = c.credited_period AND unit = c.credited_unit;
    v_revoked := c.credited_units;
  END IF;

  BEGIN
    INSERT INTO public.subscription_refunds
      (business_id, charge_id, provider_refund_id, amount_k, reason, actor, revoked_units)
    VALUES (p_business, c.id, p_provider_refund, p_amount, p_reason, p_actor, v_revoked);
  EXCEPTION WHEN unique_violation THEN
    -- The same provider refund recorded for another business's charge (invisible here under RLS).
    RAISE EXCEPTION 'subscription_record_refund: that provider refund is already recorded with another charge or amount'
      USING ERRCODE = '22023';
  END;

  UPDATE public.subscription_charges s SET
    refunded_amount_k = s.refunded_amount_k + p_amount,
    status = CASE WHEN s.refunded_amount_k + p_amount >= s.amount_k THEN 'refunded' ELSE s.status END,
    refunded_at = now(),
    units_revoked_at = CASE WHEN v_revoked > 0 THEN now() ELSE s.units_revoked_at END,
    updated_at = now()
  WHERE s.id = c.id
  RETURNING s.status INTO v_status;

  INSERT INTO public.audit_events
    (business_id, actor, entity, entity_id, action, new_value, source_type)
  VALUES (p_business, p_actor, 'subscription_charge', p_reference, 'refunded',
          jsonb_build_object('amountK', p_amount, 'reason', p_reason, 'status', v_status,
                             'revokedUnits', v_revoked, 'providerRefundId', p_provider_refund),
          'operator');
  RETURN QUERY SELECT v_status, (c.refunded_amount_k + p_amount)::bigint, v_revoked, false;
END $function$;
