-- The document-extraction daily ceiling (AI hardening item 4).
--
-- `AI_DOC_EXTRACTIONS_PER_BUSINESS` was loaded from configuration and
-- enforced nowhere, which made it a number that reassured whoever read the
-- env file and protected nothing. This table is the enforcement: a
-- per-business Lagos-day counter with the same shape as ai_quota_counters,
-- because it exists for the same reason — a ceiling decided by reading a
-- count and then acting is not a ceiling, it is a suggestion two concurrent
-- photographs walk straight past.
--
-- OPERATIONAL, not commercial: the monthly documents_understood allowance is
-- what the merchant bought; this is the per-day brake on what one tenant can
-- make Rekoda spend on vision reads before somebody looks. The two meters
-- deliberately do not share a table.

CREATE TABLE IF NOT EXISTS doc_extraction_counters (
  business_id uuid NOT NULL REFERENCES businesses(id),
  day         date NOT NULL,
  extractions integer NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, day)
);

ALTER TABLE doc_extraction_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_extraction_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON doc_extraction_counters
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON doc_extraction_counters TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON doc_extraction_counters TO rekoda_worker;
