-- G-102 (OWN-39, owner ruling 23 Oct 2026): a merchant pays Rekoda through a
-- Paystack checkout, using a billing email they give at payment time.
--   businesses.billing_email_sealed  the merchant's billing email, AES-256-GCM sealed
--                                    with the vault key and bound to the business
--                                    (NULL: none yet). Never plaintext at rest: it is
--                                    personal data Rekoda otherwise holds none of.
--   businesses.billing_email_set_at  when it was last set, for the audit trail
--   subscription_charges.checkout_url the Paystack checkout a pending charge was
--                                    initialised with. Paystack refuses a second
--                                    initialisation of the same reference, so a repeat
--                                    request hands back this link instead.
--   subscription_charges.checkout_started_at when that link was created
ALTER TABLE businesses
  ADD COLUMN billing_email_sealed text,
  ADD COLUMN billing_email_set_at timestamptz;

ALTER TABLE subscription_charges
  ADD COLUMN checkout_url text,
  ADD COLUMN checkout_started_at timestamptz;
