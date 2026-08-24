-- The temporary transfer account on the intent it belongs to (ADR 0016,
-- fix-plan 6 M5c).
--
-- Pay with Transfer hands each transaction its own short-lived account
-- number, and the storefront must show the SAME number again when the
-- customer comes back before it lapses: minting a second account for one
-- live intent would leave real money arriving on a number Rekoda no longer
-- expects. So the account lives on the intent row, beside the reference it
-- answers to, and dies with it. Nothing here is a secret: the number is
-- shown to the paying customer, which is its whole job.
ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS transfer_bank text,
  ADD COLUMN IF NOT EXISTS transfer_account_number text,
  ADD COLUMN IF NOT EXISTS transfer_account_name text,
  ADD COLUMN IF NOT EXISTS transfer_expires_at timestamptz;
