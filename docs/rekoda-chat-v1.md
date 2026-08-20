# Rekoda Chat V1 — sell anywhere, tell Rekoda what happened

**Recorded from the owner's directive, 19 August 2026.** This is the
authoritative product definition for Rekoda Chat and the binding correction to
every earlier description of it. Where older documents or copy conflict with
this one, this wins.

---

## 0. The correction this document exists to lock in

There are **two separate Rekoda products**:

1. **Rekoda Chat**
2. **Rekoda Integrate**

Only **Rekoda Integrate** is connected to a merchant's WhatsApp Business
commerce/catalogue infrastructure. **Rekoda Chat is NOT limited to merchants
who sell on WhatsApp.** It is a WhatsApp-native conversational business and
financial assistant for any vendor, whatever their sales channel: a physical
shop, Instagram, TikTok, Facebook, phone calls, a website, an independent
ecommerce store, marketplaces, exhibitions and events, walk-in customers,
referrals, field sales, wholesale, offline and manual sales, or anything else.

Rekoda Chat needs **no technical integration** with those channels. The
merchant reports what happened through WhatsApp; Rekoda converts it into
proper structured records.

```text
REKODA CHAT                          REKODA INTEGRATE

Merchant tells Rekoda                Connected WhatsApp Business
what happened anywhere               systems automatically tell
        ↓                            Rekoda what happened
Rekoda records it                            ↓
                                     Rekoda records it
```

Both feed the **exact same financial core**.

### The final rule (§32)

Never describe Rekoda Chat as *"accounting for WhatsApp sellers"*. Describe it
as **accounting and business operations through WhatsApp for merchants selling
anywhere**. WhatsApp is the interface. It is not the sales-channel
restriction.

### The product language (§31)

- **Rekoda Chat** — *"Sell anywhere. Tell Rekoda what happened."* /
  *"However you sell, tell Rekoda. We'll keep the records."*
  Description: Rekoda Chat is your WhatsApp-native business assistant. Send a
  message, voice note, receipt, invoice, bill, bank statement or other
  business document and tell Rekoda what you want done. Rekoda turns everyday
  business activity into organised financial records, documents, balances and
  reports.
- **Rekoda Integrate** — *"Connect your WhatsApp shop. Rekoda handles the
  money trail."*
  Description: Rekoda Integrate connects to your WhatsApp Business commerce
  flow, captures catalogue orders automatically, tracks Paystack payments,
  generates invoices and receipts, updates inventory and reconciles the
  transaction without manual re-entry.

---

## 1–3. Text and voice

Rekoda Chat behaves like a capable financial employee living inside WhatsApp.
The merchant never needs accounting terminology.

**Text (§1)**: "Sold 4 bags to Jennifer at ₦30k each. She paid ₦80k." →
customer Jennifer, 4 × ₦30,000, sale ₦120,000, paid ₦80,000, outstanding
₦40,000 → customer / sale / invoice / payment / receivable / receipt /
inventory / ledger / audit, subject to confirmation rules. "Paid Chima ₦250k
for stock. I still owe him ₦100k." → supplier purchase ₦350,000, paid
₦250,000, payable ₦100,000.

