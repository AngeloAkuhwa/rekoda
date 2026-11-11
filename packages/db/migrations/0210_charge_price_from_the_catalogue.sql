-- The PR #432 remediation brief (owner, 11 Nov 2026) §5.6: the database does not trust an
-- application-supplied charge amount. Since 0205 only settlement opens a charge and what it buys is
-- frozen once opened; this migration makes the OPENING amount itself independently verifiable
-- against Rekoda's authoritative, immutable, versioned price catalogue (0105, 0106, 0113: closed
-- rows are never edited, a repricing appends a new version), so a defective or compromised
-- settlement process cannot open a cheap charge and settle it consistently against that price.
--
-- Every charge INSERT by any role but the table owner is recomputed here and refused (42501) when
-- it differs:
--   first_purchase  exactly the plan's price for the charge's interval, at the business's pinned
--                   version when the pin is that plan's (grandfathering), else the current version;
--                   a missing annual row is monthly x 10 (OWN-40), as `planPriceKFor`
--   renewal         exactly the same rule for the plan and interval it renews on
--   add_on (pack)   exactly the pack's current catalogue price, in NGN, quantity 1 or none
--   upgrade         the prorated difference of the two plans' MONTHLY prices over the frozen cycle
--                   (`@rekoda/core` planChangeCharge: floor(diff x remaining / total) whole days),
--                   allowing one day either side for the clock the application computed it on;
--                   never more than the full difference, never for a cheaper or the same plan
-- Currency is NGN only (launch scope); an unknown kind is refused.
--
-- The application's own computation (`@rekoda/core`, `plan-terms.ts`) is unchanged: the two must
-- agree, and the parity tests (packages/db/src/billing/charge-price-check.integration.test.ts) pin
-- the database's figures to core's on the same catalogue. Integer kobo throughout.
--
-- With REKODA_PLAN_CATALOGUE_READS=0 the application prices from its constants; the catalogue
-- seeded by 0113 carries the same approved figures, and if they ever differ the charge is refused
-- rather than opened at a figure the catalogue does not hold.
--
-- Rollback: drop the trigger. Re-running is safe.

-- The price of `p_plan` on `p_interval` today for a business pinned to `p_pin`.
CREATE OR REPLACE FUNCTION rekoda_private.plan_price_minor(p_plan text, p_pin uuid, p_interval text)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH v AS (
    SELECT coalesce(
      (SELECT pv.id FROM public.plan_versions pv WHERE pv.id = p_pin AND pv.plan_id = p_plan),
      (SELECT pv.id FROM public.plan_versions pv
       WHERE pv.plan_id = p_plan AND pv.effective_from <= now()
         AND (pv.effective_to IS NULL OR pv.effective_to > now())
       ORDER BY pv.version DESC LIMIT 1)) AS id
  ), price AS (
    SELECT pp.billing_interval, pp.amount_minor
    FROM public.plan_prices pp, v
    WHERE pp.plan_version_id = v.id AND pp.currency = 'NGN'
      AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
  )
  SELECT coalesce(
    (SELECT amount_minor FROM price WHERE billing_interval = p_interval LIMIT 1),
    CASE WHEN p_interval = 'annual'
         THEN (SELECT amount_minor * 10 FROM price WHERE billing_interval = 'monthly' LIMIT 1) END)
$$;
REVOKE ALL ON FUNCTION rekoda_private.plan_price_minor(text, uuid, text) FROM PUBLIC;

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
  -- The table owner (migrations, a repair) is the one exemption, as for every guard. This
  -- function runs as its owner, so the CALLER is the session's role.
  IF pg_has_role(session_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF NEW.currency IS DISTINCT FROM 'NGN' THEN
    RAISE EXCEPTION 'a charge is in NGN (brief 5.6)' USING ERRCODE = '42501';
  END IF;
  SELECT plan, plan_version_id INTO b FROM public.businesses WHERE id = NEW.business_id;
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
    total := greatest(0, floor(extract(epoch FROM (NEW.period_end - NEW.period_start)) / 86400)::int);
    remaining := greatest(0, floor(extract(epoch FROM (NEW.period_end - clock_timestamp())) / 86400)::int);
    IF total <= 0 THEN
      lo := 0;
      hi := 0;
    ELSE
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

-- The check reads the catalogue and the business as its owner, never more.
DO $$ BEGIN
  CREATE ROLE rekoda_price_reader NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE rekoda_price_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA rekoda_private TO rekoda_price_reader;
GRANT SELECT ON plan_versions, plan_prices, usage_packs TO rekoda_price_reader;
GRANT SELECT (id, plan, plan_version_id) ON businesses TO rekoda_price_reader;
ALTER FUNCTION rekoda_private.plan_price_minor(text, uuid, text) OWNER TO rekoda_price_reader;
ALTER FUNCTION rekoda_private.subscription_charges_price_check() OWNER TO rekoda_price_reader;
REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_price_check() FROM PUBLIC;

DROP TRIGGER IF EXISTS subscription_charges_price_check ON subscription_charges;
CREATE TRIGGER subscription_charges_price_check
  BEFORE INSERT ON subscription_charges
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.subscription_charges_price_check();
