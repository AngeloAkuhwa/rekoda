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

-- The operator list of open blocked renewals (owner ruling OD-47, ADR 0035 Amendment 2). A
-- fixed-column SECURITY DEFINER function, EXECUTE for rekoda_worker alone, at most 200 rows:
-- Rekoda's own reference, the business id, the plan and amount of the renewal, the block reason
-- and time, and the business's plan and paid-to date now. No other column of either table is
-- reachable through it. Reading a row authorises no change: the resolve route runs under the
-- business's own pin and its own operator scope.
CREATE OR REPLACE FUNCTION blocked_renewals_ops(p_limit integer, p_offset integer DEFAULT 0)
RETURNS TABLE (
  reference text,
  business_id uuid,
  plan text,
  amount_k bigint,
  blocked_reason text,
  blocked_at timestamptz,
  current_plan text,
  current_renews_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.reference, c.business_id, c.plan::text, c.amount_k::bigint, c.blocked_reason,
         c.blocked_at, b.plan::text, b.plan_expires_at
  FROM public.subscription_charges c
  JOIN public.businesses b ON b.id = c.business_id
  WHERE c.blocked_at IS NOT NULL AND c.blocked_resolved_at IS NULL
    AND c.status = 'pending' AND c.superseded_at IS NULL
  ORDER BY c.blocked_at, c.reference
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

REVOKE ALL ON FUNCTION blocked_renewals_ops(integer, integer) FROM PUBLIC, rekoda_app;
GRANT EXECUTE ON FUNCTION blocked_renewals_ops(integer, integer) TO rekoda_worker;
