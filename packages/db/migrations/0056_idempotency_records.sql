-- The command layer's idempotency record (canonical spec §26).
--
-- Not to be confused with migration 0042, which is called
-- `idempotency_keys` and is something else: a handful of unique INDEXES an
-- audit added to specific tables after finding two of them racing. Those stay.
-- Spec §26 asks for layered defence, "financial-domain idempotency at the
-- ledger itself (§9.4), so a retry cannot create duplicate financial truth
-- even if every upstream protection fails". This table is the upstream
-- protection; those indexes are the floor beneath it.
--
-- `response_snapshot` IS THE STATE. There is no status column, for the same
-- reason `pending_confirmations` has none: a nullable column that is written
-- exactly once is a state machine with no invalid states in it.
--
--   row absent          nobody has run this command with this key
--   snapshot IS NULL    somebody is running it right now
--   snapshot NOT NULL   it ran, and this is what it answered
--
-- The middle state is the one that matters and the one an ad-hoc key check
-- always misses. Two identical requests arriving together must not both
-- execute, and the loser must not be told "done" with an empty answer.
--
-- `request_hash` is what makes the key safe to trust. A client that reuses
-- one key for two different payloads has made a mistake, and replaying the
-- first response would hide it behind a plausible answer. The mismatch is a
-- refusal instead.

CREATE TABLE IF NOT EXISTS idempotency_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id),
  /** The caller's key. Opaque to Rekoda; unique per business, not globally. */
  key               text NOT NULL CHECK (length(btrim(key)) > 0),
  command_name      text NOT NULL,
  /** A hash of the payload, so one key cannot answer for two requests. */
  request_hash      text NOT NULL,
  /** What the command answered. NULL while it is still running. */
  response_snapshot jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT idempotency_records_business_key_ux UNIQUE (business_id, key),
  /* A snapshot and its timestamp arrive together or not at all. */
  CONSTRAINT idempotency_records_complete_together
    CHECK ((response_snapshot IS NULL) = (completed_at IS NULL))
);

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_records
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

-- REVOKE, not GRANT: migration 0001's ALTER DEFAULT PRIVILEGES hands both
-- application roles DELETE on every new table. A record of what a command
-- already answered is not the application's to remove; deleting one turns a
-- replay back into a second execution, which is the whole thing this table
-- exists to prevent.
REVOKE DELETE ON idempotency_records FROM rekoda_app;
REVOKE DELETE ON idempotency_records FROM rekoda_worker;
