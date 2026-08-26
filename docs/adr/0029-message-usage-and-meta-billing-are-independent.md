# ADR 0029 — Message usage and Meta billing responsibility are independent

**Status**: accepted, amended 26 August 2026 before merge
**Date**: 26 August 2026
**Relates to**: spec §4.2, §24, §29; ADR 0024 commercial rule 3

## Context

Spec §4.2 lists five WhatsApp message categories among the seventeen canonical
metered units: `SERVICE_MESSAGE`, `UTILITY_TEMPLATE`, `AUTH_TEMPLATE`,
`AUTH_INTL_TEMPLATE`, `MARKETING_TEMPLATE`. PR-014 taught the counter to hold
all seventeen. PR-016 had to decide what "metering" one of these five means.

The first draft of this ADR framed it as a choice: the categories are either a
merchant allowance or Rekoda's cost. **That framing was wrong and is
superseded by this amendment.** It collapsed two independent axes into one, and
in doing so made a commercial arrangement Rekoda has not yet confirmed into an
architectural assumption.

Meta's Embedded Signup supports attaching client WABAs to a provider's credit
line: the businesses pay the provider, and the provider receives an aggregated
Meta invoice. Rekoda-funded billing is a live possibility, not a hypothetical,
and spec §24 still carries `MetaBillingMode` as **OPEN COMMERCIAL** pending W0.
A design that hard-codes "Rekoda pays" or "the merchant pays" is a design that
has answered W0 in advance.

## Decision

**Message usage metering and Meta cost attribution are two independent axes.**

**Axis one: usage.** Rekoda meters message categories per business for
entitlement, allowance, abuse control, analytics and commercial packaging.
This happens regardless of who Meta bills. A merchant plan may include an
allowance of utility messages even where Meta bills that merchant directly:
the allowance exists for product packaging, automation capacity, abuse
prevention and support economics, not only for cost recovery.

**Axis two: cost.** `MetaBillingMode` determines whether a metered message
also produces a Rekoda `PlatformCostEvent`.

```
MERCHANT_DIRECT      usage metered · Rekoda Meta cost may be zero
REKODA_CREDIT_LINE   usage metered · PlatformCostEvent created
PARTNER_BILLED       usage metered · cost attributed per partner agreement
```

**Provider-cost attribution must never be inferred from usage metering
alone.** A row in the usage meter is evidence that a message was sent, not
evidence that Rekoda paid for it.

## What this PR built, and what it did not

PR-016 built axis one for the sends that exist today, plus a cost figure
against each, because the margin model needs a baseline before W0 resolves
and a count that starts on the day the price does has nothing to compare
against. The rate card is effective-dated rather than absolute (see below).

It did **not** set merchant allowances for the five categories. Every plan
sells zero of them, for the reason PR-014 established: no code path consumes
them yet, and a number on the pricing page that nothing can spend is a
promise Rekoda cannot keep. Allowances arrive with W1/W2, when a merchant
messages their OWN customer on their own WABA and the category is chosen at
send time (PR-061). That is a plan-table edit, not a schema change, which is
the whole reason the units exist now.

It also did not build `PlatformCostEvent`. Until BL2 does, `usage_events`
carries the cost figure as telemetry, which spec §29 is explicit is "never
designed as a financial record".

## Rates are effective-dated observations, not constants

The marketing-to-utility ratio is approximately 5.2x at the Meta rate card
this repository last verified. **That number is an observation with a date on
it, not a domain truth.** It is derived at runtime from the rate schedule
rather than stored, so a Meta repricing moves it without anybody editing a
constant, and a stale ratio can never outlive the rates it was computed from.

## Consequences

`usage_events.usage_type` carries the category. The margin view gains
`costByUsageType`, because grouping by provider alone leaves the spread
invisible: the Meta total moves and nothing says which way the mix went.

`MARKETING_TEMPLATE` has no sender and commercial rule 2 keeps it that way in
V1. The rate is carried so that the day something sends one, it is priced and
visible rather than discovered on an invoice.

## What this does not cover

Two sends have no business to attribute anything to: the sign-in code (the
phone has no business yet, which is what signing in is for) and the stranger
reply (there is no business by definition). `usage_events.business_id` is NOT
NULL with a foreign key, so neither can be written without inventing a
merchant.

Spec §29 anticipated this and put it in `PlatformCostEvent`, whose
`businessId` is nullable because "some costs are not attributable to one
merchant". Until BL2 builds that, the sign-in code is logged with its category
and its rate and left unattributed. Inventing an attribution to make a report
look complete is the one thing a cost baseline must not do.
