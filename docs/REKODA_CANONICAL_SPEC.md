# Rekoda Canonical Specification

## 1. Document control

| Field | Value |
|---|---|
| Status | **APPROVED — FROZEN FOR IMPLEMENTATION** |
| Canonical version | 1.6.4 |
| Effective date | 25 August 2026 |
| Supersedes | Canonical Product Architecture v2.0; Chat & Integrate Journey v1.0; corrections v1.1 through v1.6.3; ADR 0004 (chart of accounts), ADR 0014 (Recorded vs Verified) in part |
| Owners | Product and engineering, jointly. Accounting sections additionally require finance sign-off. |
| Companion | `docs/REKODA_END_TO_END_BUILD_PLAN.md` |

> **This document is the authoritative Rekoda product and architecture specification. Older plans, ADRs, comments and implementations do not override it. A conflict must be surfaced and resolved rather than silently preserved.**

### 1.1 Change policy

A section here changes only through an approved correction. When implementation discovers a genuine conflict with reality, the sequence is fixed and is not negotiable:

```
stop  →  document the evidence  →  propose a correction
      →  receive approval       →  update this document  →  continue
```

Code never becomes the source of truth by accident. A merged PR that contradicts this document is a defect in one of the two, and which one is a decision somebody makes deliberately.

### 1.2 Status vocabulary

Every architectural statement in this document carries one of these, either explicitly or by section default.

| Status | Meaning |
|---|---|
| **CORRECT** | Built, and it matches this specification. Do not rework it. |
| **DRIFTED** | Built, but it diverges from this specification. Named in the build plan with the slice that repairs it. |
| **SUPERSEDED** | An older decision that a later approved correction replaced. Kept visible so nobody re-derives it. |
| **DEPRECATED** | Still running, still relied upon, scheduled for removal after a named cutover. |
| **OPEN COMMERCIAL** | Blocked on a commercial decision or a provider agreement, not on engineering. |
| **OPEN COMPLIANCE** | Blocked on legal, tax, regulatory or provider compliance review. |

### 1.3 Technology, frozen

Rekoda is TypeScript, NestJS, Drizzle ORM, the existing PostgreSQL database, the existing Next.js frontend, the existing in-schema job queue, and the existing deployment conventions. **There is no .NET migration and there never was one.**

Earlier canonical material used .NET vocabulary. It is translated once, here, and the original wording must not survive anywhere:

| Old wording | Canonical meaning |
|---|---|
| "deterministic .NET engine" | deterministic server-side application, domain and accounting engine, implemented in the existing NestJS/TypeScript architecture |
| "EF entities" | persisted, Drizzle-backed domain and data models |
| "EF migrations" | SQL migrations under `packages/db/migrations` |

### 1.4 Canonical name to physical table mapping

The canonical vocabulary below is deliberately not identical to the physical schema. Renaming fifty-one migrations' worth of tables buys nothing and risks a great deal, so the mapping is stated once and treated as authoritative.

| Canonical name | Physical table | Note |
|---|---|---|
| `JournalEntry` | `ledger_transactions` | Same rows. Gains `postingKey`, `postingPurpose`, currency columns. |
| `JournalLine` | `ledger_entries` | Same rows. Gains `accountId`, functional/transaction currency columns. |
| `JournalDraft` / `JournalDraftLine` | new tables | Do not exist today. |
| `Account` | new table | Does not exist today. The chart of accounts is currently a TypeScript constant. |
| `FinancialTransaction` | `bank_statement_lines` | Same rows. |
| `Reconciliation` | `reconciliations` | Present, but its `MATCHED` status is an internal expectation match, not a bank match. |

---

## 2. North star

> **You run the business. Rekoda builds the records.**

A Nigerian trader already runs their business in WhatsApp. They already know what they sold and who owes them. What they do not have, and cannot produce when a bank or a buyer or the tax authority asks, is a set of records that holds up.

Rekoda is seven things fused into one product:

```
accounting-grade financial truth
+ conversational operations
+ connected commerce
+ Nigerian payment and banking infrastructure
+ reconciliation
+ inventory
+ developer APIs
```

Any one of them alone is a commodity. The combination is the moat, and the accounting is the part that makes the rest defensible: a chatbot that cannot produce a trial balance is a chatbot.

### 2.1 What Rekoda is not

| Category | What they do | What they cannot do |
|---|---|---|
| Invoice apps | Produce a PDF | No ledger, no reconciliation, no proof a payment happened |
| WhatsApp chatbots | Reply, route, collect | No financial truth; nothing survives the conversation |
| Payment-link products | Collect money | No books, no receivables, no cost of goods, no statements |
| Ordinary accounting packages | Produce statements | Demand double entry from someone who is selling from a phone |

Rekoda's specific claim is that the merchant never has to be an accountant, and the books are still real. Every design decision in this document is downstream of that claim, and the ones that look expensive are the ones that protect it.

---

## 3. The three products

Product boundaries are **exclusive**. This is enforced server-side and is not a UI convention.

### 3.1 Rekoda Chat — the merchant talks to Rekoda

Merchant-facing conversational business operations. The merchant messages Rekoda; Rekoda keeps the records.

- **MUST**: record sales, payments, expenses, purchases, stock movements and corrections from merchant messages; answer questions about the merchant's own books; issue invoices and receipts; **create** payment details for a named customer and return them to the merchant.
- **MUST NOT**: expose any customer-facing commerce surface, accept an order placed by the merchant's customer, run a catalogue for the merchant's buyers, or **deliver anything into a customer's thread on the merchant's WABA**.

The last clause is the one that is easy to get wrong, so it is drawn explicitly:

```
CHAT ONLY            "Create payment details for Chidi"
                     ✓ mint the link, account or details
                     ✓ return them to the merchant, who shares them however they like
                     ✗ message Chidi's thread on the merchant's WABA

COMPLETE             "Send payment details to Chidi"
                     ✓ mint the payment details
                     ✓ resolve Chidi's customer thread
                     ✓ deliver through the merchant's WABA
```

Delivering into a customer thread is a customer-facing act on the merchant's own channel, which is the definition of Integrate. A Chat-only business gets the details in their own hands; a Complete business gets them delivered.

### 3.2 Rekoda Integrate — the merchant's customers transact

Customer-facing, merchant-owned commerce automation. **WhatsApp-native first.** The storefront is an additional surface, not the primary one.

```
merchant WABA
  → catalogue
  → cart
  → order
  → server-side validation
  → invoice / charge breakdown
  → payment
  → verified payment
  → accounting
  → receipt, delivered in the merchant's own thread
```

- **MUST**: run on the merchant's own WABA and their own payment connection; validate every order server-side against real catalogue state and real stock; produce the same accounting a Chat sale produces.
- **MUST NOT**: let a customer's message reach the merchant-operations command set; price an order from anything the customer sent; create financial records the merchant did not authorise.

### 3.3 Rekoda Complete

`REKODA_CHAT + REKODA_INTEGRATE` over the same `BusinessId` and the same accounting truth. Not a third product with its own data: an entitlement pair.

- **MUST**: share one customer identity space, one ledger, one inventory and one set of statements.
- **MUST NOT**: produce two financial records for one economic event because it arrived through two surfaces.

---

## 4. Entitlements and usage

### 4.1 Entitlements

```
REKODA_CHAT
REKODA_INTEGRATE
REKODA_API              separate commercial entitlement, see §27
```

`Complete` is the pair, not a value. Entitlements are checked in the application command layer, never in a controller and never in the frontend. The frontend hides what the merchant cannot use; the server refuses it.

### 4.2 Metered units

The current implementation meters five units. The canonical set is:

```
VOICE_MINUTES                DOCUMENT_GENERATION           DOCUMENTS_UNDERSTOOD
AI_ACTIONS                   SERVICE_MESSAGE               UTILITY_TEMPLATE
AUTH_TEMPLATE                AUTH_INTL_TEMPLATE            MARKETING_TEMPLATE
CATALOGUE_ORDERS             PAYMENT_CONNECTIONS           FINANCIAL_ACCOUNT_CONNECTIONS
REPORT_EXPORTS               ACCOUNTANT_USERS              API_REQUEST_UNITS
API_APPLICATIONS             WEBHOOK_DELIVERIES
```

Message categories are separated because their costs differ by nearly eightfold. Metering them as one unit hides the only variable cost large enough to change plan economics.

### 4.3 The four ordering rules

These are invariants, not guidance.

1. **Entitlement before meter.** An unentitled capability is refused before any allowance is consumed.
2. **Entitlement before avoidable provider cost.** Nothing that costs money at Meta, an AI provider, an OCR provider or a payment provider is dispatched before authorisation.
3. **No paid external processing before authorisation.** Including transcription, document understanding and template sends.
4. **A refused request consumes nothing.** No allowance, no provider call, no charge. Where a unit is reserved before a failure becomes visible, it is refunded on every path that does not deliver.

### 4.4 Risk tiers

Risk tier is part of E1 and is specified in **Appendix D**. Entitlement decides whether a capability exists for this business; risk tier decides what confirmation a capability demands before it acts.

### 4.5 Downgrade and lapse

Downgrade never destroys records. Losing `REKODA_INTEGRATE` stops new customer-side commerce; existing orders remain visible, existing invoices remain collectible, existing statements remain correct and exportable. A lapsed trial is modelled as a plan whose every allowance is zero, so the gate needs no separate branch.

**Grandfathering.** Where a live customer relies on Integrate behaviour that a later plan version withdraws, their entitlement is pinned to the plan version they hold. Pricing and allowances are versioned and effective-dated precisely so this is a data decision, not a code branch (§30).

---

## 5. User journey invariants

The journey specification remains a reference document. The invariants that constrain the architecture are stated here, because a journey that contradicts this section is the journey that is wrong.

### 5.1 Chat

| Journey | Invariant |
|---|---|
| Onboarding | A business exists before any financial record does. Identity is vaulted before it is used. |
| Cash sale | Sale, payment and fulfilment may post together. One event, one journal. |
| Credit sale | Creates a receivable under the configured policy (§12). Never revenue on invoice issue unless fulfilled. |
| Partial payment | Allocates against a specific invoice. Never silently spreads across invoices. |
| Merchant-attested cash | `MERCHANT_ATTESTED` + `paymentMethod = CASH`. Requires the confirmation transition (§6.10). |
| Merchant-attested transfer or POS | `MERCHANT_ATTESTED` + `BANK_TRANSFER` or `POS`. Same requirement. The instrument never changes the source. |
| Proof-of-payment screenshot | **Creates `PaymentEvidence`, never a `Payment`.** A screenshot is never proof. |
| Invoice | A projection of order and line state, not an independently editable record. |
| Payment request | Mints an intent against the merchant's own connection. Never against Rekoda's. |
| Expense / purchase / supplier payable | Post to the same kernel as sales. No parallel bookkeeping. |
| Inventory | Movements drive valuation and COGS. Stock is never inferred from sales alone. |
| Customer / supplier balances | Derived from the subledgers, never stored as a mutable total. |
| Reconciliation | See §22. AI explains; deterministic logic or a human decides. |
| Reports / financial Q&A | Read the ledger. Never recompute from source events. |
| Correction | A reversing journal. Never an edit. |
| Refund | Distinct from credit note, return, reversal and chargeback (§14). |
| Document upload | Metered as `DOCUMENTS_UNDERSTOOD` after entitlement, before OCR spend. |
| Voice | Metered as `VOICE_MINUTES` after entitlement, before transcription spend. |

