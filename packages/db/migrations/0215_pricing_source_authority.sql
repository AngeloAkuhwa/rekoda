-- OD-51.6 (owner instruction, 12 Nov 2026, PR #432): one authoritative source of prices, verified
-- by every process and recorded on every charge.
--
-- Where a price comes from was a per-process environment flag (`REKODA_PLAN_CATALOGUE_READS`): the
-- versioned plan catalogue in this database, or the figures compiled into the release. The API
-- priced a charge with its setting and settlement re-priced it with its own (0209). If the two
-- differed, or the flag changed while charges were pending, honest payments were set aside as
-- `price_not_verified`, and nothing but the deploy runbook kept the two in step (OD-51 limit 6).
--
-- After this migration the source is a fact in the database:
--
--   1. `billing_pricing_source` holds the ONE source in force (`catalogue` or `constants`), and for
--      `constants` the fingerprint of the compiled figures. Only the table owner changes it, through
--      `rekoda_private.set_pricing_source`, which keeps every previous value in
--      `billing_pricing_source_history`. Runtime roles read it; none can write it.
--   2. Every API, worker and settlement process compares its own setting (and, for `constants`, its
--      compiled fingerprint) with this row at start and refuses to start on a difference
--      (`bootChecks.assertPricingSource`): drift is caught before a single charge is priced.
--   3. A charge records the source it was priced from (`subscription_charges.pricing_source`). The
--      insert guard refuses a charge that names a source other than the one in force at that
--      moment, so a process that drifted after it started (or a stolen application credential
--      choosing the cheaper table) opens nothing. A charge that names none is priced at settlement
--      from the source in force then, which is the authoritative one by definition. The column
--      never changes afterwards.
--   4. Settlement re-prices a charge from the source the CHARGE recorded, not from the settling
--      process's own setting: a charge opened honestly before the source was switched still
--      verifies against the prices it was sold at, and a mismatch still sets the payment aside
--      (never a wrong entitlement or pack credit).
--
-- Existing charges keep a NULL `pricing_source` (the source was not recorded when they were
-- opened); settlement prices those with the source in force when it runs, which every process has
-- been checked against. No charge, payment or ledger row is rewritten.
--
-- The row is seeded `catalogue`, the default of `REKODA_PLAN_CATALOGUE_READS` and what staging
-- runs. A deployment that deliberately runs the compiled figures (the documented rollback while a
-- catalogue migration is repaired) must switch the row first: docs/runbooks/deploy.md,
-- "Pricing source".
--
-- Rollback: additive (two tables, one column, one trigger). The previous release writes no
-- `pricing_source`, which the guard accepts, so it keeps working against this schema. Re-running is
-- safe.

CREATE TABLE IF NOT EXISTS billing_pricing_source (
  -- One row, ever.
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode text NOT NULL CHECK (mode IN ('catalogue', 'constants')),
  -- For `constants`: the fingerprint of the compiled price tables every process must carry.
  constants_fingerprint text CHECK (constants_fingerprint IS NULL OR constants_fingerprint ~ '^[0-9a-f]{64}$'),
  set_at timestamptz NOT NULL DEFAULT now(),
  set_by text NOT NULL DEFAULT 'migration:0215',
  reason text NOT NULL DEFAULT 'seeded with the default source',
  CHECK ((mode = 'constants') = (constants_fingerprint IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS billing_pricing_source_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode text NOT NULL,
  constants_fingerprint text,
  set_at timestamptz NOT NULL,
  set_by text NOT NULL,
  reason text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing_pricing_source (id, mode) VALUES (true, 'catalogue')
ON CONFLICT (id) DO NOTHING;

-- Platform configuration, not tenant data: no business_id, so no tenant policy (the RLS exemption
-- register lists both). Read by every runtime role; written by none.
REVOKE ALL ON billing_pricing_source, billing_pricing_source_history
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator;
GRANT SELECT ON billing_pricing_source
  TO rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator;

-- The owner's switch: explicit, with who and why, the previous value kept.
CREATE OR REPLACE FUNCTION rekoda_private.set_pricing_source(
  p_mode text,
  p_constants_fingerprint text,
  p_actor text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('catalogue', 'constants')
     OR (p_mode = 'constants') IS DISTINCT FROM (p_constants_fingerprint IS NOT NULL)
     OR p_actor IS NULL OR length(btrim(p_actor)) < 1
     OR p_reason IS NULL OR length(btrim(p_reason)) < 1 THEN
    RAISE EXCEPTION 'set_pricing_source: a mode (catalogue, or constants with its fingerprint), an actor and a reason are required'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.billing_pricing_source_history (mode, constants_fingerprint, set_at, set_by, reason)
  SELECT mode, constants_fingerprint, set_at, set_by, reason FROM public.billing_pricing_source;
  UPDATE public.billing_pricing_source
  SET mode = p_mode, constants_fingerprint = p_constants_fingerprint,
      set_at = clock_timestamp(), set_by = p_actor, reason = p_reason;
END $$;
REVOKE ALL ON FUNCTION rekoda_private.set_pricing_source(text, text, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- A charge records the source it was priced from; the guard holds it to the source in force.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS pricing_source text
    CHECK (pricing_source IS NULL OR pricing_source IN ('catalogue', 'constants'));

CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_pricing_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_mode text;
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.pricing_source IS DISTINCT FROM OLD.pricing_source THEN
      RAISE EXCEPTION 'the source a charge was priced from is set when it is opened (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT mode INTO v_mode FROM public.billing_pricing_source;
  IF NEW.pricing_source IS NOT NULL AND NEW.pricing_source IS DISTINCT FROM v_mode THEN
    RAISE EXCEPTION 'a charge is priced from the pricing source in force (%), not %; this process is out of step and must be restarted with the authoritative setting (OD-51)',
      coalesce(v_mode, 'none'), NEW.pricing_source
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_pricing_source_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS subscription_charges_pricing_source_guard ON subscription_charges;
CREATE TRIGGER subscription_charges_pricing_source_guard
  BEFORE INSERT OR UPDATE OF pricing_source ON subscription_charges
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.subscription_charges_pricing_source_guard();
