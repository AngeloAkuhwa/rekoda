-- Which world a payment connection's money is real in (remediation R4).
--
-- `key_mode` records WHOSE key a connection uses — 'merchant_key' against the
-- platform subaccount — and never which world that key belongs to. A Paystack
-- test key is a valid key: `verifyPaystackKey` accepts it, sandbox charges
-- come back `status: "success"`, and Rekoda booked that against a real
-- invoice as verified money. The merchant's books then said a customer had
-- paid when nobody had.
--
-- NULL means "not a merchant-supplied key" — the platform subaccount path,
-- whose live-key rule is enforced separately at submission (§47).
ALTER TABLE payment_connections ADD COLUMN IF NOT EXISTS provider_environment text;

-- Everything already stored predates the check, so nothing about it is
-- known. TEST is the safe reading: a merchant whose key really is live
-- re-submits it once and the connection is corrected. Defaulting to LIVE
-- would silently bless whatever happens to be in the column today, which is
-- the opposite of what this migration is for.
UPDATE payment_connections
   SET provider_environment = 'TEST'
 WHERE key_mode = 'merchant_key'
   AND provider_environment IS NULL;

ALTER TABLE payment_connections
  DROP CONSTRAINT IF EXISTS payment_connections_environment_enum;
ALTER TABLE payment_connections
  ADD CONSTRAINT payment_connections_environment_enum
  CHECK (provider_environment IS NULL OR provider_environment IN ('LIVE', 'TEST'));
