-- Billing Slice A: the period a payment ACTUALLY bought, kept apart from the period it was priced for.
--
-- `period_start`/`period_end` are set when a charge is opened, and a first purchase is applied from the
-- moment it settles (a checkout opened on one day and paid on the next buys the later period). The
-- payment record shows what was applied, so settlement now records it here. NULL for a charge that
-- was never applied (pending, failed, refused as stale, a pack) and for one applied before this
-- column existed, which the record then shows no period for rather than guess. Nullable and
-- expand-only; the previous release ignores both columns.
ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS applied_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS applied_period_end timestamptz;
