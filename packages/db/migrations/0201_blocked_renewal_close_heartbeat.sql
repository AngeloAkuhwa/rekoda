-- OWN-88 follow-up (PR B, owner review 11 Nov 2026): the close pass HEARTBEATS its lease.
--
-- Migration 0199 extends the close-cursor lease only when a batch is saved
-- (`renewal_block_close_advance`). A batch is up to 200 closes, each its own tenant transaction, so
-- a slow but healthy batch (a busy database, lock waits, statement timeouts on some rows) could
-- outlive the lease. Another runner would then take the cursor over while the first was still
-- legitimately working: both would close the same blocks (safe, a close is conditional) and the
-- first runner's save would be refused, so its batch's counts would be lost and its whole batch
-- replayed.
--
-- `renewal_block_close_heartbeat` renews the lease, as a compare-and-set on the owner, and the pass
-- calls it before every block it closes. The lease therefore expires only when ONE block takes
-- longer than the lease (900 s in production; every statement is cut at 30 s and an idle
-- transaction at 60 s by the pool settings, packages/db/src/client.ts), or when the runner stops
-- working. A runner whose heartbeat answers false has lost the lease: it stops at once, closes
-- nothing more and saves nothing (the advance is a compare-and-set too).
--
-- The heartbeat is driven by progress, not by a timer, on purpose: a runner that hangs stops
-- heartbeating, its lease expires and the next pass takes over, as 0199 intended.
--
-- Security: same shape as the 0199 cursor functions (SECURITY DEFINER, owned by the migration
-- owner, pinned search_path, validated inputs, EXECUTE for `rekoda_worker` only). It writes only
-- the lease expiry of the single cursor row and returns a boolean; no tenant data.
--
-- Rollback: additive. Older code does not call it. Re-running is safe (OR REPLACE).

CREATE OR REPLACE FUNCTION renewal_block_close_heartbeat(p_owner uuid, p_lease_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_owner IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'renewal_block_close_heartbeat: invalid owner or lease' USING ERRCODE = '22023';
  END IF;
  -- Still this owner's (expired or not: nobody has taken it over yet, so the pass may continue).
  -- A lease another runner took over is never renewed.
  UPDATE public.renewal_block_close_cursor
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
  WHERE id AND lease_owner = p_owner;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION renewal_block_close_heartbeat(uuid, integer) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION renewal_block_close_heartbeat(uuid, integer) FROM rekoda_app;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
GRANT EXECUTE ON FUNCTION renewal_block_close_heartbeat(uuid, integer) TO rekoda_worker;
