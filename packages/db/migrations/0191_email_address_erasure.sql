-- OD-39 (owner decision, 7 Nov 2026): operator-initiated erasure of one email address.
--
-- Until now the only way to erase an address from the cross-business billing-email limit counter
-- (0185, `billing_email_address_requests`) was a one-shot command run as the database OWNER on the
-- API host (docs/runbooks/data-erasure.md). This gives the same act an authorised operator route
-- (`POST /v1/ops/privacy/email-erasure`, scope `ops:privacy`) without giving the application role
-- any direct access to the counter table, and leaves an append-only receipt.
--
-- What the function does, in the caller's transaction:
--   * deletes every counter row for one address key (a keyed HMAC of the normalised address, never
--     the address), so the address's hourly allowance and cooldown start again from nothing;
--   * writes one receipt row: who (the verified operator subject), why (a closed set of reasons, so
--     no free text that could carry the address), how many counter rows went, and whether a
--     business's billing email was cleared in the same transaction. The receipt holds no address,
--     no key and no business id: a business's own part is receipted in its `audit_events`.
-- A repeat for the same address removes nothing and writes another receipt (idempotent in effect).
--
-- The counter stays shared across businesses (OWN-58, OWN-66): nothing here changes the claim, its
-- figures (5 an hour, 60 seconds apart) or its locking. The function takes the same advisory lock
-- as the claim, so an erasure and a concurrent claim for the address are decided one at a time.
--
-- Not touched, on purpose: `email_suppressions` and `customer_email_optouts` (stop records that keep
-- mail from resuming to someone who bounced, complained or opted out, the same rule
-- `customer_message_optouts` follows), and every financial record.
--
-- Additive only: a new table and a new function; nothing existing changes.
-- Rollback (after the code that calls it is gone):
--   DROP FUNCTION IF EXISTS email_address_erase(text, text, text, boolean);
--   KEEP email_address_erasures: its rows are the receipts of erasures already done, the evidence
--   that a request was honoured. Drop it only after its rows have been exported to the operator's
--   records (COPY email_address_erasures TO a file kept with the audit trail).
--   and delete the row tagged '0191_email_address_erasure' in the migration ledger table (rekoda_migrations).

CREATE TABLE IF NOT EXISTS email_address_erasures (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator              text NOT NULL CHECK (operator ~ '^operator:' AND length(operator) <= 300),
  reason                text NOT NULL CHECK (reason IN ('erasure_request', 'limit_cleared')),
  counter_rows_removed  integer NOT NULL CHECK (counter_rows_removed >= 0),
  billing_email_cleared boolean NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Reached only through the function below: no application role reads, changes or deletes it.
REVOKE ALL ON email_address_erasures FROM PUBLIC;
REVOKE ALL ON email_address_erasures FROM rekoda_app;
REVOKE ALL ON email_address_erasures FROM rekoda_worker;

CREATE OR REPLACE FUNCTION email_address_erase(
  p_address_key text,
  p_operator text,
  p_reason text,
  p_billing_email_cleared boolean
) RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  IF p_address_key IS NULL OR p_address_key !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'email_address_erase: malformed address key';
  END IF;
  IF p_billing_email_cleared IS NULL THEN
    RAISE EXCEPTION 'email_address_erase: billing_email_cleared is required';
  END IF;

  -- The claim's own lock (0185): an erasure and a claim for one address never interleave.
  PERFORM pg_advisory_xact_lock(hashtextextended('billing-email-address:' || p_address_key, 0));

  DELETE FROM public.billing_email_address_requests r WHERE r.address_key = p_address_key;
  GET DIAGNOSTICS removed = ROW_COUNT;

  -- The CHECKs on the receipt refuse a bad operator or reason, which rolls the delete back with it.
  INSERT INTO public.email_address_erasures
    (operator, reason, counter_rows_removed, billing_email_cleared)
  VALUES (p_operator, p_reason, removed, p_billing_email_cleared);

  RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION email_address_erase(text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION email_address_erase(text, text, text, boolean) FROM rekoda_worker;
GRANT EXECUTE ON FUNCTION email_address_erase(text, text, text, boolean) TO rekoda_app;
