-- AI spend ceilings (MASTER-PLAN §5.3.3 "global daily AI-call ceiling +
-- per-tier per-vendor ceilings, race-proof").
--
-- Why a counter table rather than counting `usage_events`:
-- `SELECT count(*) … WHERE day = today` and then deciding is not a ceiling, it
-- is a suggestion. Two messages arriving together both read 999 against a
-- limit of 1000 and both proceed. At the scale where that matters — a merchant
-- being flooded, or a bug retrying — it matters a lot, because the thing on the
-- other side of the check is a bill.
--
-- The reservation is a single statement whose WHERE clause IS the limit, so
-- the increment cannot happen unless there was room. See repos/quota.ts.

CREATE TABLE IF NOT EXISTS ai_quota_counters (
  business_id uuid NOT NULL REFERENCES businesses(id),
  day         date NOT NULL,
  calls       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, day)
);

ALTER TABLE ai_quota_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_quota_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_quota_counters
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- The platform-wide ceiling. Deliberately NOT tenant-scoped and deliberately
-- outside row-level security: it holds one integer per day and no tenant data
-- whatsoever. It is the backstop that answers "what is the most this product
-- can cost me tomorrow if something goes wrong", which is not a question any
-- single tenant's row can answer.
CREATE TABLE IF NOT EXISTS ai_global_counters (
  day   date PRIMARY KEY,
  calls integer NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE ON ai_quota_counters, ai_global_counters TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON ai_quota_counters, ai_global_counters TO rekoda_worker;
