-- Conversation rows must read back in the order they were written.
--
-- `now()` is TRANSACTION START time. It returns the same instant for every
-- statement in a transaction, and one inbound job runs entirely inside one
-- transaction (`withBusiness` in apps/api/src/jobs/runner.ts): it records the
-- merchant's message, then the reply that message produced. Both rows took
-- `now()` as their `created_at`, so both carried the same timestamp, and
-- `ORDER BY created_at` had nothing left to order them by. PostgreSQL is free
-- to return either first, and it has returned the reply first — a merchant's
-- own words shown underneath the answer to them.
--
-- `clock_timestamp()` reads the wall clock at the moment the row is inserted
-- rather than at transaction start, so it advances between statements and the
-- column finally means what every reader already assumed it meant.
--
-- This is not a backfill. The true order of rows written before this migration
-- was never recorded and cannot be reconstructed, so those ties stay ties; the
-- readers resolve them deterministically on `id` so at least the same read
-- gives the same answer twice.

ALTER TABLE conversation_messages ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- Same transaction, same hazard: `pendingDraft` takes the newest draft by
-- `created_at`, and that draft is what the merchant's "yes" confirms.
ALTER TABLE command_drafts ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- And `updated_at` with it, or the two defaults disagree: a `created_at` from
-- the wall clock is LATER than an `updated_at` from transaction start, and
-- every new draft would claim it was modified before it existed.
ALTER TABLE command_drafts ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
