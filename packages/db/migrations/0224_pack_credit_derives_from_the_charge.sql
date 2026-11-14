-- PR #432 final review (15 Nov 2026): a pack charge credits exactly what it bought.
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
--   * the meter row: the one `rekoda_private.usage_meter_row_at` gives for the caller's period now,
--     which must be the caller's period (the trial row for a trial's base units; otherwise this
--     calendar month, or last month in its first seven days on a row it already opened). A future
--     month, an old month or the trial row of a paid plan is refused.
--
-- A charge with no pack (`pack_id` NULL) is no longer a pack charge that may be credited.
--
-- What this does NOT cover, deliberately: a charge priced from `constants` (the compiled figures,
-- the documented rollback source while a catalogue migration is repaired). Those figures live in
-- the release, not in the database, so the database cannot derive a constants pack's terms and
-- still takes the unit and quantity from settlement, with the meter-row check above. Switching the
-- source to `constants` is the table owner's alone (`rekoda_private.set_pricing_source`, 0215,
-- recorded in its history), and a charge can record `constants` only while it is in force (the
-- 0215 insert guard), so no runtime credential can move a charge into that mode.
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
         created_at, pricing_source INTO c
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
    SELECT p.unit, p.quantity INTO pk
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
  END IF;

  -- The row the database meters this unit on now (0222), for any source.
  IF rekoda_private.usage_meter_row_at(p_business, p_period, p_unit, now())::text
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
