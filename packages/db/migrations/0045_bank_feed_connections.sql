-- The live bank feed's one row per business (fix-plan 4, G5; ADR 0012).
--
-- 0036 shipped statement UPLOAD first because it needs approval from nobody.
-- This is the second door into the same bank_statement_lines: an aggregator
-- the MERCHANT authorises reads their account and Rekoda pulls what moved.
-- What this table holds is only the standing fact of that authorisation:
-- which provider, which account reference, and when Rekoda last asked.
--
-- What is deliberately NOT here: credentials (the merchant types theirs into
-- the aggregator's own widget and Rekoda never sees them), tokens (the
-- provider secret lives in the environment, per-business access rides the
-- account reference), and the account NUMBER (last4 is enough to label a
-- card, same rule as settlement accounts).
--
-- One row per business, enforced. V1 reconciles one account because the
-- ledger has one BANK account to reconcile against; a second feed would
-- write lines the position cannot attribute.
CREATE TABLE IF NOT EXISTS bank_feed_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  provider text NOT NULL,
  /* The aggregator's id for the linked account. Opaque, theirs, never shown. */
  account_ref text NOT NULL,
  bank_name text NOT NULL,
  account_last4 text NOT NULL,
  /* linked | unlinked. Unlinked stays as a row: "you linked this once and
   * access lapsed" is a different sentence from "you never linked anything". */
  status text NOT NULL DEFAULT 'linked',
  /* The last Lagos day a sync ran, so the next fetch knows where to start. */
  last_synced_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_feed_business_ux
  ON bank_feed_connections (business_id);

ALTER TABLE bank_feed_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_feed_connections
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
