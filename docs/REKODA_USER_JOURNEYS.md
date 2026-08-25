# Rekoda User Journey Reference

| Field | Value |
|---|---|
| Status | **CANONICAL — aligned to spec v1.6.4** |
| Version | 1.0 |
| Effective date | 25 August 2026 |
| Governed by | `docs/REKODA_CANONICAL_SPEC.md` v1.6.4 |
| Supersedes | Chat & Integrate Canonical User Journey Specification v1.0; `docs/rekoda-chat-v1.md` and `docs/integrate-explained.md` where they conflict |
| Audience | Engineering, design, QA, product, support, and future sessions |

> **This document does not decide anything.** Every invariant here is owned by the canonical specification. Where this document and the spec disagree, **the spec wins** and the disagreement is a defect in this file.

## How to read a journey

Each journey states twelve things, in this order:

```
ACTOR              who is doing it
TRIGGER            what starts it
ENTITLEMENT        which product must be held (spec §4)
STEPS              what the person sees and does
COMMAND            the application command (spec §25) — never a controller
STATE              what changes in the data
ACCOUNTING         what posts, or explicitly nothing
PAYMENT            evidence, verification, allocation
CONFIRMATION       risk tier and what is required (spec Appendix D)
FAILURES           what can go wrong and what the person is told
AUDIT              what is recorded and who is named
OUTCOME            the final UI state
```

A journey with **ACCOUNTING: nothing posts** is stating a rule, not an omission.

---

# Part 1 — Rekoda Chat

> **Chat is the merchant talking to Rekoda.** Sell anywhere; tell Rekoda what happened. Chat **never** delivers into a customer's thread on the merchant's WABA (spec §3.1).

## C1 · Onboarding

```
ACTOR         merchant
TRIGGER       first message to Rekoda, or the web signup
ENTITLEMENT   none required to start. A trial plan is granted.
STEPS         identify the business → name it → confirm the owner
COMMAND       CreateBusiness (identity path, outside the financial commands)
STATE         businesses row · membership · trial plan with its allowances
ACCOUNTING    nothing posts. A business with no events has no books yet.
PAYMENT       none
CONFIRMATION  STANDARD
FAILURES      an unknown sender gets the stranger reply exactly once,
              recorded by MATCH_KEY hash and never by phone number
AUDIT         business creation, actor = the signing-up user
OUTCOME       the merchant can record their first sale
```

## C2 · Text action

```
ACTOR         merchant
TRIGGER       a typed message: "sold 3 bags of rice to Ada for 45k"
ENTITLEMENT   REKODA_CHAT
STEPS         message → Rekoda replies with a PREVIEW naming amounts,
              customer and what will be recorded → merchant answers
COMMAND       interpretation produces a command_draft; the "yes" claims it
              and dispatches RecordSale
STATE         command_draft pending → confirmed (the single conditional
              UPDATE that makes one "yes" win)
ACCOUNTING    on confirmation only. Nothing posts from the preview.
PAYMENT       if money was received, see C5/C6
CONFIRMATION  STANDARD — preview then confirm
FAILURES      ambiguity asks rather than guesses; an unresolvable customer
              name is asked about, never invented
AUDIT         the draft survives with state = confirmed. It is the proof
              of attestation the whole provenance model rests on (spec §7.2)
OUTCOME       invoice or receipt issued, figures read back from the WRITE
```

## C3 · Voice action

As C2, with one addition before interpretation.

```
ENTITLEMENT   REKODA_CHAT + VOICE_MINUTES allowance
ORDERING      entitlement → allowance → THEN transcription (spec §4.3)
              A refused request never reaches the STT provider.
PRIVACY       audio to an approved processor; the transcript walks the PII
              gateway before any reasoning model sees it (spec App. C)
FAILURES      unintelligible audio is reported as unintelligible.
              Rekoda never guesses at a number it could not hear.
```

## C4 · Document action

```
ENTITLEMENT   REKODA_CHAT + DOCUMENTS_UNDERSTOOD allowance
ORDERING      entitlement → allowance → THEN OCR spend
PRIVACY       the raw image goes ONLY to an approved specialist processor,
              for transcription only, under terms excluding training
              (spec App. C.2). The transcript is then tokenised.
ACCOUNTING    nothing posts from a document. It produces a draft.
```

## C5 · Cash sale

```
COMMAND       RecordSale, paidK > 0, method = CASH
ACCOUNTING    sale, payment and fulfilment post together (spec §12.4e)
                DR Cash / CR Sales Revenue · DR COGS / CR Inventory
PAYMENT       initialConfirmationSource = MERCHANT_ATTESTED
              paymentMethod = CASH
              one PaymentVerification, MERCHANT_ATTESTED, actor = merchant
CONFIRMATION  STANDARD
OUTCOME       receipt issued. Badge reads MERCHANT CONFIRMED, never "verified"
```

