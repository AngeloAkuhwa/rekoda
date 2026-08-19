# Rekoda Payments V1 — Paystack behind a provider-neutral Payment Hub

**Recorded from the owner's directive, 19 August 2026.** This is the
authoritative payments specification. Where it conflicts with older documents,
this wins; the reconciliation appendix at the bottom names each conflict rather
than leaving it to be discovered.

The owner's companion directive on platform billing (Rekoda's own
subscriptions and add-ons as first-class financial transactions) is recorded in
§B at the end — it ships in M4 but the schema decisions here must not make it
impossible.

---

## 0. The one-sentence architecture

Paystack is not the Rekoda payment domain. It is the **first adapter** behind a
provider-neutral **Payment Hub**, and Monnify, Kuda, OPay, Squad or a direct
banking API must be addable later **without touching** Orders, Invoices,
Receipts, Ledger, Chat, Integrate or Reconciliation.

## 1. Product goal

A Nigerian merchant uses Rekoda without opening a Paystack dashboard, manually
confirming transfers, matching transfers to invoices, generating receipts, or
updating books. Rekoda: knows what is expected → offers a payment option →
receives authoritative provider confirmation → identifies business and
invoice → verifies amount and currency → records → allocates → issues the
receipt → updates the invoice → reconciles → posts the ledger → updates the
dashboard → notifies.

**Rekoda is NOT a wallet in V1.** The provider settles to the merchant's bank.

## 2. Core model

One platform relationship with Paystack. Each merchant is a **subaccount**
settling directly to their own bank. Merchants never see or need Rekoda's
secret key; all provider API calls are server-side.

```
Rekoda platform → Paystack → per-merchant subaccount → merchant's bank
```

## 3–5. Merchant payment onboarding

Collect only what is required (trading name, owner, settlement bank + account,
CAC/TIN optional unless a provider requires them — provider-specific KYC lives
in the provider adapter, never forced on the Business domain).

Creates a **PaymentConnection**: business, provider type, external
subaccount id, settlement details (encrypted/masked), status, KYC status,
capabilities. Secrets never sit in ordinary columns.

Connection states:
`not_configured · pending_details · pending_provider_creation · pending_kyc ·
pending_settlement_verification · active · suspended · failed · disconnected`

## 6–7. Provider abstraction

A provider-neutral port (create connection, create intent, verify payment,
parse webhook, refund) whose surface never leaks Paystack concepts
(`subaccount_code`, `authorization_url`, `charge.success`). Capabilities are
modelled explicitly (hosted checkout, dynamic bank transfer, DVA, subaccounts,
split settlement, refunds, verification, webhooks, settlement reporting) so
providers can differ without the transaction engine changing. Provider
resolution is centralised — no `if (provider === paystack)` scattered anywhere.

## 8–9. PaymentIntent and references

**Never send a customer to a provider without a Rekoda record first.**

`PaymentIntent`: business, customer/order/invoice, provider, connection,
**Rekoda reference**, expected amount + currency, provider reference/checkout
handle, status, expiry.

Statuses: `created · awaiting_provider · awaiting_customer · processing ·
succeeded · failed · expired · cancelled`

Rekoda mints the authoritative reference — `RKD-PAY-20260819-A83F92` —
globally unique, linked to the provider reference, invoice, order and
business. This is what makes reconciliation deterministic.

## 10–11. V1 customer experience

**Bank transfer first** (Paystack `bank_transfer` / Pay-with-Transfer):
matches Nigerian behaviour, natural on WhatsApp, strong references, no card
entry into Rekoda. Transaction-specific payment instructions, not one
permanent vendor account — three ₦50,000 transfers against three ₦50,000
invoices must never be ambiguous.

## 12–13. Customer contact and PII

`Customer.Email` stays nullable. When a provider requires a field Rekoda does
not have, the intent result says `requires_customer_information` with the
field list, and Chat asks the merchant. **Never fabricate**
`customer123@rekoda.app`-style identities.

The AI privacy rules stand. A regulated processor legitimately receiving
payment-required PII is a different processing purpose from a model: provider
requests are built **deterministically from domain records** — never via the
model, and provider secrets never reach it.

