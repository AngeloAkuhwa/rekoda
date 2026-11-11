-- OWN-70 / OWN-87 (PR B, 10 Nov 2026): a DURABLE cursor for the blocked-renewal close pass.
--
-- After the payment gate opens, the renewal sweep closes every open blocked renewal, bounded per
-- pass (20 pages of 200). Migration 0198 ordered candidates least-recently-attempted first and
-- relied on a failure stamp on each row to move past a block that could not be closed. A block
-- whose close AND stamp both fail never moves, so the worker kept a fallback offset in process
-- memory; a restart lost it, and more than a whole pass of such blocks plus a restart after every
-- pass starved every block behind them (CodeRabbit, PR #432).
--
-- The close pass now walks a deterministic KEYSET over (blocked_at, reference):
--   * `blocked_at` is written once, when the renewal is stamped blocked, and never changes;
--   * `reference` is globally unique (subscription_charges_reference_ux), so the key is total.
-- The position is stored in `renewal_block_close_cursor` after every batch. A pass resumes after
-- the stored key, so a restart, a redeploy or a crash costs at most a replay of the batch in
-- flight (closing is conditional on the block still being open, so a replay is safe). When a pass
-- reaches the end of the list the cursor wraps to the start, so blocks that failed are retried and
-- blocks raised with an earlier key are reached on the next pass. A key that no longer exists
-- (the block was closed) is still a valid position: the next rows are those after it.
--
-- One runner at a time: the cursor row carries a lease (owner token, expiry). A pass claims it
-- before listing, every advance is a compare-and-set on the owner, and a runner that dies leaves a
-- lease that expires, after which the next pass takes over. The sweep also runs under the worker's
-- session advisory lock; the lease makes the cursor safe on its own.
--
-- Security (invariant 3, OWN-36, ADR 0035 Amendment 2): the cursor row holds no tenant data, only
-- a position (a timestamp and a charge reference), counters and the lease. Nobody holds a grant on
-- the table; RLS is enabled and forced with no policy, so only the functions below (owned by the
-- migration owner, SECURITY DEFINER, pinned search_path, fixed and validated inputs) read or write
-- it, and only `rekoda_worker` may execute them. `blocked_renewals_close_batch` is a seventh
-- worker-only, fixed-column work-list function in the OD-47 family: the same columns as
-- `blocked_renewals_ops`, at most 200 rows, read-only.
--
-- Rollback: additive. A normal release rollback keeps the table and functions; older code does not
-- call them. Re-running this migration is safe (IF NOT EXISTS / OR REPLACE / ON CONFLICT).

CREATE TABLE IF NOT EXISTS renewal_block_close_cursor (
  -- A single row: the close pass has one position.
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- The last key the pass finished with; both NULL means "start of the list".
  after_blocked_at   timestamptz,
  after_reference    text,
  CHECK ((after_blocked_at IS NULL) = (after_reference IS NULL)),
  lease_owner        uuid,
  lease_expires_at   timestamptz,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  -- Observability: counts only, no identities.
  pass_started_at    timestamptz,
  pass_closed        integer NOT NULL DEFAULT 0 CHECK (pass_closed >= 0),
  pass_failed        integer NOT NULL DEFAULT 0 CHECK (pass_failed >= 0),
  passes_completed   bigint  NOT NULL DEFAULT 0 CHECK (passes_completed >= 0),
  -- Passes whose lease expired without a finish or a release (the runner died, or could not
  -- reach the database to give the lease back). Taken over by the next claim.
  passes_abandoned   bigint  NOT NULL DEFAULT 0 CHECK (passes_abandoned >= 0),
  -- Failures since the cursor last wrapped (a CYCLE may span several passes when more than one
  -- pass of blocks is open), and the total of the last complete cycle. The operations alert reads
  -- these too, so it stays on until a whole cycle runs clean instead of following each pass's
  -- window of the list.
  cycle_failed       integer NOT NULL DEFAULT 0 CHECK (cycle_failed >= 0),
  last_cycle_failed  integer CHECK (last_cycle_failed >= 0),
  last_pass_closed   integer CHECK (last_pass_closed >= 0),
  last_pass_failed   integer CHECK (last_pass_failed >= 0),
  last_pass_finished_at timestamptz,
  last_advanced_at   timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO renewal_block_close_cursor (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE renewal_block_close_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewal_block_close_cursor FORCE ROW LEVEL SECURITY;
REVOKE ALL ON renewal_block_close_cursor FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON renewal_block_close_cursor FROM rekoda_app;
  REVOKE ALL ON renewal_block_close_cursor FROM rekoda_worker;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- The keyset the pass walks: open blocks in (blocked_at, reference) order.
CREATE INDEX IF NOT EXISTS subscription_charges_open_block_key_ix
  ON subscription_charges (blocked_at, reference)
  WHERE blocked_at IS NOT NULL AND blocked_resolved_at IS NULL;

-- The next batch after the stored cursor. The position comes from the cursor row, never from the
-- caller: the only input is the batch size, clamped to 1..200. The key is returned exactly
-- (`blocked_at_us`, microseconds since the epoch, and `reference`) for the advance call.
CREATE OR REPLACE FUNCTION blocked_renewals_close_batch(p_limit integer)
RETURNS TABLE (
  reference text,
  business_id uuid,
  plan text,
  amount_k bigint,
  blocked_reason text,
  blocked_at timestamptz,
  blocked_at_us bigint,
  current_plan text,
  current_renews_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.reference, c.business_id, c.plan::text, c.amount_k::bigint, c.blocked_reason,
         c.blocked_at, (EXTRACT(EPOCH FROM c.blocked_at) * 1000000)::bigint,
         b.plan::text, b.plan_expires_at
  FROM public.subscription_charges c
  JOIN public.businesses b ON b.id = c.business_id
  -- No cursor row (never claimed) reads as "start of the list".
  LEFT JOIN public.renewal_block_close_cursor k ON k.id
  WHERE c.blocked_at IS NOT NULL AND c.blocked_resolved_at IS NULL
    AND c.status = 'pending' AND c.superseded_at IS NULL
    AND (k.after_blocked_at IS NULL
         OR (c.blocked_at, c.reference) > (k.after_blocked_at, k.after_reference))
  ORDER BY c.blocked_at, c.reference
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

-- Claim the lease (creating the single row if it is missing). Returns true when this owner now holds it: it was free, expired, or already
-- this owner's. A pass that starts begins its own counters; the stored position is kept.
CREATE OR REPLACE FUNCTION renewal_block_close_claim(p_owner uuid, p_lease_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_owner IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'renewal_block_close_claim: invalid owner or lease' USING ERRCODE = '22023';
  END IF;
  -- The single row is recreated if it was ever removed; a missing row means "start of the list".
  INSERT INTO public.renewal_block_close_cursor (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
  -- Taking over an ABANDONED pass (another owner's lease that expired without a finish or a
  -- release) first records what that pass saved, so its failures still reach the operations
  -- alert instead of being wiped by the counter reset. Every SET expression reads the old row.
  UPDATE public.renewal_block_close_cursor
  SET last_pass_closed = CASE WHEN lease_owner IS NOT NULL AND lease_owner <> p_owner
                              THEN pass_closed ELSE last_pass_closed END,
      last_pass_failed = CASE WHEN lease_owner IS NOT NULL AND lease_owner <> p_owner
                              THEN pass_failed ELSE last_pass_failed END,
      last_pass_finished_at = CASE WHEN lease_owner IS NOT NULL AND lease_owner <> p_owner
                                   THEN lease_expires_at ELSE last_pass_finished_at END,
      passes_abandoned = passes_abandoned
        + CASE WHEN lease_owner IS NOT NULL AND lease_owner <> p_owner THEN 1 ELSE 0 END,
      lease_owner = p_owner,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      pass_started_at = clock_timestamp(),
      pass_closed = 0,
      pass_failed = 0,
      updated_at = clock_timestamp()
  WHERE id
    AND (lease_owner IS NULL OR lease_owner = p_owner OR lease_expires_at < clock_timestamp());
  RETURN FOUND;
END $$;

-- Record a processed batch: move the cursor to the batch's last key, add the batch's counts and
-- extend the lease. A compare-and-set on the owner: returns false (and changes nothing) when this
-- owner no longer holds the lease, so a runner that lost it can never overwrite the position.
CREATE OR REPLACE FUNCTION renewal_block_close_advance(
  p_owner uuid,
  p_after_blocked_at_us bigint,
  p_after_reference text,
  p_closed integer,
  p_failed integer,
  p_lease_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  k timestamptz;
BEGIN
  -- No upper bound on the reference: `subscription_charges.reference` has none, and a cap here
  -- would refuse every advance past one long reference and wedge the cursor at that batch.
  IF p_owner IS NULL OR p_after_blocked_at_us IS NULL OR p_after_reference IS NULL
     OR length(p_after_reference) < 1
     OR p_closed IS NULL OR p_closed < 0 OR p_failed IS NULL OR p_failed < 0
     OR p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'renewal_block_close_advance: invalid input' USING ERRCODE = '22023';
  END IF;
  k := 'epoch'::timestamptz + p_after_blocked_at_us * interval '1 microsecond';
  -- The cursor only moves forward within a cycle (back to the start only through finish): a key at
  -- or before the stored one would silently re-skip or re-walk rows, so it is refused.
  UPDATE public.renewal_block_close_cursor
  SET after_blocked_at = k,
      after_reference = p_after_reference,
      pass_closed = pass_closed + p_closed,
      pass_failed = pass_failed + p_failed,
      cycle_failed = cycle_failed + p_failed,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_advanced_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id AND lease_owner = p_owner
    AND (after_blocked_at IS NULL OR (k, p_after_reference) > (after_blocked_at, after_reference));
  IF FOUND THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM public.renewal_block_close_cursor WHERE id AND lease_owner = p_owner) THEN
    RAISE EXCEPTION 'renewal_block_close_advance: the cursor cannot move backwards'
      USING ERRCODE = '22023';
  END IF;
  RETURN false;
END $$;

-- End a pass and release the lease. `p_wrapped` (the list was exhausted) moves the cursor back to
-- the start and counts a completed pass, recording what that pass closed and failed. A pass that
-- stopped early (out of pages, or after an error) keeps its position. Returns false when this owner
-- no longer holds the lease.
CREATE OR REPLACE FUNCTION renewal_block_close_finish(p_owner uuid, p_wrapped boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_owner IS NULL OR p_wrapped IS NULL THEN
    RAISE EXCEPTION 'renewal_block_close_finish: invalid input' USING ERRCODE = '22023';
  END IF;
  UPDATE public.renewal_block_close_cursor
  SET after_blocked_at = CASE WHEN p_wrapped THEN NULL ELSE after_blocked_at END,
      after_reference = CASE WHEN p_wrapped THEN NULL ELSE after_reference END,
      passes_completed = passes_completed + CASE WHEN p_wrapped THEN 1 ELSE 0 END,
      last_cycle_failed = CASE WHEN p_wrapped THEN cycle_failed ELSE last_cycle_failed END,
      cycle_failed = CASE WHEN p_wrapped THEN 0 ELSE cycle_failed END,
      last_pass_closed = pass_closed,
      last_pass_failed = pass_failed,
      last_pass_finished_at = clock_timestamp(),
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = clock_timestamp()
  WHERE id AND lease_owner = p_owner;
  RETURN FOUND;
END $$;

-- Give the lease back without moving the cursor (a pass that stopped on an error). The position is
-- never reset here.
-- `p_unrecorded_failed` counts the failures of the batch whose advance did not happen, so the
-- operations alert still sees them.
CREATE OR REPLACE FUNCTION renewal_block_close_release(p_owner uuid, p_unrecorded_failed integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_owner IS NULL OR p_unrecorded_failed IS NULL OR p_unrecorded_failed < 0 THEN
    RAISE EXCEPTION 'renewal_block_close_release: invalid input' USING ERRCODE = '22023';
  END IF;
  UPDATE public.renewal_block_close_cursor
  SET last_pass_closed = pass_closed,
      last_pass_failed = pass_failed + p_unrecorded_failed,
      last_pass_finished_at = clock_timestamp(),
      lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE id AND lease_owner = p_owner;
  RETURN FOUND;
END $$;

-- The cursor's state for operations: counts, times and whether a position is held. No reference,
-- no business, no identity. `abandoned` is a lease that expired without a finish or a release: a
-- pass died, or could not reach the database to give the lease back (the stalled-pass alert).
CREATE OR REPLACE FUNCTION renewal_block_close_status()
RETURNS TABLE (
  positioned boolean,
  leased boolean,
  abandoned boolean,
  passes_completed bigint,
  passes_abandoned bigint,
  cycle_failed integer,
  last_cycle_failed integer,
  pass_closed integer,
  pass_failed integer,
  last_pass_closed integer,
  last_pass_failed integer,
  last_pass_finished_at timestamptz,
  last_advanced_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT after_reference IS NOT NULL,
         lease_owner IS NOT NULL AND lease_expires_at >= clock_timestamp(),
         lease_owner IS NOT NULL AND lease_expires_at < clock_timestamp(),
         passes_completed, passes_abandoned, cycle_failed, last_cycle_failed, pass_closed, pass_failed, last_pass_closed, last_pass_failed,
         last_pass_finished_at, last_advanced_at
  FROM public.renewal_block_close_cursor WHERE id
$$;

REVOKE ALL ON FUNCTION blocked_renewals_close_batch(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION renewal_block_close_claim(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION renewal_block_close_advance(uuid, bigint, text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION renewal_block_close_finish(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION renewal_block_close_release(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION renewal_block_close_status() FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION blocked_renewals_close_batch(integer) FROM rekoda_app;
  REVOKE ALL ON FUNCTION renewal_block_close_claim(uuid, integer) FROM rekoda_app;
  REVOKE ALL ON FUNCTION renewal_block_close_advance(uuid, bigint, text, integer, integer, integer) FROM rekoda_app;
  REVOKE ALL ON FUNCTION renewal_block_close_finish(uuid, boolean) FROM rekoda_app;
  REVOKE ALL ON FUNCTION renewal_block_close_release(uuid, integer) FROM rekoda_app;
  REVOKE ALL ON FUNCTION renewal_block_close_status() FROM rekoda_app;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
GRANT EXECUTE ON FUNCTION blocked_renewals_close_batch(integer) TO rekoda_worker;
GRANT EXECUTE ON FUNCTION renewal_block_close_claim(uuid, integer) TO rekoda_worker;
GRANT EXECUTE ON FUNCTION renewal_block_close_advance(uuid, bigint, text, integer, integer, integer) TO rekoda_worker;
GRANT EXECUTE ON FUNCTION renewal_block_close_finish(uuid, boolean) TO rekoda_worker;
GRANT EXECUTE ON FUNCTION renewal_block_close_release(uuid, integer) TO rekoda_worker;
GRANT EXECUTE ON FUNCTION renewal_block_close_status() TO rekoda_worker;