## C6 · Credit sale

```
COMMAND       RecordSale, paidK = 0, IssueInvoice
ACCOUNTING    per ReceivableRecognitionPolicy (spec §12.3)
                ON_ISSUE_UNCONDITIONAL  DR AR / CR Contract Liability
                ON_FULFILMENT           nothing posts at issue
              Revenue is NEVER recognised merely because an invoice exists.
STATE         InvoiceLifecycle = ISSUED
              InvoicePaymentStatus = UNPAID     (derived)
              InvoiceCollectionStatus = CURRENT (derived)
OUTCOME       invoice PDF, and the customer owes it
```

## C7 · Payment request

```
COMMAND       CreatePaymentIntent
ENTITLEMENT   REKODA_CHAT. Chat may CREATE payment details.
BOUNDARY      Chat returns the details TO THE MERCHANT.
              Delivering them into the customer's WABA thread requires
              REKODA_INTEGRATE, therefore Complete (spec §3.1). See X1.
PAYMENT       an intent on the MERCHANT's own connection, never Rekoda's
FAILURES      no email on file is the merchant's own record to fix and is
              said so; a provider rejection after minting is not blamed on them
```

## C8 · Payment evidence — the screenshot

> **The single most important rule in the product.**

```
ACTOR         customer, relayed by the merchant, or the merchant directly
TRIGGER       an image of a bank transfer arrives
COMMAND       RecordPaymentEvidence
STATE         payment_evidence row, resolutionState = UNRESOLVED,
              resolutionDeadline set from business configuration
ACCOUNTING    NOTHING POSTS.
PAYMENT       NO Payment row. NO receipt. NO allocation.
OUTCOME       the UI says PAYMENT REPORTED. It does not say PAID.
RETENTION     unresolved evidence EXPIRES on its deadline and its raw media
              is purged; the claim and its outcome survive (spec §23)
```

```
Screenshot → PaymentEvidence          ✓
Screenshot → Payment → Receipt        ✗ never
```

## C9 · Merchant payment confirmation

```
TRIGGER       the merchant says the money arrived
COMMAND       ConfirmPayment
PAYMENT       initialConfirmationSource = MERCHANT_ATTESTED
              paymentMethod = CASH | BANK_TRANSFER | POS | …
              The INSTRUMENT NEVER CHANGES THE SOURCE (spec §6.2).
              PaymentVerification + PaymentVerificationClaim, one transaction
ACCOUNTING    DR Cash or Bank / CR Accounts Receivable
CONFIRMATION  STANDARD, and the confirmation event is the attestation
OUTCOME       receipt issued, badge MERCHANT CONFIRMED
LATER         if the bank feed later finds the transaction, a SECOND
              verification is appended. The Monday attestation stands.
              Trust rises to EXTERNALLY_VERIFIED. Nothing is overwritten.
```

## C10 · Partial payment

```
COMMAND       ConfirmPayment + AllocatePayment
STATE         InvoicePaymentStatus = PARTIALLY_PAID (derived, never stored)
              collection status is INDEPENDENT: an invoice is routinely
              PARTIALLY_PAID and OVERDUE at once (spec App. E.3)
ACCOUNTING    only the allocated portion posts against the receivable
FAILURES      the balance moving between preview and write refuses the
              write and reports the real balance, rather than overposting
```

## C11 · Overpayment → customer credit

```
COMMAND       AllocatePayment, remainder → CustomerCredit
ACCOUNTING    DR Bank / CR Accounts Receivable (to the invoice balance)
                          CR Customer Credit   (the excess)
RULE          an unapplied credit reduces NO invoice until it is explicitly
              applied (spec §14.1)
OUTCOME       the customer's statement shows credit available
```

## C12 · Expense · C13 · Purchase · C14 · Supplier bill

```
COMMAND       RecordExpense · RecordPurchase
ACCOUNTING    expense    DR Operating Expenses / CR Cash or Bank
              purchase   DR Inventory / CR Cash, Bank or Accounts Payable
                         stock arrives; weighted average recomputed at receipt
              bill       DR Inventory or Expense / CR Accounts Payable
ENTITLEMENT   REKODA_CHAT
CONFIRMATION  STANDARD
```

## C15 · Inventory

```
COMMAND       AdjustInventory
ACCOUNTING    a count difference posts; it is never silent
COSTING       WEIGHTED_AVERAGE (spec App. B). Receipts move the average,
              issues do not, and a customer return moves it again because
              quantity × average must equal value.
FAILURES      an issue that would take a line below zero is REFUSED
```

## C16 · Refund · C17 · Correction

