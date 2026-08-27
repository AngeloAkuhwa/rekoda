-- Backfill `ledger_entries.account_id` across all history, with validation
-- (F1; PR-032).
--
-- The dual write (0063) means no row born after that deploy is unlinked, so
-- this touches only the historical tail — and the mapping is the same one
-- the dual write uses live: legacy text key → the seeded chart row that
-- KEPT ITS CODE. The join goes key → code (the seventeen legacy pairs,
-- stated inline so this file is self-contained) → accounts.code.
--
-- VALIDATED, not hoped: the final DO block counts what is still unlinked
-- and what is linked to a row whose code disagrees with the key, and ABORTS
-- the migration on either. A backfill that reports success while rows
-- dangle is the exact failure §22-style gates exist to catch.
--
-- Idempotent: the UPDATE targets `account_id IS NULL`, so a re-run against
-- a half-backfilled estate finishes the job and a re-run against a finished
-- one touches nothing.

UPDATE ledger_entries e
SET account_id = a.id
FROM (VALUES
  ('CASH',                     '1000'),
  ('BANK_PAYSTACK',            '1010'),
  ('BANK',                     '1020'),
  ('ACCOUNTS_RECEIVABLE',      '1100'),
  ('INVENTORY',                '1200'),
  ('EQUIPMENT',                '1300'),
  ('ACCUMULATED_DEPRECIATION', '1310'),
  ('ACCOUNTS_PAYABLE',         '2000'),
  ('VAT_PAYABLE',              '2100'),
  ('OWNERS_EQUITY',            '3000'),
  ('SALES_REVENUE',            '4000'),
  ('COGS',                     '5000'),
  ('EXPENSES',                 '6000'),
  ('DEPRECIATION',             '6100'),
  ('DISPOSAL_RESULT',          '6200')
) AS map(key, code), accounts a
WHERE e.account = map.key
  AND a.business_id = e.business_id
  AND a.code = map.code
  AND e.account_id IS NULL;

/* ── the gate ───────────────────────────────────────────────────────────── */
DO $$
DECLARE
  unlinked  bigint;
  disagree  bigint;
BEGIN
  SELECT count(*) INTO unlinked FROM ledger_entries WHERE account_id IS NULL;

  SELECT count(*) INTO disagree
  FROM ledger_entries e
  JOIN accounts a ON a.id = e.account_id
  JOIN (VALUES
    ('CASH',                     '1000'),
    ('BANK_PAYSTACK',            '1010'),
    ('BANK',                     '1020'),
    ('ACCOUNTS_RECEIVABLE',      '1100'),
    ('INVENTORY',                '1200'),
    ('EQUIPMENT',                '1300'),
    ('ACCUMULATED_DEPRECIATION', '1310'),
    ('ACCOUNTS_PAYABLE',         '2000'),
    ('VAT_PAYABLE',              '2100'),
    ('OWNERS_EQUITY',            '3000'),
    ('SALES_REVENUE',            '4000'),
    ('COGS',                     '5000'),
    ('EXPENSES',                 '6000'),
    ('DEPRECIATION',             '6100'),
    ('DISPOSAL_RESULT',          '6200')
  ) AS map(key, code) ON map.key = e.account
  WHERE a.code <> map.code;

  IF unlinked > 0 THEN
    RAISE EXCEPTION 'ledger backfill incomplete: % entries still have no account_id', unlinked;
  END IF;
  IF disagree > 0 THEN
    RAISE EXCEPTION 'ledger backfill wrong: % entries link to an account whose code disagrees with their key', disagree;
  END IF;
END;
$$;
