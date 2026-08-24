-- Graduation telemetry (ADR 0019, fix-plan 6 M5d).
--
-- A Paystack Starter account stops collecting at a N2,000,000 lifetime cap,
-- and "a merchant who discovers the cap by having collections stop mid-sale
-- is a merchant Rekoda failed". Answering "who is approaching it" is
-- cross-tenant by nature, exactly like the margin report: the operator
-- asking does not know which tenants to ask about. Same policy shape as
-- 0019, same reasoning, and FOR SELECT only for the same reason -- a report
-- must never hand a handler cross-tenant write reach by inheritance.
CREATE POLICY ops_read_payments ON payments
  FOR SELECT
  TO rekoda_worker
  USING (true);

-- The one-time nudge's memory: set when the merchant is told they are
-- approaching the cap, so a message meant as a milestone never becomes a
-- drumbeat. On the connection row because the cap is a fact about their
-- provider account, not about any one payment.
ALTER TABLE payment_connections
  ADD COLUMN IF NOT EXISTS graduation_nudged_at timestamptz;
