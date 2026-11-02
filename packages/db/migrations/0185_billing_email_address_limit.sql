-- SUB-02a (OWN-58, owner rulings of 2 Nov 2026): a limit on billing-email confirmation requests per
-- ADDRESS, across every business.
--
-- The per-business limit (0174: five an hour, sixty seconds apart) cannot see that ten businesses
-- are asking for the same inbox. This table can. It is a platform-level counter, not tenant data:
--
--   * it holds a keyed HMAC of the normalised address (`billingEmailAddressKeyFor`, MATCH_KEY,
--     `billing-email-address:` keyspace), never the address, and NO business id, so a dump cannot
--     say which businesses share an address and the table carries no RLS policy because it has no
--     tenant column to scope (it is not an entry in docs/rls-exemption-register.md, which lists
--     tables WITH business_id and no policy);
--   * neither application role may touch it directly. `rekoda_app` reaches it only through the two
--     SECURITY DEFINER functions below, from inside the request's tenant transaction; `rekoda_worker`
--     has no access at all;
--   * rows are useful for one hour and are pruned after a day.
--
-- Owner rulings encoded by the caller's figures: at most 5 requests an hour per address and at least
-- 60 seconds between requests. A request is counted when its link is issued, in the same
-- transaction. A request whose hand-over to the provider ended with an UNKNOWN outcome stays counted;
-- only a definite provider refusal releases it (`billing_email_address_release`).
--
-- Concurrency: the claim takes a transaction-scoped advisory lock on the address key before it
-- counts, so concurrent requests for one address (from one business or many) are decided one at a
-- time. The lock is held until the caller's transaction commits, which is also when the counted row
-- becomes visible, so the next claimant's count (READ COMMITTED, a fresh snapshot per statement)
-- includes it. Lock order is business row (taken first by the caller) then address key; a request
-- names one address, so no cycle is possible.
--
-- Erasure: compute the key from the address with the service's MATCH_KEY and, as the owner,
-- `DELETE FROM billing_email_address_requests WHERE address_key = '<key>'`
-- (docs/runbooks/data-erasure.md). A MATCH_KEY rotation changes every key, which only resets this
-- short-lived counter.
--
-- Additive only: the previous release never calls these functions and ignores the table.
-- Rollback (if the release is rolled back, nothing needs undoing; to remove the feature entirely,
-- after the code that calls it is gone):
--   DROP FUNCTION IF EXISTS billing_email_address_release(uuid, text);
--   DROP FUNCTION IF EXISTS billing_email_address_claim(text, integer, integer);
--   DROP TABLE IF EXISTS billing_email_address_requests;
--   DELETE FROM rekoda_migrations WHERE tag = '0185_billing_email_address_limit';

CREATE TABLE IF NOT EXISTS billing_email_address_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- base64url HMAC-SHA256: 43 characters, no padding.
  address_key text NOT NULL CHECK (address_key ~ '^[A-Za-z0-9_-]{43}$'),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A request the provider definitely refused: released, and no longer counted.
  voided_at   timestamptz
);

CREATE INDEX IF NOT EXISTS billing_email_address_requests_key_ix
  ON billing_email_address_requests (address_key, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_email_address_requests_created_ix
  ON billing_email_address_requests (created_at);

-- Default privileges grant new tables to both roles; this one is reached only through functions.
REVOKE ALL ON billing_email_address_requests FROM PUBLIC;
REVOKE ALL ON billing_email_address_requests FROM rekoda_app;
REVOKE ALL ON billing_email_address_requests FROM rekoda_worker;

/**
 * Decide one request for an address and, if it is allowed, count it.
 *
 * Returns one row. `request_id` is set when the request is allowed and counted; otherwise it is NULL
 * and `retry_after_seconds` is the generic wait: the whole cooldown inside the cooldown, the whole
 * hour once the hourly allowance is used. Fixed figures on purpose, so a refusal never tells one
 * business how long ago another asked.
 */
CREATE OR REPLACE FUNCTION billing_email_address_claim(
  p_address_key text,
  p_max_per_hour integer,
  p_cooldown_ms integer
) RETURNS TABLE (request_id uuid, retry_after_seconds integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  last_hour integer;
  latest    timestamptz;
  new_id    uuid;
BEGIN
  IF p_address_key IS NULL OR p_address_key !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'billing_email_address_claim: malformed address key';
  END IF;
  IF p_max_per_hour IS NULL OR p_max_per_hour < 1 OR p_max_per_hour > 100 THEN
    RAISE EXCEPTION 'billing_email_address_claim: hourly limit out of range';
  END IF;
  IF p_cooldown_ms IS NULL OR p_cooldown_ms < 0 OR p_cooldown_ms > 3600000 THEN
    RAISE EXCEPTION 'billing_email_address_claim: cooldown out of range';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('billing-email-address:' || p_address_key, 0));

  SELECT count(*) FILTER (WHERE r.created_at > clock_timestamp() - interval '1 hour')::integer,
         max(r.created_at)
    INTO last_hour, latest
    FROM public.billing_email_address_requests r
   WHERE r.address_key = p_address_key AND r.voided_at IS NULL;

  IF latest IS NOT NULL
     AND clock_timestamp() - latest < make_interval(secs => p_cooldown_ms / 1000.0) THEN
    RETURN QUERY SELECT NULL::uuid, ceil(p_cooldown_ms / 1000.0)::integer;
    RETURN;
  END IF;
  IF last_hour >= p_max_per_hour THEN
    RETURN QUERY SELECT NULL::uuid, 3600;
    RETURN;
  END IF;

  INSERT INTO public.billing_email_address_requests (address_key, created_at)
  VALUES (p_address_key, clock_timestamp())
  RETURNING id INTO new_id;

  -- Keep the table short: drop this address's stale rows (under its own lock) and a bounded batch
  -- of anyone else's, skipping rows another claim holds so two claims never wait on each other.
  DELETE FROM public.billing_email_address_requests r
   WHERE r.address_key = p_address_key AND r.created_at < clock_timestamp() - interval '1 day';
  DELETE FROM public.billing_email_address_requests r
   WHERE r.id IN (
     SELECT s.id FROM public.billing_email_address_requests s
      WHERE s.created_at < clock_timestamp() - interval '1 day'
      ORDER BY s.created_at
      LIMIT 100
      FOR UPDATE SKIP LOCKED);

  RETURN QUERY SELECT new_id, 0;
END;
$$;

/**
 * Give a request back because the provider definitely refused the mail. Needs both the id the claim
 * returned and the address key, so an id alone releases nothing. A request already released, or
 * one whose outcome was unknown and therefore never released, is left as it is.
 */
CREATE OR REPLACE FUNCTION billing_email_address_release(
  p_request_id uuid,
  p_address_key text
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.billing_email_address_requests
     SET voided_at = clock_timestamp()
   WHERE id = p_request_id AND address_key = p_address_key AND voided_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION billing_email_address_claim(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_email_address_release(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_email_address_claim(text, integer, integer) FROM rekoda_worker;
REVOKE ALL ON FUNCTION billing_email_address_release(uuid, text) FROM rekoda_worker;
GRANT EXECUTE ON FUNCTION billing_email_address_claim(text, integer, integer) TO rekoda_app;
GRANT EXECUTE ON FUNCTION billing_email_address_release(uuid, text) TO rekoda_app;