### 5.2 Integrate

| Journey | Invariant |
|---|---|
| Merchant onboarding | Embedded Signup. Rekoda is a Tech Provider; the WABA belongs to the merchant. |
| WABA connection | `phoneNumberId → BusinessId` routing is the only routing. An unknown id is never guessed at. |
| Catalogue | Server-side state. The customer's message never sets a price. |
| Cart / place order | An order is a request. It is not a sale and not a receivable until validated. |
| Order validation | Server-side, against real catalogue and real stock, before any figure is shown. |
| Charge breakdown | Every line is a record (`PaymentCharge`, §19), never arithmetic in a controller. |
| Invoice | Same projection rules as Chat. |
| Payment choice / verification | A `PROVIDER_VERIFIED` verification is written only after a server-side verify (§6.3). |
| Receipt | Acknowledges a payment (§15). Delivered in the merchant's own thread. |
| Inventory / COGS | Recognised on fulfilment, proportionally (§12). |
| Settlement / reconciliation | §20 and §22. |
| Fulfilment | Partial fulfilment recognises only the fulfilled proportion. |
| Away assistant / human handoff | The assistant never transacts on the merchant's behalf beyond configured limits. |
| Cancellation / refund | Distinct records, distinct postings. |
| Storefront / Instagram entry | Additional ingresses to the same commands. No separate financial logic. |

### 5.3 Complete

Cross-product journeys must not double-record. "Send Chidi the payment details" is a Complete journey, not a Chat one (§3.1). It originates in Chat, mints an intent on the merchant's connection, delivers into Chidi's thread through Integrate, and when Chidi pays it produces **one** payment, **one** allocation and **one** receipt. The rule that makes this hold is §25: every ingress converges on the same command.

---

## 6. Payment evidence and payment truth

### 6.1 Separate records for separate facts

```
PaymentEvidence      something somebody showed us. Proves nothing.
Payment              money the business accepts as received.
PaymentVerification  the act of establishing that, and by what means.
PaymentAllocation    which invoice it was applied to. Append-only.
PaymentIntent        an expectation of money, on a specific connection.
PaymentAttempt       one try against that intent.
Settlement           what the provider actually paid out.
Refund               money returned deliberately.
PaymentReversal      a payment undone before settlement.
Chargeback           money taken back after settlement.
```

**A screenshot never proves payment.** It is `PaymentEvidence`, and the only thing it establishes is that a customer sent an image.

### 6.2 Confirmation source and payment method

Two independent dimensions. Multiplying source enums to cover every combination of instrument and origin is how the earlier model ran out of room the moment POS appeared.

```
confirmationSource                 how the truth was established
  PROVIDER_VERIFIED                a server-side verify against the provider succeeded
  BANK_FEED_MATCH                  an imported bank line was matched to this payment
  MERCHANT_ATTESTED                the merchant confirmed it, with recorded semantics
  MANUAL_RECONCILIATION            a person linked an ACTUAL external financial
                                   transaction to this payment (see 6.9)
  LEGACY_PROVENANCE_UNKNOWN        the estate cannot establish it

paymentMethod                      what instrument the money moved on
  CASH · BANK_TRANSFER · POS · CARD · USSD · WALLET · OTHER · UNKNOWN
```

`UNKNOWN` is kept deliberately. Historical rows exist whose instrument cannot be established, and forcing them into `OTHER` would claim knowledge the estate does not have. `OTHER` means *something we can name but have not enumerated*; `UNKNOWN` means *we do not know*.

**`LEGACY_PROVENANCE_UNKNOWN` is not a verification source.** It is an initial historical state and nothing else:

```
allowed as initialConfirmationSource     all five values
allowed as PaymentVerification.source    PROVIDER_VERIFIED · BANK_FEED_MATCH
                                         MERCHANT_ATTESTED · MANUAL_RECONCILIATION
                                         ← enforced by CHECK
```

A verification event means some evidence or assertion actually occurred. An event recording that nothing is known is a contradiction in terms, and permitting it would let the remediation queue look worked when it was not.

`MERCHANT_ATTESTED + POS` is now representable, which it was not while the source enum carried the instrument. A method never implies a source and a source never implies a method.

### 6.3 Verification is append-only, and history is never overwritten

A payment's confirmation can be **strengthened later**. It is never rewritten.

```
Payment
  initialConfirmationSource     set once, at creation. Immutable.
  paymentMethod
  (no mutable "current provenance" column)

PaymentVerification             APPEND-ONLY
  id · businessId · paymentId
  source                        a confirmationSource value
  paymentEvidenceId?            the screenshot, where one exists
  financialTransactionId?       the bank line, for BANK_FEED_MATCH / MANUAL_RECONCILIATION
  paymentAttemptId?             for PROVIDER_VERIFIED
  providerReference?
  actorId?                      who, for MERCHANT_ATTESTED and MANUAL_RECONCILIATION
  verifiedAt · reason? · metadata?
  sourceMigration?              set only by a backfill, for exact rollback
```

**Set-once, enforced by the database.** `initialConfirmationSource` is immutable in fact, not by convention: a `BEFORE UPDATE` trigger permits `NULL → value` exactly once and refuses `value → different value` unconditionally. Remediation cannot reach it, a repair script cannot reach it, and a future writer nobody has thought of cannot reach it.

The case a single mutable column could not express:

```
Monday   the merchant confirms a transfer
         Payment.initialConfirmationSource = MERCHANT_ATTESTED
         PaymentVerification #1   source = MERCHANT_ATTESTED, actorId = the merchant

Tuesday  the bank feed finds the actual transaction
         PaymentVerification #2   source = BANK_FEED_MATCH
                                  financialTransactionId = the line
         no second Payment. no overwrite. Monday's attestation stands.

derived trust today          = EXTERNALLY_VERIFIED
what the merchant said Monday = still on the record, forever
```

### 6.4 Revocation: append-only needs a compensating event

Append-only without a correction mechanism is not integrity, it is a trap. A human matches bank line `TX-123` to `PAY-001`, then discovers it belonged to `PAY-002`. `UPDATE` and `DELETE` are revoked, correctly. Without a compensating event, `PAY-001` is externally verified forever on evidence that was never its own.

The ledger solved this with reversing journals. Verification solves it the same way.

```
PaymentVerificationRevocation        APPEND-ONLY
  id · businessId · verificationId
  reason                             REQUIRED
  actorId                            REQUIRED
  occurredAt

TX-123 → PAY-001    PaymentVerification #1
                    PaymentVerificationRevocation  reason = incorrect match
TX-123 → PAY-002    PaymentVerification #2

PAY-001  no active verification. history intact: somebody matched it,
         somebody unmatched it, and both are on the record.
PAY-002  externally verified.
```

**A revocation is itself immutable.** There is no revoking a revocation, because nothing in the model gives that a meaning. If the revocation was the mistake, the correction is an ordinary one: **append a fresh `PaymentVerification` against the same evidence**, carrying a reason that says so.

```
verification #1     TX-123 → PAY-001
revocation          "not this payment"                 ← wrong; PAY-001 was right
verification #2     TX-123 → PAY-001, reason = "revocation was incorrect"
```

Three events, a legible history, and no second-order mechanism to specify. The active-claim projection (§6.5) makes this work: revoking released the claim on `TX-123`, so the fresh verification can take it again.

### 6.5 Source idempotency, and the active-claim projection

Without idempotency a retried webhook verifies twice and one bank line verifies two payments. Both are silent, and both corrupt trust rather than merely duplicating a row.

> **SUPERSEDED — this was the sibling of the generated-column defect.** An earlier draft specified partial unique indexes predicated on `WHERE revoked_at IS NULL`. `PaymentVerification` has no `revoked_at`, because revocation is a separate event table, and a PostgreSQL partial-index predicate may reference only columns of the table being indexed. It cannot see another table and cannot use a subquery. The indexes could not have been created.

The events stay genuinely immutable. Uniqueness moves to a small mutable projection that exists for exactly one purpose.

```
PaymentVerificationClaim         MUTABLE. Not audit truth. Not financial truth.
  id · businessId · verificationId
  financialTransactionId?
  paymentAttemptId?
  confirmationEventId?
  CHECK: exactly one claim key is populated

  UNIQUE (businessId, financialTransactionId) WHERE financialTransactionId IS NOT NULL
  UNIQUE (businessId, paymentAttemptId)       WHERE paymentAttemptId IS NOT NULL
  UNIQUE (businessId, confirmationEventId)    WHERE confirmationEventId IS NOT NULL
```

Every predicate now reads a column of the table it indexes, which is the only thing PostgreSQL will accept.

```
verifying     append PaymentVerification
              insert the claim
              ONE transaction. The unique violation is the idempotency check.

revoking      append PaymentVerificationRevocation
              delete the claim, releasing the evidence
              ONE transaction.
```

Each source has its **own** identity. There is no single global uniqueness rule, because the four sources do not share a notion of sameness.

```
PROVIDER_VERIFIED       identity = paymentConnectionId + provider attempt or
                                   transaction reference
                        → a retried webhook is a no-op, not a second verification

BANK_FEED_MATCH         identity = financialAccountConnectionId + financialTransactionId
                        → one bank line cannot actively verify two payments,
                          unless a deliberately supported split-payment
                          relationship says otherwise

MERCHANT_ATTESTED       identity = the explicit confirmation action:
                                   the command draft for chat,
                                   the audit event for a dashboard action
                        → a retried job cannot attest twice for one confirmation

MANUAL_RECONCILIATION   identity = financialTransactionId
                        REQUIRES an actual external FinancialTransaction,
                                 an authorised actor, and a reason

LEGACY_PROVENANCE_UNKNOWN
                        historical provenance metadata ONLY.
                        Never an active verification source. CHECK-enforced.
```

> **The claim table is a concurrency projection and nothing else.** It says which evidence is currently spoken for. **Derived trust is computed from the immutable events and revocations, never from the claims**, so a projection that was rebuilt, corrupted or dropped could be reconstructed from the events without any loss of financial truth. That directionality is what keeps the model honest: append-only remains literally true of the tables that matter.

