# 0017 — Meta-direct for Integrate too; Twilio becomes optional

**Status:** Accepted — **scope narrowed by
[0018](0018-retire-waba-catalogue-capture.md)**. Coexistence does not deliver
catalog/order events to the Cloud API app, and Nigeria may be ineligible for
Coexistence at all, so the WABA catalogue is retired as an order-capture path.
**The channel decision below still stands for Rekoda's own number**; what
disappears is multi-tenant WABA management, and with it the per-WABA credential
storage and webhook-routing work costed below.
**Date:** 2026-08-19
**Supersedes the channel split in:** [0002](0002-meta-direct-for-chat.md) (already
superseded on economics by [0011](0011-messaging-economics-revised.md); this
retires its remaining live decision)

## Context

ADR 0002 split the channels: **Meta Cloud API direct for Chat** (Rekoda's own
number) and **Twilio's Tech Provider programme for Integrate**, on the reasoning
that Twilio's tooling "genuinely reduces operational surface" for per-merchant
WABA onboarding. ADR 0011 superseded 0002's economics but explicitly left the
channel decision standing. Two findings now overturn it.

**1. Meta's own Tech Provider programme does the multi-tenant job directly.**
Tech providers can use **Embedded Signup** to onboard customers and **directly
manage their WABAs** — no BSP intermediary. As of April 2026 Embedded Signup is
**the default path** for all new WhatsApp Business API onboardings, and the whole
flow happens in a single Meta-hosted popup rather than across Business Manager,
the developer portal and a provider dashboard. Twilio is one way to reach that
programme; it is not the programme.

**2. Tech Provider enrolment is mandatory for ISVs regardless.** Rekoda has to
enrol either way, which removes most of the "Twilio saves us the setup" argument.

**3. The economics changed underneath the original decision.** Twilio charges
**~$0.005 per message each way (~₦7.25)** *on top of* Meta's own fees. Against
the Integrate plan's 800-message allowance:

```
800 messages × ₦7.25         ≈ ₦5,800 / merchant / month
as a share of ₦19,900        ≈ 29% of plan revenue
at 100 Integrate merchants   ≈ ₦580,000 / month
```

₦580,000/month is an engineer. ADR 0002 was written when messaging was a smaller
line; ADR 0011 made messaging the dominant COGS, and a 29% revenue haircut for
onboarding tooling no longer survives that.

## Decision

**Rekoda enrols as a Meta Tech Provider and runs Integrate on Meta Cloud API
direct, the same channel layer Chat already uses. Twilio becomes an optional
fallback, not the default path.**

* **The channel layer stays provider-agnostic** — that part of ADR 0002 was
  right, and it is what makes this a configuration change rather than a rewrite.
* **Onboarding is Embedded Signup**: one Meta-hosted popup, merchant owns their
  WABA, Rekoda manages it as their Tech Provider.
* **Twilio stays behind a flag** for the case where Meta-direct multi-tenant
  operations prove genuinely painful in the alpha. Keeping the adapter costs
  little; paying ₦5,800/merchant/month by default costs a lot.

**Sequencing, honestly:** during the M5 concierge alpha (5–10 merchants) the
Twilio surcharge is ~₦58,000/month total — trivial, and if Twilio's tooling gets
the first merchants live faster, use it. **The switch matters by roughly 30–50
Integrate merchants**, and the channel layer must be built so that switch is an
env var, not a project.

## Coexistence is a precondition, not a detail

Porting a number to the API historically **disconnects the WhatsApp Business
App**. For a merchant who runs her business inside that app, that trade is
unacceptable, and any A2 implementation that makes it silently has taken her
business away to gain a webhook.

**Meta's Coexistence feature (May 2025) is the precondition**: one number live on
the Business App *and* Cloud API simultaneously, chats and contacts preserved,
messages mirroring both ways, activated through Embedded Signup. **A2 uses
Coexistence or A2 does not ship.**

One consequence for ADR 0011's economics: under Coexistence the merchant's own
app messages are **not** API-billed, while Rekoda's API sends are. So Rekoda
should leave conversation to her in the app and spend API messages only on what
only Rekoda can do — confirmations, documents, verified-payment alerts.

**Unconfirmed and worth checking before A2 work starts:** whether catalogue
**order** webhooks reach the API app under Coexistence. Message mirroring is
documented; order messages specifically are not, and Meta's developer site is
egress-blocked from this environment.

## What Rekoda has to build that Twilio would have provided

Being clear-eyed about the trade — this is real work, not free:

* **Per-WABA credential storage** (encrypted, per-merchant tokens) and rotation.
* **Webhook routing by WABA/phone-number ID** to the right tenant — this must
  resolve *before* the privacy gateway, and it is the highest-risk piece:
  a mis-routed webhook is a cross-tenant data leak, so it gets the same
  fail-closed treatment as RLS.
* **Per-merchant template management** and submission state.
* **Phone-number registration and health** surfaced in admin.
* **Meta support is materially worse than Twilio's.** Budget for slower
  resolution when a merchant's number breaks, and make provider health a
  first-class admin screen (already in MASTER-PLAN Part 6.4).

## Consequences

Integrate's margin improves by roughly **29 percentage points** at plan level,
which is the difference between Integrate being a strong tier and a thin one.
One channel layer serves both products, so there is one webhook path, one
signature scheme and one set of tests instead of two.

The cost is that per-merchant WABA operations become Rekoda's problem. That is
the right trade at ₦5,800/merchant/month — but it is a real engineering
commitment, and it belongs in M5's estimate rather than being discovered inside
it.

## Sources

* Embedded Signup — default path since April 2026; tech providers onboard and directly manage client WABAs — https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/
* Meta Tech Provider registration — https://www.alibabacloud.com/help/en/chatapp/use-cases/how-to-register-as-a-meta-tech-provider
* Twilio Tech Provider programme (the retired default) — https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide
