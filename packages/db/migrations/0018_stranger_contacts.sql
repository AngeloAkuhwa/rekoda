-- Answering someone who is not a merchant yet (MASTER-PLAN §5.3.4).
--
-- A stranger messaging Rekoda's number currently gets silence, because a job
-- needs a tenant and they have none. This table is the memory that lets the
-- worker answer them exactly once rather than on every message: keyed by the
-- HMAC of the phone under MATCH_KEY, never the number itself, so the table
-- can say "we have replied to this person" without knowing who they are.
--
-- Deliberately outside row-level security, like `external_events`, because a
-- person with no business has no tenant to scope them to.
CREATE TABLE IF NOT EXISTS stranger_contacts (
  match_key text PRIMARY KEY,
  last_replied_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON stranger_contacts TO rekoda_worker;
GRANT SELECT, INSERT, UPDATE ON stranger_contacts TO rekoda_app;
