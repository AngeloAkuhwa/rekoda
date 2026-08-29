-- Hard media spending ceilings, platform-wide included (remediation A4).
--
-- The text-AI ceilings (ai_quota_counters / ai_global_counters) bound model
-- calls; the document ceiling (doc_extraction_counters, 0117) bounds one
-- business's vision reads per day. What was still unbounded: the PLATFORM's
-- vision day, and anybody's transcription day — the monthly voice allowance
-- is a commercial meter, not a brake on a runaway 24 hours. Hosted media
-- processing without a hard daily ceiling is a cost-abuse route.
--
-- Same mechanism as every real ceiling here: the limit lives in the
-- statement's WHERE clause. Voice counts SECONDS, because that is the unit
-- the provider bills and the probe measures.

CREATE TABLE IF NOT EXISTS doc_extraction_global_counters (
  day         date PRIMARY KEY,
  extractions integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS voice_second_counters (
  business_id uuid NOT NULL REFERENCES businesses(id),
  day         date NOT NULL,
  seconds     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, day)
);

ALTER TABLE voice_second_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_second_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON voice_second_counters
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- Platform-wide, one integer per day, no tenant data: deliberately outside
-- row-level security, like ai_global_counters and for the same reason.
CREATE TABLE IF NOT EXISTS voice_global_counters (
  day     date PRIMARY KEY,
  seconds integer NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE ON doc_extraction_global_counters TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON doc_extraction_global_counters TO rekoda_worker;
GRANT SELECT, INSERT, UPDATE ON voice_second_counters TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON voice_second_counters TO rekoda_worker;
GRANT SELECT, INSERT, UPDATE ON voice_global_counters TO rekoda_app;
GRANT SELECT, INSERT, UPDATE ON voice_global_counters TO rekoda_worker;