**Atomicity is a rule, not an implementation preference.** Under normal application operation the estate must never hold a verification without its claim, or a claim without its verification. Both pairs commit together or neither does:

```
verify   INSERT PaymentVerification + INSERT PaymentVerificationClaim     one tx
revoke   INSERT PaymentVerificationRevocation + DELETE the claim          one tx
```

A partial failure that left a claim behind would silently block the correct payment from ever being verified, and nothing would report it.

### 6.6 Evidence and money are different axes

> **A revocation invalidates evidence. It does not move money.** Nothing about revoking a verification reverses a journal, withdraws a receipt or removes an allocation.

```
Verification revoked   ≠   Payment reversed   ≠   Refund   ≠   Chargeback
```

Worked through, because this is the case most likely to be got wrong under pressure:

```
PAY-001, ₦60,000
  Verification A   MERCHANT_ATTESTED
  Verification B   BANK_FEED_MATCH

B turns out to have matched the wrong bank line
  PaymentVerificationRevocation  verificationId = B, reason = INCORRECT_MATCH

Payment status        CONFIRMED, unchanged
trust                 EXTERNALLY_VERIFIED → ATTESTED
journals              untouched
receipt               untouched
allocations           untouched
```

The merchant still says they received the money. That claim never depended on the bank line.

### 6.7 `confirmationIntegrity`

When the last active verification goes, the payment must not quietly keep reading as fully trusted.

```
confirmationIntegrity            derived, never stored
  CONFIRMED       at least one active verification supports the payment
  NEEDS_REVIEW    the active verification set is EMPTY
```

`NEEDS_REVIEW` is a queue item and a question, not an accounting event. It asks a human one thing: *is this payment still valid on new evidence, or does it need reversing?*

**Resolving it has exactly two permitted outcomes, and no third:**

```
new evidence exists      → append a PaymentVerification
                           confirmationIntegrity returns to CONFIRMED
                           the books never moved

the payment was wrong    → post an explicit PaymentReversal
                           THAT is what reverses the accounting
```

There is no path where clearing the review item changes the books by itself.

> **Only `PaymentReversal`, `Refund` and `Chargeback` change the books.** Verification events change evidential confidence. Financial events change financial truth. A system that let the first do the second would be one where deleting a screenshot unposts a journal.

### 6.8 Derived trust

Trust is computed from **the full set of verification events**, never from one column.

```
EXTERNALLY_VERIFIED    an ACTIVE verification with source PROVIDER_VERIFIED,
                       BANK_FEED_MATCH or MANUAL_RECONCILIATION
ATTESTED               at least one ACTIVE MERCHANT_ATTESTED and nothing stronger
UNESTABLISHED          no active verification events
```

**Revoked verifications are ignored by the derivation and erased by nothing.** A payment can move from `EXTERNALLY_VERIFIED` back to `UNESTABLISHED` when a bad match is revoked, and the history explains exactly why.

Trust is never stored as an independent flag. Storing it would let it disagree with the events that produced it, which is the failure this whole model exists to prevent.

### 6.9 `MANUAL_RECONCILIATION` means one specific thing

> **A human linked an actual external financial transaction to a Rekoda payment or invoice.**

It does **not** mean a human looked at an old record and formed an opinion about it. That distinction is the difference between evidence and assertion, and collapsing it would let legacy remediation manufacture external verification out of nothing.

```
a real bank line exists, and a person links it     → MANUAL_RECONCILIATION
the merchant now attests they received it          → MERCHANT_ATTESTED
```

In both cases `initialConfirmationSource` remains whatever it was, including `LEGACY_PROVENANCE_UNKNOWN`. **Remediation adds evidence. It never rewrites history.**

### 6.10 Medium is never proof

> **Input medium must never be treated as proof of attestation.**

"Ada says she transferred sixty thousand" and "I checked my bank and Ada's sixty thousand is there" are both text. One is a relayed customer claim; the other is the merchant asserting a fact about their own account. Classifying on message kind reads a trust level out of a keyboard.

What does establish attestation is an explicit confirmation with recorded semantics: the merchant was shown a preview naming the amount and the invoice, and answered it, and that answer persisted. `paymentMethod` is an independent dimension (6.2). **POS is not a bank transfer merely because both are electronic.**

---

## 7. R0A-i provenance rules

### 7.1 The classification ladder

Evidence only. The legacy `payments.verified` boolean is not consulted in either direction, because it records that some code path once set it, not who claimed the money arrived.

The ladder emits a `confirmationSource` (§6.2) and never an instrument. It has never emitted `MERCHANT_ATTESTED_CASH` or `MERCHANT_ATTESTED_TRANSFER`; the instrument travels in `paymentMethod`, which is read straight from the existing `payments.method` column and normalised.

```
1  payment_intent_id IS NOT NULL AND provider_ref IS NOT NULL   → PROVIDER_VERIFIED
2  an imported bank line matched this payment's posting         → BANK_FEED_MATCH
3  source_type='chat' AND draft.state='confirmed'
     AND draft.intent IN ('RecordPayment','RecordSale')         → MERCHANT_ATTESTED
4  source_type='dashboard' AND an audit row names a user actor  → MERCHANT_ATTESTED
5  anything else                                                → LEGACY_PROVENANCE_UNKNOWN
```

### 7.2 Why rungs 3 and 4 are proofs and not guesses

Established by inspection of the repository, not assumed:

- Every merchant-recorded payment reaches its writer through `confirmPendingDraft`, whose `claimDraft` is a conditional `UPDATE command_drafts SET state='confirmed' WHERE state='pending'`. The row survives, so the proof survives.
- `issueSale` has four callers. Three hardcode `paidK: 0` (storefront, forwarded order, quote acceptance). Only the chat `RecordSale` confirmation can book money through it.
- `recordMerchantPayment` has two callers: the chat confirmation, and `recordPaymentByNumber`, the dashboard entry point, whose `sourceId` is an invoice number and joins to no draft. That path is attested by its audit row, which names the user.
- Both callers of `bookVerifiedPayment` perform a server-side verify before booking and both attach an intent and a provider reference.
- **No migration has ever written or updated a `payments` row.** The code trail is the whole trail.

### 7.3 Forbidden inferences

```
text or voice           = attested          ✗  forbidden
verified=false+transfer = attested          ✗  forbidden
verified=true           = provider verified  ✗  forbidden without the anchors
POS                     = transfer           ✗  forbidden
overwriting an earlier confirmation source   ✗  forbidden (§6.3)
```

### 7.4 Reporting dimensions

Three independent columns. Never fused.

| Column | Values |
|---|---|
| `confirmationSource` | the five values of §6.2 |
| `evidence_basis` | `TYPED` · `SPOKEN` · `SAW_AN_IMAGE` · `NOT_A_MESSAGE` · `NO_MESSAGE_ON_FILE` — context for a human, never a trust grade |
| `paymentMethod` | `CASH` · `BANK_TRANSFER` · `POS` · `CARD` · `USSD` · `WALLET` · `OTHER` |

Attestations made while looking at an image are still attestations. They are reported separately **for review, not remediation**; whether to re-check them is the merchant's decision.

### 7.5 The block

The production report must produce: provenance distribution, naira totals, the remediation queue, receipt and allocation exposure, and the unknown-provenance population.

The backfill writes `initialConfirmationSource` and, for every row it can establish, one `PaymentVerification` recording how. A row it cannot establish keeps `LEGACY_PROVENANCE_UNKNOWN` **permanently visible**; later remediation adds a verification event beside it and never replaces it (§6.5).

> **R0A-ii may not write a historical provenance assignment, backfill, remediation cutover or destructive cleanup until that production report has been run and its remediation queue explicitly approved.** No historical trust may be manufactured. Additive schema and correct sources on *new* payments are not covered by this block, because empty tables manufacture nothing and getting new payments right shrinks the problem while history is being investigated. The local database is not production data and produces no counts.

---

## 8. Accounting kernel

The kernel is the part of Rekoda that cannot be approximately right.

```
business-scoped Chart of Accounts     scoped system roles
journal drafts                        immutable posted journals
journal lines                         accounting periods
general ledger                        trial balance
profit and loss                       balance sheet
cash flow                             accounts receivable
accounts payable                      customer credits
bills                                 credit notes
tax                                   multi-currency and FX
fixed assets                          inventory valuation
cost of goods sold                    recurring transactions
opening balances                      dimensions
```

Journal lines carry **source-appropriate subledger dimensions** rather than a blanket order requirement, because the recognition engine reads per-order balances from the ledger rather than from a shadow copy of it (§12.2). See §12.3.

Inventory costing policy is in **Appendix B**. Roadmap, architected for but not built in V1: project and job costing, budgets.

**Repository reality (DRIFTED).** Today there is no `accounts` table. The chart of accounts is a seventeen-key TypeScript constant and `ledger_entries.account` is a text key into it. There is no accounting-period table; `businesses.books_closed_through` is the entire period model. There is no currency on any ledger row. Repairing this is slice F1 and it is the largest slice in the plan.

---

## 9. Journal model

### 9.1 Two table pairs

```
EDITABLE                          AUTHORITATIVE
JournalDraft                      JournalEntry
JournalDraftLine                  JournalLine
```

`JournalEntry` and `JournalLine` **have no mutable lifecycle state**. There is no `state` column and there must never be one. Existence in the authoritative table *is* posted. A row cannot be promoted from draft to posted once `UPDATE` is revoked, which is precisely why the two are separate tables rather than one table with a flag.

### 9.2 Posting

```
validate  →  atomic INSERT  →  immutable forever
```

### 9.3 Reversal

A reversal is a new posted journal with `reversesJournalId` set to the original. Never an edit, never a delete.

```
UNIQUE (businessId, reversesJournalId) WHERE reversesJournalId IS NOT NULL
```

A full reversal may occur only once. Multiple partial reversals are not modelled in V1; a partial change of mind is a full reversal followed by a fresh correct posting.

### 9.4 Financial-event idempotency

Application idempotency protects the command. It does not protect the ledger from a writer that bypasses the command layer, and defence in depth is the same argument that justifies the balance trigger.

```
JournalEntry
  sourceType · sourceId · postingPurpose
  UNIQUE (businessId, sourceType, sourceId, postingPurpose)

postingPurpose ∈ PAYMENT_CONFIRMATION · REVENUE_RECOGNITION · SETTLEMENT
                 CHARGEBACK · REFUND · TAX_POINT · REVERSAL · CORRECTION
```

A retried webhook cannot produce a second balanced journal even if every layer above it fails.

### 9.5 Posted drafts lock

```
JournalDraft.postedJournalId   UNIQUE, nullable

once postedJournalId IS NOT NULL:
  the draft and every one of its lines become read-only, enforced by trigger
```

