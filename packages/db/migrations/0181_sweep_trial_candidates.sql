-- OD-33 (owner ruling 25 Oct 2026): narrow, ID-only scheduling discovery for the trial reminder sweep.
--
-- The sweep needs to know WHICH businesses have a trial ending soon; that is a cross-tenant question
-- by nature. Discovery for this sweep is one dedicated function (the worker's older table grants and
-- ops_read_businesses remain for the other sweeps and are NOT removed here; see ADR 0035 Amendment 1,
-- residual privilege, and backlog N8):
--   * SECURITY DEFINER with a pinned search_path, so it runs with the owner's reach and the caller
--     needs no table access for it;
--   * takes only scheduling inputs (a clock reading, a window, a page size, a keyset cursor), no
--     merchant input;
--   * returns only the business id, the trial end and the latest reminder attempt: no phone, name,
--     consent flag, plan price, payment or message content;
--   * EXECUTE for rekoda_worker only (not PUBLIC, not rekoda_app).
-- Every later read of owner data and every write runs under withBusiness() on the application role,
-- which revalidates plan, expiry and consent at claim time. Expand-only: it adds a function.
CREATE OR REPLACE FUNCTION sweep_trial_candidates(
  as_of timestamptz,
  within_days integer,
  page_size integer,
  after_id uuid
) RETURNS TABLE (
  id uuid,
  plan_expires_at timestamptz,
  last_trial_notice_stage smallint,
  trial_notice_state text,
  trial_notice_attempted_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT b.id, b.plan_expires_at, b.last_trial_notice_stage,
         b.trial_notice_state, b.trial_notice_attempted_at
  FROM public.businesses b
  WHERE b.plan = 'trial'
    AND b.plan_expires_at IS NOT NULL
    AND b.plan_expires_at > as_of
    AND b.plan_expires_at <= as_of + make_interval(days => least(greatest(within_days, 0), 60))
    AND (after_id IS NULL OR b.id > after_id)
  ORDER BY b.id
  LIMIT least(greatest(page_size, 1), 1000)
$$;

REVOKE ALL ON FUNCTION sweep_trial_candidates(timestamptz, integer, integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sweep_trial_candidates(timestamptz, integer, integer, uuid) FROM rekoda_app;
GRANT EXECUTE ON FUNCTION sweep_trial_candidates(timestamptz, integer, integer, uuid) TO rekoda_worker;
