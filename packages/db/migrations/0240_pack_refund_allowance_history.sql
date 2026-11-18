-- Independent review of the PR #432 remediation (A-1, IMPORTANT): a credited pack is judged unused
-- only when nothing that sets the unit's allowance changed after the credit.
--
-- 0235 refused an automatic pack refund unless the unit's allowance NOW equalled the one recorded at
-- the credit. Equal at two moments is not unchanged in between: credited on Complete (200), a
-- renewal-time downgrade to Chat (100) during which 40 of the pack's units are consumed, an upgrade
-- back to Complete, and the refund passed (200 = 200, 140 used <= 200) with the units revoked.
--
-- Since 0240 every change of `businesses.plan` or `plan_version_id`, and every insert, update or
-- delete of a `business_add_ons` holding, records the time in `business_allowance_changes` (one row
-- per business, by trigger, whoever writes). `subscription_record_refund` refuses an automatic pack
-- refund, for the owner's decision (OD-55), when such a change is at or after the credit, as well
-- as when the allowance differs. What is not tracked, and why it is safe: a trial or a holding that
-- ends by its date lowers the allowance without a write, and a lower allowance already fails the
-- equality check; a catalogue edit (owner-only) is outside a merchant's reach.
--
-- The table is tenant data (FORCE RLS, tenant policy, no runtime grant); the trigger function pins
-- the row's own business for its write and restores the caller's pin.
-- Not a compatibility break. Re-running is safe.

CREATE TABLE IF NOT EXISTS business_allowance_changes (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  changed_at timestamptz NOT NULL
);
ALTER TABLE business_allowance_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_allowance_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON business_allowance_changes;
CREATE POLICY tenant_isolation ON business_allowance_changes
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
REVOKE ALL ON business_allowance_changes
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator;

CREATE OR REPLACE FUNCTION rekoda_private.note_allowance_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_business uuid;
  v_pin text := current_setting('app.business_id', true);
BEGIN
  IF TG_TABLE_NAME = 'businesses' THEN
    v_business := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_business := OLD.business_id;
  ELSE
    v_business := NEW.business_id;
  END IF;
  PERFORM set_config('app.business_id', v_business::text, true);
  INSERT INTO public.business_allowance_changes AS a (business_id, changed_at)
  VALUES (v_business, clock_timestamp())
  ON CONFLICT (business_id) DO UPDATE SET changed_at = excluded.changed_at;
  PERFORM set_config('app.business_id', coalesce(v_pin, ''), true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION rekoda_private.note_allowance_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS businesses_note_allowance_change ON businesses;
CREATE TRIGGER businesses_note_allowance_change AFTER UPDATE OF plan, plan_version_id ON businesses
  FOR EACH ROW
  WHEN (OLD.plan IS DISTINCT FROM NEW.plan OR OLD.plan_version_id IS DISTINCT FROM NEW.plan_version_id)
  EXECUTE FUNCTION rekoda_private.note_allowance_change();
DROP TRIGGER IF EXISTS business_add_ons_note_allowance_change ON business_add_ons;
CREATE TRIGGER business_add_ons_note_allowance_change AFTER INSERT OR UPDATE OR DELETE ON business_add_ons
  FOR EACH ROW EXECUTE FUNCTION rekoda_private.note_allowance_change();

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
    SELECT used, bonus INTO m FROM public.usage_counters
    WHERE business_id = p_business AND period = c.credited_period AND unit = c.credited_unit
    FOR UPDATE;
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