```
REFUND        COMMAND RefundPayment · RISK HIGH_RISK
              money leaves the business, so the confirmation names that
              consequence in the merchant's own words, and an audit event
              records the actor and reason
CORRECTION    a REVERSING JOURNAL. Never an edit, never a delete.
              The original posting stays readable forever (spec §9.3).
RULE          CreditNote · GoodsReturn · Refund · OverpaymentRefund ·
              PaymentReversal · Chargeback are SIX DISTINCT concepts and
              are never collapsed (spec §14.3)
```

## C18 · Bank feed · C19 · Reconciliation

> **A bank credit proves account movement, not business purpose.**

```
TRIGGER       an imported statement line
COMMAND       IngestFinancialTransaction
STATE         FinancialTransaction, IMPORTED
ACCOUNTING    NOTHING POSTS AUTOMATICALLY
TIERS         exact reference · strong deterministic · suggested · manual
RULE          AI may explain and suggest. Deterministic logic or an
              authorised human DECIDES (spec §22.1).
```

**The golden case, permanent (spec §22.2):**

```
+₦5,000,000 · "DIRECT CREDIT" · no reference · no expected payment · no payer
  → FinancialTransaction created
  → NO Payment · NO journal · reconciliation UNMATCHED, queued
merchant classifies it as owner capital
  → DR Bank 5,000,000 / CR Owner Equity 5,000,000
  → Sales Revenue unchanged. No Payment row ever existed for this money.
```

## C20 · Reports · C21 · Financial Q&A

```
COMMAND       read-only queries
RISK          READ_ONLY. No confirmation.
RULE          reports read THE LEDGER. They never recompute from source
              events, because a figure that disagrees with the books is
              worse than no figure.
OUTCOME       GL · trial balance · P&L · balance sheet · cash flow ·
              AR aging · supplier balances, all tying to the ledger
```

---

# Part 2 — Rekoda Integrate

> **Integrate is the merchant's customers transacting on the merchant's own channels.** WhatsApp-native first; the storefront is an additional surface (spec §3.2).

## I1 · Merchant WABA connection

```
ACTOR         merchant
ENTITLEMENT   REKODA_INTEGRATE
STEPS         Embedded Signup → the merchant authorises their own WABA
STATE         waba_connection · channelAccountId recorded
ROUTING       phoneNumberId → BusinessId. An UNKNOWN id is REFUSED,
              never guessed (spec §24).
GATE          requires the conversation migration PR-058a-4. Before it, one
              merchant cannot hold two customer threads at all.
FAILURES      Meta Advanced Access absent → the connection cannot go to
              production; the flow still builds and tests against test numbers
```

## I2 · Customer catalogue · I3 · Native cart · I4 · Native order

```
ACTOR         the merchant's customer
ENTITLEMENT   the MERCHANT's REKODA_INTEGRATE. The customer holds nothing.
COMMAND       PlaceOrder
STATE         Conversation, conversationKind = CUSTOMER, resolved by
              businessId + channel + channelAccountId + participant hash
PRIVACY       the participant hash is keyed and SCOPED to
              (businessId, channelAccountId, version), so the same person
              messaging two merchants produces two unrelated values and the
              index cannot correlate across businesses (spec App. F.4)
ACCOUNTING    an order is a REQUEST. Nothing posts. It is not a sale and
              not a receivable until validated and accepted.
```

## I5 · Server-side validation

> **The customer's message never sets a price.**

```
COMMAND       PlaceOrder validation stage
CHECKS        every line against real catalogue state and real stock
STATE         Order: PLACED → VALIDATED
              VALIDATED is a distinct state precisely so a placed-and-refused
              order is representable (spec App. E.4)
FAILURES      out of stock, price changed, item withdrawn — each says which,
              and the customer is never quietly given a different price
```

## I6 · Charge breakdown

```
RULE          every line is a PaymentCharge record, never arithmetic in a
              controller (spec §19.1)
DISPLAY       Items · Delivery · Payment charge · VAT · Total
TAX           the taxable base is STATED, never inferred from the arithmetic
GATE          a customer surcharge is configuration a merchant switches on.
              Rekoda never adds a charge a merchant did not choose.
```

## I7 · Payment selection · I8 · Provider verification

```
COMMAND       CreatePaymentIntent → PaymentAttempt → ConfirmPayment
PAYMENT       initialConfirmationSource = PROVIDER_VERIFIED, and ONLY after
              a server-side verify. The provider's own status is recorded
              verbatim for audit and never trusted (spec §6.2)
IDEMPOTENCY   verification identity = paymentConnectionId + attempt reference.
              A retried webhook is a no-op, not a second verification.
ACCOUNTING    DR Provider Clearing / CR Accounts Receivable
              settlement is a LATER, separate event
```

