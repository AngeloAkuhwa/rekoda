-- PR #432 final review (14 Nov 2026): a pack charge credits exactly what it bought.
--
-- `usage_credit_pack` (0216) checked that the charge was a paid, not-set-aside, not-yet-credited
-- add-on charge of the pinned business, then took the unit, the meter row and the number of units
-- from its caller. Only `rekoda_settlement` may call it, but a holder of that credential could
-- credit one legitimate paid pack charge with any unit and any quantity (reproduced: 2,000,000
-- AI actions for one 100-message pack), or credit an add-on charge that carries no pack at all.
-- The settlement process computes the right values (`applySettledCharge`: the pack version in force
-- when the charge was priced, x the packs bought); nothing in the database held it to them.
--
-- After this migration, for a charge priced from the catalogue (the `catalogue` source, which
-- staging and production run, or no recorded source while `catalogue` is in force), the function
-- derives the terms itself and refuses a call that names any others:
--
--   * the pack version: the one in force for `pack_id` at the charge's `priced_at` (else its
--     `created_at`), and when none was in force at that instant the earliest version, exactly as
--     `planCatalogueRepo.usagePackAt` resolves it for settlement;
--   * the unit: that version's unit;
--   * the quantity: that version's quantity x the packs bought (`subscription_charges.quantity`),
--     voice counted in seconds (`UNIT_SCALE`, as `usage_entitlement` counts it);
--   * the amount: the charge's `amount_k` must be that version's price x the packs bought, so a
--     charge opened for many packs at a token amount credits nothing; and a recorded payment
--     (`paid_amount_k`) must cover it;
--   * the meter row: this Lagos month, or the trial row where `rekoda_private.usage_meter_row_at`
--     meters the unit on it. Last month (even in its first seven days), a future month, an old
--     month or the trial row of a paid plan is refused.
--
-- A charge with no pack (`pack_id` NULL) is no longer a pack charge that may be credited.
--
-- And settlement can no longer put a paid charge that was set aside (`unapplied_at`) or superseded
-- back in play: the charge guard's rule "a paid charge set aside cannot be put back" now applies
-- to settlement as it already applied to the application (no code path clears either column on a
-- paid charge). Before, settlement could clear `unapplied_at` on a charge set aside as
-- `price_not_verified` and then credit it.
--
-- What this does NOT cover, deliberately: the QUANTITY of a charge priced from `constants` (the
-- compiled figures, the documented rollback source while a catalogue migration is repaired). Those
-- figures live in the release, not in the database, so the database cannot derive a constants
-- pack's size or price; it still checks the unit (the catalogue's for that pack), the payment and
-- the meter row, and takes the quantity from settlement. Switching the source to `constants` is
-- the table owner's alone (`rekoda_private.set_pricing_source`, 0215, recorded in its history), and
-- a charge can record `constants` only while it is in force (the 0215 insert guard), so no runtime
-- credential can create such a charge while `catalogue` is in force; charges already recorded as
-- `constants` (none exist: the source has been `catalogue` since 0215) keep this boundary.
--
-- A refusal raises (42501): the settlement transaction rolls back, nothing is credited and the
-- charge is not stamped; the job is retried and, past its budget, becomes a dead-job record for an
-- operator. An honest settlement always agrees: it resolves the same version from the same instant
-- through the same catalogue, and a retry recomputes the period from its own clock.
--
-- Compatibility: the signature, the grants and the result are unchanged; the previous release
-- (main, 0192) never calls this function, and this release's settlement passes exactly the derived
-- values. Not compatibility-breaking. Rollback: none past 0196 (OWN-86). Re-running is safe.

GRANT SELECT ON usage_packs, billing_pricing_source TO rekoda_usage_writer;

CREATE OR REPLACE FUNCTION public.usage_credit_pack(
  p_business uuid,
  p_reference text,
  p_period text,
  p_unit text,
  p_n integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
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
  SELECT id, kind, status, units_credited_at, unapplied_at, pack_id, quantity, priced_at,
         created_at, pricing_source, amount_k, paid_amount_k INTO c
  FROM public.subscription_charges
  WHERE business_id = p_business AND reference = p_reference
  FOR UPDATE;
  IF NOT FOUND OR c.kind IS DISTINCT FROM 'add_on' OR c.pack_id IS NULL
     OR c.status IS DISTINCT FROM 'paid' OR c.unapplied_at IS NOT NULL THEN
    RAISE EXCEPTION 'usage_credit_pack: not a paid pack charge that may be credited'
      USING ERRCODE = '42501';
  END IF;
  IF c.units_credited_at IS NOT NULL THEN
    RETURN false; -- credited already: a charge raises the ceiling once
  END IF;

  -- The source the charge was priced from; none recorded means the source in force (0215).
  v_source := coalesce(c.pricing_source, (SELECT mode FROM public.billing_pricing_source));
  IF v_source = 'catalogue' THEN
    v_at := coalesce(c.priced_at, c.created_at);
    -- `planCatalogueRepo.usagePackAt`: the version in force at that instant, else the earliest.
    SELECT p.unit, p.quantity, p.price_minor INTO pk
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
  ELSE
    -- Constants: the compiled figures are not in the database, so the quantity is settlement's (the
    -- recorded trust boundary). A pack's unit is not a commercial figure: it is the catalogue's.
    IF p_unit IS DISTINCT FROM
       (SELECT unit FROM public.usage_packs WHERE pack_id = c.pack_id ORDER BY version LIMIT 1) THEN
      RAISE EXCEPTION 'usage_credit_pack: the credit does not match the pack this charge bought (not the unit the pack sells)'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- A recorded payment covers the amount (an overpayment still buys the pack; an underpayment never
  -- settles, and a charge marked paid for less is refused here as well).
  IF c.paid_amount_k IS NOT NULL AND c.paid_amount_k < c.amount_k THEN
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
  UPDATE public.subscription_charges
  SET units_credited_at = clock_timestamp(), updated_at = now()
  WHERE id = c.id;
  RETURN true;
END $$;

ALTER FUNCTION public.usage_credit_pack(uuid, text, text, text, integer)
  OWNER TO rekoda_usage_writer;
REVOKE ALL ON FUNCTION public.usage_credit_pack(uuid, text, text, text, integer)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.usage_credit_pack(uuid, text, text, text, integer)
  TO rekoda_settlement;

-- ---------------------------------------------------------------------------------------------
-- The charge guard: settlement cannot put a set-aside or superseded paid charge back either.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
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
       AND OLD.units_credited_at IS NULL AND NEW.units_credited_at IS NOT NULL
       AND (to_jsonb(NEW) - 'units_credited_at' - 'updated_at')
           = (to_jsonb(OLD) - 'units_credited_at' - 'updated_at') THEN
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
    -- The credit time is written by usage_credit_pack alone, in the call that raises the ceiling.
    IF NEW.units_credited_at IS DISTINCT FROM OLD.units_credited_at
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'a pack is credited only through usage_credit_pack (OD-51)'
        USING ERRCODE = '42501';
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
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'paid' AND NEW.status = 'refunded') THEN
    RAISE EXCEPTION 'only settlement moves a charge''s status, apart from a refund (OD-37)'
      USING ERRCODE = '42501';
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
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_settlement_guard() FROM PUBLIC;
