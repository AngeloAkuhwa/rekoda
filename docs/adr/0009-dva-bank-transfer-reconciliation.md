# 0009 — Dedicated Virtual Accounts turn bank transfers into verified payments

**Status:** Proposed — blocked on eligibility verification (see Consequences)
**Date:** 2026-08-19
**Extends:** [0003](0003-paystack-merchant-owned-account.md)

## Context

The reconciliation moat (MASTER-PLAN §1.3) closes only when a *provider*
confirms money moved. Until now that meant Paystack **checkout** — a card or
transfer through a Paystack payment page. But the dominant way a Nigerian small
business is actually paid is a **direct bank transfer** to their account, which
produces no webhook. Every such payment was destined to sit permanently at
`RECORDED` and never reach `VERIFIED`, leaving the moat serving only the subset
of merchants who push customers through checkout links.

Paystack **Dedicated Virtual Accounts** (DVA, "Paystack-Titan") close this.
A DVA is a real NUBAN account at Wema or Titan Trust. Any customer transferring
from any Nigerian bank over NIP lands a `charge.success` webhook with
`channel: "dedicated_nuban"` — the same verified payment event as a checkout.

## Decision

**Adopt DVAs as a first-class Integrate capability in M5**, not a later idea.

The design turns on one fact that is easy to get wrong: **a DVA is assigned to
a customer, not to the business.** Each of the merchant's customers gets their
own unique NUBAN. That is precisely what makes attribution automatic — *the
account the money arrived into is the identity of who paid*, before any
matching heuristic runs. `findUniqueAmountMatch()`'s refusal to guess between
two debtors owing the same amount stops being the common path and becomes the
exception, because amount-matching is no longer the primary signal.

Consequences of per-customer assignment, all of which are design constraints:

* **A `Customer` record must exist before a DVA can be issued.** DVA
  provisioning is a step in the customer lifecycle, not in business onboarding.
* **~1,000 DVAs per business.** Issue lazily — on a customer's first order or
  first invoice, never in bulk — and build a reclamation policy for dormant
  customers before a merchant approaches the ceiling.
* **The DVA lives under the merchant's own Paystack account** (ADR 0003), so
  money still never touches Rekoda and the settlement-liability position is
  unchanged.
* **The customer-to-NUBAN map is Zone 1 identity data.** It is a direct
  identifier of a merchant's customer; it lives in the vault and is rehydrated
  only in the authorised output layer, never sent to the AI zone.

**Never rely on webhooks alone.** A pg-boss cron reconciles against Paystack's
transaction API on a schedule to catch webhooks that were missed, dropped, or
retried into a gap. This is Paystack's own guidance and it is cheap.

## Consequences

**Eligibility is the risk, and it is material.** DVAs require a **CAC-registered
business** (BN or RC/LTD) on a Paystack account that is *not* a Starter or
Individual account, with **full KYC approved** — certificate of registration,
director ID, proof of address. This is a CBN-driven regulatory condition, not a
Paystack policy that support can waive.

That excludes a large share of the stated target market. Market vendors and
Instagram sellers trading unregistered **cannot** get DVAs. So the honest
framing is not "bank transfers become verifiable for nearly everyone" — it is:

> DVAs extend the reconciliation moat to **CAC-registered merchants**. For
> unregistered merchants, bank transfers and cash remain `RECORDED`, and that
> remains a normal, non-alarming state (MASTER-PLAN §5.6).

This aligns naturally with sequencing: Integrate already requires CAC name
alignment for Meta business verification, so the merchants reaching M5 are
largely the merchants eligible for DVAs. It also sharpens the Complete tier's
value story without promising Chat merchants something they cannot have.

**Before this ADR moves to Accepted**, confirm with Paystack directly that DVA
provisioning is currently open for a typical registered Nigerian small business.
There is a documented class of "dedicated account not assigned" failures, and
provisioning has been subject to CBN-driven changes at the Wema/Titan layer
before. Do not let the roadmap lean on this until that confirmation exists.

## Sources

* https://paystack.com/docs/payments/dedicated-virtual-accounts/
* https://paystack.com/docs/api/dedicated-virtual-account/
* https://support.paystack.com/en/articles/2124866 — fees (1%, capped ₦300), 1,000-account limit, registered-business-only
* https://paystack.com/blog/product/paystack-titan
