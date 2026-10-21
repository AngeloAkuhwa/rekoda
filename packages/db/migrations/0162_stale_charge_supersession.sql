-- G-104 / G-112: a payment for an OLD subscription decision must never
-- overwrite a NEWER one.
--
-- `businesses.plan_decided_at` is when the subscription was last DECIDED
-- (an operator move, a settled plan charge, a scheduled change). A plan charge
-- opened before that moment was priced and promised against a state that no
-- longer exists. `subscription_charges.superseded_at` marks a charge that was
-- paid (the money is real and stays `paid`) whose plan change was refused for
-- that reason, so an operator can reconcile it.
--
-- Existing rows stay NULL: nothing is retroactively superseded.

ALTER TABLE businesses ADD COLUMN plan_decided_at timestamptz;
-- plan_decided_at as it stood before a scheduled change, so undoing that change
-- (a cancelled cancellation) restores it: an undo is not a new decision.
ALTER TABLE businesses ADD COLUMN plan_decided_before_pending timestamptz;
ALTER TABLE subscription_charges ADD COLUMN superseded_at timestamptz;

-- OD-30 (OWN-29): a PAID charge whose plan change was refused stays `paid`, is
-- UNAPPLIED, and waits in the operator exception queue until somebody resolves
-- it (no automatic refund, no automatic credit). `unapplied_at` is when the
-- payment settled and was refused; the SLA clock runs from it.
ALTER TABLE subscription_charges ADD COLUMN unapplied_at timestamptz;
ALTER TABLE subscription_charges ADD COLUMN unapplied_reason text;
ALTER TABLE subscription_charges ADD COLUMN unapplied_resolved_at timestamptz;
ALTER TABLE subscription_charges ADD COLUMN unapplied_resolution text;

CREATE INDEX subscription_charges_unapplied_open_ix
  ON subscription_charges (unapplied_at)
  WHERE unapplied_at IS NOT NULL AND unapplied_resolved_at IS NULL;

CREATE INDEX subscription_charges_superseded_ix
  ON subscription_charges (business_id, superseded_at)
  WHERE superseded_at IS NOT NULL;

-- A stale pending upgrade must not occupy the one-pending-upgrade slot: the
-- merchant's next request opens a fresh charge priced against today's state.
DROP INDEX IF EXISTS subscription_charges_pending_upgrade_ux;
CREATE UNIQUE INDEX subscription_charges_pending_upgrade_ux
  ON subscription_charges (business_id, plan)
  WHERE kind = 'upgrade' AND status = 'pending' AND superseded_at IS NULL;

-- Likewise a stale first purchase or renewal must not hold its cycle: the
-- replacement for the same cycle is priced against today's state.
DROP INDEX IF EXISTS subscription_charges_cycle_ux;
CREATE UNIQUE INDEX subscription_charges_cycle_ux
  ON subscription_charges (business_id, period_start)
  WHERE kind IN ('first_purchase', 'renewal') AND superseded_at IS NULL;
