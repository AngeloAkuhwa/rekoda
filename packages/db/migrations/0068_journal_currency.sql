-- Journal currency columns, additive (spec §16; F1, PR-037).
--
-- §16's model, mapped onto the tables that exist: `ledger_transactions` is
-- the JournalEntry and gains `functional_currency`; `ledger_entries` is the
-- JournalLine — its `debit_k`/`credit_k` ARE debitFunctionalMinor and
-- creditFunctionalMinor (kobo is the NGN minor unit) — and gains what the
-- money ACTUALLY was: `transaction_currency`, `transaction_amount_minor`,
-- and the snapshot reference that makes a cross-currency line honest.
--
-- Additive on purpose. Every posting to date is NGN-in, NGN-functional, so
-- the defaults state the truth about history and the backfill is pure
-- arithmetic: the transaction amount of a same-currency line is its
-- functional amount, and exactly one of debit/credit is non-zero, so the
-- sum is the amount. The FX table, the snapshot FK and the §10 coherence
-- rules land in PR-038/PR-039; nothing here changes a writer's behaviour.
--
-- `businesses.currency` (0000, default NGN) is Business.functionalCurrency;
-- the §16 invariant that an entry's functional currency equals its
-- business's becomes a trigger in PR-039.

ALTER TABLE ledger_transactions
  ADD COLUMN functional_currency char(3) NOT NULL DEFAULT 'NGN'
    CONSTRAINT ledger_tx_functional_currency_shape CHECK (functional_currency ~ '^[A-Z]{3}$');

ALTER TABLE ledger_entries
  ADD COLUMN transaction_currency char(3) NOT NULL DEFAULT 'NGN'
    CONSTRAINT ledger_entries_tx_currency_shape CHECK (transaction_currency ~ '^[A-Z]{3}$'),
  ADD COLUMN transaction_amount_minor bigint,
  ADD COLUMN exchange_rate_snapshot_id uuid;

UPDATE ledger_entries SET transaction_amount_minor = debit_k + credit_k;

ALTER TABLE ledger_entries
  ALTER COLUMN transaction_amount_minor SET NOT NULL;
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_tx_amount_nonneg CHECK (transaction_amount_minor >= 0);
