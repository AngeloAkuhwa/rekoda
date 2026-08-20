# 0019 — The Paystack model: merchant-owned accounts, Rekoda stays out of the money

**Status:** Accepted
**Date:** 2026-08-19
**Supersedes the positioning in:** [0013](0013-rekoda-as-the-single-integration.md) ·
**restores and sharpens:** [0003](0003-paystack-merchant-owned-account.md)

## Context — and an honest note about churn

This decision has moved twice, and the reader deserves to know why rather than
finding three contradictory recommendations in the repo:

1. **First:** platform-managed flow (Rekoda's Paystack, merchants as subaccounts),
   because it made onboarding _"give us your account number."_
2. **Then:** standard flow first, on the reasoning that it carries no transaction
   liability while the product is unproven.
3. **Then back to platform-managed**, once the **₦2M lifetime cap** on Starter
   Businesses looked like it would strand successful merchants.

Three facts have landed since, and together they settle it in the other
direction:

- **The friction gap is much smaller than assumed.** Platform-managed still
  requires Rekoda to collect **BVN/NIN + a Resolve Account name match** for every
  sub-merchant (ADR 0013's own controls). A Starter Business requires **ID + BVN
  - a bank account**. **Both ask the merchant for the same things.** The
    difference is _who_ collects them and _who_ carries the consequences — not how
    much the merchant is asked to do.
- **The ₦2M cap is a graduation gate, not a wall.** It is a _lifetime_ cap on
  **Starter** accounts only. A merchant who reaches it is turning over real money
  and has an obvious next step — CAC registration, which Paystack itself sells as
  a service. Hitting the cap is a **success signal**, and the moment to help
  rather than the moment to lose them.
- **Aggregation itself — not just custody — is what PSSP licenses.** The PSSP
  scope is "payment processing gateway and portals, solution/application
  development, **merchant service aggregation and collections**." The plan has
  been careful about _custody_ (safety-review R1/R2) while treating aggregation
  as free. It is not obviously free. Paystack Connect existing as a product
  strongly implies Paystack has structured it so platforms may use it — but
  **that is an inference, and it is exactly what counsel has not yet confirmed.**

## Decision

**Default: the merchant owns their Paystack account. Rekoda never enters the
money flow.**

```
Merchant's own Paystack account (Starter — ID + BVN + bank, no CAC)
        │  secret key vaulted by Rekoda, AES-256-GCM (ADR 0003)
        ▼
Rekoda creates the charge  →  Pay with Transfer, temporary account per invoice
        ▼
Customer transfers  →  settles to THE MERCHANT'S OWN Paystack balance
        ▼
charge.success → Rekoda's webhook → reconcile → receipt → ledger
```

**Rekoda is software.** It never collects on behalf of a third party, never
aggregates sub-merchants, never holds or routes funds. There is **no custody
question and no aggregation question**, so there is nothing to license and
nothing to ask counsel before starting.

What this buys, beyond compliance:

- **Chargebacks, fraud and AML stay with Paystack and the merchant** — Paystack
  does the KYC, as its standard flow documents.
- **No concentration risk.** One bad merchant cannot take down every other
  merchant, which was ADR 0013's single largest exposure.
- **The merchant sees their own Paystack dashboard** — their money, their
  records, verifiable independently of Rekoda. For a product whose entire pitch
  is _"know what actually happened"_, that transparency is on-message.
- **Low lock-in, honestly.** They can leave and keep their payment relationship.
  Charging ₦19,900 for books, not for holding their money hostage, is the
  stronger position.

**Splits are not needed in this model at all** — money is already the merchant's
when it lands. The `split_code` capability confirmed for PwT matters only if
Phase 2 is ever taken.

### The graduation path — design it as a feature, not an edge case

| Stage            | Merchant state           | Rekoda's move                                                                              |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| Start            | Starter account, no CAC  | Onboard, collect nothing but their key                                                     |
| ~₦1.5M collected | Approaching the cap      | **Proactive nudge**: "you've collected ₦1.5M — time to register, here's how, we'll help"   |
| Cap reached      | Collections disabled     | Registration support; Paystack sells this. **A retention moment, possibly a revenue line** |
| Registered       | Uncapped, DVAs available | Full capability                                                                            |

**Instrument this from day one.** Collected-to-date per merchant is a
first-class telemetry field, and crossing ₦1.5M fires an alert in admin. A
merchant who discovers the cap by having collections stop mid-sale is a merchant
Rekoda failed.

### Phase 2 — platform-managed, deliberately deferred

Platform-managed (Rekoda's account, merchants as subaccounts, PwT with
`split_code`) remains fully designed and **not discarded**. It is the right answer
for merchants who genuinely will not open any account of their own. It ships when
**all three** hold:

1. **Counsel confirms** that split-settled sub-merchant aggregation, without
   custody, sits outside licensable activity — including in light of Paystack's
   **January 2026 acquisition of Ladder Microfinance Bank**, now Paystack
   Microfinance Bank, which changes what Paystack itself may hold.
2. The **empirical split check** passes: a live PwT charge with `split_code`
   returns a **populated `split` object**, asserted on a field _inside_ it —
   never on truthiness, per the `plan: {}` trap.
3. The **ADR 0013 controls exist and have been exercised**: sub-merchant KYC,
   velocity limits, anomaly alerts, settlement-change re-verification, kill
   switch — remembering that **withholding settlement is not available** (R28).

## Consequences

**Nothing blocks building.** This is the only model that needs no legal opinion,
no aggregation permission and no new risk appetite to start. Every open question
moves off the critical path.

**The one real cost is the ₦2M ceiling on unregistered merchants**, and it is
bounded, visible and turned into a product moment rather than a failure.

**A structural benefit worth naming:** the merchant-owned model makes Rekoda's
value proposition _purely_ the books, the reconciliation and the fake-alert
defence. It cannot be mistaken for a payment company, does not compete with
Paystack, and is the easiest possible story to tell a regulator, a partner or a
merchant.

## What this does not change

- **Catalogue management is Rekoda's storefront** ([ADR 0018](0018-retire-waba-catalogue-capture.md)) — nothing to do with Paystack.
- **Pay with Transfer is the collection method** ([ADR 0016](0016-per-transaction-accounts-not-per-customer.md)) — per-transaction accounts, **no customer KYC**, at **1.5% + ₦100 capped ₦2,000**, borne by the merchant and stated on `/pricing`.
- **No customer is ever KYC'd** (R25) and **no BVN is ever stored** (R26).
- **The fake-alert defence is unaffected** — verification still arrives in seconds from `charge.success`.

## One setup detail to solve properly

Under this model each merchant's Paystack account must point its **webhook URL**
at Rekoda. Confirm whether that can be set via API with the merchant's key or
must be done by hand in their dashboard — if manual, it is a step in the
concierge script and a likely drop-off point. **Regardless: never rely on
webhooks alone.** A pg-boss cron reconciling against the Transactions API is
Paystack's own guidance, and here it doubles as the safety net for a merchant who
mis-configures the URL.
