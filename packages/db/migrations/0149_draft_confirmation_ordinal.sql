-- What a merchant's "yes" confirms must not depend on clock resolution.
--
-- `pendingDraft` picks the draft a confirmation executes, and it picked by
-- `created_at DESC, id DESC`. Migration 0146 made `created_at` advance
-- between statements, but two inserts can still land on the same microsecond,
-- and the tiebreaker behind it is a RANDOM uuid: deterministic, yet with no
-- relation to which draft is newer. A transcript can tolerate that; the
-- selector for WHICH FINANCIAL COMMAND RUNS cannot. The ordering authority
-- has to be something PostgreSQL itself increments per insert.
--
-- `insertion_seq` is that authority: a bigint identity, GENERATED ALWAYS, so
-- the database assigns it and an application caller cannot choose it (an
-- explicit value is refused without OVERRIDING SYSTEM VALUE, which no
-- application role uses). Sequence semantics are exactly right here:
-- monotonic per insert, never derived from the wall clock, never from uuid
-- order, and gaps from rolled-back inserts are harmless because only ORDER
-- matters, never density.
--
-- Existing rows are backfilled EXPLICITLY, in the exact order the old reader
-- ranked them - `created_at, id` - and not by letting the identity rewrite
-- assign values in heap-scan order. The difference is load-bearing: rows are
-- routinely UPDATEd (`claimDraft`, `supersedePendingDrafts`), each update
-- moves a row version in the heap, so heap order diverges from history, and
-- a heap-order backfill could INVERT a pair of existing pending drafts whose
-- `created_at` values were not tied and had been ordering them correctly.
-- The switch of authority must change no answer the old reader was getting
-- right. Where `created_at` genuinely ties, the backfill resolves by `id`,
-- which is exactly what the old reader did; the true insertion order of
-- those tied rows was never recorded and is not reconstructed.
--
-- `created_at` remains what it always was - time and provenance. It stops
-- being the final word on ordering.

ALTER TABLE command_drafts ADD COLUMN insertion_seq bigint;

UPDATE command_drafts
   SET insertion_seq = ranked.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
          FROM command_drafts) ranked
 WHERE command_drafts.id = ranked.id;

ALTER TABLE command_drafts ALTER COLUMN insertion_seq SET NOT NULL;
ALTER TABLE command_drafts ALTER COLUMN insertion_seq ADD GENERATED ALWAYS AS IDENTITY;

-- The identity's sequence starts at 1; move it past the backfill so the next
-- draft continues the order rather than colliding with history.
SELECT setval(pg_get_serial_sequence('command_drafts', 'insertion_seq'),
              COALESCE(max(insertion_seq), 0) + 1, false)
  FROM command_drafts;

-- 0009 built `command_drafts_pending_ix (business_id, created_at DESC) WHERE
-- state = 'pending'` for exactly this hot path. The path now orders by the
-- ordinal, so the index follows it; keeping the old one would leave the
-- planner sorting every pending row while an index nothing uses is
-- maintained on every insert and state change.
DROP INDEX command_drafts_pending_ix;
CREATE INDEX command_drafts_pending_ix
  ON command_drafts (business_id, insertion_seq DESC)
  WHERE state = 'pending';
