-- A business's functional currency must look like a currency (FX-01, §16).
--
-- Every OTHER currency column in this schema already says so:
-- `ledger_transactions.functional_currency` and
-- `ledger_entries.transaction_currency` since 0068, and both sides of
-- `exchange_rate_snapshots` since 0069, all carry `~ '^[A-Z]{3}$'`.
-- `businesses.currency` is `text NOT NULL DEFAULT 'NGN'` and carries
-- nothing, which makes the ONE column that decides what a merchant's books
-- are denominated in the only unconstrained one in the set.
--
-- That asymmetry is harmless while the launch is NGN-only and no onboarding
-- path accepts a currency at all. It stops being harmless the moment the
-- dark FX work (ADR 0033) starts reading this column to decide whether a
-- line is cross-currency: `ledger_tx_currency_valid` already compares a
-- transaction's functional currency against it, so 'ngn' or 'Naira' in this
-- column would refuse every posting a merchant made, with an error about the
-- transaction rather than about the data that is actually wrong.
--
-- Deliberately shape only. It does NOT restrict the value to NGN: that is a
-- product decision recorded in ADR 0033 and enforced by there being no way
-- to set it, not a constraint that a later multicurrency merchant would have
-- to migrate their way out of.
--
-- The backfill runs first and is not a guess. Anything that is already three
-- upper-case letters is left exactly as it is; a lower-case three-letter
-- value is the one unambiguous repair, because 'ngn' can only have meant
-- NGN. Anything else is left alone and the constraint refuses it, which is
-- the correct outcome: a value nobody can interpret should stop a migration
-- rather than be quietly rewritten into one somebody guessed.
UPDATE businesses
   SET currency = upper(currency)
 WHERE currency ~ '^[a-zA-Z]{3}$'
   AND currency <> upper(currency);

ALTER TABLE businesses
  ADD CONSTRAINT businesses_currency_shape CHECK (currency ~ '^[A-Z]{3}$');
