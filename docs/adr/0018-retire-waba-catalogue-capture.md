# 0018 — Retire the WABA catalogue as an order-capture path

**Status:** Accepted
**Date:** 2026-08-19
**Retires rung A2 of:** [0012](adr/0012-integrate-without-cac.md) · **corrects**
[0017](0017-meta-direct-for-integrate-too.md) and `integrate-explained.md` §6b

## Context

ADR 0012 kept the native WABA catalogue as rung **A2** — the upgrade for
CAC-registered merchants whose customers order inside WhatsApp's own catalogue
UI. ADR 0017 made **Coexistence** a precondition, so a merchant would keep the
WhatsApp Business App rather than lose it to a migration, and flagged one
unknown: *do catalogue `order` webhooks reach the API app under Coexistence?*

The owner ran that question down against Meta's own sources. **The answer is no,
and there is a prior blocker underneath it.**

**1. Coexistence does not carry business tools to the API side.** Meta's own
feature-comparison table for Business App → Cloud API onboarding has a row
covering **catalog, orders and status**: post-onboarding the app side shows *no
change*, and the "supported on Cloud API" column reads **Not supported**. Group
chats, voice and video calls, messaging tools and business profile carry the
same verdict. **The catalogue keeps working in her app and stays invisible to
Rekoda.**

**2. Nigeria may be ineligible for Coexistence at all.** Sources conflict and
Meta publishes no dated list. A GitHub thread citing Meta's
`#unsupported-countries` anchor lists **Nigeria and South Africa** as the only
remaining unsupported countries; GoHighLevel (June 2026) states Coexistence is
unavailable for Nigerian and South African numbers and directs you to New Number
or BSP Migration instead; Wati says eligibility is confirmed **per phone number
during Embedded Signup** rather than from a published list. One outlier
(ChakraHQ, July 2026) claims both countries were added from April 2026.

Either finding alone is fatal to A2. Together they settle it.

## Decision

**Retire the WABA catalogue as an order-capture path. Ladder A is A0 and A1.**

The remaining route to catalogue orders would be a **full migration** — porting
the number to the Cloud API outright, where catalog and order webhooks do work
normally. **That is not impossible; it is unacceptable**, because the price is
the merchant's WhatsApp Business App: the interface she runs her business in,
along with her chat history and groups. Rekoda does not ask a market vendor to
give up her app to gain a webhook (ADR 0017).

So:

* **A1, the Rekoda storefront, is not the default — it is the path.** It was
  already better on approval gates and schema ownership; it is now the only
  order-capture route that does not cost the merchant something she cannot
  afford to lose.
* **A0, order forwarding, remains the bridge** for merchants who already run a
  Business App catalogue and would rather forward than move.
* **A WABA may still earn its place for *messaging*** — sending invoices,
  receipts and payment confirmations from the merchant's own branded number
  rather than Rekoda's. That is a separate question from order capture, it
  requires CAC and verification, and it is **out of V1 scope**. Do not let it
  quietly reintroduce A2.

## The one-hour test that closes this

Before any A2-shaped work is ever reconsidered: **push a +234 number through
Embedded Signup and observe whether it throws a country-ineligibility error.**
That resolves the Coexistence-availability question empirically, costs about an
hour, and is cheaper than resolving the webhook question first. **Note the order
of operations — eligibility first, webhooks second.** If eligibility fails, the
webhook question never needs asking.

## Consequences

**Integrate gets simpler and more honest.** Ladder A collapses from three rungs
to two, both of which need nothing from Meta. Every remaining external approval
gate leaves the product: no business verification, no display-name review, no
catalogue approval, no Coexistence eligibility.

**It also removes a class of engineering** ADR 0017 had scoped: per-WABA
credential storage, webhook routing by phone-number ID, per-merchant template
state. That routing layer was the highest-risk piece in the whole Integrate
design — a mis-routed webhook is a cross-tenant leak — and it is now
unnecessary for V1. **ADR 0017's channel decision still stands for Rekoda's own
number**; what disappears is multi-tenant WABA management.

**The strategic reading:** the storefront was adopted to route around CAC. It
turns out to route around Meta entirely — approval queues, country eligibility,
feature gaps and app migration alike. That is a stronger position than the plan
originally claimed, arrived at for a reason nobody anticipated.

## Sources

* Meta feature comparison for Business App → Cloud API onboarding: business tools (catalog, orders, status) — **Not supported** on Cloud API post-onboarding
* Meta Coexistence unsupported-countries anchor (via GitHub thread) — Nigeria, South Africa
* GoHighLevel, June 2026 — Coexistence unavailable for NG/ZA numbers
* Wati — eligibility confirmed per phone number during Embedded Signup
* ChakraHQ, July 2026 — contrary claim that NG/ZA were added April 2026
