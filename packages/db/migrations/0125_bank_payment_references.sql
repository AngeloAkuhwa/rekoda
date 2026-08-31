-- Extract Rekoda payment references at ingest, and backfill the history
-- (R7a; §22.1).
--
-- Reconciliation has never needed the bank's words. It needs the Rekoda
-- references those words happen to carry, and `reconcile` already threw the
-- text away the moment it had them:
--
--   references: paymentReferencesIn(`${l.narration} ${l.bankRef ?? ''}`)
--
-- Running that on every reconcile is why the narration had to stay on the
-- row. Running it once, at ingest, is why it no longer does. This column is
-- the store for the result; the reader cutover and the removal of the
-- narration itself are separate migrations, so a deploy can stop here.
--
-- An ARRAY, not one reference. A single transfer can quote two invoices,
-- and `matchStatement` iterates every reference a line carries when it looks
-- for a tier-1 match. Keeping only the first would silently drop the second
-- invoice's match and leave a merchant reconciling it by hand.
--
-- The extraction below must agree with `paymentReferencesIn` exactly, or a
-- line matched before this migration stops matching after it. Two details
-- carry that: the text is upper-cased BEFORE matching, as the TypeScript
-- does, and `bank_ref` joins the narration with a space, as the reader does.
-- `payment-references.integration.test.ts` runs both implementations over
-- the same awkward strings and asserts they agree, because a regular
-- expression that looks equivalent in two dialects is not evidence.
--
-- Idempotent: the UPDATE targets rows still NULL, so a re-run against a
-- half-backfilled estate finishes the job and a finished one is untouched.

ALTER TABLE bank_statement_lines
  ADD COLUMN payment_references text[];

UPDATE bank_statement_lines
SET payment_references = ARRAY(
  SELECT m FROM (
    SELECT DISTINCT ON (found.m) found.m, found.ord
    FROM (
      SELECT (hit.match)[1] AS m, hit.ord
      FROM regexp_matches(
             upper(narration || ' ' || coalesce(bank_ref, '')),
             'RKD-PAY-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{6}',
             'g'
           ) WITH ORDINALITY AS hit(match, ord)
    ) found
    ORDER BY found.m, found.ord
  ) unique_hits
  ORDER BY unique_hits.ord
)
WHERE payment_references IS NULL;

/* ── the gate ───────────────────────────────────────────────────────────── */
DO $$
DECLARE
  unfilled bigint;
  lost bigint;
BEGIN
  SELECT count(*) INTO unfilled
  FROM bank_statement_lines
  WHERE payment_references IS NULL;

  IF unfilled > 0 THEN
    RAISE EXCEPTION 'backfill left % statement lines without a references array', unfilled;
  END IF;

  /* The property that actually matters: no line that carried a reference in
   * its text lost it. Counted rather than trusted, because the whole point
   * of the column is that the text it came from is about to be deleted, and
   * a reference missed here is a reconciliation that silently stops working
   * with no way left to recover it. */
  SELECT count(*) INTO lost
  FROM bank_statement_lines
  WHERE upper(narration || ' ' || coalesce(bank_ref, ''))
          ~ 'RKD-PAY-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{6}'
    AND cardinality(payment_references) = 0;

  IF lost > 0 THEN
    RAISE EXCEPTION 'backfill dropped references on % statement lines', lost;
  END IF;
END $$;