**Voice (§2)** is a first-class input:
receive audio → check length → transcribe → detect/tokenise PII → interpret →
structured command → deterministic validation → confirmation where required →
record. The maximum duration is **configuration, never hard-coded logic**
(`VOICE_NOTE_MAX_DURATION_SECONDS`), variable by plan, environment and future
pricing. An over-length note gets a natural reply ("This voice note is longer
than your current Rekoda limit. Please send it in shorter parts."), never a
silent failure.

**Multiple voice notes (§3)**: sequential notes in one active conversation
compose ("bought fifty cartons from Emeka" + "₦28,000 each" + "paid ₦1
million" → purchase ₦1,400,000, paid ₦1,000,000, payable ₦400,000), with the
interpreted transaction shown for confirmation before any material posting.

## 4–7. Documents, photos, statements

**Upload (§4)**: receipts, supplier invoices, customer invoices, bills,
proofs of payment, purchase orders, quotations, bank statements, expense
evidence, product/inventory lists, existing financial reports. No menu first:
send the document, Rekoda infers the type and asks only when unsure.

**Document + instruction (§5)** — never a bare upload→extract→store pipeline.
"Add this to today's expenses" with a fuel receipt drafts a categorised
expense. "I received this from Chima. I've paid ₦300k already" with a supplier
invoice drafts the purchase, payment and payable. "This is the payment Ada
made for yesterday's invoice" with a transfer screenshot drafts a payment
match, and **a merchant-supplied document is evidence, never provider
confirmation**: `PAYMENT_REPORTED` stays distinct from
`PAYMENT_PROVIDER_CONFIRMED` (ADR 0014 holds).

**Photos (§6)**: paper receipts, handwritten bills, POS slips, delivery notes
photographed and "Record this". **Bank statements (§7)**: PDF/CSV (Excel where
supported) parsed securely, normalised, matched against expected records
(matched / partial / unmatched / possible / needs attention), with a
conversational summary and an offer to review exceptions.

## 8–15. Actions

Invoices (§8, AI interprets, deterministic code computes totals), receipts
(§9, reported vs provider-confirmed always distinguished), **quotations
(§10)** that can become orders and invoices without re-entry, **purchase
orders (§11)** linking to supplier invoice / payment / inventory / payable,
expenses (§12, auto-categorised but editable), products and inventory (§13,
deterministic records), customer management (§14, external messages respect
consent and WhatsApp template rules), supplier management (§15).

## 16–18. Questions, reports, dashboard access

**Business questions (§16)** are a major capability, and the database is never
sent to the model: natural language → intent → structured query request →
tenant-scoped application query → deterministic results → AI formats. Reports
(§17) as PDF / Excel / CSV from chat. Dashboard access (§18) by one-time magic
link (validate → OTP if risk requires → session), never a permanent token.

## 19–23. Corrections, safety, action model

Corrections (§19) identify the referenced transaction, show current vs
proposed **with consequences** (invoice, customer balance, ledger, inventory),
confirm, and audit; history is never silently rewritten. Cancel/void/refund
(§20) are financial actions with reversal entries, never deletions. Follow-up
references (§21) may resolve conversationally, but never where ambiguity
could hit the wrong customer: ask. Risk-sensitive confirmation (§22): reads
execute, creations preview, destructive/large/high-risk actions always
confirm. Every document connects to a business purpose (§23), never a loose
file library.

## 24–26. Document security and privacy

Documents carry PII and financial detail: private object storage (the R2
abstraction, no public bucket, temporary authorised links), metadata in the
database under tenant scope (§24). **Tokenisation still applies (§25)**:
extract → detect PII → encrypted identity layer → external AI sees
`CUSTOMER_X91`; rehydrate only at authorised output. Rekoda Chat is
multimodal by design (§26): text, voice, photo, PDF, CSV/Excel all enter the
same ingress → privacy gateway → understanding → validation → confirmation →
transaction engine → reconciliation → financial truth.

## 27–29. Sale source vs captured-via

**Rekoda Chat does not care where the sale happened (§27).** The domain keeps
two separate facts:

- **`sale_source`** — where the sale actually happened: `physical_store`,
  `instagram`, `facebook`, `tiktok`, `website`, `phone`, `whatsapp_catalogue`,
  `marketplace`, `event`, `other`. Optional; never demanded per transaction,
  inferred or asked only where useful.
- **captured-via** — how the event reached Rekoda (the existing
  `source_type`): a Rekoda Chat conversation or a Rekoda Integrate webhook.
  "Captured via chat" does **not** mean "sold on WhatsApp".

One financial truth (§29): an Instagram sale told to Chat and a WhatsApp
catalogue order captured by Integrate land in the same books, and the
dashboard can total by source.

## 30. HelloBooks is a UX benchmark, not an architecture

Match its conversational convenience (send bills/receipts and draft entries,
ask the books questions, voice-driven entry, statement parsing and matching).
Do not clone its architecture or India/GST flows. Rekoda's differentiators
stay: Nigeria-first, WhatsApp-native, any-channel Chat, WhatsApp commerce
automation via Integrate, Paystack verification, allocation, reconciliation,
merchant + accountant dashboard, PII tokenisation, invoices/receipts,
supplier and customer balances, inventory, the full money trail.

---

## Appendix — reconciliation with the existing codebase (19 Aug 2026)

**Already true, no work**: text commands with deterministic money and CG1–CG5
confirmation gates; tokenise-before-model and rehydrate-at-send; RECORDED vs
VERIFIED (ADR 0014); the structured-query shape of §16 (the model never sees
the database); R2 private storage abstraction with unguessable keys; the
one-transaction engine every capture path shares.

**Corrected by this document**: all product copy that framed Rekoda Chat as
being for WhatsApp *sellers* (landing hero, metadata, FAQ, structured data).
WhatsApp is the interface; the merchant sells anywhere.

**Decided by this document, landing now**: `sale_source` as a first-class
optional domain field (core constants, migration, contract field the
interpreter may fill only when the merchant names a channel);
`VOICE_NOTE_MAX_DURATION_SECONDS` as configuration ahead of the voice slice.

**Still ahead (build order, each slice a reviewed PR)**: voice notes
(transcription pipeline + multi-note composition); document upload + photo
capture with instruction handling — **gated on pricing the new
document-understanding cost class first (plan unit + daily ceiling + usage
row; see docs/pricing-model.md "Known gap")**; quotations and purchase
orders; statement import and the matching conversation; report generation
from chat; magic-link dashboard access; correction/void/refund
conversations. Each lands on the existing ingress → gateway → understanding
→ engine spine.
