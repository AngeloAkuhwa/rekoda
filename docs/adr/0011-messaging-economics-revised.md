# 0011 — Messaging economics after Meta's 1 October 2026 change

**Status:** Accepted
**Date:** 2026-08-19
**Supersedes:** [0002](0002-meta-direct-for-chat.md)

## Context

ADR 0002 chose Meta Cloud API direct over Twilio for Rekoda Chat and claimed
**~₦2,900/merchant/month of COGS deleted**, on the basis that free-form service
replies inside the 24-hour window carry no Meta per-message fee. That was true
when written. It stops being true in six weeks, and ADR 0002's margin
arithmetic — and the "75%+ gross margin" line it funded — does not survive the
change.

The confirmed facts:

* From **1 October 2026** Meta charges for **every service message**
  individually. Service messages are all free-form replies inside the 24-hour
  window, regardless of whether a human or an AI wrote them. They have been
  free since November 2024.
* The rate is the **same per-message rate as utility/authentication templates
  in that country**, **flat, with no volume discount** — unlike templates.
* Utility templates lose their free-inside-the-window status at the same time.
* Meta publishes exact rates by **1 September 2026**. The anchor is known:
  Nigeria utility ≈ **$0.0067/message**, authentication ≈ **$0.0145**.
  At ~₦1,500/$ that is roughly **₦10 per outbound message**.

## Decision

**1. Meta-direct stands.** Twilio passes Meta's fees through *and* adds its own
~$0.005 each way, so Meta-direct remains strictly cheaper under any published
rate. Nothing about the channel choice changes. What changes is the size of the
prize: the saving is real but far smaller than ADR 0002 claimed, and it no
longer funds an unlimited-feeling allowance.

**2. Bill on messages *processed*, not messages sent.** Meta charges on
outbound; inbound merchant messages are not billed the same way. So the plan
allowance must be defined as **inbound + outbound messages processed**, which
bounds Rekoda's COGS *by design* rather than leaving it hostage to how
conversational a given merchant is. A 400-message allowance under this
definition has a hard worst case; under an outbound-only definition it does not.

**3. Publish both scenarios internally and price against the pessimistic one.**

| Scenario | Outbound | Messaging | AI | COGS | Margin on ₦9,900 |
|---|---|---|---|---|---|
| All 400 billable | 400 | ₦4,000 | ₦2,000 | ₦6,000 | **39%** |
| ~50/50 split (expected) | 200 | ₦2,000 | ₦2,000 | ₦4,000 | **60%** |

The gap between those rows is the difference between "the plan works" and
"Chat is mispriced". The **~₦2,900 saved / 75%+ margin** claim in ADR 0002 is
withdrawn; ₦9,900 still clears its COGS in both rows, but the pessimistic row
is below target and must not be discovered after launch.

**4. Message-count engineering is mandatory from M2, not an optimisation.**
Every outbound message is now COGS, so the conversation design *is* the margin:

* batch confirmation and result into **one** message, never a sequence;
* one interactive-button message instead of three texts;
* suppress low-value acknowledgements (`quiet_mode` becomes the default, not
  an opt-in);
* never send a message a deterministic reply could have carried.

**5. `outbound_messages` per merchant is a first-class telemetry column** in
`usage_events` from M2, with an alert threshold — not a number reconstructed
later from provider invoices.

## Consequences

The **1 September 2026** standing trigger (MASTER-PLAN §11.2) is promoted from
"re-run the COGS table" to a **release-gating task**: pull the published rates,
re-run both scenarios, and re-confirm the ₦9,900 tier before any public pricing
page goes live. If the published Nigerian service rate lands materially above
the utility anchor, the ₦9,900 allowance is cut before launch rather than the
price being raised on a cohort we promised to grandfather.

`docs/pricing-model.md` must be regenerated against this ADR; every COGS table
in it currently assumes the pre-October regime.

## Sources

* https://nordflux.de/en/insights/whatsapp-business-api-pricing-october-2026
* https://turbodev.ai/blog/whatsapp-business-api-pricing-change-october-2026
* https://ominiflow.com/whatsapp-api-pricing/nigeria — Nigeria per-message rates
