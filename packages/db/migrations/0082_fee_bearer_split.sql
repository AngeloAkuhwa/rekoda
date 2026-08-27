-- EconomicFeeBearer split from ProviderFeePayer (spec §19; P1, PR-056).
--
-- Two different things, and conflating them produces an adapter that
-- cannot be written:
--
--   economic_fee_bearer   who ends up out of pocket. REKODA'S concept.
--                         MERCHANT · CUSTOMER · REKODA · SHARED
--   provider_fee_payer    what we send to the provider. ADAPTER-SPECIFIC
--                         and opaque to the core — paystack accepts
--                         account | subaccount | all | all-proportional,
--                         and has NO customer value, because a customer
--                         bears a fee only if somebody adds a visible line
--                         to the order total (§19.1's PaymentCharge, next
--                         PR). So the column carries no enum: the adapter
--                         that owns the vocabulary validates it.
--
-- The blended `fee_policy` stays for its current readers (the fee split
-- arithmetic); it now DERIVES its meaning from the bearer at write time,
-- and narrows away when the charge model lands.

ALTER TABLE payment_connections
  ADD COLUMN economic_fee_bearer text NOT NULL DEFAULT 'MERCHANT'
    CONSTRAINT pc_fee_bearer_enum CHECK (economic_fee_bearer IN
      ('MERCHANT', 'CUSTOMER', 'REKODA', 'SHARED')),
  ADD COLUMN provider_fee_payer text;

/* The backfill states what each blended value always meant economically:
 * merchant_bearing = the merchant absorbs it; customer_bearing = the
 * customer does (via a visible line, never a provider concept);
 * platform_bearing = Rekoda does. The provider-side value is known only
 * for the paystack rails that exist: the account (or subaccount) pays. */
UPDATE payment_connections SET
  economic_fee_bearer = CASE fee_policy
    WHEN 'customer_bearing' THEN 'CUSTOMER'
    WHEN 'platform_bearing' THEN 'REKODA'
    ELSE 'MERCHANT'
  END,
  provider_fee_payer = CASE
    WHEN provider_type = 'paystack' AND key_mode = 'merchant_key' THEN 'account'
    WHEN provider_type = 'paystack' THEN 'subaccount'
    ELSE NULL
  END;
