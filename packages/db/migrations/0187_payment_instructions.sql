-- REM-04 / OWN-64: the merchant's own, approved bank details for customers to pay into.
--
-- A debt reminder must give the customer an actionable way to settle. Rekoda never invents bank
-- details and never uses its own subscription checkout for a customer's invoice, so the destination
-- is entered by the merchant (owner only) and carries the moment of approval. A reminder uses these
-- only when all three fields and the approval are present (the CHECK keeps that all-or-nothing);
-- removal clears every column. The business's existing RLS covers the row; no new table.
--
-- Safe on a populated table: every column is nullable and the CHECK holds for all-NULL rows.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS payment_bank_name text,
  ADD COLUMN IF NOT EXISTS payment_account_name text,
  ADD COLUMN IF NOT EXISTS payment_account_number text,
  ADD COLUMN IF NOT EXISTS payment_instruction_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_instruction_approved_by uuid;

ALTER TABLE businesses
  ADD CONSTRAINT businesses_payment_instruction_all_or_nothing CHECK (
    (payment_bank_name IS NULL AND payment_account_name IS NULL AND payment_account_number IS NULL
       AND payment_instruction_approved_at IS NULL)
    OR
    (payment_bank_name IS NOT NULL AND payment_account_name IS NOT NULL
       AND payment_account_number ~ '^[0-9]{10}$' AND payment_instruction_approved_at IS NOT NULL)
  ) NOT VALID;
ALTER TABLE businesses VALIDATE CONSTRAINT businesses_payment_instruction_all_or_nothing;