## 14–15. Fees

`PaymentFeePolicy`: `customer_bearing · merchant_bearing · platform_bearing`
(recommended default: customer-bearing where permitted). Configurable, never
hard-coded.

**Fees never distort revenue.** ₦100,000 invoice + ₦300 customer processing
charge = ₦100,300 paid, ₦100,000 Sales Revenue — with processor fee, platform
fee, settlement and customer charge recorded separately.

## 16–17. Payment record

A real `Payment` row only after authoritative confirmation: gross / invoice /
provider-fee / platform-fee / settlement amounts, currency, method, Rekoda +
provider references, **Rekoda status** (`pending · processing · confirmed ·
failed · reversed · refunded · partially_refunded`) with the provider's native
status stored separately for audit.

## 18–21. Webhook pipeline

`POST /webhooks/paystack` — public but signature-verified (Paystack signs with
the secret key, HMAC-SHA512 over the raw body, `x-paystack-signature`). Never
trust redirects, frontend callbacks, WhatsApp claims or query strings as proof
of payment.

```
capture raw → verify signature → reject invalid → fingerprint → idempotency
→ persist event → ack fast → process async → normalise → resolve intent
→ SERVER-SIDE verify (status, reference, amount, currency, business)
→ create/update Payment → reconcile
```

A retried event must never produce two payments, two receipts, two postings or
two inventory movements. Expected ₦100,000 with provider-reported ₦90,000 does
**not** mark the invoice paid.

## 22–25. Reconciliation, allocation, invoice state

