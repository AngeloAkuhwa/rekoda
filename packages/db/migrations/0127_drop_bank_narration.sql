-- The bank's words stop being kept (R7d; §22.1).
--
-- The end of the sequence. 0125 added `payment_references` and filled it,
-- 0126 rebuilt every line's identity without the narration in it, and the
-- readers, the API contract and the statement page stopped asking for the
-- text in between. Nothing reads this column any more. It only holds
-- counterparty names.
--
-- The gate runs BEFORE the drop, because after it there is nothing left to
-- check against. It asks the one question that matters: is there a line
-- whose text still carries a Rekoda reference that did not make it into
-- `payment_references`? One such line is a reconciliation that would stop
-- working the moment this column goes, with no way left to recover it, so
-- any at all aborts the migration and the column stays.
--
-- This is not reversible. A restore is the only way back, which is why the
-- three changes before it were each shippable and revertible on their own.

/* ── the gate ───────────────────────────────────────────────────────────── */
DO $$
DECLARE
  lost bigint;
BEGIN
  SELECT count(*) INTO lost
  FROM bank_statement_lines
  WHERE upper(narration || ' ' || coalesce(bank_ref, ''))
          ~ 'RKD-PAY-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{6}'
    AND cardinality(coalesce(payment_references, ARRAY[]::text[])) = 0;

  IF lost > 0 THEN
    RAISE EXCEPTION
      'refusing to drop narration: % line(s) carry a reference that was never extracted', lost;
  END IF;
END $$;

ALTER TABLE bank_statement_lines DROP COLUMN narration;
