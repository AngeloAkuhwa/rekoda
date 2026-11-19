-- PR #432 final engineering review (19 Nov 2026), finding B-1 (IMPORTANT): a pack credited before
-- the upgrade was refunded as if it had never been credited.
--
-- `units_credited_at` was added in 0193 with no backfill, and main (0192) credited a paid pack by
-- writing `usage_counters.bonus` directly. Every pack paid and credited before the upgrade therefore
-- has `units_credited_at` NULL, and 0230 to 0244 applied the pack rules (one full refund, within
-- seven days, unused, units revoked) only `IF c.kind = 'add_on' AND c.units_credited_at IS NOT
-- NULL`. Such a pack was refunded in full or in part with `revoked_units = 0`, the merchant kept its
-- units, and neither the seven-day nor the unused rule ran: against 0230's own header ("a pack
-- credited before 0230 ... is refused ... settle it by hand") and OD-55.
--
-- Since 0193, settlement either credits a paid pack in the same transaction (setting
-- `units_credited_at`) or sets it aside with `unapplied_at`. So a paid pack with neither is exactly a
-- pack credited before 0193, and it is now refused with the existing 0230 wording. A set-aside pack
-- (a second payment for one purchase) added no units and remains refundable.
--
-- Reproduced in packages/db/src/ops/upgrade-from-main.integration.test.ts (the main-era credited
-- pack `RKD-ADD-20261105-MAINCR`, refunded after the upgrade: accepted with no units revoked at 0245).
--
-- Nothing else changes: lock order, owner, grants, signature, result and every other message are
-- those of 0244. Not a compatibility break: additive (the refund replaced in place, same signature).
-- Re-running is safe; re-running 0244 or earlier afterwards would put back the earlier definition
-- (the pre-start smoke pins this one by the md5 of its body).

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
         credited_unit, credited_period, units_revoked_at, pack_id, unapplied_at INTO c
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

  -- 0246: a paid pack with no recorded credit that was not set aside was credited before 0193
  -- recorded credits (main wrote the bonus directly). Its units cannot be revoked and whether it was
  -- used cannot be shown, so it is refused like any pack credited before its units were recorded.
  -- A pack set aside unapplied (a second payment, `unapplied_at`) added no units and stays
  -- refundable: that is the duplicate-payment refund.
  IF c.kind = 'add_on' AND c.pack_id IS NOT NULL AND c.units_credited_at IS NULL
     AND c.unapplied_at IS NULL THEN
    RAISE EXCEPTION 'subscription_record_refund: this pack was credited before its units were recorded (0230); settle it by hand'
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
