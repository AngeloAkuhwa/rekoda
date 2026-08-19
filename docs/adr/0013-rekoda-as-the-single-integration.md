# 0013 — Rekoda as the single integration: platform-owned Paystack, merchant subaccounts

**Status:** Proposed — collection mechanism **corrected by
[0016](0016-per-transaction-accounts-not-per-customer.md)**: per-*transaction*
transfer accounts, not per-*customer* DVAs, because a dedicated account requires
**BVN validation of the end customer** for our business category. The platform
model (Rekoda's Paystack account, merchants as subaccounts) is unchanged; only
the instrument is. **Three of four questions answered from Paystack's own
documentation** (see §"What the documentation settles"). One blocking
unknown remains, plus counsel.
**Date:** 2026-08-19
**Extends / likely reorders:** [0012](0012-integrate-without-cac.md) ladder B

## Context

ADR 0012 removed the CAC barrier by giving merchants alternatives they onboard
to themselves: link your own bank account (B0), or get virtual accounts on an
unregistered tier (B1). Both work. Both still ask the merchant to *do something
with a financial provider*, and every such step is a place a market vendor
drops out.

The owner asked the sharper question: **can Rekoda be the only party that
integrates, and carry every merchant implicitly underneath it?**

For payments the answer is yes, and the mechanism already exists.

**Paystack subaccounts:** a sub-merchant does **not** need their own Paystack
account. The platform transacts on *its* Paystack account and splits proceeds
to the sub-merchant. Onboarding a sub-merchant requires **a bank account,
validated through Resolve Account** — no CAC, no Paystack signup, no KYC queue
the merchant has to survive.

**And decisively — Dedicated NUBANs accept a split.** `assign_dedicated_
virtual_account` takes an optional `subaccount` or `split_code`, and a split can
also be attached to an existing dedicated account. So Rekoda can issue
**per-customer NUBANs under Rekoda's own CAC**, with proceeds splitting straight
to the merchant's bank account.

That collapses the entire onboarding to: *give us your account number.*

## What the documentation settles (researched 19 Aug 2026)

The product for this already exists and is named: **Paystack Connect** — "allows
platform businesses to onboard their sub-merchants and manage flow of funds
using its APIs." Aggregation is not a grey area we have to ask permission for;
it is a supported product with two documented flows.

### ✅ Q1 — Is sub-merchant aggregation permitted? **Yes, documented.**

### ✅ Q2 — Does DVA-with-split work? **Yes, documented.**

`assign_dedicated_virtual_account` accepts an optional `subaccount` or
`split_code`, and a split can be attached to an existing dedicated account.
Multi-split has **no maximum number of subaccounts**. Fee bearer is
configurable (`bearer_type`: `account` | `all` | `subaccount`), so Paystack fees
can be borne by the sub-merchant — which is exactly what MASTER-PLAN Part 8's
"processing fees are never absorbed" requires.

### ✅ Q4 — Who bears chargebacks? **Documented, and it is a choice of flow.**

| Flow | Who onboards the merchant | Who does KYC | **Who bears transaction risk** | Merchant gets |
|---|---|---|---|---|
| **Standard** | Sub-merchant onboards directly on Paystack | **Paystack** | **Sub-merchant** | Own dashboard + API; manages own chargebacks, fraud, reconciliation |
| **Platform-managed** | Rekoda onboards them | **Rekoda** | **Rekoda** | Nothing to set up — Rekoda collects bank details only |

This is the central trade-off of the whole design, and it is ours to pick.

### ❌ Q3 — Is the ~1,000 dedicated-account ceiling per platform or per subaccount? **Not answerable from documentation.**

Support states "all businesses have a limit of 1,000 virtual accounts to be
assigned to customers" — which reads **per Paystack account**, i.e. per
*platform*. Under the platform-managed flow that is 1,000 NUBANs shared across
**every merchant's customers combined**, which would bind almost immediately.
**This single number decides whether the platform model scales.** Only Paystack
can answer it.

### The Starter Business finding — it changes the trade-off

**Unregistered individuals can already open a Paystack account.** A *Starter
Business* needs only a government ID, a BVN and a personal bank account — **no
CAC**. But it is capped at a **₦2M lifetime collections limit** (₦3M with
Truecaller phone verification), after which collections are **disabled** until
the business upgrades to Registered — and Starter accounts have **no access to
Transfers or Identity verification**, so **Dedicated Virtual Accounts are out**.

So the two flows serve genuinely different merchants:

* **Standard flow** — merchant opens their own Starter account (ID + BVN + bank
  account). They bear their own risk, Paystack does KYC, and Rekoda's exposure
  is nil. **But: ₦2M lifetime cap, and no DVAs — so no bank-transfer
  reconciliation.** An active fashion vendor can exhaust ₦2M in months.
* **Platform-managed flow** — merchant gives a bank account and nothing else.
  No cap of their own (the ceiling is Rekoda's, and Rekoda is Registered), and
  **DVAs work, because they are issued under Rekoda's registration**. Rekoda
  bears the risk.

## Decision

**Adopt Paystack Connect, and offer both flows — standard first, platform-managed
as the upgrade** — subject to the confirmations below.

Revised from this ADR's first draft, which assumed platform-managed throughout.
Now that the flows and their liability are documented, the safer sequence is:

1. **Launch on the standard flow.** The merchant opens a Paystack Starter
   Business themselves — ID + BVN + bank account, **no CAC** — and Rekoda
   reconciles their checkout payments. Risk and KYC stay with Paystack and the
   merchant. Rekoda proves the product carrying **no transaction liability at
   all**, which is the right posture for a company with no payments track record.
2. **Add the platform-managed flow once the ₦2M ceiling or DVA demand forces
   it** — and once Q3, counsel, and the risk controls below are all in place.
   That is the rung that unlocks bank-transfer reconciliation for merchants who
   will never register.

This sequencing matters: it means **nothing in M5 is blocked** on the open
question. Q3 gates the *upgrade*, not the launch.

```
Rekoda Ltd (one CAC, one Paystack account, one integration)
   └── merchant = subaccount  (bank account + BVN/NIN; no CAC, no Paystack signup)
         └── customer = Dedicated NUBAN issued under Rekoda, split → merchant
```

What this buys, and why it beats both existing rungs:

* **Zero merchant setup.** An account number is the whole onboarding. Compare
  B0 (consent to a bank-linking flow) and B1 (a provider signup with BVN + NIN).
* **Verification by construction.** Every payment — checkout *and* direct bank
  transfer to a customer's dedicated NUBAN — produces a `charge.success`
  webhook on **Rekoda's** integration. Attribution comes free: the account the
  money arrived into identifies the payer (ADR 0009's mechanism, now available
  to unregistered merchants).
* **One integration to build, operate and monitor** instead of one per merchant.
* **The merchant remains the seller.** Funds split to *their* bank account and
  never rest with Rekoda, so Rekoda's documents stay the merchant's records —
  the product promise is intact.

**ADR 0012's ladder is not deleted; it is reordered.** B0 (open banking) remains
essential and becomes the complement, not the fallback: it is the only way to
see money that arrives at an account Rekoda did not issue — a customer paying
the merchant's personal account directly, or cash deposited at a branch. The two
together are what make "every payment reaches `VERIFIED`" true rather than
aspirational.

**WhatsApp cannot be made implicit the same way, and the plan must not pretend
otherwise.** Meta is **deprecating the OBO ("on behalf of") model** in which a
tech provider owned WABAs for its clients; the surviving path is Embedded Signup
with the *client* owning the WABA and passing business verification. So Rekoda
cannot hold merchants' WhatsApp numbers on their behalf. The answer stays ADR
0012 ladder A: make a WABA **unnecessary** — the Rekoda storefront carries
orders, and the merchant keeps using the free WhatsApp Business App they already
have. Ladder A2 remains a genuine upgrade for merchants who qualify.

## Precedent — this model is well-trodden

| Who | What they prove |
|---|---|
| **Selar** (NG) | 241,000 creators, **₦9.8bn paid out in 2024**, individuals selling with no company registration and no payment-provider onboarding. The single-integration model at national scale, in this exact market. |
| **Shopify Payments · Stripe Connect · Gumroad** | The global pattern: the platform holds the processor relationship; sellers supply a bank account. |
| **Flowcart · Wapikit** (IN/BR) | WhatsApp commerce aggregators that sync catalogues and handle checkout so sellers never touch the WhatsApp API. **Borrow the onboarding model, not the product** — they are commerce and marketing tools; none of them keeps a double-entry ledger or reconciles. |

## Risks — every one of these is why this ADR is Proposed, not Accepted

1. **Concentration risk is the big one.** Every merchant now sits under one
   Paystack account. A fraudulent sub-merchant, or a compliance action against
   Rekoda, can take **all merchants down at once** — where the ADR 0003
   merchant-owned-key model failed one merchant at a time. Mitigations: real
   sub-merchant KYC before activation, per-merchant velocity limits and
   anomaly alerts, and keeping ADR 0012 B0/B1 live as an escape hatch so the
   platform rung is never the only path.
2. **Risk and liability transfer to Rekoda.** Where a sub-merchant onboards to
   Paystack directly, Paystack does KYC and the sub-merchant carries the
   transaction risk. Under the platform flow that moves to Rekoda —
   chargebacks, fraud, and AML obligations included.
3. **Licensing — do not drift into holding funds.** A **PSSP** licence
   (₦100M deposit with CBN, plus fees) covers gateways and merchant
   aggregation, and **explicitly does not permit holding customer funds** —
   only an MMO (₦2B deposit) may. The design therefore depends on funds
   splitting at Paystack and settling directly to merchant banks, never resting
   in a Rekoda balance. **Any feature that parks money — escrow, wallets,
   "hold until delivery", payout scheduling — crosses into licensed territory
   and must not be built without counsel.**
4. **The DVA ceiling may bind far sooner.** The ~1,000 dedicated-account limit
   was assumed per merchant. Under one Rekoda account it may apply across *all*
   merchants' customers, which at scale is nothing. Establish the actual limit
   and whether it is negotiable before designing issuance.
5. **Contractual permission.** Paystack's merchant agreement may restrict
   aggregating third-party sub-merchants without a specific arrangement. Ask
   plainly; do not infer permission from API capability.

## Before this becomes Accepted

* **The only blocking question left for Paystack: is the ~1,000
  dedicated-account ceiling per platform or per subaccount, and is it
  negotiable?** Aggregation (Q1), DVA-with-split (Q2) and chargeback liability
  (Q4) are all settled by the Connect documentation. Worth confirming in the
  same message: does DVA-with-split behave identically for a sub-merchant
  subaccount as for the platform's own account?
* An opinion from **Nigerian fintech counsel** that split-settled aggregation
  without fund custody sits outside licensable activity — and exactly where the
  line is.
* A decision on **sub-merchant KYC depth** Rekoda will perform (minimum:
  BVN/NIN plus Resolve Account name match against the claimed business owner).

## Sources

* Paystack split payments — https://paystack.com/docs/payments/split-payments/
* Paystack transaction splits (subaccounts, settlement) — https://support.paystack.com/en/articles/2132802
* Dedicated Virtual Account API — `subaccount` / `split_code` on assignment — https://paystack.com/docs/api/dedicated-virtual-account/
* Dedicated NUBAN — https://paystack.com/docs/payments/dedicated-virtual-accounts/
* Meta Tech Provider onboarding / OBO deprecation — https://www.infobip.com/docs/whatsapp/tech-provider-program/business-onboarding
* CBN PSSP licensing, capital, and the no-fund-custody rule — https://srjlegal.com/licencing-regime-series-payment-solution-service-provider-pssp-in-nigeria/
* Selar payouts and creator count — https://techpoint.africa/news/selar-paid-out-9-8-billion-in-2024/
