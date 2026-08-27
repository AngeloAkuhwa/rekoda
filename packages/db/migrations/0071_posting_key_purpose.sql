-- postingKey, postingPurpose, reversal uniqueness (spec §9.3, §9.4;
-- F1, PR-040).
--
-- Application idempotency protects the command. It does not protect the
-- ledger from a writer that bypasses the command layer, and defence in
-- depth is the same argument that justifies the balance trigger (§9.4).
-- Three uniques, all partial, all additive:
--
--   reversal-once      a full reversal may occur only once (§9.3); multiple
--                      partial reversals are not modelled in V1
--   financial event    (business, sourceType, sourceId, postingPurpose) —
--                      a retried webhook cannot produce a second balanced
--                      journal even if every layer above it fails
--   postingKey         the ledger-level dedupe key for writers whose event
--                      identity is not (sourceType, sourceId) shaped
--
-- History carries NULL purpose and NULL key: assigning purposes to rows
-- after the fact would be guessing, and NULLs are distinct under UNIQUE,
-- so the estate is untouched while every purposeful row from now on is
-- protected. Reversal rows are identified by `reverses_id` itself; the
-- REVERSAL purpose is stamped by writers whose source ids are per-event
-- (the recognition engine, PR-045+), because today's void path legally
-- reverses several transactions under one source id.

ALTER TABLE ledger_transactions
  ADD COLUMN posting_key text,
  ADD COLUMN posting_purpose text
    CONSTRAINT ledger_tx_posting_purpose_enum CHECK (
      posting_purpose IS NULL OR posting_purpose IN (
        'PAYMENT_CONFIRMATION', 'REVENUE_RECOGNITION', 'SETTLEMENT', 'CHARGEBACK',
        'REFUND', 'TAX_POINT', 'REVERSAL', 'CORRECTION'
      )
    );

/* ── §9.3: a full reversal may occur only once ──────────────────────────
 * Gated first (0064-style): the void paths guard status transitions, so
 * no original can have two reversals — but "cannot" is what gates are
 * for. */
DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT 1 FROM ledger_transactions
    WHERE reverses_id IS NOT NULL
    GROUP BY business_id, reverses_id
    HAVING count(*) > 1
  ) d;
  IF bad > 0 THEN
    RAISE EXCEPTION 'reversal uniqueness: % originals carry more than one reversal; repair before constraining', bad;
  END IF;
END;
$$;

CREATE UNIQUE INDEX ledger_tx_reversal_once_ux
  ON ledger_transactions (business_id, reverses_id)
  WHERE reverses_id IS NOT NULL;

/* ── §9.4: financial-event idempotency ──────────────────────────────────*/
CREATE UNIQUE INDEX ledger_tx_financial_event_ux
  ON ledger_transactions (business_id, source_type, source_id, posting_purpose)
  WHERE posting_purpose IS NOT NULL;

/* ── the ledger-level postingKey ────────────────────────────────────────*/
CREATE UNIQUE INDEX ledger_tx_posting_key_ux
  ON ledger_transactions (business_id, posting_key)
  WHERE posting_key IS NOT NULL;
