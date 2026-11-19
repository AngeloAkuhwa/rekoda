-- OD-51.7 (owner instruction, 12 Nov 2026, PR #432): one intended pack purchase is credited once,
-- however many payment links it ended up with.
--
-- A pending pack charge that is no longer at today's price is retired and today's charge opened in
-- its place (0212). The retired charge's Paystack link can still be paid, and Rekoda cannot rely on
-- Paystack cancelling it. Each charge is honest at the instant it was priced, so each passed the
-- settlement price check and each credited the pack: a merchant who paid both links got the pack
-- twice, with no automatic refund (recorded in OD-51 as residual limit 7). A plan charge was never
-- applied twice (the second payment is set aside, G-104); a pack had no such rule.
--
-- After this migration a charge carries the identity of the purchase it belongs to:
--
--   * `purchase_id` is set when a charge is opened. A replacement for a retired pending charge of
--     the same business and pack takes that charge's `purchase_id` (the application names the
--     charge it replaces; the insert guard checks it). Any other charge gets a new one.
--   * At most ONE charge per (business, purchase) may ever carry `units_credited_at` (a unique
--     index, so the rule holds whatever code or credential runs the settlement).
--   * `purchase_id` never changes after the insert, for any runtime role.
--
-- Settlement (apps/api `applySettledCharge`) checks the purchase before it credits: the first
-- verified payment of a purchase grants the units; a later verified payment of the same purchase is
-- recorded as paid and set aside for an operator (`unapplied_reason = 'duplicate_purchase'`), never
-- dropped and never credited. When a purchase is credited, its other still-payable charges are
-- retired, so buying the pack again opens a NEW purchase rather than handing back a link that would
-- be set aside.
--
-- Existing rows: every existing charge gets its own `purchase_id` (it was its own purchase as far as
-- the database can tell). Nothing else about them is rewritten; no payment, credit or ledger row is
-- touched.
--
-- Rollback: additive (one column, one index, one trigger). The previous release ignores the column
-- (its inserts get a fresh default) and never violates the index unless it credits two charges that
-- THIS release linked, which only this release's replacement path can create. Re-running is safe.

ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS purchase_id uuid NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS subscription_charges_purchase_ix
  ON subscription_charges (business_id, purchase_id);

-- The rule itself: one credit per purchase.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_charges_one_credit_per_purchase_ux
  ON subscription_charges (business_id, purchase_id)
  WHERE units_credited_at IS NOT NULL;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_purchase_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  sibling record;
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.purchase_id IS DISTINCT FROM OLD.purchase_id THEN
      RAISE EXCEPTION 'the purchase a charge belongs to is set when it is opened (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- INSERT: a charge that names an existing purchase must be a replacement for it. The lookup runs
  -- as the caller, under its tenant pin: a purchase id of another business is simply unknown here
  -- and is its own purchase in this one (the unique index is per business).
  FOR sibling IN
    SELECT kind, pack_id, quantity, units_credited_at
    FROM public.subscription_charges
    WHERE business_id = NEW.business_id AND purchase_id = NEW.purchase_id
  LOOP
    IF NEW.kind <> 'add_on' OR sibling.kind <> 'add_on'
       OR sibling.pack_id IS DISTINCT FROM NEW.pack_id
       OR sibling.quantity IS DISTINCT FROM NEW.quantity THEN
      RAISE EXCEPTION 'a charge continues a purchase only as a replacement for the same pack (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    IF sibling.units_credited_at IS NOT NULL THEN
      RAISE EXCEPTION 'that purchase is already credited; a new purchase gets a new identity (OD-51)'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_purchase_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS subscription_charges_purchase_guard ON subscription_charges;
CREATE TRIGGER subscription_charges_purchase_guard
  BEFORE INSERT OR UPDATE OF purchase_id ON subscription_charges
  FOR EACH ROW
  EXECUTE FUNCTION rekoda_private.subscription_charges_purchase_guard();
