# 0025 — The merchant's own bank account, separate from settlements

**Status:** Accepted
**Date:** 2026-08-21
**Supersedes (in part):** 0004, which fixed the chart at ten accounts

## Context

ADR 0004 fixed a ten-account chart and said it "stays fixed until real usage
(not speculation) demands custom accounts". This is that demand, and it
arrives from two directions at once.

**The label is wrong today.** `cashOrBank()` maps anything that is not cash to
`BANK_PAYSTACK`, and `'transfer'` is the default when a caller names no
method. So a customer transferring straight to a merchant's GTB account, a
merchant paying a supplier by transfer, and an opening bank balance all land
in an account whose statement line reads "Bank (Paystack)". Paystack is not
live (spec §47 gates it on written confirmation), which means that label is
wrong for every merchant who could currently exist.

**The figure reconciles against nothing.** Bank reconciliation compares what
the books say against what one bank says. A single account holding both a
merchant's own account and their Paystack settlements produces a balance that
matches no statement anybody holds, so reconciliation would be incoherent
before it was built.

## Decision

Split into two accounts:

- `BANK` (1020) — the merchant's own bank account. Every ordinary transfer,
  every opening bank balance, every supplier payment made by transfer.
- `BANK_PAYSTACK` (1010) — settlements from the payment provider, and
  nothing else. Written only by `postProviderPayment`.

The chart is now eleven accounts. It is still fixed: a merchant cannot add
one, and the ten-versus-eleven number was never the point. What ADR 0004
protects is that a trader who cannot name their accounts cannot misfile into
them, and that is unchanged.

Existing entries are attributed by migration 0035 rather than left where they
are. `ledger_transactions.source_type = 'webhook'` identifies a provider
settlement exactly (it is written in one place, `bookVerifiedPayment`), so
every other `BANK_PAYSTACK` entry moves to `BANK`.

### Why the codes are not renumbered

The merchant's own bank is the more important account and would read better
first, which would mean giving it 1010 and moving settlements to 1015. It
keeps its 1020 anyway: `ledger_entries.account` stores the key and the code is
rendered from `ACCOUNTS` at display time, so renumbering an existing account
changes what a re-rendered statement says about a period that has already
been reported. ADR 0015's statements are a file merchants hand to banks, and
PR #102 exists to stop those changing after the fact. A slightly odd ordering
is a smaller cost than a number that moves.

In practice most merchants see one line either way: a balance sheet lists
only accounts that carry entries, so a business with no Paystack never sees
the settlement account at all.

## Consequences

Reconciliation becomes possible: each account has exactly one statement to
compare against. Cash flow and the "money in the bank" figures must count
both accounts, which is a change in `CASH_KEYS` (core) and `CASH_ACCOUNTS`
(the reports repo) rather than a change in meaning.

The migration is the risk. Attributing an existing entry wrongly changes a
balance sheet that has already been read, so it is exact rather than
heuristic, and it is proven against entries written by every path that
touches a bank account.
