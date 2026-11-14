-- Final remediation of PR #432 (owner brief, 15 Nov 2026): refunded packs and refund authorisation.
--
-- Owner decisions: a refunded pack's remaining units are revoked; a full refund is allowed only for
-- an unused pack within seven days. Partial refunds of a used pack are NOT approved, so none is
-- implemented (no formula is invented). And refund authorisation (OD-53): only an authorised actor
-- records a refund, auditably, and the application credential cannot bypass it.
--
-- Before 0230 the application credential recorded a refund (`POST /v1/ops/refund` on the API ran
-- `subscriptionsRepo.refundCharge` on `rekoda_app`, which the charge guard allowed to move a paid
-- charge to refunded). A refund changed only the charge: a credited pack kept its units, and
-- neither ADR 0024's seven-day window nor its "unused" condition was checked anywhere. Any holder of
-- the application credential could mark any charge refunded with no operator involved.
--
-- After 0230:
--
--   * `subscription_charges` records what a pack credited (`credited_units`, `credited_unit`,
--     `credited_period`, written by `usage_credit_pack` in the call that credits) and when its
--     units were revoked (`units_revoked_at`).
--   * `subscription_record_refund(business, reference, amount, reason, actor)` is the ONE way to
--     record a Rekoda refund: SECURITY DEFINER, `search_path` pinned, EXECUTE for
--     `rekoda_billing_operator` only (the operator process, which verifies the operator's identity
--     and `ops:payment` scope itself, OD-51.1). For a credited pack it refuses anything but a full
--     refund, of an unused pack, within seven days of its credit, and in the same transaction
--     revokes the pack's units from the meter row it was credited to. Every refund writes an audit
--     event (actor, reason, amount, units revoked). A second refund of a credited pack is refused
--     (it is refunded already), so a retried request cannot revoke twice.
--   * The charge guard: the application moves no status at all and writes no refund or credit fact;
--     settlement writes neither either.
--
-- "Unused" (no ruling defines it precisely; recorded in the OD-41 row): on the meter row the pack was
-- credited to, consumption has not needed the pack's units, i.e. used <= the row's ceiling without
-- the pack (`usage_entitlement` + bonus - the pack's units), read now. "Within seven days": the
-- refund is recorded within seven days (exactly 7 x 24 hours) of `units_credited_at`. A pack credited
-- before 0230 has no recorded credit and is refused with a message to settle it by hand.
--
-- A charge that was paid but never credited (a duplicate payment set aside, a price not verified)
-- keeps the existing ADR 0024 rows: refundable in full or in part up to its amount, with no units to
-- revoke.
--
-- Compatibility: the previous release (main, 0192) never refunds through the application in a way
-- this breaks at the database level (main's ops refund route would now be refused: it is the API
-- route this release moves to the operator process). Listed in COMPAT_BREAKING_MIGRATIONS so the
-- API is stopped while it applies. Rollback: none past 0196 (OWN-86). Re-running is safe.

ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS credited_units integer CHECK (credited_units IS NULL OR credited_units > 0),
  ADD COLUMN IF NOT EXISTS credited_unit text,
  ADD COLUMN IF NOT EXISTS credited_period char(7)
    CHECK (credited_period IS NULL OR credited_period ~ '^(TRIAL00|[0-9]{4}-(0[1-9]|1[0-2]))$'),
  ADD COLUMN IF NOT EXISTS units_revoked_at timestamptz;

GRANT UPDATE (credited_units, credited_unit, credited_period) ON subscription_charges
  TO rekoda_usage_writer;

CREATE OR REPLACE FUNCTION public.usage_credit_pack(p_business uuid, p_reference text, p_period text, p_unit text, p_n integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  c record;
  pk record;
  v_source text;
  v_unit text;
  v_n bigint;
  v_at timestamptz;
BEGIN
  IF p_business IS NULL OR p_reference IS NULL OR p_unit IS NULL
     OR p_period IS NULL OR p_period !~ '^(TRIAL00|[0-9]{4}-(0[1-9]|1[0-2]))$'
     OR p_n IS NULL OR p_n < 1 THEN
    RAISE EXCEPTION 'usage_credit_pack: invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_business IS DISTINCT FROM nullif(current_setting('app.business_id', true), '')::uuid THEN
    RAISE EXCEPTION 'usage_credit_pack: the business is not the pinned tenant' USING ERRCODE = '42501';
  END IF;
  SELECT id, kind, status, units_credited_at, unapplied_at, superseded_at, abandoned_at,
         purchase_id, pack_id, quantity, priced_at, created_at, pricing_source, amount_k,
         paid_amount_k, currency INTO c
  FROM public.subscription_charges
  WHERE business_id = p_business AND reference = p_reference
  FOR UPDATE;
  -- A superseded charge may be credited only when it was superseded as a WITHDRAWN LINK (retired
  -- while pending, `abandoned_at` set with it: a reprice replacement or a completed purchase's
  -- sibling) and its payment, already in flight, is the first of its purchase (OD-51.7). Any other
  -- supersession (a paid charge set aside, which also carries `unapplied_at`) is never credited.
  IF NOT FOUND OR c.kind IS DISTINCT FROM 'add_on' OR c.pack_id IS NULL
     OR c.status IS DISTINCT FROM 'paid' OR c.unapplied_at IS NOT NULL
     OR (c.superseded_at IS NOT NULL AND c.abandoned_at IS NULL) THEN
    RAISE EXCEPTION 'usage_credit_pack: not a paid pack charge that may be credited'
      USING ERRCODE = '42501';
  END IF;
  IF c.units_credited_at IS NOT NULL THEN
    RETURN false; -- credited already: a charge raises the ceiling once
  END IF;
  -- One intended purchase is credited once (OD-51.7, 0214), refused here before anything is written
  -- (the unique index on a credited purchase stays the backstop). The charges of the purchase are
  -- serialised by the business row lock settlement takes first (`lockBusiness`).
  IF EXISTS (SELECT 1 FROM public.subscription_charges o
             WHERE o.business_id = p_business AND o.purchase_id = c.purchase_id
               AND o.id <> c.id AND o.units_credited_at IS NOT NULL) THEN
    RAISE EXCEPTION 'usage_credit_pack: this purchase is credited already (OD-51.7)'
      USING ERRCODE = '42501';
  END IF;

  -- The source the charge was priced from; none recorded means the source in force (0215).
  v_source := coalesce(c.pricing_source, (SELECT mode FROM public.billing_pricing_source));
  IF v_source = 'catalogue' THEN
    v_at := coalesce(c.priced_at, c.created_at);
    -- `planCatalogueRepo.usagePackAt`: the version in force at that instant, else the earliest.
    SELECT p.unit, p.quantity, p.price_minor, p.currency INTO pk
    FROM public.usage_packs p
    WHERE p.id = coalesce(
      (SELECT id FROM public.usage_packs
        WHERE pack_id = c.pack_id AND effective_from <= v_at
          AND (effective_to IS NULL OR effective_to > v_at)
        ORDER BY version DESC LIMIT 1),
      (SELECT id FROM public.usage_packs WHERE pack_id = c.pack_id ORDER BY version LIMIT 1));
    IF NOT FOUND THEN
      RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought (no catalogue version of the pack)'
        USING ERRCODE = '42501';
    END IF;
    v_unit := pk.unit;
    -- `UNIT_SCALE`: voice is sold in minutes and counted in seconds (ADR 0028).
    v_n := pk.quantity::bigint * c.quantity
           * CASE WHEN pk.unit = 'VOICE_MINUTES' THEN 60 ELSE 1 END;
    IF p_unit IS DISTINCT FROM v_unit OR p_n::bigint IS DISTINCT FROM v_n THEN
      RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought'
        USING ERRCODE = '42501';
    END IF;
    -- What was paid for buys these units: the charge's amount is that version's price x the packs
    -- bought, exactly as the application opens it (`pack.priceK * quantity`) and settlement
    -- re-prices it (OD-51.6). A charge opened for more packs than its amount pays for, or for one
    -- kobo, credits nothing.
    IF c.amount_k IS DISTINCT FROM pk.price_minor::bigint * c.quantity THEN
      RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought (the amount is not its price)'
        USING ERRCODE = '42501';
    END IF;
    IF c.currency IS DISTINCT FROM pk.currency THEN
      RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought (not the currency the pack is sold in)'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Constants: the compiled figures are not in the database, so the quantity is settlement's (the
    -- recorded trust boundary). A pack's unit is not a commercial figure: it is the catalogue's.
    SELECT p.unit, p.currency INTO pk
    FROM public.usage_packs p WHERE p.pack_id = c.pack_id ORDER BY p.version LIMIT 1;
    IF p_unit IS DISTINCT FROM pk.unit THEN
      RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought (not the unit the pack sells)'
        USING ERRCODE = '42501';
    END IF;
    IF c.currency IS DISTINCT FROM pk.currency THEN
      RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought (not the currency the pack is sold in)'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- A recorded payment covers the amount (an overpayment still buys the pack; an underpayment never
  -- settles, and a charge marked paid for less is refused here as well). Settlement records the
  -- verified amount on every pack charge it pays (`applySettledCharge` from the Paystack verify),
  -- so a paid pack charge with no amount recorded was not paid through it and credits nothing.
  IF c.paid_amount_k IS NULL THEN
    RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought (no payment amount is recorded)'
      USING ERRCODE = '42501';
  END IF;
  IF c.paid_amount_k < c.amount_k THEN
    RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought (paid less than its amount)'
      USING ERRCODE = '42501';
  END IF;

  -- The row a pack bought now is spent on, for any source: this Lagos month, or the trial row where
  -- the database meters this unit on it (0222). Never last month, never a future month.
  IF rekoda_private.usage_meter_row_at(
       p_business, to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYY-MM'), p_unit, now())::text
     IS DISTINCT FROM p_period THEN
    RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought (not the meter row in use)'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.usage_counters AS u (business_id, period, unit, bonus)
  VALUES (p_business, p_period::char(7), p_unit, p_n)
  ON CONFLICT (business_id, period, unit) DO UPDATE
    SET bonus = u.bonus + p_n, updated_at = now();
  -- 0230: what was credited, where, so a refund revokes exactly it.
  UPDATE public.subscription_charges
  SET units_credited_at = clock_timestamp(), credited_units = p_n, credited_unit = p_unit,
      credited_period = p_period::char(7), updated_at = now()
  WHERE id = c.id;
  RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  -- 0230: the 0224 definition, plus the credit and refund facts below.
  -- 0224: the 0222 definition, plus the set-aside rule below applied to settlement.
  IF TG_OP = 'INSERT' THEN
    IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RETURN NEW;
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.priced_at := coalesce(NEW.priced_at, NEW.created_at);
    IF NEW.priced_at > NEW.created_at + interval '1 minute'
       OR NEW.priced_at < NEW.created_at - interval '5 minutes' THEN
      RAISE EXCEPTION 'a charge is priced at most five minutes before it is opened (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    IF current_user = 'rekoda_settlement' THEN
      IF NEW.units_credited_at IS NOT NULL THEN
        RAISE EXCEPTION 'a pack is credited only through usage_credit_pack (OD-51)'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM 'pending'
       OR NEW.paid_at IS NOT NULL OR NEW.paid_amount_k IS NOT NULL
       OR NEW.provider_reference IS NOT NULL OR NEW.provider_paid_at IS NOT NULL
       OR NEW.provider_settled_at IS NOT NULL OR NEW.units_credited_at IS NOT NULL
       OR NEW.failed_at IS NOT NULL OR NEW.failure_reason IS NOT NULL
       OR NEW.refunded_at IS NOT NULL OR coalesce(NEW.refunded_amount_k, 0) <> 0
       OR NEW.applied_period_start IS NOT NULL OR NEW.applied_period_end IS NOT NULL
       OR NEW.checkout_url IS NOT NULL OR NEW.checkout_started_at IS NOT NULL
       OR NEW.superseded_at IS NOT NULL OR NEW.abandoned_at IS NOT NULL
       OR NEW.unapplied_at IS NOT NULL OR NEW.unapplied_reason IS NOT NULL
       OR NEW.unapplied_resolved_at IS NOT NULL OR NEW.unapplied_resolution IS NOT NULL
       OR NEW.unapplied_resolved_by IS NOT NULL
       OR NEW.blocked_resolved_by IS NOT NULL OR NEW.blocked_resolution IS NOT NULL
       OR NEW.blocked_at IS NOT NULL OR NEW.blocked_reason IS NOT NULL
       OR NEW.blocked_resolved_at IS NOT NULL OR NEW.blocked_close_failed_at IS NOT NULL THEN
      RAISE EXCEPTION 'the application opens only a new pending charge; settlement records the rest (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- usage_credit_pack (0216) runs as rekoda_usage_writer: it may stamp the credit time of a paid
  -- pack charge, once, and change nothing else on the row.
  IF current_user = 'rekoda_usage_writer' THEN
    IF OLD.kind = 'add_on' AND OLD.status = 'paid' AND OLD.unapplied_at IS NULL
       AND (OLD.superseded_at IS NULL OR OLD.abandoned_at IS NOT NULL) -- 0224: as usage_credit_pack
       AND OLD.units_credited_at IS NULL AND NEW.units_credited_at IS NOT NULL
       AND OLD.credited_units IS NULL AND NEW.credited_units IS NOT NULL -- 0230
       AND (to_jsonb(NEW) - 'units_credited_at' - 'updated_at' - 'credited_units' - 'credited_unit'
              - 'credited_period')
           = (to_jsonb(OLD) - 'units_credited_at' - 'updated_at' - 'credited_units' - 'credited_unit'
              - 'credited_period') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the usage writer records only the credit time of a paid pack charge (OD-51)'
      USING ERRCODE = '42501';
  END IF;

  IF current_user = 'rekoda_settlement'
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    IF NEW.priced_at IS DISTINCT FROM OLD.priced_at
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'what a charge buys is set when it is opened (OD-37)' USING ERRCODE = '42501';
    END IF;
    -- 0230: what a pack credited, and its refund, are written by usage_credit_pack and by the
    -- operator's refund alone.
    IF (NEW.credited_units IS DISTINCT FROM OLD.credited_units
        OR NEW.credited_unit IS DISTINCT FROM OLD.credited_unit
        OR NEW.credited_period IS DISTINCT FROM OLD.credited_period
        OR NEW.units_revoked_at IS DISTINCT FROM OLD.units_revoked_at
        OR NEW.refunded_amount_k IS DISTINCT FROM OLD.refunded_amount_k
        OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at)
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'a refund is recorded by the operator alone (0230)' USING ERRCODE = '42501';
    END IF;
    -- The credit time is written by usage_credit_pack alone, in the call that raises the ceiling.
    IF NEW.units_credited_at IS DISTINCT FROM OLD.units_credited_at
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'a pack is credited only through usage_credit_pack (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    -- 0224: settlement moves a charge's status only out of `pending` (`settleCharge` updates only
    -- `WHERE status = 'pending'`; a refund is recorded by the application, paid to refunded). So a
    -- paid, failed or refunded charge cannot be walked back to pending and paid again, which would
    -- get round the rule below.
    IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status IS DISTINCT FROM 'pending'
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'settlement moves a charge''s status only out of pending (OD-37)'
        USING ERRCODE = '42501';
    END IF;
    -- 0224: a link is withdrawn (`abandoned_at`) only while it is pending, never afterwards: a
    -- withdrawn link paid first may still be credited (OD-51.7), so marking a paid charge withdrawn
    -- must not be a way to qualify it.
    IF NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at AND OLD.status IS DISTINCT FROM 'pending'
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'a link is withdrawn only while it is pending (OD-51)' USING ERRCODE = '42501';
    END IF;
    -- 0224: a paid charge set aside or superseded stays so, for settlement too (an operator
    -- resolves it; nothing un-sets it to credit or apply it after all).
    IF OLD.status IN ('paid', 'refunded')
       AND ((OLD.unapplied_at IS NOT NULL AND NEW.unapplied_at IS NULL)
            OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL))
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'a paid charge set aside cannot be put back (OD-37)' USING ERRCODE = '42501';
    END IF;
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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.priced_at IS DISTINCT FROM OLD.priced_at THEN
    RAISE EXCEPTION 'what a charge buys is set when it is opened (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  -- 0230: a refund is the billing operator's (`subscription_record_refund`), no longer the
  -- application's: the application moves no status at all and writes no refund or credit fact.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'only settlement moves a charge''s status; a refund is recorded by the operator (OD-37, 0230)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.refunded_amount_k IS DISTINCT FROM OLD.refunded_amount_k
     OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at
     OR NEW.units_revoked_at IS DISTINCT FROM OLD.units_revoked_at
     OR NEW.credited_units IS DISTINCT FROM OLD.credited_units
     OR NEW.credited_unit IS DISTINCT FROM OLD.credited_unit
     OR NEW.credited_period IS DISTINCT FROM OLD.credited_period THEN
    RAISE EXCEPTION 'a refund is recorded by the operator alone (0230)' USING ERRCODE = '42501';
  END IF;
  IF NEW.paid_at IS DISTINCT FROM OLD.paid_at
     OR NEW.paid_amount_k IS DISTINCT FROM OLD.paid_amount_k
     OR NEW.provider_paid_at IS DISTINCT FROM OLD.provider_paid_at
     OR NEW.provider_settled_at IS DISTINCT FROM OLD.provider_settled_at
     OR NEW.units_credited_at IS DISTINCT FROM OLD.units_credited_at
     -- The provider's transaction id is payment evidence, written by settlement (MVP readiness
     -- review, 0222): the application holds the column grant for the lifecycle columns beside it.
     OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference THEN
    RAISE EXCEPTION 'only settlement records a payment on a charge (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('paid', 'refunded')
     AND ((OLD.unapplied_at IS NOT NULL AND NEW.unapplied_at IS NULL)
          OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL)) THEN
    RAISE EXCEPTION 'a paid charge set aside cannot be put back (OD-37)' USING ERRCODE = '42501';
  END IF;
  -- 0224: as for settlement above.
  IF NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at AND OLD.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'a link is withdrawn only while it is pending (OD-51)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.subscription_record_refund(
  p_business uuid,
  p_reference text,
  p_amount bigint,
  p_reason text,
  p_actor text
) RETURNS TABLE (status text, refunded_k bigint, revoked_units integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c record;
  m record;
  v_ceiling bigint;
  v_revoked integer := 0;
  v_status text;
BEGIN
  IF p_business IS NULL OR p_reference IS NULL OR p_amount IS NULL OR p_amount < 1
     OR p_actor IS NULL OR length(btrim(p_actor)) < 1 OR length(p_actor) > 200
     OR p_reason IS NULL OR p_reason NOT IN ('duplicate_charge', 'incorrect_amount',
       'service_failure', 'unused_add_on', 'suspension_error') THEN
    RAISE EXCEPTION 'subscription_record_refund: a business, a reference, a positive amount, an actor and one of the ADR 0024 reasons are required'
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
  IF NOT FOUND OR c.status NOT IN ('paid', 'refunded')
     OR c.refunded_amount_k + p_amount > c.amount_k THEN
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
    v_ceiling := public.usage_entitlement(p_business, c.credited_unit)::bigint
                 + coalesce(m.bonus, 0) - c.credited_units;
    IF coalesce(m.used, 0) > v_ceiling THEN
      RAISE EXCEPTION 'subscription_record_refund: the pack has been used; a used pack is not refundable'
        USING ERRCODE = '22023';
    END IF;
    UPDATE public.usage_counters
    SET bonus = greatest(bonus - c.credited_units, 0), updated_at = now()
    WHERE business_id = p_business AND period = c.credited_period AND unit = c.credited_unit;
    v_revoked := c.credited_units;
  END IF;

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
                             'revokedUnits', v_revoked),
          'operator');
  RETURN QUERY SELECT v_status, (c.refunded_amount_k + p_amount)::bigint, v_revoked;
END $$;
REVOKE ALL ON FUNCTION public.subscription_record_refund(uuid, text, bigint, text, text)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.subscription_record_refund(uuid, text, bigint, text, text)
  TO rekoda_billing_operator;
