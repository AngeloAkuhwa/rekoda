-- Provider-neutral connection attributes (spec §17.2; P1, PR-052).
--
--   account_ownership   whose account the money lands in
--   representation      how the merchant appears to the provider
--   credential_source   whose credentials the connection runs on
--
-- PLATFORM_ONLY is not a degenerate case: it is the correct description
-- of an aggregator arrangement, and naming it stops that arrangement
-- being mislabelled as a direct merchant relationship it is not.

ALTER TABLE payment_connections
  ADD COLUMN account_ownership text NOT NULL DEFAULT 'MERCHANT_OWNED'
    CONSTRAINT pc_ownership_enum CHECK (account_ownership IN
      ('MERCHANT_OWNED', 'PLATFORM_OWNED')),
  ADD COLUMN representation text NOT NULL DEFAULT 'SUB_MERCHANT'
    CONSTRAINT pc_representation_enum CHECK (representation IN
      ('SUB_MERCHANT', 'DIRECT_MERCHANT', 'PLATFORM_ONLY')),
  ADD COLUMN credential_source text NOT NULL DEFAULT 'PLATFORM_ISSUED'
    CONSTRAINT pc_credential_enum CHECK (credential_source IN
      ('MERCHANT_SUPPLIED', 'PLATFORM_ISSUED', 'OAUTH_DELEGATED'));

/* A merchant on their own key IS the direct merchant on their own
 * credentials; the platform subaccount model represents them as a
 * sub-merchant on platform-issued credentials. Both settle into the
 * merchant's own bank — PLATFORM_OWNED describes no connection that
 * exists today. */
UPDATE payment_connections SET
  representation = 'DIRECT_MERCHANT',
  credential_source = 'MERCHANT_SUPPLIED'
WHERE key_mode = 'merchant_key' AND merchant_key_cipher IS NOT NULL;

/* ── a PR-051 review find, corrected here ───────────────────────────────
 * `storeMerchantKey` marks kyc_status 'not_required': the provider
 * verified that merchant when it issued their own live key, so KYC is not
 * a pending fact but an inapplicable one — and the §17.1 axis reads "has
 * the merchant been verified by the provider", which for a
 * MERCHANT_SUPPLIED credential the key itself answers. The derived
 * column now says so. */
ALTER TABLE payment_connections DROP COLUMN production_enabled;
ALTER TABLE payment_connections
  ADD COLUMN production_enabled boolean
    GENERATED ALWAYS AS (
      operational_status = 'ACTIVE'
      AND kyc_status IN ('verified', 'approved', 'not_required')
      AND commercial_status = 'AGREED'
      AND compliance_status = 'PERMITTED'
    ) STORED;

/* The gate: a live merchant-keyed connection, whose arrangement is its
 * own, must derive enabled once its axes are stamped. */
DO $$
DECLARE broken bigint;
BEGIN
  SELECT count(*) INTO broken FROM payment_connections
  WHERE status = 'active' AND key_mode = 'merchant_key' AND merchant_key_cipher IS NOT NULL
    AND operational_status = 'ACTIVE' AND commercial_status = 'AGREED'
    AND production_enabled IS DISTINCT FROM true;
  IF broken > 0 THEN
    RAISE EXCEPTION 'connection attributes: % live merchant-keyed connections still derive disabled', broken;
  END IF;
END;
$$;
