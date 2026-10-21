-- G-107: remember what the provider actually took for a subscription charge.
--
-- `amount_k` is what Rekoda asked for. A payment that arrives larger (an
-- overpayment) is accepted, because the month IS paid for, but the excess used
-- to be recorded nowhere. `paid_amount_k` stores the verified amount, so the
-- excess is paid_amount_k - amount_k. Returning it happens at the provider: the ops
-- refund record caps at amount_k, so recording an excess refund there is not built.
-- Null for charges settled before this column and for charges not yet paid.
ALTER TABLE subscription_charges ADD COLUMN IF NOT EXISTS paid_amount_k bigint;
ALTER TABLE subscription_charges DROP CONSTRAINT IF EXISTS subscription_charges_paid_amount_positive;
ALTER TABLE subscription_charges ADD CONSTRAINT subscription_charges_paid_amount_positive
  CHECK (paid_amount_k IS NULL OR paid_amount_k > 0);
