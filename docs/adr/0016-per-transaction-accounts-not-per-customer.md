# 0016 — Per-transaction transfer accounts, not per-customer DVAs

**Status:** Accepted
**Date:** 2026-08-19
**Supersedes the mechanism in:** [0009](0009-dva-bank-transfer-reconciliation.md) ·
**corrects** [0013](0013-rekoda-as-the-single-integration.md) and
[0014](0014-payment-verification-anti-fake-alert.md) · **corrects**
`integrate-explained.md`

## Context

The owner asked the question the whole design had been walking past: *if Rekoda
issues a bank account to Ada's customer Jennifer, does Rekoda now have to
inspect Jennifer — and does that bite us?*

It does. Checking Paystack's documentation settles it, and against us:

* **A Dedicated Virtual Account is tied to a customer.** You must first create a
  customer record with `email`, `first_name`, `last_name` and `phone`.
* **BVN validation is required for businesses in the Betting, Financial services
  and General services categories** before they may assign dedicated accounts.
  **Rekoda plausibly falls in one of those categories** — it is a financial
  operating platform, and we should assume the stricter rule applies until
  Paystack says otherwise.
* Where it applies, the customer's **BVN and a bank account connected to that
  BVN** must be supplied, and the validated name is then **used in naming the
  bank account number**.

Read plainly: **Jennifer would have to hand over her BVN to buy a gown.**

That is fatal three times over. It destroys conversion — no WhatsApp shopper
completes a BVN check for a ₦25,000 handbag. It drags Rekoda into **storing
BVNs**, the most sensitive identifier in the Nigerian financial system, for
people who are not even Rekoda's users. And it hands Rekoda a **KYC and
monitoring obligation over its merchants' customers**, which is a payment
institution's job, not a bookkeeping platform's.

The instinct behind the question generalises into a rule:

> **Rekoda's KYC boundary is the sub-merchant. Never the sub-merchant's
> customers.** Any design that pushes identity obligations onto end customers is
> the wrong design for a retail product — and the fact that per-customer DVAs do
> exactly that is the signal that they are the wrong instrument here.

## Decision

**Use Paystack's "Pay with Transfer" — a randomised, temporary virtual account
generated per transaction — as the default collection method. Retire
per-customer DVAs from the mainline design.**

Documented behaviour: virtual accounts generated on Paystack Checkout are
**randomised and temporary**, tied to the *current transaction*, and become
invalid once paid or once `account_expires_at` passes (default minimum 15
minutes, maximum 8 hours). It is **enabled by default for Nigerian businesses**.

This is not a compromise. On every axis that matters it is better:

| | Per-customer DVA | **Per-transaction account** |
|---|---|---|
| Customer KYC / BVN | **Required** (our category) | **None** — no account is assigned to a person |
| BVN storage risk | Rekoda holds BVNs | **Nothing to hold** |
| Attribution | By customer — **cannot separate two orders from the same customer** | **By transaction — exact, always** |
| 1,000-account ceiling | **Confirmed per *platform*** — 1,000 total across every merchant's customers, raisable only by emailing Paystack support for review | **Does not apply** — accounts are transient, not assigned |
| Verification latency | Seconds | **Seconds** (unchanged) |
| Fake-alert defence (ADR 0014) | Works | **Works** |

**The ceiling question is settled, and it settles against DVAs.** The limit is
**per platform** — *"All businesses have a limit of 1,000 virtual accounts to be
assigned to customers"*, raisable only on review by emailing support. Note the
noun: accounts are assigned to **customers**, not subaccounts. **Subaccounts are
settlement destinations and do not each carry their own pool**, so a
"DVA per vendor" design does not escape it either — and it would put the account
under Rekoda's integration, which is the custody posture we are avoiding. DVAs
are also gated to **registered businesses in Nigeria and Ghana that have
completed go-live**. Transient per-transaction accounts are not assigned, so the
ceiling does not reach them.

### What changes in the flow

Instead of *"Jennifer has an account number forever"*, it becomes:

