-- Review A of the PR #432 closeout round (IMPORTANT, financial truth): a credited pack's refund
-- judges the allowance only after it holds the period's usage counter.
--
-- `subscription_record_refund` (0235, 0240) read the recorded allowance, `usage_entitlement` and the
-- allowance history BEFORE it locked the counter row. Each PL/pgSQL statement takes its own READ
-- COMMITTED snapshot, so while the refund waited for the counter (held by a consumer):
--   1. the refund read the allowance: unchanged since the credit, so it went on;
--   2. a downgrade (or an add-on holding ending, or a trial expiring) committed;
--   3. consumption, metered by `usage_reserve` against the lower allowance plus the pack's bonus,
--      spent pack units and committed;
--   4. the refund took the counter, judged `used` against the allowance recorded at the credit,
--      found the pack "unused", revoked it and recorded a full refund of a pack that was spent.
-- That matches neither serial order (reproduced deterministically: packages/db/src/billing/
-- pack-refund-concurrency.integration.test.ts, "a downgrade and consumption that spends the pack").
--
-- The allowance checks now run after the counter `FOR UPDATE`: any consumption committed before the
-- lock was granted is in `used`, any allowance change it relied on committed before it and is in the
-- later statement's snapshot, and no consumption can commit after the lock until the refund ends.
-- Nothing else changes: the lock order is still the charge, then the counter (no new lock, no new
-- cycle); owner, grants, signature, messages and every other rule are unchanged.
--
-- Not a compatibility break: the function is replaced in place with the same signature and result.
-- Re-running is safe; re-running 0235 or 0240 afterwards would put back the earlier order.

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
    -- lock. Read before it, a downgrade (or a holding ending, or a trial expiring) committing while
    -- this refund waited for the counter, and consumption that then spent pack units under the lower
    -- allowance, were both invisible: the pack looked unused and was refunded. Every consumption
    -- that committed before this lock was granted is now in `used`, and any allowance change it
    -- relied on committed before it, so the next statement's fresh snapshot sees that change.
    -- R09: "unused" is judged against the allowance the pack was credited beside, and only while the
    -- allowance is still exactly that; a changed allowance is the owner's decision (OD-55).
    SELECT entitlement INTO e FROM public.pack_credit_entitlements WHERE charge_id = c.id;
    IF NOT FOUND
       OR public.usage_entitlement(p_business, c.credited_unit) IS DISTINCT FROM e.entitlement
       -- 0240 (A-1): equal now is not unchanged throughout. Any change of the plan, its version or
       -- an add-on holding after the credit (a downgrade and back, a holding ended and restarted)
       -- could have made consumption need the pack, so the rule cannot decide.
       OR EXISTS (SELECT 1 FROM public.business_allowance_changes a
                  WHERE a.business_id = p_business AND a.changed_at >= c.units_credited_at) THEN
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
