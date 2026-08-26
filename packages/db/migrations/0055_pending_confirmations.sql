-- High-risk confirmations (canonical spec Appendix D.3).
--
-- A HIGH_RISK command demands "explicit confirmation naming the specific
-- consequence, an authenticated actor, and an audit event carrying the
-- reason". A row here is that confirmation, opened when the consequence is
-- shown and claimed when the command runs.
--
-- It is a ROW rather than a signed token on purpose. A token is bearer
-- authority: it survives being copied, it cannot be withdrawn, and nothing
-- stops it being replayed twice in the same second. A row can be claimed
-- exactly once by a single UPDATE, and a merchant who changes their mind
-- leaves it unclaimed until it expires.
--
-- Everything it is bound to is a column, so a claim cannot drift onto another
-- tenant, another actor, another command or another subject:
--   business_id  the tenant, under RLS as well
--   actor        who was authenticated when the consequence was shown
--   command      what they were shown, not what is being asked now
--   subject      which refund, which period, which connection
--
-- `reason` is NOT NULL. Appendix D.3: "A missing reason is a refusal, not a
-- blank field." The column enforces what the service refuses, so a caller
-- that finds a way past the service still cannot write a blank one.

CREATE TABLE IF NOT EXISTS pending_confirmations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id),
  command      text NOT NULL,
  /** What this confirmation is ABOUT: a payment id, a period, a connection. */
  subject      text,
  actor        text NOT NULL,
  /** The front door it was opened from, so a claim cannot cross ingresses. */
  ingress      text NOT NULL,
  /** The consequence as the merchant was shown it, kept for the audit trail. */
  consequence  text NOT NULL,
  reason       text NOT NULL CHECK (length(btrim(reason)) > 0),
  context      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  claimed_at   timestamptz,
  CHECK (expires_at > created_at)
);

/* The lookup the claim makes: this tenant, this command, this subject, still
 * open. Partial, because a claimed confirmation is never looked up again. */
CREATE INDEX pending_confirmations_open_ix
  ON pending_confirmations (business_id, command, expires_at)
  WHERE claimed_at IS NULL;

ALTER TABLE pending_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_confirmations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pending_confirmations
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- REVOKE, not GRANT. Migration 0001 carries
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rekoda_app
-- so a new table arrives with DELETE already granted to both roles, and a
-- GRANT listing three privileges adds nothing and removes nothing. The same
-- trap PR-010 found on the ledger: a permission you did not ask for is one
-- you have to take away.
--
-- An unclaimed confirmation that expired is evidence of a merchant who was
-- shown a consequence and declined it, and that is worth keeping as much as
-- the ones they accepted. A claimed one is the authority a refund was made
-- under. Neither is the application's to delete.
REVOKE DELETE ON pending_confirmations FROM rekoda_app;
REVOKE DELETE ON pending_confirmations FROM rekoda_worker;

-- The worker reads; it never opens or claims. Confirmation is a human act at
-- a front door, and a background sweep is neither.
REVOKE INSERT, UPDATE ON pending_confirmations FROM rekoda_worker;