The ledger stays correct without this, which is what makes the omission dangerous: the approval trail silently stops describing what was approved. Post `DR Rent / CR Bank`, then edit the draft to say `DR Advertising`, and nobody can tell what anyone approved.

---

## 10. Database accounting invariants

The application layer validates first, because a good error message reaches the caller as something they can act on. PostgreSQL enforces the same rules again, because the trigger catches the writer nobody has thought of yet.

| Invariant | Enforced by |
|---|---|
| At least two lines per entry | trigger, deferred to statement end |
| Exactly one of debit or credit is non-zero per line | CHECK |
| Debit total equals credit total, in functional currency | trigger |
| Every line shares the entry's `businessId` | CHECK + composite FK |
| The account is active | trigger |
| The accounting period is open | trigger |
| The currency is valid for the business | CHECK |
| Functional amounts are coherent with transaction amounts | trigger |
| An FX snapshot exists when transaction currency differs from functional | CHECK |

The balance trigger sums **functional** amounts only and must never see a transaction amount (§16).

---

## 11. Chart of accounts

### 11.1 Scoped system roles, not a global key

A single globally unique `systemKey` cannot express per-connection clearing accounts, which is why it is replaced.

```
Account
  systemRole              nullable
  systemScopeType         nullable
  scopeBusinessId           → businesses(id)              real FK
  scopePaymentConnectionId  → payment_connections(id)     real FK
  scopeFinancialAccountId   → financial_accounts(id)      real FK
```

Typed scope columns rather than one polymorphic `systemScopeId`, because a polymorphic id cannot be a foreign key at all, and a trigger that checks existence is a foreign key somebody has to remember to write. Each FK is composite on `(businessId, id)`, so a scope belonging to another tenant cannot be referenced.

### 11.2 The canonical role-to-scope mapping

Every account the deterministic engine posts to has a role. **The engine must never resolve an account by name.** A lookup for the string `"Sales Revenue"` breaks the first time a merchant renames it, and renaming an account is something merchants do.

```
BALANCES AND SUBLEDGERS
ACCOUNTS_RECEIVABLE          → BUSINESS
ACCOUNTS_PAYABLE             → BUSINESS
RETAINED_EARNINGS            → BUSINESS
CONTRACT_LIABILITY           → BUSINESS
CUSTOMER_CREDIT              → BUSINESS

EQUITY
OWNER_EQUITY                 → BUSINESS
OPENING_BALANCE_EQUITY       → BUSINESS

TRADING
SALES_REVENUE                → BUSINESS
SALES_RETURNS                → BUSINESS
INVENTORY_ASSET              → BUSINESS
COGS                         → BUSINESS

COSTS
PAYMENT_PROCESSING_FEES      → BUSINESS
OPERATING_EXPENSES           → BUSINESS
DEPRECIATION                 → BUSINESS

TAX  (F2 extends this set as the tax model lands)
VAT_PAYABLE                  → BUSINESS      output VAT owed
INPUT_VAT_RECOVERABLE        → BUSINESS      recoverable VAT, including on provider fees
WITHHOLDING_RECEIVABLE       → BUSINESS      tax withheld at source, recoverable

PROVIDER
PAYMENT_PROVIDER_CLEARING    → PAYMENT_CONNECTION
PROVIDER_CHARGEBACK_PAYABLE  → PAYMENT_CONNECTION

MONEY
BANK                         → FINANCIAL_ACCOUNT
CASH                         → FINANCIAL_ACCOUNT / TILL
```

Enforced as a `CHECK` on the `(systemRole, systemScopeType)` pair, which makes `ACCOUNTS_RECEIVABLE` scoped to a payment connection unrepresentable rather than merely wrong.

**`PostingAccountPolicy`.** Where a business needs a posting to land somewhere other than the default role account — a second revenue account per channel, a separate fee account per provider — the resolution is a configured policy row, `(businessId, postingPurpose, dimension) → accountId`, resolved deterministically at posting time and audited when changed. The engine asks the policy; the policy answers with an account id. It is never a string.

The golden bank-feed test of §22.2 depends on `OWNER_EQUITY` existing as a role, which is why it is in the list rather than assumed.

### 11.3 Constraints

```
all-or-none      systemRole, systemScopeType and exactly one scope column
                 are set together, or none of them is
uniqueness       partial unique index on (businessId, systemRole, scope column)
                 WHERE systemRole IS NOT NULL
compatibility    the (role, scopeType) pair is in §11.2
integrity        the referenced scope exists, is of the expected type,
                 and belongs to the same business
```

### 11.4 Lifecycle

| Action | Account with postings | Account without postings |
|---|---|---|
| DELETE | refused, always | permitted |
| Change `systemRole` or scope | refused, always | refused, always |
| Deactivate | **allowed** where policy permits | allowed |
| Post into it once inactive | refused | refused |
| Appear in historical reports | yes, forever | n/a |

Historical postings are the reason deactivation exists instead of deletion. A rule that forbade deactivation because postings exist would make every used account permanent, and a merchant who changes banks would be stuck with a chart of accounts they can never tidy.

A **mandatory** role (AR, AP, retained earnings, VAT payable) may be deactivated only when a replacement account of the same role and scope is configured first.

---

## 12. Revenue and receivable recognition

### 12.1 Separate concepts, separate records

```
Order  ·  Invoice  ·  Payment  ·  ReceivableRecognition
       ·  Fulfilment  ·  RevenueRecognition  ·  TaxPoint
```

IFRS for SMEs is explicit that a receivable is an unconditional right to consideration, and that billing alone does not establish one. That is why receivable recognition is a policy and not an assumption about invoice issuance.

### 12.2 An engine driven by events and ledger state

**Do not hardcode accounting shapes as implementation logic.** And do not maintain a parallel set of mutable balance columns beside the ledger: **the ledger is the authoritative balance**, and a second copy of it is a second thing that can be wrong.

> **SUPERSEDED — this was a real arithmetic error.** An earlier draft of this section stated
> `contractLiability = (receivedMinor + receivableRaisedMinor) − earnedMinor`.
> That double-counts consideration. Raise an unconditional receivable of 100,000 against a contract liability, then collect it: `receivedMinor = 100,000` and `receivableRaisedMinor = 100,000` while `earnedMinor = 0`, so the formula reports a contract liability of 200,000 where the ledger correctly holds 100,000. The error is that collecting a receivable moves an asset; it does not create a second obligation. The formula is replaced by the event rules below and must not be implemented.

#### What the engine reads

Per order, at posting time, from the ledger:

```
contractLiabilityBalanceForOrder     the CONTRACT_LIABILITY balance carried on this order
accountsReceivableBalanceForOrder    the ACCOUNTS_RECEIVABLE balance carried on this order
revenueRecognisedToDate              the sum of this order's RevenueRecognitionEvents
```

and from order state:

```
earnedToDate                         the value of performance obligations satisfied
```

Reading a per-order balance requires journal lines to carry what they belong to. The dimension rule is stated in §12.3; a blanket `orderId` requirement would be too strong, because plenty of legitimate receivables never had an order.

#### Dimensions: subledger always, order where an order exists

> **SUPERSEDED.** An earlier draft required `JournalLine.orderId` on every line touching `ACCOUNTS_RECEIVABLE` or `CONTRACT_LIABILITY`. That is too strong. Migration-day opening receivables, a receivable inherited from a previous system, and a standalone manually entered invoice are all legitimate and none of them has an order. Requiring one would force the engine to fabricate commerce objects that never existed, which is a worse lie than a nullable column.

Traceability rests on the **generic** dimensions every journal already carries. The specific ones are additional context, never the only route:

```
ALWAYS, on every JournalEntry
  sourceType · sourceId · postingPurpose        the universal trace

OPTIONAL, on JournalLine, where they apply
  orderId? · orderLineId? · invoiceId?
  receivableId? · paymentId? · fulfilmentId?

ACCOUNTS_RECEIVABLE line
  receivableId or invoiceId      REQUIRED. The AR subledger reference.
  orderId                        REQUIRED where the posting's source is order
                                 recognition or fulfilment. NULL otherwise, and
                                 legitimately so.

CONTRACT_LIABILITY line
  orderId or contractId          REQUIRED. A contract liability without a contract
                                 is not one, and there is no opening-balance case.
```

`orderId` must never become the only way to determine a contract-liability balance. It is not available at all for opening receivables, manual journals, historical imports, supplier transactions, tax adjustments, owner capital or bank reclassifications, and forcing it would make the engine fabricate orders for every one of them.

So AR is always traceable to something in the subledger, an order-recognition posting is always traceable to its order, and opening balances post without inventing anything.

#### The event rules

```
unconditional receivable raised, before performance
    DR Accounts Receivable
    CR Contract Liability

payment collected against an existing receivable
    DR Bank / Clearing
    CR Accounts Receivable
    contract liability UNCHANGED           ← the rule the old formula broke

advance payment where no receivable exists
    DR Bank / Clearing
    CR Contract Liability

fulfilment
    recogniseDelta = earnedToDate − revenueRecognisedToDate
    release        = min(recogniseDelta, contractLiabilityBalanceForOrder)
    remaining      = recogniseDelta − release

    DR Contract Liability     release
    DR Accounts Receivable    remaining, where a right to collect now exists
    CR Sales Revenue          recogniseDelta
    DR COGS / CR Inventory    at costed value
```

Cash and carry is not a special case: sale, payment and fulfilment occur in one transaction, `contractLiabilityBalanceForOrder` is zero, `release` is zero, and the whole `recogniseDelta` posts against the cash side directly.

#### Earned, but no unconditional right yet

The fulfilment rule says `DR Accounts Receivable remaining, where a right to collect now exists`. That clause hides a case, and it should not.

Revenue can be earned while the right to consideration is still conditional — the obligation is satisfied but something else must happen before the customer owes anything. Under IFRS 15 that balance is a **contract asset**, not a receivable, because it is conditional on something other than the passage of time.

```
V1 behaviour: REFUSE ATOMICALLY

  recogniseDelta > 0
  AND contractLiabilityBalanceForOrder < recogniseDelta
  AND no unconditional right to the remainder exists
    → POST NOTHING
    → state = REQUIRES_REVIEW
    → create a review item carrying the reason
    → the human either establishes the right or corrects the fulfilment record
```

> **The command is atomic. There is no half-posted transaction.** It must never post revenue while omitting the receivable or contract asset, and it must never post part of a transaction and then flag it for review. A journal that balances only because one leg was left out is worse than no journal, because it balances.

Rekoda does not model contract assets in V1 and **must not silently post one as a receivable**, which is what the unqualified rule would have done. Calling a conditional balance a receivable overstates collectability on the balance sheet, and it is exactly the error the receivable-recognition policy exists to prevent. `CONTRACT_ASSET` is reserved as a role name for the version that models it.

