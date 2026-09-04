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
-- `created_at` remains what it always was - time and provenance. It stops
-- being the final word on ordering.
--
-- Existing rows: PostgreSQL fills the new identity column in table-scan
-- order. That assigns them SOME deterministic sequence so the schema is
-- complete; it does NOT reconstruct their true insertion order, which was
-- never recorded. Their `created_at` ties stay ties, exactly as 0146
-- documented; from this migration on, new drafts carry the real order.

ALTER TABLE command_drafts
  ADD COLUMN insertion_seq bigint GENERATED ALWAYS AS IDENTITY;
