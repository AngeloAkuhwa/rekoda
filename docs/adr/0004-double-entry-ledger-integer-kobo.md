# 0004 — Double-entry ledger, integer kobo

**Status:** Accepted
**Date:** 2026-08-19

## Context

The architecture spec lists `LedgerAccount`/`LedgerEntry` but does not
commit to a bookkeeping model. Rekoda's differentiator is reconciliation —
"what should have happened vs what actually happened" — which is incoherent
without entries that always balance. Accountant trust (a named growth
channel) requires records an accountant recognises.

Separately: the predecessor codebase proved integer-kobo arithmetic (every
financial value stored and computed in minor units) eliminates float drift,
with an invariant test suite.

## Decision

* **Double-entry bookkeeping** from the first posting. Every financial
  mutation writes balanced debit/credit pairs inside one database
  transaction; an unbalanced posting is a thrown error, not a warning.
* Fixed V1 chart of accounts: Cash · Bank(Paystack) · Accounts Receivable ·
  Accounts Payable · Sales Revenue · Inventory · COGS · Expense categories ·
  VAT Payable · Owner's Equity.
* **All money is `BIGINT` kobo** in the database and integer kobo in code.
  Formatting to naira happens only at the presentation edge.
* The ledger is append-only: corrections are reversing entries, never
  UPDATEs — matching the spec's audit rules (§42).

## Consequences

Reports, reconciliation states and balances become derivations of one
provably consistent source. Slightly more up-front modelling than a naive
transactions table — repaid the first time a merchant, an accountant and a
Paystack webhook disagree about a payment. The chart of accounts stays
fixed until real usage (not speculation) demands custom accounts.