## I9 · Settlement

```
TRIGGER       the provider pays out
STATE         Settlement · SettlementItem · SettlementComponent
COMPONENTS    signed DEDUCTION or ADDITION: processing fee, VAT on fee,
              withholding, levy, reserve held or released, rebate, chargeback
ACCOUNTING    DR Bank / DR fee accounts / CR Provider Clearing
RULE          ACTUAL provider data drives the books. A rate card produces
              checkout estimates and cost models, never postings (spec §20).
INVARIANT     the clearing account settles to zero or an explainable balance
```

## I10 · Receipt

```
RULE          a receipt acknowledges that a specific payment was ACCEPTED.
              It is not the authoritative allocation statement (spec §15).
SNAPSHOT      records the allocations known AT ISSUANCE, immutably
LATER         a later allocation appears in the customer statement and the
              payment allocation view. It does NOT mutate the receipt.
DELIVERY      into the customer's thread on the MERCHANT's WABA
```

## I11 · Fulfilment · I12 · Partial fulfilment

```
COMMAND       fulfilment event
ACCOUNTING    recogniseDelta = earnedToDate − revenueRecognisedToDate
              release   = min(recogniseDelta, contractLiabilityBalance)
              remaining = recogniseDelta − release
                DR Contract Liability release
                DR Accounts Receivable remaining, where a right exists
                CR Sales Revenue recogniseDelta
                DR COGS / CR Inventory
RULE          partial fulfilment recognises ONLY the fulfilled proportion
REFUSAL       earned but the right is still conditional → POST NOTHING,
              REQUIRES_REVIEW, review item with the reason. V1 does not
              model contract assets and must not call one a receivable.
```

## I13 · Refund · I14 · Cancellation

```
REFUND        RefundPayment, HIGH_RISK, distinct from credit note and return
CANCELLATION  before fulfilment: release the contract liability, restore
              stock reservation; nothing was earned so nothing is unearned
```

## I15 · Away assistant · I16 · Human takeover

```
RULE          the away assistant may answer within configured limits and may
              NEVER autonomously execute a HIGH_RISK command — including one
              the merchant has performed manually before. Past manual use is
              not standing consent for an unattended agent (spec App. D).
HANDOFF       it hands off, every time, and says it is doing so
```

## I17 · Storefront

```
SURFACE       Instagram · Facebook · TikTok · websites · QR · ads ·
              Google Business
RULE          the storefront converges on THE SAME COMMANDS and the same
              accounting truth as WhatsApp. No separate financial logic.
```

---

# Part 3 — Rekoda Complete

## X1 · "Send Chidi the payment details"

The journey that proves one economic event produces one record.

```
ACTOR         merchant, in Chat
ENTITLEMENT   REKODA_CHAT + REKODA_INTEGRATE — this is a Complete journey,
              not a Chat one (spec §3.1)
STEPS         merchant asks → Rekoda mints the details → resolves Chidi's
              customer thread → delivers through the merchant's WABA
COMMAND       CreatePaymentIntent (Chat side)
              delivery through the Integrate channel (Integrate side)
STATE         ONE PaymentIntent. One conversation thread for Chidi.
PAYMENT       when Chidi pays: ONE Payment, ONE allocation, ONE receipt
ACCOUNTING    one journal. Not two, because the request came from one
              product and the money from another.
PROOF         the mechanism is spec §25: every ingress converges on the same
              command, so there is no second implementation to disagree with.
CHAT-ONLY     without REKODA_INTEGRATE the merchant gets the details in
              their own hands and shares them however they like
```

## X2 · One customer, both products

```
Chat records a walk-in sale to Ada.
Integrate takes Ada's WhatsApp order the next week.
ONE customer record. ONE ledger. ONE statement. ONE AR balance.
Identity resolves through the privacy gateway in both directions; neither
product holds its own customer table.
```

---

# Part 4 — Journey invariants, consolidated

Every journey above obeys these. A journey that appears to need an exception has found a defect in itself.

```
 1  a screenshot creates PaymentEvidence, never a Payment
 2  a bank credit creates a FinancialTransaction, never revenue
 3  a posted journal is never modified; corrections are new postings
 4  one economic event produces one set of records, across any ingress
 5  payment provenance is appended to, never overwritten
 6  an invoice does not recognise revenue by existing
 7  entitlement is checked before any chargeable provider action
 8  the clearing account settles to zero or an explainable balance
 9  a customer's message never sets a price
10  an unknown channel identifier is refused, never guessed
11  every financial write goes through an application command
12  a HIGH_RISK command is never executed by an unattended agent
13  the UI never claims more certainty than the record supports
14  a refused request consumes nothing
```
