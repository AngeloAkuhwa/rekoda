-- Second independent review of PR #432: refunds of Rekoda's own charges (R04, R06, R09) and the
-- application's charge insert (G1-1).
--
-- R06 (IMPORTANT): `subscription_record_refund` (0230) added an amount to the charge's cumulative
-- `refunded_amount_k` and named no individual provider refund. Recording the same Paystack partial
-- refund twice (a retried request, an operator unsure whether the first call landed) inflated the
-- refunded amount with no second movement of money. Since 0235:
--   * `subscription_refunds` holds one row per provider refund: the charge, the amount, the reason,
--     the verified actor, the units revoked, and the provider's own refund id, which is UNIQUE across
--     Rekoda (a Paystack refund belongs to one transaction of one business).
--   * The function takes that id. The same id for the same charge and amount is a REPLAY: it changes
--     nothing and answers what was recorded (`replayed = true`), so an operator whose first call's
--     outcome is unknown (the provider refund succeeded, the recording timed out) simply records it
--     again. The same id with another amount, another charge or another business is refused as a
--     conflict. Two genuine partial refunds have two ids and are both recorded, up to the charge.
--   * Concurrency: the charge row is locked first (as before), so two calls for one charge are
--     serialised and the second sees the first's row; two calls naming one id for two charges are
--     serialised by the unique index, and the loser is refused.
--   * No money moves: the refund is made in Paystack by the operator; this records that fact.
--
-- R04 (IMPORTANT): the actor follows the shared contract, `operator:<subject>` with a subject of 1 to
-- 255 printable characters (0230 refused a valid subject of 192 to 255 characters and accepted any
-- non-blank text).
--
-- R09 (IMPORTANT): 0230 judged a credited pack "unused" against the unit's allowance read at refund
-- time. A plan whose allowance grew after the credit (an upgrade, a trial converted to a paid plan)
-- made consumption that needed the pack look covered by the plan, so a consumed pack could appear
-- unused and be refunded with its units revoked. Since 0235 `usage_credit_pack` records the unit's
-- allowance at the moment of the credit (`pack_credit_entitlements`), and an automatic pack refund
-- is recorded only when the allowance now is exactly that one (nothing changed the comparison).
-- Otherwise the refund is refused with the reason, for the owner's decision (OD-55 in
-- `REKODA_LAUNCH_READINESS.md`): no formula for a changed allowance is invented. A pack credited
-- before 0235 has no recorded allowance and is refused the same way, as 0230 already refused a pack
-- credited before 0230.
--
-- G1-1 (MINOR): the charge guard's "pristine pending charge" rule for the application's insert now
-- also refuses the 0230 credit and revocation columns preset.
--
-- Compatibility: the refund function's signature changes (a sixth argument); its only caller is this
-- release's operator process, so 0235 is applied with it stopped (COMPAT_BREAKING_MIGRATIONS). The
-- previous release (main, 0192) has none of these objects. Re-running is safe.

CREATE TABLE IF NOT EXISTS subscription_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  charge_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'paystack' CHECK (provider = 'paystack'),
  provider_refund_id text NOT NULL CHECK (provider_refund_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  amount_k bigint NOT NULL CHECK (amount_k > 0),
  reason text NOT NULL CHECK (reason IN ('duplicate_charge', 'incorrect_amount',
    'service_failure', 'unused_add_on', 'suspension_error')),
  actor text NOT NULL CHECK (actor ~ '^operator:[!-~]{1,255}$'),
  revoked_units integer NOT NULL DEFAULT 0 CHECK (revoked_units >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, charge_id) REFERENCES subscription_charges (business_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_refunds_provider_refund_ux
  ON subscription_refunds (provider, provider_refund_id);
CREATE INDEX IF NOT EXISTS subscription_refunds_charge_ix
  ON subscription_refunds (business_id, charge_id, recorded_at);
ALTER TABLE subscription_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_refunds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON subscription_refunds;
CREATE POLICY tenant_isolation ON subscription_refunds
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
-- Read by the merchant's billing history and the operator; written only by the function below.
REVOKE ALL ON subscription_refunds
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator;
GRANT SELECT ON subscription_refunds TO rekoda_app, rekoda_billing_operator;

CREATE TABLE IF NOT EXISTS pack_credit_entitlements (
  charge_id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id),
  unit text NOT NULL,
  period char(7) NOT NULL CHECK (period ~ '^(TRIAL00|[0-9]{4}-(0[1-9]|1[0-2]))$'),
  entitlement integer NOT NULL CHECK (entitlement >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, charge_id) REFERENCES subscription_charges (business_id, id)
);
CREATE INDEX IF NOT EXISTS pack_credit_entitlements_business_ix
  ON pack_credit_entitlements (business_id);
ALTER TABLE pack_credit_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_credit_entitlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pack_credit_entitlements;
CREATE POLICY tenant_isolation ON pack_credit_entitlements
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
REVOKE ALL ON pack_credit_entitlements
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator;
GRANT SELECT, INSERT ON pack_credit_entitlements TO rekoda_usage_writer;

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
       OR NEW.blocked_resolved_at IS NOT NULL OR NEW.blocked_close_failed_at IS NOT NULL
       -- 0235 (G1-1): the 0230 credit and revocation facts are never preset on a new charge.
       OR NEW.credited_units IS NOT NULL OR NEW.credited_unit IS NOT NULL
       OR NEW.credited_period IS NOT NULL OR NEW.units_revoked_at IS NOT NULL THEN
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
  -- 0235 (R09): the unit's plan allowance at the moment of the credit, so a refund can tell whether
  -- consumption needed this pack without reading a later plan's allowance.
  INSERT INTO public.pack_credit_entitlements (charge_id, business_id, unit, period, entitlement)
  VALUES (c.id, p_business, p_unit, p_period::char(7), public.usage_entitlement(p_business, p_unit));
  RETURN true;
END $function$;

ALTER FUNCTION public.usage_credit_pack(uuid, text, text, text, integer)
  OWNER TO rekoda_usage_writer;
REVOKE ALL ON FUNCTION public.usage_credit_pack(uuid, text, text, text, integer)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.usage_credit_pack(uuid, text, text, text, integer)
  TO rekoda_settlement;

DROP FUNCTION IF EXISTS public.subscription_record_refund(uuid, text, bigint, text, text);

CREATE OR REPLACE FUNCTION public.subscription_record_refund(
  p_business uuid,
  p_reference text,
  p_amount bigint,
  p_reason text,
  p_actor text,
  p_provider_refund text
) RETURNS TABLE (status text, refunded_k bigint, revoked_units integer, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
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
       OR public.usage_entitlement(p_business, c.credited_unit) IS DISTINCT FROM e.entitlement THEN
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
END $$;
REVOKE ALL ON FUNCTION public.subscription_record_refund(uuid, text, bigint, text, text, text)
  FROM PUBLIC, rekoda_app, rekoda_worker, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.subscription_record_refund(uuid, text, bigint, text, text, text)
  TO rekoda_billing_operator;
