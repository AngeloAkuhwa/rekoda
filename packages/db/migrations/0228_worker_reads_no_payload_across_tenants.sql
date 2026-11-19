-- Final remediation of PR #432 (owner brief, 15 Nov 2026): cross-tenant payload isolation for the
-- worker credential, enforced by the database where feasible.
--
-- The worker claims and coordinates every tenant's jobs (`worker_claim`, 0004; ADR 0035 Amendment 1,
-- class 2), so it must read their coordination columns across tenants. Until this migration it held
-- SELECT on the whole of `jobs`, payload included, and the rule that it reads a payload only under
-- that job's own tenant pin (0225, ADR 0035 Amendment 6) was a property of the repository code,
-- held by tests and a boundary script. Since 0228:
--
--   * `rekoda_worker` holds SELECT on every column of `jobs` except `payload`. A worker statement
--     that names the payload, selects the whole row (`*`, `to_jsonb(j)`), filters on it or returns
--     it is refused by the database, pinned or not.
--   * It reads a payload only through `job_payload(job)`: SECURITY DEFINER, `search_path` pinned,
--     returning that one job's payload only where the job's business is the pinned tenant
--     (`app.business_id`), and NULL otherwise. EXECUTE for `rekoda_worker` and `rekoda_settlement`
--     (whose claim uses the same repository path) only.
--
-- What the database still cannot enforce, and why: the tenant pin is set by the caller (it is a
-- scoping device, not an authentication), and the worker process legitimately runs every tenant's
-- jobs. A holder of the worker credential can therefore still pin each business in turn and read
-- its jobs one at a time; what it can no longer do is read payloads unpinned, across tenants, or in
-- bulk in one statement. Settlement keeps its own SELECT on `jobs` (its RLS policy on
-- `external_events` reads `jobs.payload`, 0223), restricted by policy to its two job kinds.
--
-- Compatibility: the previous release (main, 0192) reads payloads on the worker credential in its
-- claim, so a worker of that release could not claim after this migration; this release's worker
-- reads them through the function. The deploy applies it with the worker stopped (it is in
-- COMPAT_BREAKING_MIGRATIONS). Rollback: GRANT SELECT ON jobs TO rekoda_worker. Re-running is safe.

CREATE OR REPLACE FUNCTION public.job_payload(p_job uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT j.payload FROM public.jobs j
  WHERE j.id = p_job
    AND j.business_id = nullif(current_setting('app.business_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION public.job_payload(uuid)
  FROM PUBLIC, rekoda_app, rekoda_billing_operator;
GRANT EXECUTE ON FUNCTION public.job_payload(uuid) TO rekoda_worker, rekoda_settlement;

REVOKE SELECT ON jobs FROM rekoda_worker;
GRANT SELECT (id, business_id, kind, singleton_key, state, attempts, max_attempts, run_at,
              locked_at, locked_by, last_error, failure_category, created_at, updated_at)
  ON jobs TO rekoda_worker;