#### The invariants the engine asserts after every posting

Stated as checks against the ledger, not as definitions of it:

```
sum of this order's revenue lines            = earnedToDate
contract liability balance                   ≥ 0
accounts receivable balance for the order     ≥ 0
revenueRecognisedToDate                       ≤ earnedToDate
```

A violation is a defect in the engine, not a number to be recomputed.

### 12.3 Policy

```
ReceivableRecognitionPolicy
  ON_ISSUE_UNCONDITIONAL   the invoice itself creates the right
  ON_FULFILMENT            the right arises when the obligation is satisfied
  NONE                     no receivable is ever raised (cash and carry)

RevenueRecognitionPolicy
  AT_POINT_IN_TIME_ON_FULFILMENT    the only V1 value
```

### 12.4 The five cases, as tests

**(a) Unconditional receivable before fulfilment**
```
invoice      DR Accounts Receivable   100,000    CR Contract Liability  100,000
payment      DR Clearing / Bank       100,000    CR Accounts Receivable 100,000
fulfilment   DR Contract Liability    100,000    CR Sales Revenue       100,000
                                                 DR COGS / CR Inventory
```

**(b) Advance payment, no receivable**
```
payment      DR Clearing / Bank       100,000    CR Contract Liability  100,000
fulfilment   DR Contract Liability    100,000    CR Sales Revenue       100,000
```

**(c) Fulfilment before payment (conditional invoice, trade credit)**
```
invoice      nothing posts
fulfilment   DR Accounts Receivable   100,000    CR Sales Revenue       100,000
                                                 DR COGS / CR Inventory
payment      DR Bank                  100,000    CR Accounts Receivable 100,000
```

**(d) Partial deposit**
```
deposit      DR Clearing               30,000    CR Contract Liability   30,000
fulfilment   DR Contract Liability     30,000
             DR Accounts Receivable    70,000    CR Sales Revenue       100,000
                                                 DR COGS / CR Inventory
balance      DR Bank                   70,000    CR Accounts Receivable  70,000
```

**(e) Immediate cash and carry**
```
sale+pay+fulfil   DR Clearing / Bank   100,000   CR Sales Revenue       100,000
                                                 DR COGS / CR Inventory
```

The engine is never told which case it is in. The same arithmetic produces all five.

### 12.5 Rules

- **Partial fulfilment recognises only the fulfilled proportion.** Never more.
- Revenue-recognition events are **idempotent by fulfilment and line**:
  ```
  RevenueRecognitionEvent
    UNIQUE (businessId, sourceType, sourceId, orderLineId)
    amountMinor    REVENUE only. Never gross. Never VAT-inclusive.
  ```
- Accounting policy changes are **versioned, forward-looking, privileged and audited**.
- **Historical accounting never changes because a policy changed later.**

---

## 13. Tax timing is separate

The tax point is not automatically the revenue-recognition point. They coincide under Nigerian VAT for most of what Rekoda will see, and that coincidence is exactly what would let them be fused by accident.

```
TaxCode  ·  TaxRate  ·  TaxTreatment  ·  TaxPointPolicy
         ·  TaxLiability  ·  FiscalisationProvider

TaxPointPolicy ∈ ON_INVOICE_ISSUE · ON_PAYMENT_RECEIPT · ON_FULFILMENT

TaxEvent
  businessId · taxCode · basisMinor · taxMinor · currency
  sourceType · sourceId · occurredAt (the TAX POINT) · journalId
  UNIQUE (businessId, taxCode, sourceType, sourceId)
```

`RevenueRecognitionEvent` and `TaxEvent` are written by separate calculators reading the same order state. No hardcoded tax assumptions. Nigeria-first configuration.

> **OPEN COMPLIANCE:** no statutory-compliance claim may appear in marketing or in product copy without approved review.

---

## 14. Customer credit, returns and refunds

### 14.1 One subledger

```
CustomerCredit               a balance the business owes a customer
CustomerCreditApplication    that balance, applied to an invoice. Append-only.
```

Credit notes create customer credits. Overpayments create customer credits. **An unapplied credit reduces no invoice until it is explicitly applied.**

### 14.2 Append-only with one full reversal

Payment allocations and credit applications are append-only. V1 uses **one full reversal row**, not mutable or deleted allocations.

```
reversal.businessId    = original.businessId
reversal.paymentId     = original.paymentId       (or customerCreditId)
reversal.invoiceId     = original.invoiceId
reversal.currency      = original.currency
reversal.amountMinor   = −original.amountMinor    exactly
reversal.reason        required
reversal.sourceType/Id required
original.reversalOfId IS NULL                     cannot reverse a reversal
UNIQUE (businessId, reversalOfId) WHERE reversalOfId IS NOT NULL
```

"At most one reversal" combined with partial amounts would strand the remainder permanently and silently. A partial change of mind is a full reversal followed by a fresh allocation of the correct amount.

### 14.3 Six distinct concepts

```
CreditNote          the business agrees it owes value back
GoodsReturn         goods physically came back; stock and COGS move
Refund              money deliberately returned to a customer
OverpaymentRefund   money returned because too much arrived
PaymentReversal     a payment undone before settlement
Chargeback          money taken back after settlement, by the provider
```

**Never collapse these into one generic refund concept.** They have different postings, different inventory effects and different evidence requirements.

### 14.4 A reconciling worked example

Sale: net 100,000 + VAT 7,500 = 107,500. Return of net 20,000 + VAT 1,500 = **21,500 credited, 21,500 refunded.** The credit note and the refund agree because both are computed from the same returned lines.

---

## 15. Receipts

> **A receipt is an acknowledgement that a specific payment has been accepted by the business.** It is not the authoritative statement of how that payment was applied.

One payment may settle multiple invoices. The receipt snapshot records the allocations **known at issuance**.

```
Receipt              immutable. One per confirmed payment.
ReceiptAllocation    the allocations as at issuance
ReceiptVoid          only when the ORIGINAL receipt was itself wrong. Carries lineage.
```

A later allocation does not mutate the original receipt. It appears in the customer statement, the payment allocation view and the invoice balances. `ReceiptVoid` is for errors, never for allocation changes, which are not errors.

Original rendered documents remain immutable and byte-stable. A re-rendered statement must say the same thing about a month already reported.

---

## 16. Multi-currency

Journal currency semantics are explicit, because a column called `debitMinor` next to a column called `transactionCurrency` invites exactly one bug and it is a bug that balances.

```
JournalEntry
  functionalCurrency        INVARIANT: = Business.functionalCurrency
JournalLine
  debitFunctionalMinor      always the entry's functional currency
  creditFunctionalMinor
  transactionCurrency       what the money actually was
  transactionAmountMinor
  exchangeRateSnapshotId    REQUIRED when transactionCurrency ≠ functionalCurrency
                            NULL when equal; the rate is 1 by definition
```

Statements sum functional values. **Historical transactions never use today's rate.**

See **Appendix A** for the rate source, fallback, staleness and override rules. Four FX concepts, kept distinct and never shared:

```
Accounting FX          what the books used at the transaction date
Settlement FX          what the provider actually converted at
Cost-model FX          what Rekoda's own costs converted at
Commercial pricing FX  what a price list is denominated in
```

---

## 17. Payment hub

```
PaymentConnection  ·  PaymentIntent  ·  PaymentAttempt  ·  Payment
PaymentVerification ·  PaymentAllocation ·  Refund  ·  PaymentReversal
Chargeback  ·  Settlement  ·  SettlementItem  ·  SettlementComponent
ProviderCapability  ·  ProviderCostSchedule  ·  PaymentProviderResolver
```

### 17.1 PaymentConnection: four independent statuses

Today one blended `status` with nine values plus a separate `kyc_status` (DRIFTED). Canonically:

```
operationalStatus    can it technically transact right now
kycStatus            has the merchant been verified by the provider
commercialStatus     is there an agreed commercial arrangement
complianceStatus     is it permitted under Rekoda's own policy
productionEnabled    derived; all four must permit it
```

They are independent because they fail independently. A connection can be operationally healthy and commercially suspended, and blending them makes that state unrepresentable.

### 17.2 Provider-neutral attributes

```
accountOwnership   MERCHANT_OWNED · PLATFORM_OWNED
representation     SUB_MERCHANT · DIRECT_MERCHANT · PLATFORM_ONLY
credentialSource   MERCHANT_SUPPLIED · PLATFORM_ISSUED · OAUTH_DELEGATED
```

`PLATFORM_ONLY` is not a degenerate case. It is the correct description of an aggregator arrangement, and naming it stops that arrangement being mislabelled as a direct merchant relationship it is not.

---

## 18. Provider interfaces

Three separate ports. A provider that does two things implements two.

```
PaymentProvider         collect money
FinancialFeedProvider   read account movement
PayoutProvider          send money
```

Initial architecture:

```
PaystackPaymentProvider     MonoDirectPayProvider
OPayPaymentProvider         KudaPaymentProvider

MonoFinancialFeedProvider   KudaFinancialFeedProvider
OPayFinancialFeedProvider   (where applicable)
```

Production availability is **capability and compliance gated** per connection, per business. An adapter existing in the codebase is not the same as it being available to a merchant.

> **OPEN COMMERCIAL / OPEN COMPLIANCE:** Paystack commercial confirmation, Mono production terms, OPay production access, Kuda regulatory and commercial approval. See build plan §external blockers.

---

## 19. Economic fee bearer vs provider fee payer

These are two different things and conflating them produces an adapter that cannot be written.

```
EconomicFeeBearer     who ends up out of pocket. Rekoda's concept.
  MERCHANT · CUSTOMER · REKODA · SHARED

ProviderFeePayer      what we send to the provider. Adapter-specific, opaque to the core.
  paystack:  account | subaccount | all | all-proportional
  others:    whatever that provider actually accepts
```

Paystack's fee bearer is `account` or `subaccount`, with `all` and `all-proportional` for splits. **There is no customer value, because the provider has no concept of one.** A customer bears a fee only if somebody adds a visible line to the order total.

### 19.1 PaymentCharge

```
PaymentCharge
  id · businessId · orderId
  type                    PAYMENT_PROCESSING · DELIVERY · SERVICE · SURCHARGE
  label                   what the customer reads. Honest, not "convenience fee".
  amountMinor · currency
  beneficiary             MERCHANT · REKODA · PROVIDER
  economicBearer          EconomicFeeBearer
  taxCode                 nullable; a surcharge may itself be taxable
  actualOrEstimated       ESTIMATED at checkout · ACTUAL once settled
  providerCostScheduleId  nullable; what the estimate came from
```

Producing a breakdown where every line is a record, and where the taxable base is **stated rather than inferred from the arithmetic**:

