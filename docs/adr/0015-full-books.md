# 0015 — End-to-end books: trial balance, P&L, balance sheet, period close

**Status:** Accepted
**Date:** 2026-08-19
**Extends:** [0004](0004-double-entry-ledger-integer-kobo.md)

## Context

The owner's requirement is that Rekoda gives vendors **end-to-end accounting**,
not a document generator with a ledger hidden behind it. ADR 0004 already put
the hard part in place — balanced double-entry postings in integer kobo over a
fixed chart of accounts — and M0 proved it (property sweep: 200 runs × 20
postings, never unbalanced).

But the plan's only reporting artefact is a **Financial Snapshot**: sales,
received, expenses, outstanding, unreconciled. That is a *pulse*, not a set of
books. An accountant cannot file from it, and a merchant applying for credit
cannot show it to a lender.

The gap is smaller than it looks: the ledger already holds everything needed.
What is missing is the reporting layer over it.

## Decision

**Ship the four statements plus period close, all derived deterministically
from `ledger_entries` — never from AI, never recomputed from documents.**

| Statement | Derived from | Who it is for |
|---|---|---|
| **Trial balance** | All postings, grouped by account | The correctness proof; already exists in `@rekoda/core` |
| **Profit & loss** | `SALES_REVENUE` · `COGS` · `EXPENSES` over a period | The merchant's "am I making money?" |
| **Balance sheet** | `CASH` · `BANK_PAYSTACK` · `ACCOUNTS_RECEIVABLE` · `INVENTORY` · `ACCOUNTS_PAYABLE` · `VAT_PAYABLE` · `OWNERS_EQUITY` at a date | Lenders, accountants, anyone assessing the business |
| **Cash flow** | Movement across `CASH` + `BANK_PAYSTACK`, reconciled to opening/closing balances | The one a market vendor actually feels |

The V1 chart of accounts already supports all four. No schema change is needed —
this is a reporting layer, which is why it is affordable.

### Cash-basis presentation, accrual ledger

**The ledger stays accrual** — that is what makes receivables, payables and
reconciliation coherent, and it is not negotiable.

**But the merchant's default view is cash basis**, because that is how a market
trader thinks: money in, money out, what's left. A vendor who sold ₦500,000 on
credit has not "made ₦500,000" in any sense they recognise, and showing that as
profit teaches them to distrust the product.

So: **one ledger, two lenses.** Cash basis by default for the merchant, accrual
available to the accountant and always used for the balance sheet. The toggle
is labelled in plain words — *"money actually received"* vs *"including money
owed to you"* — never "cash basis / accrual basis."

### Period close

An accountant who reconciles August needs August to stop moving.

* Closing a period **locks** it: no new postings dated inside it.
* A correction after close posts a **dated reversal in the open period**,
  referencing the original — which the append-only rule already requires.
* Closing is **reversible by the owner** with an audit event, because small
  businesses reopen periods and pretending otherwise just teaches them to
  avoid closing.
* Every close writes an immutable snapshot: the four statements as at close,
  hashed like any other document.

### What this is explicitly not

* **Not a tax filing product.** Statements are management accounts. Rekoda does
  not file, does not compute tax liability beyond the VAT it already tracks,
  and must never imply otherwise (MASTER-PLAN §9.2).
* **Not a replacement for an accountant.** It is the thing that makes an
  accountant cheap — which is also the growth wedge: one accountant brings
  10–30 merchants.

## Consequences

Rekoda stops being "WhatsApp invoicing with a ledger" and becomes a system a
merchant can take to a bank. That is a materially stronger reason to pay
₦29,900 than more documents.

It also sharpens the accountant channel: an accountant receiving a trial balance
and a locked period is receiving something they recognise, instead of a CSV they
must rebuild.

**Build cost is low and should not be over-scoped.** These are SQL aggregations
over `ledger_entries` plus a lock flag and a snapshot — no new tables of
substance, no new domain concepts. The risk is not difficulty; it is scope creep
into budgeting, forecasting, multi-currency and departments. **V1 ships four
statements and a period lock. Nothing else.**
