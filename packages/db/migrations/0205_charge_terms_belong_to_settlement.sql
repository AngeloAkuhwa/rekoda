-- OD-37, independent security review of PR #432 (11 Nov 2026, at e848bd9): close the two gaps the
-- 0202 settlement guard left open, both reachable with the general application or worker credential.
--
-- B1. The terms of a PENDING charge were not protected. Settlement checks the provider's verified
--     amount against `amount_k`, applies `billing_interval` months and credits `quantity` packs, all
--     read from the charge. `rekoda_app` and `rekoda_worker` could INSERT a charge with any terms
--     (a year of Complete for 1 kobo) or UPDATE a pending one (monthly to annual, a larger pack
--     quantity), pay the small amount through the normal checkout, and settlement, acting correctly
--     on what it read, would grant what was never paid for.
-- B2. Only a move INTO `paid` was refused. `paid -> pending` was allowed, so a charge already settled
--     could be put back to pending and settled again from the same verified Paystack transaction
--     (pack units credited again, the payment evidence rewritten); a paid charge set aside as
--     unapplied could be reopened.
--
-- After this migration, for every role but `rekoda_settlement` and the table owner:
--   * no INSERT on `subscription_charges` at all: a charge is opened only by code running as
--     settlement, which prices it (the owner's plan change, the pack purchase and the renewal sweep
--     now open charges on the settlement pool);
--   * what a charge buys is frozen from the moment it is opened: business, reference, kind, plan,
--     pack, quantity, amount, currency, provider, interval, period and creation time;
--   * the status may move only from `paid` to `refunded` (a refund, which takes entitlement away);
--     every other transition (into or out of pending, failed, paid or refunded) is settlement's;
--   * a paid charge set aside (`unapplied_at`, `superseded_at`) cannot be put back.
-- The application keeps the lifecycle bookkeeping around a charge: supersede and abandon a pending
-- one (and undo that), its checkout link, the renewal block and its resolution, the unapplied review,
-- the refund amounts, and the applied period it records after the writer (the applied-once guard of
-- 0200 still refuses clearing it).
--
-- Rollback: none past 0196 (OWN-86); applied with the api and worker stopped like 0202 and 0203 (the
-- previous release opens charges on `rekoda_app`). Re-running is safe.

REVOKE INSERT ON subscription_charges FROM rekoda_app, rekoda_worker;
GRANT INSERT ON subscription_charges TO rekoda_settlement;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'rekoda_settlement'
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Unreachable through the grants above; kept so a later GRANT cannot reopen it.
    RAISE EXCEPTION 'only settlement opens a charge (OD-37)' USING ERRCODE = '42501';
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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'what a charge buys is set when settlement opens it (OD-37)'
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
     OR NEW.units_credited_at IS DISTINCT FROM OLD.units_credited_at THEN
    RAISE EXCEPTION 'only settlement records a payment on a charge (OD-37)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('paid', 'refunded')
     AND ((OLD.unapplied_at IS NOT NULL AND NEW.unapplied_at IS NULL)
          OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL)) THEN
    RAISE EXCEPTION 'a paid charge set aside cannot be put back (OD-37)' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION rekoda_private.subscription_charges_settlement_guard() FROM PUBLIC;