```
Items                 100,000     taxCode = STANDARD_RATE
Delivery                3,000     taxCode = STANDARD_RATE
Payment charge          1,500     taxCode = NOT_IN_BASE   (example configuration only)
                      -------
Taxable base          103,000
VAT at 7.5%             7,725
                      -------
Total                 112,225
```

`PaymentCharge.taxCode` is nullable, so whether a charge sits in the base is a configuration decision and not a property of the concept. A different configuration that taxed the charge would give a base of 104,500 and VAT of 7,837.50, and both are correct under their own configuration.

> **A canonical example must never contain arithmetic whose tax basis has to be guessed.**

> A customer surcharge is **configuration-gated**, never derived. In several markets it is regulated or prohibited. Rekoda must never add a charge a merchant did not choose to add.

---

## 20. Provider settlement

```
Settlement           what the provider paid out, and when
SettlementItem       which payments it covered
SettlementComponent  signed adjustments
```

Components are signed `DEDUCTION` or `ADDITION` and may represent:

```
processing fee · VAT on provider fee · withholding · levy
reserve held · reserve released · rebate · adjustment · chargeback
```

**Actual provider settlement data drives the books.** Where provider data exists, do not estimate final settlement postings from a rate card. Rate cards produce estimates for checkout display (§19) and for the cost model (§29), never for authoritative postings.

---

## 21. Chargeback accounting

### 21.1 Pre-settlement reversal

Nothing has left the provider, so the clearing account reverses.

```
DR Accounts Receivable
CR Provider Clearing
```

### 21.2 Post-settlement chargeback

The money is gone and the merchant now owes the provider. That is a **liability**, not a second receivable.

```
DR Accounts Receivable            the customer owes it again
CR Provider Chargeback Payable    and the merchant owes the provider
```

Recovery from a future settlement is not a new event type. It is a `DEDUCTION` component on that settlement, clearing the payable:

```
DR Provider Chargeback Payable
```

If the provider debits the bank account directly instead:

```
DR Accounts Receivable
CR Bank
```

> **SUPERSEDED:** `CHARGEBACK_RECEIVABLE`. Crediting a receivable asserts that a second party owes the merchant money, which is the opposite of what a chargeback creates.

---

## 22. Financial feeds and reconciliation

> **A bank credit proves account movement, not business purpose.**

```
bank transaction  ≠  customer payment
```

Money moving through an account is a fact. What that money *was* is a judgement, and the judgement belongs to the merchant.

### 22.1 Tiers

```
1  exact reference           deterministic, auto-matched
2  strong deterministic      amount + date + counterparty, auto-matched
3  suggested                 proposed to a human, never applied
4  manual review             a person decides, with a reason recorded
```

**AI can explain. Deterministic logic or an authorised human decides.** An AI-proposed match is never applied without one of the two.

### 22.2 The required golden test

```
GIVEN   a bank feed line arrives
          +5,000,000 · narration "DIRECT CREDIT"
          no invoice reference · no expected payment · no known payer

THEN    FinancialTransaction   created
        Payment                NOT created
        revenue journal        NOT posted
        reconciliation state   UNMATCHED, queued for review

WHEN    the merchant classifies it as owner capital

THEN    DR Bank          5,000,000
        CR Owner Equity  5,000,000

AND     Sales Revenue is unchanged
AND     no Payment row exists for this money at any point
```

The merchant may classify a line as owner capital, a loan, a supplier refund, an internal transfer, or anything else. Rekoda never makes that judgement silently.

### 22.3 Connection-scoped identity

An identifier is scoped to the connection that produced it unless the provider's documentation explicitly guarantees global uniqueness, and the guarantee is cited where the constraint is defined.

```
FinancialTransaction   UNIQUE (businessId, provider, financialAccountConnectionId, externalTransactionId)
Settlement             UNIQUE (businessId, paymentConnectionId, providerSettlementId)
PaymentAttempt         UNIQUE (businessId, paymentConnectionId, providerAttemptId)
ProviderEvent          UNIQUE (businessId, paymentConnectionId, providerEventId)
```

---

## 23. Payment evidence retention

Raw evidence retention is separate from financial-record retention. A screenshot of somebody's bank app is personal data; the fact that a claim was made is a financial record.

```
PaymentEvidence
  resolutionState      UNRESOLVED · RESOLVED · EXPIRED
  resolutionDeadline   set when the claim is raised, from business configuration
  resolvedAt           set on RESOLVED, and also on EXPIRED
  rawPurgedAt
  retentionPolicyId
```

```
REPORTED
  → nobody responds by resolutionDeadline
EXPIRED  (resolvedAt := now)
  → the ordinary raw-retention countdown begins
  → raw media deleted; the claim, its amount and its outcome survive

unless EvidenceLegalHold is active — dispute, investigation or tax audit —
which suspends the countdown and is the only thing that can
```

> **An unresolved claim must not live forever automatically.** An abandoned dispute is the most likely state for a claim to be in, not the least. Derived safe facts, hashes and audit records survive under financial-record retention.

---

## 24. Meta and WhatsApp

**WhatsApp-native Integrate first. Storefront second.** This ordering is a product decision, not a sequencing convenience.

```
Tech Provider status              App Review
Advanced Access:                  Embedded Signup
  business_management
  whatsapp_business_management
  whatsapp_business_messaging
phoneNumberId → BusinessId routing
per-WABA templates                service window management
connection health                 billing mode
```

Meta billing mode, once confirmed:

```
MERCHANT_DIRECT        the merchant is billed by Meta directly
REKODA_CREDIT_LINE     Rekoda fronts the cost and recovers it
PARTNER_BILLED         Meta bills Rekoda as partner
```

> **OPEN COMMERCIAL:** billing mode is unconfirmed. It changes unit economics materially and is a W0 deliverable.

Message categories are metered separately (§4.2) because utility and marketing differ by roughly eightfold in cost, and that difference is the largest variable in plan margin.

---

## 25. Application layer

Every ingress converges on the same commands. This is the rule that makes cross-product journeys safe and makes the public API possible without a second implementation.

```
RecordSale              PlaceOrder              IssueInvoice
CreatePaymentIntent     ConfirmPayment          AllocatePayment
RecordPaymentEvidence   RecordExpense           RecordPurchase
PostJournal             RefundPayment           ClosePeriod
IngestFinancialTransaction                      ConfirmReconciliation
```

> **Chat, Dashboard, Storefront, WABA, the future public API and the future Embed must not implement separate financial logic.**

An ingress is responsible for authentication, shape validation and reply rendering. It is responsible for nothing financial. **Repository reality (DRIFTED):** logic currently lives in controllers and job handlers calling repositories directly. Slice A1 extracts it.

---

## 26. Idempotency and the transactional outbox

```
IdempotencyRecord    businessId · key · commandName · requestHash
                     · responseSnapshot · createdAt
                     UNIQUE (businessId, key)

OutboxEvent          businessId · type · payload · occurredAt
                     · dispatchedAt · attempts
                     written in the SAME transaction as the state change
```

Plus financial-domain idempotency at the ledger itself (§9.4), so a retry cannot create duplicate financial truth even if every upstream protection fails.

---

## 27. Public API

Every major capability is architected for eventual API commercialisation from the start, because retrofitting an API onto controller-resident logic means writing the logic twice.

> **The public API is a separate commercial entitlement.** It is not automatically included with Chat, Integrate or Complete.

```
Merchant API          Partner API            Enterprise API
Accounting API        Reconciliation API     Reporting API
Documents API         AI Business Actions API
Payment orchestration API   (where legally permitted)
Webhooks
```

Rules:

- APIs call the **same application commands** as every other ingress.
- Public contracts **must not expose Drizzle table shapes**. Contracts live in `packages/contracts` and are versioned independently of the schema.
- API usage is metered (`API_REQUEST_UNITS`, `API_APPLICATIONS`, `WEBHOOK_DELIVERIES`) and gated by entitlement like everything else.

---

## 28. Rekoda Embed

**Do not build now.** Architecture is preserved so that it remains possible without a second backend:

```
JS SDK  ·  React SDK  ·  embeddable widget
headless conversational API  ·  white-label assistant
```

The constraint that keeps this open is §25 and §27: one command layer, one contract layer, no ingress-resident financial logic.

---

## 29. COST-1 — Rekoda's own provider costs

> **Decision COST-1.** Not `D1`, which is the Dashboard and Accountant build slice.

**V1: no second corporate general ledger inside the merchant product.** Instead, an immutable platform-cost subledger feeding a margin model.

```
PlatformCostEvent            append-only. No UPDATE, no DELETE.
  id · provider · providerProduct
  businessId?                nullable; some costs are not attributable to one merchant
  paymentConnectionId? · paymentId? · settlementId?
  costType                   MESSAGING · AI_INFERENCE · OCR · PAYMENT_FEE
                             BANK_FEED · STORAGE · TELEPHONY
  amountMinor · currency · taxMinor?
  externalReference          the provider's own id for the charge
  incurredAt
  source                     PROVIDER_INVOICE · PROVIDER_API · DERIVED_FROM_RATE_CARD
  costScheduleId?
  actualOrEstimated          ACTUAL · ESTIMATED
```

`usage_events` is telemetry. It is mutable in practice and was never designed as a financial record. Real money Rekoda spends gets an immutable fact.

BL2 consumes these for unit economics: revenue less Meta messaging, AI inference, OCR, payment fees, bank feeds and storage, per merchant, per plan, per cohort. Exportable later into Rekoda Commerce Technologies Limited's own statutory books. **Rekoda's corporate statutory accounting stays outside the merchant product for V1.**

---

## 30. Pricing and billing

Launch **candidates** only, and explicitly not frozen:

```
₦9,900   Rekoda Chat
₦19,900  Rekoda Integrate
₦29,900  Rekoda Complete
```

Pricing is versioned, effective-dated, configurable, grandfatherable, usage-aware and FX-aware.

```
PlanVersion       a named set of entitlements and allowances, effective-dated
PlanPrice         a price for a plan version, in a currency, effective-dated
AllowanceVersion  the allowance table for a plan version
AddOn             a recurring capability purchased alongside a plan
UsagePack         a one-off block of units
```

> **Commercial prices must not be hardcoded in application logic.** Today's allowance table is a TypeScript constant with five units and five plan ids (DRIFTED); BL2 replaces it with data.

Current modelled economics, for reference and not as a commitment: variable cost per merchant per month of roughly ₦892 (Chat), ₦957 (Integrate) and ₦1,453 (Complete) at 1,000 merchants, giving 91–95% gross margin, with break-even near 761 merchants. These figures depend on the Meta billing mode (§24) and on tiered bank-feed pricing, both of which are open.

---

## 31. Accounting definition of done

Fourteen invariants. A release that violates any of them is not shippable, regardless of what else it does.

