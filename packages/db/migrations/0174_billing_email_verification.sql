-- G-102 slice 2b (OWN-51): the billing email is proven to be the merchant's before a LIVE
-- subscription payment, by a link mailed to it.
--
--   businesses.billing_email_verified_at  when the mailbox was proven (NULL: not proven).
--                                         Reset whenever the address changes, in the same
--                                         statement that changes it.
--   billing_email_verifications           one row per mailed link. The link itself is a
--                                         bearer secret and is never stored: only its
--                                         SHA-256. A row is bound to the address it was
--                                         mailed to by `email_revision` (the business's
--                                         billing_email_revision when it was issued; a counter
--                                         bumped on every change, never a clock reading, so two
--                                         changes in one instant still differ), so a link for an
--                                         address the merchant has since replaced proves nothing
--                                         about the new one. It expires, and it works once.
--
-- No address, plain or sealed, is kept here: the address lives only in
-- businesses.billing_email_sealed, so erasing the account (OWN-52) leaves nothing to chase.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS billing_email_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_email_revision integer NOT NULL DEFAULT 0;

-- A checkout session is started for one address. Binding it to the revision lets a later
-- request see that the address has changed since, and not hand the old session out.
-- NULL for a session that predates this column: its address is unknown.
ALTER TABLE subscription_charge_attempts
  ADD COLUMN IF NOT EXISTS email_revision integer,
  -- Whether the provider key that started the session was a live one. A test-key link is
  -- never presented as a ready live checkout. NULL for a session that predates the column.
  ADD COLUMN IF NOT EXISTS provider_live boolean;

CREATE TABLE IF NOT EXISTS billing_email_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  token_hash    text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  email_revision integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  -- A link that could not be mailed: spent, and not counted against the rate limit.
  voided_at     timestamptz,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_email_verifications_hash_ux
  ON billing_email_verifications (token_hash);
CREATE INDEX IF NOT EXISTS billing_email_verifications_business_ix
  ON billing_email_verifications (business_id, created_at DESC);

ALTER TABLE billing_email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_email_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_email_verifications
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON billing_email_verifications TO rekoda_app;
-- The worker never reads or writes these: a link is requested and confirmed by an owner's
-- session. Default privileges (0004) hand every new table to the worker, so take it back.
REVOKE DELETE ON billing_email_verifications FROM rekoda_app;
REVOKE ALL ON billing_email_verifications FROM rekoda_worker;
