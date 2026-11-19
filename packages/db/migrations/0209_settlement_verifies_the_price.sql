-- OD-51 (owner instruction, 11 Nov 2026, PR #432 closeout): settlement verifies what a charge costs,
-- so the API no longer needs, or holds, the settlement credential.
--
-- Until now (0205) only `rekoda_settlement` could open a charge, because settlement trusted the
-- price the opener wrote. That put the settlement credential in the API process, which prices and
-- opens every plan and pack charge: a compromised API process held a credential that can record a
-- payment and apply a paid plan, so the separate principal isolated nothing from it.
--
-- The trust now sits where the money is checked. Settlement (the worker's `billing.process`, the
-- only holder of the settlement credential) recomputes a charge's kind and amount at the instant it
-- was priced, from the plan catalogue (or the constant table), the merchant's pinned version, the
-- subscription's guarded cycle columns and the charge's frozen terms, with the same functions the
-- openers use (`expectedChargeTerms`, apps/api/src/billing/billing.service.ts). A charge that
-- disagrees is recorded as paid and set aside for an operator (`price_not_verified`); it is never
-- applied and never credits units. So the opener is no longer trusted, and the application may open
-- a charge again, under the rules below. Everything 0205 froze after opening stays frozen.
--
--   * `priced_at`: the instant the opener priced the charge, which settlement prices at. Written at
--     insert, no more than five minutes before the insert's own clock time and no more than one
--     minute after it (the API host's clock may run slightly ahead of the database's; a later time
--     can only shorten an upgrade's remaining whole days, so at most one day's difference, and only
--     across a midnight inside that minute); frozen after.
--     Rows opened before this migration have none, and are priced at `created_at`.
--   * An insert by any role but settlement and the table owner must be a pristine pending charge:
--     status `pending`, no payment, provider reference, failure, refund, applied period, units,
--     checkout link, supersession, abandonment, block or unapplied review. `created_at` is set to
--     the insert's clock time, whatever the caller sent.
--   * `rekoda_worker` still cannot insert one.
--
-- Rollback: none past 0196 (OWN-86); applied with the api and worker stopped. Re-running is safe.

ALTER TABLE subscription_charges ADD COLUMN IF NOT EXISTS priced_at timestamptz;

GRANT INSERT ON subscription_charges TO rekoda_app;
REVOKE INSERT ON subscription_charges FROM rekoda_worker;

CREATE OR REPLACE FUNCTION rekoda_private.subscription_charges_settlement_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
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
       OR NEW.unapplied_resolved_at IS NOT NULL
       OR NEW.blocked_at IS NOT NULL OR NEW.blocked_reason IS NOT NULL
       OR NEW.blocked_resolved_at IS NOT NULL OR NEW.blocked_close_failed_at IS NOT NULL THEN
      RAISE EXCEPTION 'the application opens only a new pending charge; settlement records the rest (OD-51)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF current_user = 'rekoda_settlement'
     OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    IF NEW.priced_at IS DISTINCT FROM OLD.priced_at
       AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
      RAISE EXCEPTION 'what a charge buys is set when it is opened (OD-37)' USING ERRCODE = '42501';
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
