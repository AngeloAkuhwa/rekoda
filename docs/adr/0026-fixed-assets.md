# 0026 — A generator is an asset, not a month's expense

**Status:** Accepted
**Date:** 2026-08-22
**Supersedes (in part):** 0004, which fixed the chart; extends 0025, which last amended it

## Context

ADR 0004 fixed the chart and said it stays fixed "until real usage (not
speculation) demands custom accounts". This is that demand, and the evidence
is arithmetic rather than opinion.

A merchant buys a ₦450,000 generator. Today that reaches `EXPENSES` through
the `power` category, which means:

- **The month of purchase reports a loss it did not make.** ₦450,000 comes
  off one month's profit for a thing the business will use for years.
- **Every month after reports a profit it did not make**, because nothing
  charges the use of that generator against the months it powers.
- **The balance sheet never shows it.** A business that owns a generator, a
  freezer and a delivery bike shows none of them, so its total assets are
  understated by everything it owns that is not stock or money.

ADR 0015 committed Rekoda to "a system a merchant can take to a bank". A
balance sheet that omits the equipment and a profit figure that swings by the
cost of a generator is not that. This is the same class of defect as the cost
of goods sold overstating profit (#68) and inventory drifting from the ledger
(#71): the books are internally consistent and describe something untrue.

## Decision

**Three accounts, and the chart grows to fourteen.**

| Key | Code | Type | What it holds |
|---|---|---|---|
| `EQUIPMENT` | 1300 | asset | What the business paid for things it keeps and uses |
| `ACCUMULATED_DEPRECIATION` | 1310 | asset | What has been charged against them so far, as a negative |
| `DEPRECIATION` | 6100 | expense | This period's charge |

`ACCUMULATED_DEPRECIATION` is a **contra-asset**: an asset-type account with a
credit balance. It needs no special handling, because `naturalBalance` already
computes debits less credits for asset accounts, so it lands on the balance
sheet as a negative figure directly beneath the equipment it reduces. That is
exactly how a real balance sheet presents it, and it means the accounting
identity holds without anything being told about depreciation.

It is a separate account rather than a reduction of `EQUIPMENT` because the
two facts are different and an accountant expects both: what the business
paid, and how much of that has been used up. Netting them would destroy the
first, and the first is the one a lender asks about.

**Straight line, monthly, no salvage value.**

Cost divided by useful life in months, charged every month, down to zero.

The alternatives are all defensible and all worse here. Reducing balance
front-loads the charge and needs a rate nobody in this market will have an
opinion about. A salvage value asks a merchant to predict what a freezer will
fetch in five years, which is a guess dressed as an input, and getting it
wrong misstates every month rather than just the last one. Straight line with
no salvage is the method a Nigerian SMB's accountant will expect, the one a
merchant can check with a calculator, and the only one whose inputs a merchant
actually knows: what it cost, and roughly how long it will last.

**Useful life is asked, never inferred.** Rekoda does not guess whether a
thing is a generator or a laptop from its description. A model deciding how
long a merchant's equipment lasts would be a model computing money, which the
spec forbids, and it would be wrong often enough to matter.

**What counts as equipment is the merchant's call, not a threshold.** No
minimum naira value: a ₦40,000 phone a trader uses for three years is as much
a fixed asset as a ₦450,000 generator, and a threshold would only teach
merchants to route things around it. The surface asks plainly and the merchant
decides.

## What this is explicitly not

- **Not a fixed asset register for auditors.** No serial numbers, locations,
  insurance values, or revaluation. Those are a different product.
- **Not a disposal workflow.** Selling or scrapping equipment is a real event
  with a gain or loss, and it is not in this slice. Until it exists, a
  disposal is expressible as a manual journal (#73), which is why that exists.
- **Not tax depreciation.** Nigerian capital allowances follow their own
  rules and rates. These are management accounts (ADR 0015), and a merchant's
  accountant computes the tax position from them.

## Consequences

The balance sheet gains two lines and the profit and loss gains one. Because
both statements are built by iterating the chart and grouping by account
TYPE, no statement code changes at all — which is the payoff for having built
them that way.

A month's profit stops moving by the price of a generator, and a merchant who
owns things can show a lender what they own.
