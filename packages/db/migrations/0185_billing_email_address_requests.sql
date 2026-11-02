-- OWN-58 (billing Slice C): the billing-email confirmation limits also hold per ADDRESS, across
-- every business. The per-business limits (0174) alone let one person mail a stranger's inbox from
-- many trial businesses.
--
-- Platform-wide, not tenant-owned, like email_suppressions (0179): the count must span businesses,
-- and a tenant-scoped table cannot be counted across tenants by the application role. So there is
-- no business_id and no tenant policy, and nothing here says which business asked: a row holds the
-- SHA-256 of the trimmed, lower-cased address, the SHA-256 of the link's token (to give the
-- allowance back when the mail could not be sent) and two timestamps. An unkeyed hash is still
-- linkable by anyone who can guess the address, so the table is personal data: an operator removes
-- an address's rows for an erasure request (OWN-52) by hashing the address. Pruning old rows is
-- retention work (G-15) and is not done by a request path.
CREATE TABLE IF NOT EXISTS billing_email_address_requests (
  token_hash   text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  address_hash text NOT NULL CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_at    timestamptz
);

CREATE INDEX IF NOT EXISTS billing_email_address_requests_recent
  ON billing_email_address_requests (address_hash, created_at);

-- The API role counts, records, and voids a request whose mail could not be sent. It may not
-- move a timestamp or delete a row: either would reopen the limit.
GRANT SELECT, INSERT ON billing_email_address_requests TO rekoda_app;
-- Default privileges (0004) also hand the API role UPDATE and DELETE on a new table; take them back,
-- then give back only the column a void writes.
REVOKE UPDATE, DELETE ON billing_email_address_requests FROM rekoda_app;
GRANT UPDATE (voided_at) ON billing_email_address_requests TO rekoda_app;
-- Default privileges (0004) hand every new table to the worker; it has no use for this one.
REVOKE ALL ON billing_email_address_requests FROM rekoda_worker;
