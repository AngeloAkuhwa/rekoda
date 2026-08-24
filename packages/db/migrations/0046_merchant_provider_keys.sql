-- The merchant's OWN provider key (fix-plan 6, M5a; ADR 0019).
--
-- The platform/subaccount model waits on Paystack's written confirmation
-- (spec paragraph 47); ADR 0019's model does not: the merchant connects
-- their own Paystack account by handing Rekoda their own secret key, money
-- flows merchant-to-merchant, and Rekoda is never in the path. The key is
-- what M5's storefront collection charges against.
--
-- The key lives ONLY as a CONNECTION_KEY cipher, like the settlement account
-- number beside it: one hop in plaintext (form to verification call over
-- TLS), then the vault blob and a tail for the card to render. `key_mode`
-- says which model a connection is on, because one business could hold both
-- facts and every reader needs to know which one is live.
ALTER TABLE payment_connections
  ADD COLUMN IF NOT EXISTS merchant_key_cipher text,
  ADD COLUMN IF NOT EXISTS merchant_key_tail text,
  ADD COLUMN IF NOT EXISTS key_mode text NOT NULL DEFAULT 'platform_subaccount';
