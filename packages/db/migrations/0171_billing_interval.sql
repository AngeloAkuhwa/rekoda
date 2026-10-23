-- G-110 (OWN-40, owner ruling 23 Oct 2026): Rekoda launches with monthly AND
-- annual billing, annual = monthly x 10. The plan catalogue has held the annual
-- price rows since 0105, but nothing recorded WHICH interval a subscription is
-- on, so every cycle, renewal and charge was a month by construction.
--   businesses.billing_interval          the interval the CURRENT cycle was bought on
--   businesses.pending_billing_interval  a switch waiting for the next renewal
--                                        (NULL: none). Like a scheduled downgrade,
--                                        a switch never discards service already paid for.
--   businesses.interval_decided_at       when the interval switch last changed (NULL: never). Undoing a
--                                        scheduled plan change restores the decision time from before it,
--                                        and must not roll back past this one (G-104).
--   subscription_charges.billing_interval the interval a charge was opened for, so
--                                        the cycle it buys is fixed when it is opened
-- Every existing row was bought, or arranged by an operator, as a month: 'monthly'
-- is the truthful backfill. Whether a cycle may be prorated stays decided by its
-- origin and length (OWN-33, OWN-34), never by this column.
ALTER TABLE businesses
  ADD COLUMN billing_interval text NOT NULL DEFAULT 'monthly'
    CHECK (billing_interval IN ('monthly', 'annual')),
  ADD COLUMN pending_billing_interval text
    CHECK (pending_billing_interval IN ('monthly', 'annual')),
  ADD COLUMN interval_decided_at timestamptz;

ALTER TABLE subscription_charges
  ADD COLUMN billing_interval text NOT NULL DEFAULT 'monthly'
    CHECK (billing_interval IN ('monthly', 'annual'));
