-- OWN-70 (PR B item 4): a renewal raised while Rekoda cannot take the payment is recorded.
--
-- The renewal sweep raises a cycle's renewal charge and starts the grace clock (ADR 0024), and that
-- charge can only be paid through hosted checkout, which `chargeGate` refuses while a live Paystack
-- key is unconfirmed (spec §47, OWN-70) or no usable key is configured. Until now nothing recorded
-- that such a renewal could not be paid. The sweep now stamps the charge: `blocked_at` and
-- `blocked_reason` (the gate's own reason). The renewal row and the grace clock are UNCHANGED
-- (OD-44 is open: no resume and no new expiry policy is built). Nothing here marks a charge paid,
-- creates a Paystack reference or event, or moves the plan.
--
-- An operator sees open blocked renewals on GET /v1/ops/exceptions, an alert fires while any is
-- open, and an operator may close one with a written resolution. A blocked renewal that is later
-- paid, failed or retired leaves the list by its status.
--
-- Rollback: a normal release rollback keeps these columns; the older code ignores them.

ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_reason text,
  ADD COLUMN IF NOT EXISTS blocked_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_resolved_by text,
  ADD COLUMN IF NOT EXISTS blocked_resolution text;

ALTER TABLE subscription_charges
  ADD CONSTRAINT subscription_charges_blocked_reason_ck
  CHECK (blocked_reason IS NULL
         OR blocked_reason IN ('awaiting_platform_confirmation', 'payments_not_configured'));

-- Only a renewal is ever blocked, and only with a reason.
ALTER TABLE subscription_charges
  ADD CONSTRAINT subscription_charges_blocked_shape_ck
  CHECK ((blocked_at IS NULL AND blocked_reason IS NULL)
         OR (blocked_at IS NOT NULL AND blocked_reason IS NOT NULL AND kind = 'renewal'));

-- The operator list and the alert count read open blocked renewals across tenants.
CREATE INDEX IF NOT EXISTS subscription_charges_blocked_open_ix
  ON subscription_charges (blocked_at)
  WHERE blocked_at IS NOT NULL AND blocked_resolved_at IS NULL AND status = 'pending';