1. Every statement figure traces to account → journal → business event → origin.
2. Every posted journal balances.
3. No paid invoice exists without authoritative allocations or applied credits.
4. No receipt exists without accepted confirmation provenance.
5. Provider settlement reconciles to gross payment.
6. Inventory gross profit reconstructs from costing movements.
7. Statements tie to the ledger.
8. Revenue is recognised only according to the configured recognition policy.
9. Credits, returns, refunds, reversals and chargebacks preserve history.
10. Clearing, bank and customer-credit balances are explainable.
11. A bank credit is never assumed to be customer revenue or a customer payment merely because money arrived.
12. Receivable recognition and revenue recognition can happen at different times.
13. Partial fulfilment cannot recognise more revenue than has been fulfilled.
14. Financial-event retries cannot produce duplicate journals.

---

## 32. The golden business fixture

One fictional business, one permanent integration test, run end to end. This becomes among the strongest regression protections Rekoda has, because it is the only test that can catch an error that is individually plausible everywhere and collectively wrong.

**The scenario, in order:**

```
opening balances            purchase inventory          supplier bill
partial supplier payment    cash sale                   credit sale
WhatsApp Integrate order    customer deposit            partial fulfilment
final fulfilment            payment                     provider settlement
provider fee                bank feed import            reconciliation
customer overpayment        customer credit             refund
sale return                 payment reversal            chargeback
operating expense           fixed asset                 depreciation
FX transaction              accounting close
```

**What it must prove ties:**

```
General Ledger  ·  Trial Balance  ·  Profit and Loss  ·  Balance Sheet
Cash Flow  ·  AR  ·  AP  ·  Inventory
Customer Statement  ·  Supplier Statement  ·  Reconciliation
```

The fixture lands incrementally: a first version when F1 completes, extended by each subsequent slice, complete after F2. A slice that cannot extend the fixture has not finished.

---

## 33. Freeze

On approval of this document and the build plan, **the architecture is frozen for implementation**.

Reopen a canonical decision only when:

```
repository evidence makes it impossible
financial integrity would be violated
legal or compliance evidence invalidates it
provider capability makes it impossible
material production evidence proves the design incorrect
```

**Refactoring preference alone is not sufficient.** A nicer-looking implementation of a settled decision is not a reason to reopen it.


---

# Appendices

The appendices are canonical. They exist as appendices because they are reference material rather than narrative, not because they are optional.

---

## Appendix A — Dynamic FX

§16 defines what the ledger stores. This defines where a rate comes from and what happens when it cannot be got.

### A.1 The port

```
ExchangeRateProvider              provider-neutral, like every other port
  rateFor(base, quote, at) → ExchangeRateSnapshot | Unavailable

ExchangeRateSnapshot              immutable, once written
  id · baseCurrency · quoteCurrency
  rate                            stored at full provider precision, never rounded
  effectiveAt                     the moment the rate applies to, not fetch time
  fetchedAt
  source                          PROVIDER · MANUAL_OVERRIDE · INHERITED
  providerName · providerReference?
  actorId?                        required for MANUAL_OVERRIDE
  reason?                         required for MANUAL_OVERRIDE
```

### A.2 Primary, fallback and staleness

```
1  primary provider          the configured rate source
2  fallback provider         a different provider, on primary failure
3  cached snapshot           reused when its effectiveAt is inside the freshness window
4  REFUSE                    all three exhausted
```

The resolver returns a named state, never a bare rate or a null:

```
RATE_AVAILABLE              proceed
RATE_STALE                  a rate exists, outside the window for this request
RATE_UNAVAILABLE            no source could answer
MANUAL_OVERRIDE_REQUIRED    policy demands a human decision for this case

for a financial posting:
  RATE_STALE or RATE_UNAVAILABLE beyond configured policy
    → REFUSE the posting
    → REQUIRES_REVIEW
```

> **Never silently fall back to the latest current rate for a historical transaction.** That is the single most likely way a wrong rate enters the books, because it always succeeds and always looks reasonable.

**A stale rate is refused, never guessed.** The freshness window is configuration; outside it, the posting fails with a named error and the operation is queued rather than completed at an invented rate. Refusing to post is recoverable. Posting at a wrong rate is a wrong set of books that balances, and nobody notices.

> **Staleness is measured against the requested accounting timestamp, not against today's date.** A transaction dated 15 June asks for a 15 June rate. That rate is fresh for that request in August, in December, and in five years. Measuring against wall-clock time would make every historical import and every opening-balance migration impossible the moment it aged past the window, which is the opposite of what the rule is for.

```
request      rateFor(USD, NGN, at = 2026-06-15T00:00Z)
freshness    |snapshot.effectiveAt − requested at|  ≤ window
             NOT  |now − snapshot.effectiveAt|
```

Rates are cached by `(base, quote, effectiveAt)`, which is what makes the cache safe: two postings for the same moment get the same snapshot by construction rather than by luck.

### A.3 Manual override

A merchant may pin a rate — a contractual rate, a bank's actual fill. It is a first-class snapshot with `source = MANUAL_OVERRIDE`, an actor, a reason, and an audit event. It is never silent and never inferred.

### A.4 Historical rates are permanent

> **A historical transaction always uses its own snapshot.** Re-rendering a statement for a closed month must produce the same figures it produced then. Nothing recomputes a past posting at today's rate, for any reason, including a corrected rate: a corrected rate produces a reversing journal at the new snapshot, never a mutation of the old one.

### A.5 Commercial FX is a different thing entirely

Accounting FX records what happened. Commercial FX decides what to charge, and it is a pricing decision with a margin in it.

```
CommercialFxPolicy
  sourceSnapshot            the accounting-grade mid rate it starts from
  bufferBps                 the spread applied, in basis points
  roundingRule              UP · NEAREST · TO_MAJOR_UNIT
  minMarginBps              the floor below which a quote is refused
  quoteValidityWindow       how long a quoted rate is honoured
```

**A commercial rate is never posted to the ledger and an accounting rate is never quoted to a customer.** Mixing them is how a business discovers it has been absorbing a spread for a year.

---

## Appendix B — Inventory costing

### B.1 The V1 policy

```
InventoryCostingPolicy = WEIGHTED_AVERAGE
```

Fixed for V1. FIFO and specific identification are reserved enum values and are not implemented. Two engineers implementing "inventory" without a stated policy produce two sets of books that each look right, and the golden fixture in §32 covers inventory and COGS, so it would certify whichever one shipped.

### B.2 The rules

```
receipt of stock          new average = (existing value + received value)
                                        ÷ (existing qty + received qty)
                          recomputed at the moment of receipt, never retroactively

issue of stock (sale)     COGS = qty issued × average cost at issue
                          the average is UNCHANGED by an issue

customer return           1. restore the returned quantity at the ORIGINAL issue
                             cost carried on the outbound movement
                          2. reverse COGS at that same historical cost
                          3. add that quantity and value to current inventory
                          4. RECALCULATE the moving average from the resulting
                             quantity and value
                          → the average moves, and it must

supplier return           reverses the receipt at the receipt's own cost, and the
                          average is recomputed as at that moment

negative stock            REFUSED. An issue that would take a line below zero is
                          rejected, because a negative average cost is not a number
                          any statement can survive.
```

> **SUPERSEDED — an earlier draft said a customer return "cannot move the average". That is arithmetically impossible.** Worked through:

```
buy 10 @ 100          10 units · 1,000 · avg 100
sell 5 @ cost 100      5 units ·   500 · avg 100
buy 5 @ 200           10 units · 1,500 · avg 150

return 1 unit, restored at its original issue cost of 100
                      11 units · 1,600 · avg 145.4545…

if the average did not move:   11 × 150 = 1,650 ≠ 1,600
```

Quantity times average must equal inventory value. Holding the average fixed breaks that identity on the first return, and a broken identity there propagates into COGS on every subsequent sale. Returning goods at their **original** cost is the part that protects gross profit from a price swing; recalculating the average afterwards is what keeps the books internally consistent. Both are required, and they are not in tension.

**Non-resalable returns.** A damaged or expired return must not silently rejoin sellable stock. It enters a damaged or returns holding location, and leaving it there is a decision: either it is refurbished back into sellable stock at an assessed cost, or it is written off. The write-off is a posting, not a disappearance.

Every movement carries the unit cost applied to it, so gross profit reconstructs from the movements and definition-of-done invariant 6 holds without a second calculation.

**Invariants asserted after every inventory movement:**

```
quantity                 ≥ 0
inventoryValue           ≥ 0
inventoryValue           consistent with the movement history
movement values          reconcile to the resulting balance
if quantity > 0          averageCost = inventoryValue / quantity
cumulative COGS          reconstructable from the outbound movements alone
```

> **Exact arithmetic only.** Money in integer minor units, quantities and unit costs at a defined decimal precision, division rounded by a stated rule with the residual carried, never dropped. **No floating-point money arithmetic anywhere in the costing path.** A moving average is a repeated division; float error there does not stay small, it accumulates into every subsequent COGS figure.

### B.3 Roadmap

Net realisable value impairment — writing stock down to what it will actually fetch — is architected for and not built in V1. The seam is a nullable `impairedValueMinor` on the stock line and an `InventoryImpairment` posting purpose.

---

## Appendix C — Privacy and the AI processor boundary

The privacy gateway exists so that no model reasoning about a merchant's business ever sees who their customers are. One step in the pipeline is a deliberate, narrow exception, and a permanent specification must state it rather than leave a future engineer to infer a rule.

### C.1 The pipeline

```
typed or spoken message
  → PII gateway: tokenise names, phone numbers, addresses
  → reasoning model receives TOKENS only

photographed document
  → APPROVED SPECIALIST PROCESSOR: raw image, transcription only
  → PII gateway: tokenise the transcript
  → reasoning model receives TOKENS only
```

### C.2 The exception, stated precisely

A PII gateway tokenises text. It cannot tokenise an image, because the personal data in a photograph is pixels. Something must read the paper before anything can be tokenised.

```
APPROVED SPECIALIST PROCESSOR

  purpose        transcription ONLY. Transcribe what is on the page, verbatim.
                 No interpretation, no summarising, no inference.
  input          the raw image
  output         text, and nothing else
  terms          API terms that exclude training on inputs. A DPA is required
                 before a processor is approved.
  retention      the processor must not retain the image
  storage        Rekoda does not store the raw image beyond the evidence
                 retention rules of §23
  registry       approved processors are named in configuration and are
                 auditable. Adding one is a decision, not a deployment.
```

The self-hosted OCR sidecar remains a supported configuration and is the hardening move. `/ai-privacy` describes whichever configuration a deployment actually runs, and that page is generated from configuration rather than written by hand, so it cannot drift from the truth.

### C.3 The invariant that does not bend

