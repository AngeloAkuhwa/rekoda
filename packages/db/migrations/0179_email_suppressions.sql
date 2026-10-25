-- N7 slice 2 (OWN-49, OWN-55): an address that bounced for good, or whose owner marked a
-- Rekoda email as spam, is never mailed again.
--
-- Platform-wide, not tenant-owned: a mailbox that rejects Rekoda rejects it for every
-- merchant, and the webhook that learns of it knows no business. So there is no business_id
-- and no tenant policy. Only the SHA-256 of the lower-cased address is kept, not the address. An
-- unkeyed hash is still linkable by anyone who can guess the address, so the table is personal
-- data: an operator removes a row for an erasure request (OWN-52) by hashing the address.
CREATE TABLE IF NOT EXISTS email_suppressions (
  address_hash      text PRIMARY KEY CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  reason            text NOT NULL CHECK (reason IN ('bounced', 'complained')),
  -- The provider's delivery id for the event that caused it, for audit; not the address.
  provider_event_id text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The API role records and reads suppressions (the webhook and the sender). It may not
-- change or delete one: lifting a suppression is an operator act, not a request path.
GRANT SELECT, INSERT ON email_suppressions TO rekoda_app;
-- Default privileges (0004) also hand the API role UPDATE and DELETE on a new table; take them back.
REVOKE UPDATE, DELETE ON email_suppressions FROM rekoda_app;
-- Default privileges (0004) hand every new table to the worker; it has no use for this one.
REVOKE ALL ON email_suppressions FROM rekoda_worker;
