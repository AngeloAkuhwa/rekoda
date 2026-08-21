-- The merchant's own bank account, separate from provider settlements
-- (ADR 0025).
--
-- Until now `cashOrBank()` mapped anything that was not cash to
-- BANK_PAYSTACK, and 'transfer' was the default when a caller named no
-- method. So a customer transferring into a merchant's GTB account, a
-- merchant paying a supplier, and an opening bank balance all landed in an
-- account whose statement line read "Bank (Paystack)". Paystack is not live,
-- which made that label wrong for every merchant who could currently exist,
-- and it made the figure match no statement anybody holds.
--
-- The attribution is exact rather than heuristic, because getting it wrong
-- changes a balance sheet somebody has already read. `source_type =
-- 'webhook'` on a ledger transaction identifies a provider settlement and
-- nothing else: it is written in exactly one place (`bookVerifiedPayment` in
-- settle.ts), and merchant-reported payments arrive as 'chat' or 'dashboard'.
-- Everything else on BANK_PAYSTACK is the merchant's own bank.
--
-- What this does NOT move is the same predicate the overview's VERIFIED lens
-- already counts with (`account = 'BANK_PAYSTACK' AND source_type =
-- 'webhook'`, ADR 0014), so that figure is unchanged by construction.
--
-- No total moves either. Both accounts are assets and both are counted by the
-- cash lens (CASH_KEYS in core, CASH_ACCOUNTS in the reports repo), so no
-- balance sheet total, trial balance total or cash flow figure changes. Only
-- which line a figure prints on.

-- Why a relabel and not a reversing posting.
--
-- ADR 0004 says corrections are reversing entries, never edits, and this is
-- the one place that rule cannot be followed. A reversal would be a posting,
-- postings are dated, and migration 0034 refuses any posting dated into a
-- month a merchant has closed. The entries needing correction are exactly the
-- oldest ones, which are exactly the ones most likely to sit in a closed
-- month. A reversal would also print as movement on a cash flow statement for
-- money that never moved.
--
-- So: an in-place relabel, run once, by the owner, during a migration. It is
-- not reachable from the application, which holds no UPDATE on this table at
-- all (0001_rls.sql revokes it, which is what makes the ledger append-only).

DO $$
DECLARE
  moved   bigint;
  stragglers bigint;
BEGIN
  /* Row-level security is FORCED on this table, so it applies to the owner
   * too, and an unpinned statement matches nothing. In development the owner
   * happens to be a superuser and bypasses it; a production migration role
   * that is not would UPDATE zero rows and report success, leaving every
   * merchant's bank money mislabelled with no error anywhere. Disabling it
   * explicitly for the length of this transaction is the difference between
   * a migration that works and one that only appears to. DDL is
   * transactional, so a failure below puts the policy straight back. */
  ALTER TABLE ledger_entries DISABLE ROW LEVEL SECURITY;

  UPDATE ledger_entries e
     SET account = 'BANK'
    FROM ledger_transactions t
   WHERE t.id = e.transaction_id
     AND t.business_id = e.business_id
     AND e.account = 'BANK_PAYSTACK'
     AND t.source_type <> 'webhook';
  GET DIAGNOSTICS moved = ROW_COUNT;

  /* The check that makes a silent no-op impossible. If anything is still on
   * the settlement account that did not come from a settlement, the
   * attribution above did not do what it claims and the whole migration
   * rolls back rather than leaving the books half relabelled. */
  SELECT count(*) INTO stragglers
    FROM ledger_entries e
    JOIN ledger_transactions t
      ON t.id = e.transaction_id AND t.business_id = e.business_id
   WHERE e.account = 'BANK_PAYSTACK' AND t.source_type <> 'webhook';

  ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;

  IF stragglers > 0 THEN
    RAISE EXCEPTION
      'bank split left % entries on the settlement account that are not settlements', stragglers;
  END IF;

  RAISE NOTICE 'bank split: % entries moved to BANK', moved;
END
$$;
