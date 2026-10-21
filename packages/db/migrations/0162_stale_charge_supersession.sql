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
ALTER TABLE subscription_charges ADD COLUMN superseded_at timestamptz;

CREATE INDEX subscription_charges_superseded_ix
  ON subscription_charges (business_id, superseded_at)
  WHERE superseded_at IS NOT NULL;
