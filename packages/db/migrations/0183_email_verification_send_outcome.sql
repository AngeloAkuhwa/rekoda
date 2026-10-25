-- Billing Slice C (OWN-58): remember how the confirmation email's hand-over ended.
--
-- A request that timed out after the provider may have accepted the mail is neither "sent" nor
-- "not sent". The row stays valid (the link may arrive), still counts against the hourly allowance,
-- and records `uncertain` so the billing page can say so instead of guessing. A send the provider
-- definitely refused is voided as before (voided_at), and a send it accepted is `accepted`.
-- NULL is a link issued before this column existed or not yet handed over. Nullable and
-- expand-only: the previous release ignores it. No address is stored here.
ALTER TABLE billing_email_verifications
  ADD COLUMN IF NOT EXISTS send_outcome text
    CHECK (send_outcome IN ('accepted', 'uncertain'));