Confirmation ("did the provider confirm money?") and reconciliation ("does it
satisfy the expected obligation?") are separate. Reconciliation states:
`matched · partial_match · overpaid · unmatched · amount_mismatch ·
currency_mismatch · duplicate · reversed · requires_review`.

Payments are **allocated** (already true in this codebase), never pinned to an
invoice by a single column. Invoice state is derived from financial records;
the AI can never set `status = paid`.

## 26–28. Receipts, settlement, no wallet

Provider-confirmed receipts come from `confirmed → allocation → receipt`, from
deterministic records. Merchant-reported payments stay visibly distinct
(ADR 0014's RECORDED state). Settlement status (`not_applicable · pending ·
processing · settled · failed · held`) is tracked separately from payment
status. **No Rekoda-held merchant balances in V1.**

## 29–35. Product surfaces

Chat: "Send her payment details" → intent → provider → transaction-specific
instructions; "Did Ada pay?" is answered from stored records, never invented.
Integrate: catalogue → order → invoice → intent → the **same** engine, plus
inventory (reserve on order, commit on payment, release on expiry — never
twice on a retried webhook). Dashboard "Payments" page (not "Paystack"),
masked bank accounts (`GTBank •••• 4821`), admin views for events, failed
webhooks, unmatched payments, exceptions, provider health. `ProviderCost`
rows feed the real pricing model.

## 36–37. Configuration and sandbox-first

Secrets from environment only. Build against test mode; integration tests must
cover: full payment, partial, wrong amount, failure, duplicate webhook, replay,
unknown reference, invalid signature, reversal, unmatched, expired intent,
inactive connection, wrong business mapping. **No production activation until
these pass.**

## 38–46. Provider-neutral events and deferred scope

Reconciliation consumes normalised events (`PaymentConfirmed`), never
`PaystackChargeSuccess`. Per-business provider choice comes later. **Do not
build yet:** wallets, withdrawals, smart routing, other providers, crypto,
escrow, lending, stored cards.

## 47. Pre-production dependency (RELEASE-GATING)

Before assuming informal merchants can be auto-onboarded as Paystack
subaccounts, Rekoda must obtain **explicit commercial/compliance confirmation
from Paystack** for the platform-subaccount model. Never bypass provider KYC in
code; build onboarding so provider-required KYC fields can be added dynamically.
This is the same item as MASTER-PLAN §11.1 (1a).

## 48. Definition of done

Connection created and stored safely · intent from invoice/order · customer
receives instructions · sandbox payment completes · webhook verified ·
duplicate-safe · server-side verification · amount/currency/reference checked ·
payment persisted once · allocation and partial payment work · invoice updates
· receipt exactly once · reconciliation record · ledger posted · dashboard
reflects it · Chat answers from records · Integrate uses the same engine ·
audited · provider code isolated · no secret in frontend · no AI trusted about
money movement · a Monnify adapter would touch no core aggregate.

---

## §B. Platform billing (owner directive, same date — ships M4)

Rekoda's own subscriptions and add-ons are **real financial transactions**,
held to the same discipline as merchant sales. Two logically separate ledgers:
Rekoda's platform books and each merchant's books. One confirmed billing
payment posts to both — subscription **revenue** in Rekoda's books,
subscription **expense** (with invoice + receipt attached) in the merchant's —
via an event, never by one tenant writing into the other's ledger.

Billing module: plans, subscriptions, add-ons, cycles, billing invoices
(distinct from merchant invoices), payments, receipts, **entitlements separate
from plans** (no `if (plan === complete)` scattered), usage, renewals,
discounts (recorded as discounts, never mutated prices), credits, refunds.
Subscription state machine: `trialing · active · payment_due · past_due ·
grace_period · suspended · cancelled · expired` — never a bare `isSubscribed`,
never locking a merchant out of **reading** their own records over a failed
₦9,900 renewal. Trials run on the same engine. Store service-period fields now
so deferred-revenue recognition is possible later. Processor fees on billing
follow §15. Merchants can see and query their Rekoda spend like any expense.

---

## Appendix — reconciliation with the existing codebase (19 Aug 2026)

**Already true, no work:** integer-kobo money (satisfies §43.10–12);
`payment_allocations` (§24); invoice status derived by the engine, AI cannot
set it (§25); RECORDED-vs-VERIFIED honesty (§26, ADR 0014); `external_events`
with idempotent `(provider, external_id)` ingress and sealed payloads (§19–20);
customer email exists only as a nullable encrypted facet (§12); ledger revenue
already excludes non-product amounts (§15); tenant scoping via RLS (§42.7);
`AuditEvent` (§42.13).

**Decided by this spec:**
- ADR 0003 ("merchant's own Paystack account", PROPOSED) is **superseded in
  direction**: V1 is the platform-subaccount model of ADR 0013/0019, gated by
  §47's written Paystack confirmation. The vaulted-merchant-key path remains a
  fallback if Paystack declines the platform model.
- The spec's C#-flavoured shapes (interfaces, `[Flags]` enums, `Rekoda.Billing`
  namespaces) are recorded as **concepts**; the implementation follows this
  repository's TypeScript idioms (ports as interfaces + injection tokens,
  capabilities as a readonly set, packages not namespaces).
- `PaymentConnection` is a **new table**, not a reuse of `business_connections`
  — settlement details, KYC state and capabilities are payment-specific, and
  the channel-connection table must not grow payment semantics.
- The existing `payments` table gains the gross/fee/settlement breakdown when
  the webhook-processing slice lands (it is unused surface before then).

**Build order (each slice a reviewed PR, tests first where they have teeth):**
1. ✅ **Shipped (PR #32).** Domain rules in `@rekoda/core` (references,
   verification decision, fee split, reconciliation states) +
   `payment_connections` and `payment_intents` + authenticated
   `/webhooks/paystack` ingress (signature → fingerprint → idempotency →
   sealed persist → 200).
2. ✅ **Shipped (PR #33).** The Paystack adapter behind the provider port:
   intent initialisation (transfer-first), server-side verification,
   normalised events; webhook processing job → Payment → allocation →
   receipt → ledger → reconciliation. Sandbox-fake covered §37 cases: full,
   partial, overpaid, failure, pending, duplicate webhook, replay, unknown
   reference, foreign reference, expired intent (lazy sweep), inactive
   connection, missing customer email, provider outage mid-verify.
   Deferred to slice 3: receipt PDF rendering, owner WhatsApp notification
   on confirmed payment, chat/"send payment details" wiring, settlement
   tracking from provider settlement events.
3. Connection onboarding flow + dashboard Payments/Providers pages + admin
   exception views (+ the slice-2 deferrals above).
4. (M4) `Rekoda.Billing` per §B.
