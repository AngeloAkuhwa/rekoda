# 0012 — Integrate without CAC: tiered capture and tiered verification

**Status:** Accepted — ladder B reordered by [0013](0013-rekoda-as-the-single-integration.md)

> **Ladder B update, 2026-08-19.** Everything below stands. But B0/B1 both still
> ask the merchant to onboard themselves to a financial provider, and ADR 0013
> found a rung that asks for nothing but an account number: Rekoda's own
> Paystack account with merchants as **subaccounts**, and per-customer NUBANs
> issued under Rekoda that split straight to the merchant's bank. If Paystack
> and counsel confirm it, that becomes ladder B's default and **B0 (open
> banking) becomes its complement** — the way to see money arriving at accounts
> Rekoda did not issue — rather than the primary.
**Date:** 2026-08-19
**Supersedes:** [0009](0009-dva-bank-transfer-reconciliation.md) — which positioned
Paystack DVAs as *the* bank-transfer answer. They are one rung of a ladder, and
not the rung most Rekoda merchants will stand on.

## Context

ADR 0009 established that Paystack DVAs require a **CAC-registered business
with approved KYC**, and concluded that DVAs therefore "extend the moat to
registered merchants". Restating the owner's objection, which is correct:
**most WhatsApp vendors do not have a CAC registration, and they are precisely
the market Rekoda exists to serve.** A design that serves them last is a design
aimed at the wrong customer.

Investigating properly surfaced a second, larger exclusion that ADR 0009 missed
entirely:

> **Meta business verification for a WABA also effectively requires CAC in
> Nigeria.** A utility bill can support an address claim but is not accepted as
> proof of legal business identity on its own. So the *original* Integrate
> design — per-merchant WABA via Embedded Signup — already excluded the same
> merchants, before Paystack was ever considered.

**Precision added 19 Aug 2026 — Meta does not require CAC to *have* a WABA.**
An **unverified** business can operate one and message **250 unique customers
per rolling 24 hours** with **two registered phone numbers**. For a market
vendor, 250 customers a day is far above real volume, so the messaging cap is
not what excludes them. Two other things are:

1. **The display name is not visible until the business is verified** — the
   merchant's customers see a phone number instead of "Ada Fashion", which
   destroys exactly the trust the WABA was meant to provide.
2. ~~Meta may deactivate unverified WhatsApp Business accounts after ~30 days.~~
   **RETIRED 19 Aug 2026 — unsupported.** Meta's own messaging-limits
   documentation (updated 8 May 2026) does not gate scaling on business
   verification at all: new business portfolios start at 250, rise to 2,000 by
   completing a scaling path, and increase automatically thereafter on message
   quality plus having used at least half the current limit in the last 7 days.
   Verification appears only as *one option* inside a denial alert —
   `INCREASED_CAPABILITIES_ELIGIBILITY_NEED_MORE_INFO` offers **either** verifying
   identity **or** sending 2,000 delivered messages to unique users over a 30-day
   moving period with high-quality templates. Vonage states it plainly: **there is
   no time limit to the unverified stage.** The "30 days" traces to BSP help
   centres (Brevo), with no Meta citation behind it.

   *Probable origin of the garbled claim:* WABAs **can** be restricted immediately
   after creation for Meta policy or integrity reasons, and WhatsApp Manager's
   remediation prompt reads *"Business Verification Needed"* **even for businesses
   already verified**. A restriction with a misleading remedy label, not a
   verification clock.

**What is actually true of unverified accounts:** 250 unique customers per
rolling 24 hours, at most **2 registered phone numbers**, no Official Business
Account status, and display-name review triggering only once the messaging limit
reaches 2,000 — regardless of verification status.

So the conclusion stands on **point 1 alone**: the display name is invisible
until verification, so her customers see a phone number instead of her business.
That is enough. And rung A2 has since been **retired outright** by
**[ADR 0018](0018-retire-waba-catalogue-capture.md)** for unrelated, more
decisive reasons.

Integrate as specified was a product for registered businesses in both halves.
That is the actual defect, and it is architectural rather than commercial.

The regulatory picture is also narrower than assumed. **CBN requires a virtual
account to be linked to a BVN or NIN — individual identifiers, not CAC.** The
CAC requirement is a *provider onboarding tier* policy, not the underlying rule,
and providers differ: Flutterwave explicitly supports unregistered / sole-
proprietor merchant accounts on BVN + NIN of the proprietor.

## Decision

**Integrate is redefined as two independent ladders — order capture and payment
verification — each of which has a rung that requires nothing but a phone
number and a bank account.** A merchant's tier is whatever they qualify for; no
tier is a prerequisite for the ledger, the documents, or the reconciliation
engine, which are identical for everyone.

### Ladder A — order capture

