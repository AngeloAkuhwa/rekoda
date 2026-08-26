# ADR 0029 — Message categories are Rekoda's cost, not the merchant's allowance

**Status**: accepted
**Date**: 26 August 2026
**Relates to**: spec §4.2, §24, §29; ADR 0024 commercial rule 3

## Context

Spec §4.2 lists five WhatsApp message categories among the seventeen canonical
metered units: `SERVICE_MESSAGE`, `UTILITY_TEMPLATE`, `AUTH_TEMPLATE`,
`AUTH_INTL_TEMPLATE`, `MARKETING_TEMPLATE`. PR-014 taught the counter to hold
all seventeen. PR-016 had to decide what "metering" one of these five means,
and the two readings lead to opposite code.

Read as **allowance**, a message category is capacity a merchant buys and
spends, enforced by `usage_counters` and refused when exhausted.

Read as **cost**, it is money Rekoda pays Meta, recorded in `usage_events` and
totalled by the margin view.

Every outbound message the system sends today is Rekoda talking to the
merchant on Rekoda's own number: a reply to something they said, a sign-in
code, a notice that their card failed, a warning that abandoned records are
due for deletion.

## Decision

The five categories are **Rekoda's cost telemetry**. They do not consume
merchant allowance, and every plan sells zero of them.

Three things decide it:

**The messages are not the merchant's.** Charging a merchant's allowance for
a billing reminder bills them for Rekoda telling them their payment failed.
Charging for a sign-in code bills them for logging in. The reply to their own
message was already paid for as an `AI_ACTION`; charging again for the answer
is charging twice for one exchange.

**ADR 0024 commercial rule 3 already said so.** "Merchants see concrete units
(messages, voice minutes, documents, orders); infrastructure units (tokens,
STT minutes, template fees) are tracked internally per business." Template
fees are named, in the list of things tracked internally.

**Spec §24 says what the separation is for.** "Message categories are metered
separately (§4.2) because utility and marketing differ by roughly eightfold in
cost, and that difference is the largest variable in plan margin." Plan
margin is Rekoda's side of the ledger. An allowance does not have a margin.

## Consequences

`usage_events.usage_type` carries the category. The margin view gains
`costByUsageType`, because grouping by provider alone leaves the eightfold
spread invisible: the Meta total moves and nothing says which way the mix
went.

The allowance side of these units is not dead, it is early. When W1/W2 lands
a merchant's own WABA, the merchant messages their OWN customer, the category
is chosen at send time (PR-061), and metering it against their plan is
correct — because then it is their message. The units exist now so that PR
adds a number to a table rather than a column to a database.

`MARKETING_TEMPLATE` stays at zero on both sides. Commercial rule 2 excludes
bulk and promotional WhatsApp from every V1 plan. The rate is carried so that
the day something sends one, it is priced and visible rather than discovered
on an invoice.

## What this does not cover

Two sends have no business to attribute a cost to, and are therefore not
recorded at all: the sign-in code (the phone has no business yet, which is
what signing in is for) and the stranger reply (there is no business by
definition). `usage_events.business_id` is NOT NULL with a foreign key, so
neither can be written without inventing a merchant to blame.

Spec §29 anticipated exactly this and put it in `PlatformCostEvent`, whose
`businessId` is nullable because "some costs are not attributable to one
merchant". Until BL2 builds that, the sign-in code — the single most
expensive message Rekoda sends — is logged with its category and its rate and
left unattributed. Inventing an attribution to make a report look complete is
the one thing a cost baseline must not do.
