-- Rebuild every statement line's fingerprint without the bank's words
-- (R7c; §22.1).
--
-- The fingerprint is not only computed at import, it is STORED, and
-- `bank_lines_fingerprint_ux` is what makes a re-upload a no-op. Every row
-- here holds a hash whose body contained the narration. Change the formula
-- in the application and nothing appears to break: the next re-upload of an
-- old statement simply computes a different hash, hits no conflict, and
-- inserts a second copy of every line. The reconciliation then reports a
-- position built from doubled money, which is the exact failure the
-- fingerprint exists to prevent.
--
-- So the formula and the stored values change together, here, while the
-- narration is still readable and the old identity can still be checked
-- against the new one.
--
-- The body must match `fingerprintLines` in @rekoda/core exactly:
--
--   external_transaction_id | bank_ref | posted_on | amount_k
--   | payment_references joined by ',' | occurrence
--
-- joined by US (chr 31), SHA-256, first 32 hex characters. Verified against
-- the TypeScript rather than assumed: `amount_k` is bigint, so `::text`
-- renders exactly what `String(amountK)` does, and `posted_on::text` is the
-- `YYYY-MM-DD` the parser produced. `bank-fingerprint.integration.test.ts`
-- runs both implementations over the same rows.
--
-- `occurrence` is derived here the way the import derives it: identical
-- bodies numbered in a stable order. `imported_at, id` rather than file
-- order, because file order is not recorded and id breaks every tie.
--
-- The index is dropped first because a non-deferrable unique index is checked
-- row by row during an UPDATE, and rewriting every value at once can collide
-- with a value not yet rewritten. Recreating it at the end is also the gate:
-- if two historical rows genuinely share the narration-free identity, the
-- CREATE fails and the whole migration rolls back rather than quietly
-- merging two real transactions.

DROP INDEX bank_lines_fingerprint_ux;

WITH bodies AS (
  SELECT
    id,
    coalesce(external_transaction_id, '') || chr(31) ||
    coalesce(bank_ref, '')               || chr(31) ||
    posted_on::text                      || chr(31) ||
    amount_k::text                       || chr(31) ||
    array_to_string(coalesce(payment_references, ARRAY[]::text[]), ',') AS body
  FROM bank_statement_lines
),
numbered AS (
  SELECT
    id,
    body,
    row_number() OVER (
      PARTITION BY business_id, body
      ORDER BY imported_at, l.id
    ) AS occurrence
  FROM bodies b JOIN bank_statement_lines l USING (id)
)
UPDATE bank_statement_lines t
SET fingerprint = left(
  encode(sha256(convert_to(n.body || chr(31) || n.occurrence::text, 'UTF8')), 'hex'),
  32
)
FROM numbered n
WHERE t.id = n.id;

CREATE UNIQUE INDEX bank_lines_fingerprint_ux
  ON bank_statement_lines (business_id, fingerprint);

/* ── the gate ───────────────────────────────────────────────────────────── */
DO $$
DECLARE
  stale bigint;
BEGIN
  /* Every row was rewritten: a fingerprint of the wrong length means a row
   * the UPDATE did not reach, which would be a line that silently stopped
   * deduplicating. */
  SELECT count(*) INTO stale
  FROM bank_statement_lines
  WHERE length(fingerprint) <> 32;

  IF stale > 0 THEN
    RAISE EXCEPTION 'recompute left % statement lines on an old fingerprint', stale;
  END IF;
END $$;
