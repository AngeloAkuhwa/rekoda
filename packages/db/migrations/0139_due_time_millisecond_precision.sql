-- Two queues stamped their due-time at a precision their reader cannot see.
--
-- `pending_object_deletions.next_attempt_at` and
-- `webhook_deliveries.next_attempt_at` both defaulted to `now()`, which
-- PostgreSQL records to the MICROSECOND. Both are read by a query that
-- compares them against a JavaScript `Date`:
--
--     WHERE next_attempt_at <= ${now.toISOString()}::timestamptz
--
-- A JavaScript Date holds MILLISECONDS, and `toISOString()` truncates. So a
-- row stamped 20:40:35.739632 is not `<=` a reader's 20:40:35.739, and a row
-- enqueued "now" is invisible for the rest of that millisecond:
--
--     SELECT timestamptz '2026-09-01 20:40:35.739632+00'
--         <= '2026-09-01T20:40:35.739Z'::timestamptz;   -- f
--
-- In production the enqueue and the drain are minutes apart, so nothing was
-- ever lost: the row is simply picked up on the next pass. It surfaced in the
-- test suite, where the two happen in the same millisecond often enough to
-- fail a run at random, and a queue whose "due now" is not reliably due now is
-- worth being able to state plainly either way.
--
-- The fix is to stop storing precision nobody can observe. Every OTHER writer
-- of these columns already passes a JavaScript Date, so the default was the
-- only source of sub-millisecond values; truncating it makes "enqueued now"
-- mean "due now" exactly. `jobs.run_at` is deliberately untouched: it is
-- claimed with `run_at <= now()`, database to database, so it never had this
-- problem and is the shape the other two now match.
ALTER TABLE pending_object_deletions
  ALTER COLUMN next_attempt_at SET DEFAULT date_trunc('milliseconds', now());
ALTER TABLE webhook_deliveries
  ALTER COLUMN next_attempt_at SET DEFAULT date_trunc('milliseconds', now());

-- Existing rows, so the invariant holds for the whole column rather than only
-- for rows written from here on. Moving a due-time EARLIER by under a
-- millisecond can only make a row due sooner, never later, so nothing that was
-- already scheduled is delayed and nothing pending is skipped.
UPDATE pending_object_deletions
   SET next_attempt_at = date_trunc('milliseconds', next_attempt_at)
 WHERE next_attempt_at <> date_trunc('milliseconds', next_attempt_at);
UPDATE webhook_deliveries
   SET next_attempt_at = date_trunc('milliseconds', next_attempt_at)
 WHERE next_attempt_at <> date_trunc('milliseconds', next_attempt_at);
