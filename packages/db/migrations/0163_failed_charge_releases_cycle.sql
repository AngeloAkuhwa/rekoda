-- G-105: a FAILED first purchase or renewal must not hold its cycle.
--
-- `subscription_charges_cycle_ux` kept one first-purchase/renewal charge per
-- (business, period_start) whatever its status, so a charge the provider
-- declined blocked every retry for that cycle. A failed charge never bought
-- anything and cannot be paid again; releasing the slot lets the retry open a
-- fresh one. Pending and paid charges (and a refunded one, which did buy the
-- cycle) still hold it, so a double-click still cannot mint two payable
-- charges and a paid cycle cannot be sold twice.
DROP INDEX IF EXISTS subscription_charges_cycle_ux;
CREATE UNIQUE INDEX subscription_charges_cycle_ux
  ON subscription_charges (business_id, period_start)
  WHERE kind IN ('first_purchase', 'renewal')
    AND superseded_at IS NULL
    AND status <> 'failed';

-- A pending charge the merchant ABANDONED by asking for another plan the same
-- day is retired (superseded) so only the new link is payable, but it is not
-- stale: nothing newer was decided about the subscription. Paying it later
-- still buys what it promised unless a newer decision exists by then.
ALTER TABLE subscription_charges ADD COLUMN IF NOT EXISTS abandoned_at timestamptz;