| Rung | Mechanism | Requires | Who |
|---|---|---|---|
| **A0 — Order forwarding** | Merchant keeps the free WhatsApp Business App catalogue. When a customer sends a cart/order, the merchant **forwards that message to Rekoda**. WhatsApp order messages are structured and parseable → `OrderPlaced`. | Nothing | **Everyone** |
| **A1 — Rekoda storefront** | Rekoda hosts the merchant's catalogue at `rekoda.app/s/<handle>`. The merchant shares that link in WhatsApp, bio or status. Orders land in Rekoda directly, fully structured, with customer details. | Nothing | **Everyone** |
| ~~**A2 — Native WABA**~~ | ~~Per-merchant WABA via Embedded Signup; catalogue order webhooks.~~ **RETIRED — [ADR 0018](0018-retire-waba-catalogue-capture.md).** Coexistence does not deliver catalog/order events to the Cloud API app, and Nigeria may be ineligible for Coexistence entirely. | — | — |

A0 is one extra gesture — and it is a gesture merchants already make. A1 is
strictly better *for Rekoda* than A2, because Rekoda owns the schema instead of
parsing Meta's: no verification queue, no display-name review, no external
approval gate, and it works on day one. **A1 is the default Integrate
experience; A2 is an upgrade for merchants who want orders to originate inside
WhatsApp's own catalogue UI.**

### Ladder B — payment verification

| Rung | Mechanism | Requires | Who |
|---|---|---|---|
| **B0 — Open banking account link** | Merchant links the bank account they **already use** (personal or business) via Mono, with consent. Rekoda reads *incoming credits* and matches them to expected payments. | BVN + consent | **Everyone** |
| **B1 — Virtual accounts, unregistered tier** | Flutterwave/Monnify virtual accounts issued under the sole-proprietor tier (CBN's actual requirement: BVN/NIN of the proprietor). | BVN + NIN | Unregistered merchants |
| **B2 — Paystack DVA / checkout** | Per-customer NUBANs; the account identifies the payer (ADR 0009's mechanism, unchanged). | CAC + KYC | Registered |

**B0 is the primary V1 target**, not B2. It is the only rung that requires no
change in the merchant's or their customers' behaviour: money keeps arriving at
the account they already give out, and Rekoda simply gains the ability to *see*
it. Mono fires `account-updated` webhooks and supports real-time refresh on a
5-minute rate limit, so verification latency is **minutes** — slower than a
payment webhook, far faster than never, and invisible in a bookkeeping workflow.

## Consequences

**The moat gets bigger, not smaller.** ADR 0009's honest framing — "reconciliation
for registered merchants" — is replaced by: *every* Rekoda merchant can reach
`VERIFIED`, because B0 asks only for a bank account and consent. The tier ladder
becomes an upgrade path rather than a gate.

**Integrate stops being blocked on external approval queues.** A1 + B0 removes
all four of the approval gates that forced Integrate into a concierge alpha
(MASTER-PLAN §5.6). A2/B2 keep their gates, but they are no longer on the
critical path — which materially de-risks M5.

**New obligations, none optional:**

* **Consent scope is the hard part.** Linking a bank account — especially a
  *personal* one — exposes the merchant's own spending, not just business
  inflows. Under NDPA: consent is explicit, specific, revocable, and unlinking
  must be one tap. **Rekoda ingests credit transactions only**, above a
  configurable threshold, for reconciliation only. Debits are never stored.
  Statement data never enters the AI zone; it is Zone 1 vault data.
* **Provider concentration.** Mono was acquired by Flutterwave in January 2026.
  Ladder B therefore leans on one corporate group at two rungs. The
  `BusinessConnection` abstraction already makes a provider a channel adapter,
  so keep at least one alternative (Okra-class aggregator, or direct
  Monnify/Squad virtual accounts) behind the same interface, and do not let
  provider-specific shapes leak into the reconciliation engine.
* **Verify before committing.** Confirm with Mono that reading a merchant's own
  account for reconciliation is a supported use case under their CBN Open
  Banking participation, and confirm the unregistered-merchant onboarding tier
  with Flutterwave/Monnify. These are the M5 equivalents of ADR 0009's
  Paystack check — same discipline, applied earlier.
* **A0's parser needs real specimens.** WhatsApp forwarded-order message shapes
  must be collected from live vendors before the parser is written; do not
  build against a guessed format.

## Sources

* Meta verification documents for Nigeria — https://www.memorly.ai/blog/our-blog-1/documents-required-for-whatsapp-business-api-approval-60
* Meta: WhatsApp does not support payment reconciliation; the business must reconcile with its PSP — https://developers.facebook.com/documentation/business-messaging/whatsapp/payments/payments-br/overview/
* CBN BVN/NIN linkage for virtual accounts — https://support.monnify.com/topics/other-monnify-services-259/compliance-guide-linking-bvn-and-nin-to-virtual-accounts-612
* Flutterwave unregistered-business onboarding — https://flutterwave.com/us/support/onboarding/onboarding-requirements-for-using-flutterwave-in-nigeria
* Mono Connect webhooks and real-time data — https://docs.mono.co/docs/financial-data/webhook-introduction · https://docs.mono.co/docs/financial-data/realtime-data
