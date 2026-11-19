-- OWN-70 (PR B review): closing blocked renewals must not starve later rows behind persistent failures.
--
-- After the payment gate opens, the renewal sweep closes every open blocked renewal. It paged the
-- operator list from the oldest block and skipped, within one pass, the rows it failed on. A pass is
-- bounded (20 pages of 200), so more than 4,000 rows that persistently fail to close left every
-- later row waiting, sweep after sweep.
--
-- The cursor is now persisted on the row itself: `blocked_close_failed_at` is the time a close of
-- this block last failed. The close pass asks for its candidates least-recently-attempted first
-- (never-attempted rows before any that failed, oldest failure first), and only rows not attempted
-- since the pass began, so a row that fails is stamped, drops behind every row not yet tried, and is
-- not retried again in the same pass. Progress survives a restart (it is data), concurrent sweeps
-- cannot corrupt it (a stamp is a plain write of "now", a close is conditional on the block still
-- being open), and a pass stays bounded. The operator list keeps its own order (oldest block first).
--
-- The function keeps its name, owner, search_path, grants and fixed output; it gains one optional
-- parameter. It is still one of the six OD-47 work-list functions (ADR 0035 Amendment 2).
--
-- Rollback: a normal release rollback keeps the column and the function; older code calls the
-- function with two arguments, which still works (the third parameter defaults to NULL).

ALTER TABLE subscription_charges
  ADD COLUMN IF NOT EXISTS blocked_close_failed_at timestamptz;

DROP FUNCTION IF EXISTS blocked_renewals_ops(integer, integer);

CREATE OR REPLACE FUNCTION blocked_renewals_ops(
  p_limit integer,
  p_offset integer DEFAULT 0,
  p_not_attempted_since timestamptz DEFAULT NULL
)
RETURNS TABLE (
  reference text,
  business_id uuid,
  plan text,
  amount_k bigint,
  blocked_reason text,
  blocked_at timestamptz,
  current_plan text,
  current_renews_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.reference, c.business_id, c.plan::text, c.amount_k::bigint, c.blocked_reason,
         c.blocked_at, b.plan::text, b.plan_expires_at
  FROM public.subscription_charges c
  JOIN public.businesses b ON b.id = c.business_id
  WHERE c.blocked_at IS NOT NULL AND c.blocked_resolved_at IS NULL
    AND c.status = 'pending' AND c.superseded_at IS NULL
    AND (p_not_attempted_since IS NULL
         OR c.blocked_close_failed_at IS NULL
         OR c.blocked_close_failed_at < p_not_attempted_since)
  ORDER BY
    CASE WHEN p_not_attempted_since IS NULL THEN NULL ELSE c.blocked_close_failed_at END NULLS FIRST,
    c.blocked_at, c.reference
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
  OFFSET greatest(coalesce(p_offset, 0), 0)
$$;

REVOKE ALL ON FUNCTION blocked_renewals_ops(integer, integer, timestamptz) FROM PUBLIC, rekoda_app;
GRANT EXECUTE ON FUNCTION blocked_renewals_ops(integer, integer, timestamptz) TO rekoda_worker;
