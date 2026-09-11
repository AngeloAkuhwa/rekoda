-- Which allocation a partial refund unwinds first must not depend on uuid
-- order (G-06).
--
-- `standingAllocationsFor` lists the allocations of one payment that still
-- stand, NEWEST first, and `unwindAllocations` reverses them in that order
-- until the refunded amount is answered. It ordered by
-- `created_at DESC, id DESC`. `created_at` defaults to `now()`, which is the
-- TRANSACTION's start time, so every allocation written in one transaction -
-- a payment matched across several invoices, the §14.2 re-match of one
-- payment onto two - carries the same timestamp, and the tiebreaker behind
-- it is a RANDOM uuid. Which invoice reopens on a partial refund was
-- therefore decided by uuid lexical order: deterministic, yet unrelated to
-- which allocation is newer, and different on every run.
--
-- `insertion_seq` is the ordering authority, exactly as 0149 made it for
-- command drafts: a bigint identity, GENERATED ALWAYS, so PostgreSQL assigns
-- it per insert and an application role cannot choose it. Monotonic per
-- insert, never derived from the wall clock, never from uuid order; gaps
-- from rolled-back inserts are harmless because only ORDER matters.
--
-- Existing rows are backfilled EXPLICITLY in the order the old reader
-- ranked them - `created_at, id` - so the switch of authority changes no
-- answer the old reader was giving where `created_at` did not tie. Where it
-- tied, the true insertion order was never recorded and is not
-- reconstructed; the backfill resolves those rows by `id`, as the old
-- reader did.
--
-- `created_at` remains time and provenance. It stops being the final word
-- on ordering.
ALTER TABLE payment_allocations ADD COLUMN insertion_seq bigint;
UPDATE payment_allocations
   SET insertion_seq = ranked.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
          FROM payment_allocations) ranked
 WHERE payment_allocations.id = ranked.id;
ALTER TABLE payment_allocations ALTER COLUMN insertion_seq SET NOT NULL;
ALTER TABLE payment_allocations ALTER COLUMN insertion_seq ADD GENERATED ALWAYS AS IDENTITY;
-- The identity's sequence starts at 1; move it past the backfill so the next
-- allocation continues the order rather than colliding with history.
SELECT setval(pg_get_serial_sequence('payment_allocations', 'insertion_seq'),
              COALESCE(max(insertion_seq), 0) + 1, false)
  FROM payment_allocations;
