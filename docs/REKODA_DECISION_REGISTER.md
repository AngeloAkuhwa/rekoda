# Rekoda Decision Register

> **GENERATED VIEW — NOT A SOURCE OF TRUTH.**
> Every decision below is owned by the document named in its Authority column. This file exists so a decision can be found by name; it never states a rule the authority does not.

| Field | Value |
|---|---|
| Status | Generated index |
| Generated against | spec v1.6.4, build plan v1.5, commit `77ff16c` |
| Authority | `docs/REKODA_CANONICAL_SPEC.md` and `docs/REKODA_END_TO_END_BUILD_PLAN.md` |

## Product and commercial

| ID | Decision | Authority |
|---|---|---|
| PROD-1 | Three products: Chat, Integrate, Complete. Boundaries are **exclusive** and enforced server-side | spec §3 |
| PROD-2 | Chat **creates** payment details; delivering them into a customer thread requires Integrate, therefore Complete | spec §3.1 |
| PROD-3 | Integrate is **WhatsApp-native first**; the storefront is an additional surface | spec §3.2 |
| PROD-4 | Complete is an entitlement pair over one BusinessId, not a third data model | spec §3.3 |
| COMM-1 | Launch prices ₦9,900 / ₦19,900 / ₦29,900 are **candidates**, versioned and effective-dated | spec §30 |
| COMM-2 | No commercial price is hardcoded in application logic | spec §30 |
| **COST-1** | Rekoda's own provider costs use an immutable `PlatformCostEvent` subledger. **No second corporate GL in V1.** Renamed from D1, which is the Dashboard slice | spec §29 |

## Financial integrity

| ID | Decision | Authority |
|---|---|---|
| FIN-1 | A screenshot creates `PaymentEvidence`, never a `Payment` | spec §6.1, journeys C8 |
| FIN-2 | `initialConfirmationSource` is set once and never overwritten | spec §6.3 |
| FIN-3 | `PaymentVerification` and its revocation are append-only; uniqueness lives in a mutable claim projection | spec §6.5 |
| FIN-4 | Revocation invalidates evidence and **never** moves money | spec §6.6 |
| FIN-5 | `confirmationIntegrity = NEEDS_REVIEW` when no active verification remains; it resolves two ways and no third | spec §6.7 |
| FIN-6 | Trust is derived from events minus valid revocations, never stored | spec §6.8 |
| FIN-7 | `MANUAL_RECONCILIATION` requires a real external transaction, an actor and a reason | spec §6.9 |
| FIN-8 | Input medium never proves attestation | spec §6.10 |
| FIN-9 | Posted journals are immutable; drafts are a separate table pair | spec §9 |
| FIN-10 | Financial-event idempotency at the ledger via `postingKey` | spec §9.4 |
| FIN-11 | Recognition is event and ledger-state driven. The cumulative formula that double-counted contract liability is **superseded** | spec §12.2 |
| FIN-12 | A contract-asset case posts **nothing** and raises `REQUIRES_REVIEW` | spec §12 |
| FIN-13 | Tax point is separate from revenue recognition | spec §13 |
| FIN-14 | Six distinct concepts: credit note, goods return, refund, overpayment refund, payment reversal, chargeback | spec §14.3 |
| FIN-15 | One full reversal per allocation, mirrored exactly | spec §14.2 |
| FIN-16 | A receipt acknowledges a payment; it is not the allocation statement | spec §15 |
| FIN-17 | Journal lines carry functional amounts; FX snapshot required when currencies differ | spec §16 |
| FIN-18 | Post-settlement chargeback credits `PROVIDER_CHARGEBACK_PAYABLE`, a liability | spec §21 |
| FIN-19 | A bank credit proves movement, not purpose | spec §22 |
| FIN-20 | Weighted average; a customer return re-enters at original issue cost and **then** moves the average | spec App. B |

## Architecture

| ID | Decision | Authority |
|---|---|---|
| ARCH-1 | Stack frozen: TypeScript, NestJS, Drizzle, PostgreSQL, existing frontend and queue. **No .NET** | spec §1.3 |
| ARCH-2 | Canonical names map to physical tables rather than renaming 51 migrations' worth of schema | spec §1.4 |
| ARCH-3 | Every ingress converges on one command layer | spec §25 |
| ARCH-4 | `IdempotencyRecord` and transactional `OutboxEvent` | spec §26 |
| ARCH-5 | Accounts carry scoped system roles with typed scope columns, not a polymorphic id | spec §11 |
| ARCH-6 | Four independent `PaymentConnection` statuses | spec §17.1 |
| ARCH-7 | Three provider ports: payment, financial feed, payout | spec §18 |
| ARCH-8 | `EconomicFeeBearer` separate from adapter-specific `ProviderFeePayer` | spec §19 |
| ARCH-9 | Public API is a separate commercial entitlement; contracts never expose Drizzle shapes | spec §27 |
| ARCH-10 | Embed deferred; no second backend | spec §28 |
| ARCH-11 | Conversation identity: `conversationKind`, scoped participant hash, versioned key | spec App. F |
| ARCH-12 | Participant hash key scoped to `(businessId, channelAccountId, version)` so identities cannot correlate across merchants | spec App. F.4 |

## Privacy, risk and enforcement

| ID | Decision | Authority |
|---|---|---|
| PRIV-1 | Reasoning models receive tokenised context, always | spec App. C.3 |
| PRIV-2 | Approved specialist processors may receive raw images for **transcription only**, under terms excluding training, with a DPA and no retention | spec App. C.2 |
| PRIV-3 | The AI boundary is enforced in **both** directions by `check-boundaries.mjs` and fails CI | spec App. C.4 |
| PRIV-4 | Evidence retention is resolution-based; unresolved claims expire | spec §23 |
| RISK-1 | Three tiers; the tier lives on the command so no ingress can soften it | spec App. D |
| RISK-2 | The away assistant may never autonomously execute a high-risk command, including one performed manually before | spec App. D |

## Superseded

Kept visible so nobody re-derives them.

| Superseded | By | Where marked |
|---|---|---|
| ADR 0004 chart of accounts as a fixed constant | Business-scoped `Account` rows with scoped roles | spec §11 |
| ADR 0014 Recorded vs Verified (`verified` boolean) | Confirmation source, verification events, derived trust | spec §6 |
| `contractLiability = (received + receivableRaised) − earned` | Event and ledger-state driven recognition | spec §12.2 |
| `CHARGEBACK_RECEIVABLE` | `PROVIDER_CHARGEBACK_PAYABLE` | spec §21 |
| `verified` as a generated column | Trigger-maintained compatibility column | plan PR-009 |
| Partial indexes on `WHERE revoked_at IS NULL` | `PaymentVerificationClaim` projection | spec §6.5 |
| `MERCHANT_ATTESTED_CASH` / `_TRANSFER` as source values | `MERCHANT_ATTESTED` + independent `paymentMethod` | spec §6.2 |
| Blanket `orderId` on every AR line | Source-appropriate subledger dimensions | spec §12.3 |
| A customer return cannot move the moving average | It moves it, and must | spec App. B |
| Invoice status as one enum | Lifecycle, payment status, collection status, aging | spec App. E.3 |