> **The reasoning model receives tokenised context. Always.** The specialist-processor exception covers transcription and covers nothing else. A model asked to reason, decide, classify or advise never receives untokenised personal data, whatever surface the request came from and whatever the merchant asked for.

### C.4 What a model may and may not do

An appendix nobody can violate is worth more than one nobody reads, so this is enforced by module boundaries rather than by convention.

```
MAY        interpret · extract intent · explain · propose · draft

MAY NOT    write a financial table
           mark a payment confirmed
           select an authoritative reconciliation match
           calculate a final ledger posting
           override an entitlement
           override a risk tier
           bypass a confirmation
```

The flow is one-directional and has no shortcut:

```
ingress
  → privacy gateway or approved specialist processing
  → AI-safe structured intent
  → deterministic application command
  → validation
  → accounting and payment engine
  → persistence
```

**Enforcement, in both directions.** `scripts/check-boundaries.mjs` already bans raw `db` imports outside `packages/db`. It gains two rules, and they are deliberately mirrored:

```
AI adapters          may NOT import financial repositories or the accounting engine
domain / accounting  may NOT import Anthropic, OpenAI or any provider SDK directly
provider adapters    stay isolated behind their ports
reasoning calls      reach a model only through the approved AI abstraction
                     and the privacy gateway
```

One direction stops a model reaching money. The other stops money reaching a model — which is the leak that would otherwise happen quietly, the first time somebody adds a helpful summary to an accounting service. **A violation fails CI**, so the boundary is architecture rather than convention.

---

## Appendix D — Risk tiers and confirmation policy

Entitlement decides whether a capability exists for a business. Risk tier decides what a capability demands before it acts. Without this, every command is equally easy, and reversing a period close is as cheap as asking for a sales figure.

### D.1 The tiers

```
READ_ONLY        no confirmation. Questions, reports, balances, statements.

STANDARD         a preview and a confirmation, which is the existing draft
                 mechanism. Sales, payments, expenses, purchases, stock counts.

HIGH_RISK        explicit confirmation naming the specific consequence,
                 an authenticated actor, and an audit event carrying the reason.
                 Never available to an unattended assistant.
```

### D.2 What is HIGH_RISK

```
RefundPayment                      money leaves the business
ReceiptVoid                        a document already given to a customer
PaymentVerificationRevocation      unpicking established trust
ConfirmReconciliation override     overruling a deterministic match
PaymentConnection credential change  where money will land
PaymentConnection provider change    which rails money runs on
ReopenAccountingPeriod             reported figures become movable again
Account deactivation, mandatory role  the chart of accounts loses a required part
EraseData                          exact-phrase confirmation, never "yes"
PostingAccountPolicy change        where the engine posts from now on
Destructive inventory adjustment   stock written off or forced to a count
PaymentConnection disconnect       collection stops
```

**The away assistant may perform none of these autonomously.** Not one, not ever, under the current canon. A later decision may introduce a specifically bounded approval mechanism; until it exists, the list is absolute and the assistant hands off.

### D.3 The rules

- **Every front door obeys the same tiers.** Chat, Dashboard, Integrate, Storefront, the future public API, the future Embed and every background automation. **No alternate ingress gets a cheaper safety path**, which is the entire reason the tier lives on the command rather than on the controller.
- **The away assistant (W4) may never autonomously execute a `HIGH_RISK` command.** It hands off to a human, every time, without exception, **including when the merchant has performed that same action manually before**. Past manual use is not standing consent for an unattended agent.
- A `HIGH_RISK` confirmation names the consequence in the merchant's own terms. "Refund ₦20,000 to Ada. The money leaves your account." Not "confirm?".
- Every `HIGH_RISK` execution writes an audit event with the actor and the reason. A missing reason is a refusal, not a blank field.
- Risk tier is a property of the **command**, declared in the command layer (§25), so no ingress can lower it. A tier that a controller could soften would not be a tier.

---

## Appendix E — Lifecycle status reference

Superseding the older specifications means their status vocabularies come with, or they are lost and reinvented at implementation time. This is that vocabulary, consolidated.

### E.1 Payment

```
status              PENDING · PROCESSING · CONFIRMED · FAILED
                    REVERSED · REFUNDED · PARTIALLY_REFUNDED
trust               derived, never stored (§6.8)
```

### E.2 PaymentIntent and PaymentAttempt

```
PaymentIntent       CREATED · AWAITING_PAYMENT · PARTIALLY_PAID · PAID
                    EXPIRED · CANCELLED · FAILED
PaymentAttempt      INITIATED · PENDING · SUCCEEDED · FAILED · ABANDONED
```

### E.3 Invoice

> **SUPERSEDED.** An earlier draft listed `PARTIALLY_PAID` and `PAID` as *lifecycle* states. They are not. An invoice is simultaneously `ISSUED`, `PARTIALLY_PAID` and `OVERDUE`, and a single column cannot say that. Three independent dimensions, as previously agreed:

```
InvoiceLifecycle          DRAFT · ISSUED · VOID
                          what the document IS

InvoicePaymentStatus      UNPAID · PARTIALLY_PAID · PAID
                          derived from allocations and applied credits, never stored

InvoiceCollectionStatus   CURRENT · DUE · OVERDUE · IN_DISPUTE
                          · IN_COLLECTION · WRITTEN_OFF
                          what is being done about getting paid

AgingBucket               0-30 · 31-60 · 61-90 · 90+
                          derived from the DUE date, never from the issue date
```

**Payment status, collection status and aging are DERIVED**, computed from invoice totals, allocations, applied credits, the due date and the void state. None of them is independently mutable financial truth, because a stored status is a second copy of a fact that can disagree with the first.

The three are independent by design. `ISSUED` + `PARTIALLY_PAID` + `OVERDUE` is an ordinary Tuesday and must be representable; collapsing them is how a partly paid overdue invoice becomes invisible to whoever is chasing it. `WRITTEN_OFF` is a collection outcome rather than a lifecycle state, because the invoice still exists and the receivable still has a history.

**Supplier bills mirror this exactly:**

```
BillLifecycle             DRAFT · RECEIVED · VOID
BillPaymentStatus         UNPAID · PARTIALLY_PAID · PAID
BillSettlementStatus      CURRENT · DUE · OVERDUE · IN_DISPUTE · WRITTEN_BACK
```

### E.4 Order and fulfilment

```
Order               DRAFT · PLACED · VALIDATED · CONFIRMED
                    PARTIALLY_FULFILLED · FULFILLED · CANCELLED
Fulfilment          PENDING · PARTIAL · COMPLETE · RETURNED
```

`VALIDATED` is a distinct state from `PLACED` on purpose: the gap between them is the server-side validation that Integrate depends on (§5.2), and a model that skipped it could not represent an order that was placed and refused.

### E.5 Settlement

```
Settlement          EXPECTED · IN_TRANSIT · SETTLED · FAILED · REVERSED
SettlementComponent DEDUCTION · ADDITION            signed (§20)
```

### E.6 Reconciliation

```
FinancialTransaction   IMPORTED · MATCHED · PARTIALLY_MATCHED
                       UNMATCHED · IGNORED · IN_REVIEW
match confidence       EXACT_REFERENCE · STRONG_DETERMINISTIC
                       SUGGESTED · MANUAL                (§22.1)
```

### E.7 Payment evidence

```
resolutionState     UNRESOLVED · RESOLVED · EXPIRED      (§23)
```

---

## Appendix F — Conversation identity

Chat and Integrate must not be forced into one identity model by one constraint. They are different shapes of conversation and the model says so.

### F.1 The model

```
Conversation
  id · businessId
  channel                        WHATSAPP · SIMULATOR · …
  channelAccountId               which merchant channel asset (phoneNumberId / WABA)
  externalConversationId?        the provider's own thread identity, where it has one
  externalParticipantIdHash?     keyed lookup token. NEVER a raw identifier.
  participantHashVersion?        which key produced the hash. See F.3.
  externalParticipantVaultRef?   the vaulted raw identifier, where retention is needed
  conversationKind               MERCHANT · CUSTOMER
  customerId?                    resolved through the privacy gateway
  status
```

### F.2 Two identities, two constraints

```
MERCHANT     the merchant talking to Rekoda. Exactly one per business per
             channel, which was the correct part of the old rule.
  UNIQUE (businessId, channel) WHERE conversationKind = 'MERCHANT'

CUSTOMER     a customer talking to the merchant on the merchant's own channel
             asset.
  UNIQUE (businessId, channel, channelAccountId,
          externalParticipantIdHash, participantHashVersion)
    WHERE conversationKind = 'CUSTOMER'
      AND externalParticipantIdHash IS NOT NULL
```

> **PostgreSQL treats NULLs as distinct in a unique index**, so a nullable identity column silently permits unlimited duplicates. Every constraint above is therefore partial and explicitly excludes the NULL case. A constraint that quietly stops applying is worse than no constraint, because the schema still looks like it has one.

Which thread a WhatsApp Integrate message belongs to:

```
businessId + channel=WHATSAPP + channelAccountId + externalParticipantIdHash
```

### F.3 Hash key versioning and rotation

A keyed hash is only as good as the ability to change the key. Routing must never become permanently dependent on one secret.

```
participantHashVersion    V1, V2, …   stored beside every hash

rotation
  1  introduce V2 alongside V1
  2  reads resolve EITHER version
  3  backfill V2 hashes
  4  new writes use V2
  5  cut over
  6  retire V1 only after validation
```

The raw identifier, where it must be retained at all, lives in the vault and never in the conversation index. **The raw participant identifier is never logged during lookup or routing** — not at debug level, not in an error message, not in a trace.

### F.4 The hash is scoped, so it cannot correlate across merchants

A single global HMAC of a phone number would make one customer's identity **the same value in every merchant's data**, turning the conversation index into a cross-business correlation table nobody asked for. The key material is therefore scoped:

```
externalParticipantIdHash = HMAC(key(businessId, channelAccountId, version),
                                 raw participant identifier)
```

The same person messaging two merchants produces two unrelated hashes. Rekoda cannot join them, and neither can anyone who obtains one merchant's rows.

### F.5 Two identities that must not merge

```
channelAccountId               WHICH MERCHANT this is. Routed from phoneNumberId.
externalParticipantIdHash      WHO IS WRITING. A customer of that merchant.
```

`phoneNumberId → BusinessId` continues to route the merchant's WABA and nothing else. **Customer identity and WABA identity stay separate concepts**, and no constraint, index or resolver may quietly conflate them.

### F.6 Backfill honesty

Legacy conversations are merchant threads. The backfill sets `conversationKind = MERCHANT` and stops there.

> **Do not fabricate a customer participant for a legacy merchant-only Chat thread.** There was no customer on the other end; there was Rekoda. Inventing a participant hash to make a column non-null would put a fictional person in the identity index, and every later query would treat that fiction as a fact.