```
Jennifer submits order  →  Rekoda creates Invoice INV-2026-000318
                        →  Rekoda requests a transfer account for THIS invoice
                        →  "Transfer ₦105,000 to Wema 7042318856
                            — expires in 2 hours"
                        →  she transfers
                        →  charge.success → matched to INV-…318 by construction
```

**Expiry is the one new piece of UX.** WhatsApp commerce is not instant — a
customer may intend to pay tomorrow. So:

* Set a generous `account_expires_at` (hours, not the 15-minute minimum).
* When it lapses without payment, the invoice stays open and Rekoda offers
  **"get a fresh account number"** — one tap for the merchant, one message to
  the customer. An expired number must never read as a cancelled order.
* Never reuse an expired number's reference for a different invoice.

### Where per-customer DVAs may still earn their place

Narrowly, and never by default: a **repeat B2B buyer** — a boutique that orders
from Ada monthly and will happily validate once for a permanent account. That is
an opt-in per-customer feature, initiated by the merchant, with the customer's
explicit consent, and it stays out of the retail path entirely.

## Consequences

Rekoda's compliance surface shrinks to where it belongs: **we KYC Ada, Paystack
KYCs the rails, and Jennifer is nobody's onboarding problem.** No BVN storage, no
customer monitoring obligation, no identity friction in the buying flow.

Attribution actually improves — a per-transaction account distinguishes two
orders from the same customer, which a per-customer account never could.

## Both open questions resolved (19 Aug 2026)

**✅ Splits work — the design holds.** Pay with Transfer is a **channel on the
standard charge, not a separate money-movement product**. It is initiated via
**Create Charge** with `email`, `amount` and a `bank_transfer` object — and on
that same endpoint `split_code`, `subaccount`, `transaction_charge` and `bearer`
are **top-level optional body parameters, siblings of `bank_transfer`**. The
checkout route behaves identically: `bank_transfer` is one value in the
`channels` array on **Initialize Transaction**, which also accepts
`subaccount`/`split_code`.

**The split engine sits above the channel.** Funds settle directly to each
subaccount's bank on the normal cycle; Rekoda never holds them. That is exactly
what the licensing position (safety-review R1) requires.

> **One empirical check before treating this as closed.** Run a live PwT
> transaction with a `split_code` and confirm the `charge.success` payload comes
> back with a **populated `split` object, not `{}`**. A parameter being accepted
> and settlement actually splitting are two different facts, and only the webhook
> proves the second. **This is the same class of bug as the `plan: {}` trap
> already in the VoiceReceipt port map** — Paystack returns empty objects that
> are truthy in JavaScript. Assert on a *field inside* `split`, never on the
> object's truthiness.

**❌ The fee is the local rate, not the DVA rate.** Paystack's pricing table
(last edited 20 May 2026) lists Nigeria at **1.5% + ₦100 for all local
channels**, capped at **₦2,000**, with the ₦100 waived under ₦2,500. The
**1% capped ₦300** sits in a *separate column headed Dedicated Virtual
Accounts*. **A PwT temporary account is not a DVA and does not get DVA pricing.**

The merchant bears this, so it must be stated accurately on `/pricing`. On a
₦105,000 order that is **₦1,675 (PwT)** against **₦300 (DVA)** — a real
difference, and it is the price of not asking her customer for a BVN. Getting
the cheaper rate means using actual DVAs, which drags back customer KYC, the
per-platform ceiling, and the registered-business gate. **The trade is worth it;
it should be made with open eyes and disclosed plainly.**

**Do not misdeclare Rekoda's business category to escape the stricter rule.**
Declare honestly and design within whatever applies — which is precisely what
this ADR does.

## Sources

* Dedicated Virtual Accounts — customer requirement and BVN validation by business category — https://paystack.com/docs/payments/dedicated-virtual-accounts/
* Validate Customer — https://paystack.com/docs/identity-verification/validate-customer/
* Pay with Transfer — randomised temporary accounts, `account_expires_at` — https://support.paystack.com/en/articles/2128642
* Payment Channels — https://paystack.com/docs/payments/payment-channels/
