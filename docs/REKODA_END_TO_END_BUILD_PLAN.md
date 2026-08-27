# Rekoda End-to-End Build Plan

| Field | Value |
|---|---|
| Status | **APPROVED — EXECUTION PLAN** |
| Version | 1.7 (v1.6.6 implementation consistency) |
| Effective date | 25 August 2026 |
| Governs | `docs/REKODA_CANONICAL_SPEC.md` v1.6.6 |
| Total slices | 20 |
| Baseline PR plan | **120**, target range 105&ndash;130 |

This is the dependency-safe route from the repository as it exists today to a production-ready Rekoda. It is not a wish list and it is not a backlog. Every entry has a completion gate, and a slice is finished when its gate passes and not before.

---

## 1. Repository reality

Established by inspection, not from memory. This is the baseline the plan is written against.

### 1.1 What is CORRECT and must be preserved

| Area | Evidence |
|---|---|
| Modular monolith, TypeScript / NestJS / Drizzle | `apps/api`, `packages/db`, `packages/core`, `packages/contracts` |
| Row-level security, double-enforced, with `rekoda_app` and `rekoda_worker` roles | migration 0004; `packages/db/src/testing.ts` refuses to run as superuser |
| `withBusiness` transaction pinning | `packages/db/src/client.ts` |
| Boundary rule: no raw `db` imports outside `packages/db` | `scripts/check-boundaries.mjs` |
| Double-entry ledger in integer kobo, append-only by convention | `packages/core/src/ledger.ts`, ADR 0004 |
| Privacy gateway and identity vault | `packages/core/src/vault.ts`, ADR 0021 |
| In-schema job queue with advisory-lock claiming | `apps/api/src/jobs/`, ADR 0022 |
| Bank feed: connections, statement lines, line matches | migrations 0036, 0037, 0045 |
| Command draft confirmation transition | `conversations.ts:294` — the proof R0A-i depends on |
| Fifty-one applied migrations, all reproducible from zero | `packages/db/migrations` |

### 1.2 What is DRIFTED and must be repaired

| Area | Reality today | Canonical | Repaired by |
|---|---|---|---|
| Chart of accounts | A 17-key TypeScript constant. **No `accounts` table exists.** `ledger_entries.account` is a text key. | Business-scoped `Account` rows with scoped system roles | F1 |
| Journal | `ledger_transactions` / `ledger_entries`. No drafts, no posting purpose, no immutability triggers | Draft pair plus immutable authoritative pair | F1 |
| Accounting periods | `businesses.books_closed_through`, a single text column | An `accounting_periods` table | F1 |
| Currency | No currency on any ledger row. NGN implied throughout | Functional and transaction currency with FX snapshots | F1 |
| Recognition | Revenue posts with the invoice. No contract liability, no receivable policy | The recognition engine of spec §12 | F1 |
| Payment provenance | `payments.verified` integer plus `method` text | Five confirmation sources and an independent `paymentMethod`; an immutable `initialConfirmationSource`; append-only verifications and revocations; trust and `confirmationIntegrity` derived, never stored | R0A-ii |
| Payment evidence | Does not exist. A screenshot that produced a payment produced a `Payment` | `PaymentEvidence`, separate and never a payment | R0A-ii |
| `PaymentConnection` | One blended `status` with nine values plus `kyc_status` | Four independent statuses plus derived `productionEnabled` | P1 |
| Entitlements | Five plan ids, five metered units, hardcoded in `packages/core/src/allowances.ts` | Two product entitlements, seventeen metered units, all data | E1, BL2 |
| Application layer | Financial logic in controllers and job handlers calling repos directly | One command layer, every ingress converging on it | A1 |
| Idempotency and outbox | Neither exists | Both, plus ledger-level `postingKey` | A1, F1 |
| Fee bearer | A `fee_policy` column on the connection | `EconomicFeeBearer` split from `ProviderFeePayer` | P1 |
| Settlement | Amounts on the payment row; a polling sweep | `Settlement` / `SettlementItem` / `SettlementComponent` | P2 |
| Reconciliation | `reconciliations` matches internal expectations only | Four tiers, with the bank feed as an independent source | B1 |
| **Conversations** | **`UNIQUE (businessId, channel)` — literally one thread per business per channel** (`ops.ts:41`, migration 0006) | One merchant thread per business and channel, plus one customer thread per channel account and participant | **PR-058a-1 … -5** |
| Public API | Contracts exist for internal use only | Separately entitled, versioned public surface | API-D |

### 1.3 Open work carried forward

Fix-plan 7 slices **H7c through H7g** remain paused and are folded into S1 (PR-108). Task 40, the legal pages, remains owner-blocked on six real business facts and is not an engineering dependency.

---

## 2. Build order

Preserved as approved. Where the order below differs from a naive reading, the reason is given.

```
W0        Meta readiness                                    parallel, owner-driven
R0A-i     Legacy payment provenance investigation           read-only
R0A-ii    Payment evidence and trust migration              BLOCKED, see §7
R0B       Ledger integrity and privacy truth
E1        Entitlements, pre-cost gating, risk tier
A1        Application command layer, idempotency, outbox
F1        Accounting Kernel I
P1        Payment Hub
W1/W2     Merchant WABA connection and messaging            parallel after E1/A1
P2        Paystack platform model and settlements
P3        Mono DirectPay, OPay, Kuda adapters
B1        Financial feeds and reconciliation
F2        Accounting Kernel II
W3        Native WhatsApp commerce
W4        Away assistant
X1        Complete cross-product experience
D1        Dashboard and accountant experience
BL2       Billing, pricing, usage, cost model, margin
S1        Production hardening
API-D     Developer platform
EMBED     Later, separate approval
```

**No dependency changed.** What did change is the *scope* of the R0A block, because the earlier wording contradicted the PR graph: PR-022 depends on PR-003, and PR-011 depends on PR-003, so "A1 and R0B continue in full" could not have been true while PR-003 was blocked.

The block is therefore stated precisely, and narrowly:

```
BLOCKED until the R0A-i production report is approved
  PR-006   historical provenance backfill
  PR-007   remediation
  PR-008   readers cutover
  PR-009   verified retirement
  PR-115   verified column drop

NOT BLOCKED
  PR-003   additive PaymentEvidence / PaymentVerification schema   (empty tables)
  PR-004   nullable source columns, no writers                     (no data)
  PR-005   correct confirmation source on NEW payments             (no history)
```

The rule, in one sentence:

> **No historical provenance assignment, backfill, remediation cutover or destructive cleanup until R0A-i is approved.** Not: no additive schema whatsoever.

PR-005 is the one worth arguing for rather than merely permitting. Every day it is not deployed, the unknown population grows. It does not manufacture historical trust; it stops the problem getting larger while history is being investigated.

---

## 3. Slice detail

Each slice states what the build plan requires of it. PR-level detail for the first ten is in §9.

---

### W0 — Meta readiness

| | |
|---|---|
| **Objective** | Obtain everything Meta must grant before Integrate can run on a merchant's own WABA. |
| **Canonical sections** | spec §24 |
| **Current state** | Direct Meta integration for Chat exists (ADR 0002, 0017). Tech Provider status, App Review and Advanced Access are not held. |
| **Target state** | Tech Provider approved; **Advanced Access granted for the scopes Embedded Signup documents as requiring it (`business_management`, `whatsapp_business_management`)**, and `whatsapp_business_messaging` separately approved and configured for messaging; Embedded Signup prerequisites met; coexistence capability confirmed; **billing mode confirmed** as one of `MERCHANT_DIRECT`, `REKODA_CREDIT_LINE`, `PARTNER_BILLED`. |
| **Dependencies** | None. Runs in parallel from day one. |
| **Schema / commands / endpoints / jobs / frontend** | None. This slice ships no code. |
| **Tests** | None. |
| **Rollout / flags / rollback** | n/a |
| **Doc updates** | Spec §24 billing mode becomes CORRECT rather than OPEN COMMERCIAL. |
| **Completion gate** | Written Meta confirmation of Advanced Access for the scopes Embedded Signup requires, messaging capability approved and configured, and a recorded billing-mode decision. Do not assert that Meta requires Advanced Access to all three for Embedded Signup unless the current App Review surface says so. |
| **PRs** | 0 engineering PRs. Owner action. |
| **Complexity** | Low engineering, high calendar risk. |

---

### R0A-i — Legacy payment provenance investigation

| | |
|---|---|
| **Objective** | Establish, from evidence, what can and cannot be known about every historical payment. |
| **Canonical sections** | §6, §7 |
| **Current state** | The classifier is written and corrected (spec §7.1). It runs clean against the real schema. It has never been run against production. |
| **Target state** | An approved production report: provenance distribution, naira totals, remediation queue, receipt and allocation exposure, unknown-provenance population. |
| **Dependencies** | None. |
| **Schema** | None. Read-only. |
| **Tests** | The script's own execution is the test. |
| **Rollout** | Run against a production read replica or the primary in a read-only transaction. |
| **Completion gate** | The owner has reviewed the report and made a remediation decision for the `LEGACY_PROVENANCE_UNKNOWN` population. |
| **PRs** | PR-001, PR-002 |
| **Complexity** | Low. |

---

### R0A-ii — Payment evidence and trust migration

| | |
|---|---|
| **Objective** | Give every payment an honest provenance, and give evidence somewhere to live that is not a payment. |
| **Canonical sections** | §6, §7, spec §23 |
| **Current state** | `payments.verified` integer and `payments.method` text. No evidence table, no verification table. A screenshot that produced a payment produced a `Payment` row. |
| **Target state** | `PaymentEvidence`, append-only `PaymentVerification` and its revocation event exist; every payment carries an immutable `initialConfirmationSource` and a `paymentMethod`; trust is derived from active verification events and never stored; `verified` is retired. |
| **Dependencies** | **R0A-i approval blocks PR-006 onward.** PR-003, PR-004 and PR-005 are not blocked; see §2. |
| **Schema** | `payment_evidence`, `payment_verifications`, `payment_verification_revocations`, `migration_manifests`, `migration_manifest_items`; `payments.initial_confirmation_source`, `payments.payment_method`, `payments.evidence_basis`; evidence retention columns per spec §23. |
| **Commands** | `RecordPaymentEvidence`, `AddPaymentVerification`, `RevokePaymentVerification` (HIGH_RISK, spec Appendix D), `ConfirmPayment` extended. |
| **Endpoints** | Remediation queue read and resolve. |
| **Jobs** | Evidence retention sweep; unresolved-TTL expiry. |
| **Frontend** | Remediation queue; evidence viewer with retention state. |
| **Tests** | Every source round-trips; no code path writes `MERCHANT_ATTESTED` without a recorded confirmation; a bank line cannot actively verify two payments; a revoked verification frees its line; `initialConfirmationSource` cannot be changed once set; expired evidence purges raw media and keeps the fact. |
| **Migration** | Additive → writers → backfill → cutover → cleanup. Five PRs, deliberately. |
| **Rollout** | Flag `provenance_reads` defaults off; readers dual-source until cutover. |
| **Rollback** | Every step before cutover is reversible by disabling the flag. After cleanup, rollback is a restore. |
| **Completion gate** | Zero payments with a null `initialConfirmationSource`; remediation queue empty or explicitly accepted; `verified` has no writers and is trigger-maintained only. |
| **PRs** | PR-003 … PR-009 |
| **Complexity** | High. Historical data, live money. |

---

### R0B — Ledger integrity and privacy truth

| | |
|---|---|
| **Objective** | Make the append-only ledger append-only in the database, not by convention, and make retention claims true. |
| **Canonical sections** | §9, §10, spec §23 |
| **Current state** | The ledger is append-only because nothing updates it. Grants are not proven by test. Retention sweeps exist (task 52). |
| **Target state** | `UPDATE` and `DELETE` on `ledger_transactions` and `ledger_entries` are revoked from `rekoda_app` and `rekoda_worker`, and a test proves the revocation. Retention claims on `/privacy` match what the sweep does. |
| **Dependencies** | PR-010 has none and is safe to start now. **PR-011 depends on PR-003**, because evidence retention needs somewhere to retain evidence; it is unblocked by the narrow reading in §2. |
| **Schema** | Grant changes only for PR-010; retention columns for PR-011. |
| **Tests** | A test that attempts an UPDATE as `rekoda_app` and asserts it is refused. A test that asserts every published retention period has a sweep that enforces it. |
| **Completion gate** | Both tests green in CI. |
| **PRs** | PR-010, PR-011 |
| **Complexity** | Low, high value. |

---

### E1 — Entitlements, pre-cost gating, risk tier

| | |
|---|---|
| **Objective** | Make product boundaries a server-side fact, and stop money leaving before authorisation. |
| **Canonical sections** | §3, §4 |
| **Current state** | Five plan ids with hardcoded allowances over five units. Integrate is gated by an allowance of zero rather than by entitlement. |
| **Target state** | `REKODA_CHAT` and `REKODA_INTEGRATE` as first-class entitlements, checked in the command layer; seventeen metered units; message categories metered separately; the four ordering rules of spec §4.3 enforced and tested. |
| **Dependencies** | None on R0A-ii. **Safe to start now.** |
| **Schema** | `entitlements`, `business_entitlements`, expanded `usage_counters` units. |
| **Commands** | An entitlement guard in the command dispatcher. |
| **Frontend** | Visibility rules; downgrade messaging. |
| **Tests** | **A Chat-only business cannot reach any Integrate capability through any ingress.** A refused request consumes no allowance and dispatches no provider call. **Every ingress enforces the same risk tier for the same command — Chat, Dashboard, Storefront and background automation are asserted individually, so no front door gets a cheaper path. The away assistant is refused every `HIGH_RISK` command, including ones the merchant has performed manually before.** |
| **Rollout** | Additive; entitlements derived from existing plan id until BL2 makes them data. |
| **Completion gate** | The cross-product refusal suite passes for every command, from every ingress. |
| **PRs** | PR-012 … PR-018, including PR-017a |
| **Complexity** | Medium. |

---

### A1 — Application command layer, idempotency, outbox

| | |
|---|---|
| **Objective** | One place where financial logic lives, so that every later slice has somewhere to put its logic and the public API needs no second implementation. |
| **Canonical sections** | spec §25, spec §26 |
| **Current state** | Logic in `inbound-message.handler.ts` (1,500+ lines), `shop.controller.ts`, `reports.controller.ts`, calling repos directly. |
| **Target state** | Fourteen named commands; `IdempotencyRecord`; `OutboxEvent` written in the same transaction as the state change; every ingress a thin adapter. |
| **Dependencies** | E1 for the entitlement guard. **PR-022, and therefore PR-027 and PR-028, depend on PR-003.** Under the narrow block of §2 that is not a wait; under a strict block A1 could start but not finish, and the plan says so rather than claiming A1 continues "in full". |
| **Schema** | `idempotency_records`, `outbox_events`. |
| **Jobs** | Outbox dispatcher. |
| **Tests** | Replaying any command with the same idempotency key returns the first response and writes nothing. An outbox event and its state change commit or roll back together. **`scripts/check-boundaries.mjs` gains two mirrored rules: AI adapters may not import financial repositories or the accounting engine, and domain or accounting code may not import a provider SDK — spec Appendix C.4 fails a build rather than a review. Adapter fail-closed test: the reasoning-model adapter REFUSES an outgoing request carrying a known raw protected field, with an error rather than a silent redaction, because a silently redacted prompt returns a confidently wrong answer. Observability test: processor, model, purpose, tokenisation status and policy version are recorded; the prompt, the completion and every protected field are not.** |
| **Rollout** | Command by command, each behind a flag, old path retained until its command is proven. |
| **Rollback** | Flag flip returns to the old path, per command. |
| **Completion gate** | No financial write occurs outside the command layer, proven by a boundary check in CI. |
| **PRs** | PR-019 … PR-028 |
| **Complexity** | High. Large refactor of live paths, no behaviour change intended. |

---

### F1 — Accounting Kernel I

The largest slice. Twenty-two PRs, because it replaces the foundation everything else stands on while the books stay readable throughout.

| | |
|---|---|
| **Objective** | A real chart of accounts, a real journal, real periods, real currency, and a recognition engine. |
| **Canonical sections** | §8–§12, §16 |
| **Current state** | See §1.2. The kernel is a constant and two tables. |
| **Target state** | `Account` rows with scoped system roles; `JournalDraft` pair; invariant triggers; `accounting_periods`; functional and transaction currency with FX snapshots; the recognition engine with all five cases as tests; `CustomerCredit`; append-only allocations. |
| **Dependencies** | A1 (`PostJournal` needs the command layer). |
| **Schema** | `accounts`, `journal_drafts`, `journal_draft_lines`, `accounting_periods`, `exchange_rate_snapshots`, `customer_credits`, `customer_credit_applications`, `revenue_recognition_events`; columns on `ledger_transactions` and `ledger_entries`. |
| **Migration** | The account cutover is the single riskiest sequence in the plan: additive column → dual write → backfill → validate → readers cutover → drop text column. Five PRs, and they must not be combined. |
| **Tests** | Every invariant of §10 has a test that proves the trigger refuses. All five recognition cases post exactly the journals of spec §12.4. **A refused contract-asset case leaves NO journal at all, proven by asserting zero rows, and produces a review item carrying `reviewReason = UNSUPPORTED_CONTRACT_ASSET` and the full source context. Replay test: re-running the same events against an engine that supports contract assets clears the item deterministically.** Collection and aging are never stored as independently mutable columns; any projection is suffixed as such, carries its computed-at timestamp and has an exercised rebuild path. Inventory invariants hold after every movement and the costing path uses exact arithmetic throughout. A stale or unavailable FX rate refuses the posting rather than falling back to today's rate. **Calendar tests:** a Sunday transaction correctly uses Friday's published rate under the configured `ExchangeRateSelectionPolicy` and is not treated as stale; a rate published AFTER the requested timestamp is never substituted; no valid rate within policy yields `RATE_UNAVAILABLE` and `REQUIRES_REVIEW`. The golden fixture v1 ties. |
| **Rollout** | Flag `kernel_v2_reads`. Statements dual-computed and compared in CI before cutover. |
| **Rollback** | Reversible until PR-034 drops the text column. |
| **Completion gate** | Golden fixture v1 ties across GL, trial balance, P&L, balance sheet and AR. Historical statements are byte-identical before and after cutover. |
| **PRs** | PR-029 … PR-050 |
| **Complexity** | Very high. |

---

### P1 — Payment Hub

| | |
|---|---|
| **Objective** | A provider-neutral payment model with honest connection state. |
| **Canonical sections** | §17, spec §19 |
| **Current state** | One blended `status`; `fee_policy` on the connection; intents exist. |
| **Target state** | Four independent statuses; provider-neutral attributes; connection-scoped clearing accounts; `EconomicFeeBearer` split from `ProviderFeePayer`; `PaymentCharge`. |
| **Dependencies** | F1 for the scoped account mechanism. **P1 does not move ahead of F1** — F1 defines the mechanism and seeds only BUSINESS-scoped accounts; P1 provisions the connection-scoped ones. |
| **Schema** | Status columns and backfill; `payment_charges`; `provider_capabilities`. |
| **Tests** | A connection can be operationally healthy and commercially suspended. Two connections never share a clearing account. Provisioning is idempotent. |
| **Completion gate** | Every live connection has correct four-way status derived from its old blended value, verified row by row. |
| **PRs** | PR-051 … PR-057 |
| **Complexity** | High. Live money paths. |

---

### W1/W2 — Merchant WABA connection and messaging

| | |
|---|---|
| **Objective** | The merchant's own WABA, connected by them, routed by us. |
| **Canonical sections** | spec §24 |
| **Dependencies** | E1 and A1 for gating and commands. **W0 for Meta approvals.** Runs in parallel with F1 and P1. |
| **Schema** | `waba_connections`, `waba_templates`, service-window state, **and the conversation model migration of PR-058a-1 … -5**. |
| **The blocker PR-058a-1 … -5 removes** | The repository has `uniqueIndex('conversations_business_channel_ux').on(t.businessId, t.channel)` with the comment "One thread per business per channel". Correct for merchant ↔ Rekoda Chat, where there is exactly one thread. It **cannot represent** a merchant WABA carrying Ada, Chidi, Bola and fifty thousand others, so Integrate is structurally impossible until it changes. |
| **Why five PRs and not one** | This is the same shape of migration the rest of the plan refuses to do in one go, and it is riskier than most: every existing conversation row and every message reader depends on the current shape, so a mistake breaks Chat while building Integrate. It follows the standard pattern of §10. |
| **Tests** | An unknown `phoneNumberId` is refused, never guessed. Template category is chosen at send time and metered to the right unit. |
| **Completion gate** | A merchant completes Embedded Signup and receives a message on their own WABA, metered correctly. |
| **PRs** | PR-058, **PR-058a-1 … PR-058a-5**, PR-059 … PR-062 |
| **Complexity** | Medium, gated by W0. |

---

### P2 — Paystack platform model and settlements

| | |
|---|---|
| **Objective** | Settlement truth from the provider, not from a rate card. |
| **Canonical sections** | spec §20, spec §21 |
| **Dependencies** | P1, F1. |
| **Schema** | `settlements`, `settlement_items`, `settlement_components`, `chargebacks`. |
| **Tests** | Settlement reconciles to gross payment. A post-settlement chargeback credits a payable, never a receivable. Recovery clears the payable as a settlement deduction. |
| **Completion gate** | Definition-of-done invariant 5 holds against real settlement data. |
| **PRs** | PR-063 … PR-067 |
| **Complexity** | High. |

---

### P3 — Mono DirectPay, OPay, Kuda adapters

| | |
|---|---|
| **Objective** | Provider neutrality proven by having more than one provider. |
| **Canonical sections** | §17, §18 |
| **Dependencies** | P1, P2. Each adapter is **OPEN COMMERCIAL** on its own terms. |
| **Tests** | The resolver picks a provider from capability and compliance, never from a hardcoded default. Each adapter's identifiers are connection-scoped. |
| **Completion gate** | Two providers pass the same conformance suite. |
| **PRs** | PR-068 … PR-072 |
| **Complexity** | Medium each; parallelisable. |

---

### B1 — Financial feeds and reconciliation

| | |
|---|---|
| **Objective** | Prove that a bank credit is never assumed to be revenue. |
| **Canonical sections** | spec §22 |
| **Current state** | Bank feed tables and matching exist; `reconciliations` matches internal expectations only. |
| **Dependencies** | F1, P2. |
| **Tests** | **The golden test of spec §22.2 is mandatory and blocking.** |
| **Completion gate** | Definition-of-done invariant 11 holds. |
| **PRs** | PR-073 … PR-076 |
| **Complexity** | Medium-high. |

---

### F2 — Accounting Kernel II

| | |
|---|---|
| **Objective** | Everything a real set of books needs that F1 deliberately deferred. |
| **Canonical sections** | §8, §13, §14, §15 |
| **Dependencies** | F1. Tax is **OPEN COMPLIANCE**. |
| **Schema** | Bills, tax model, returns with `disposition` (RESALABLE / DAMAGED / QUARANTINED / SCRAPPED), credit notes, recurring, opening balances, document projections. |
| **Return tests** | A RESALABLE return posts `DR Inventory Asset / CR COGS` at the ORIGINAL issue cost and then moves the average. A DAMAGED, QUARANTINED or SCRAPPED return **never enters sellable stock**, and a zero-value return is not admitted to make a quantity balance. Salvage records the supported value with the difference as a named inventory loss. Physical quantity and financial valuation are asserted separately. |
| **Completion gate** | **The complete golden business fixture ties across all eleven outputs of spec §32.** |
| **PRs** | PR-077 … PR-085 |
| **Complexity** | High. |

---

### W3 — Native WhatsApp commerce

| | |
|---|---|
| **Objective** | The Integrate journey of spec §3.2, on the merchant's own WABA. |
| **Dependencies** | W1/W2, P1, F1, E1, **and P2 for the transactional payment path**. |
| **Payment-path rule** | W3's transactional flow requires **at least one production-ready `PaymentProvider` path on the canonical `PaymentConnection` architecture, with authoritative verification and settlement accounting.** For V1 that is Paystack, which is P2. Native WhatsApp commerce must not be born on the old merchant-key path. |
| **Tests** | The customer's message never sets a price. Stock is validated server-side before any figure is shown. |
| **Completion gate** | An end-to-end order from catalogue to receipt in the merchant thread, with correct accounting. |
| **PRs** | PR-086 … PR-089 |
| **Complexity** | High. |

---

### W4 — Away assistant · X1 — Complete · D1 — Dashboard and accountant

| Slice | Objective | Dependencies | PRs |
|---|---|---|---|
| W4 | The assistant answers when the merchant cannot, within configured limits, and hands off cleanly. | W3 | PR-090, PR-091 |
| X1 | Cross-product journeys that produce one record, not two. | W3, F1, P1 | PR-092, PR-093 |
| D1 | Accountant users, statements on the kernel, customer and supplier statements, receipt separated from statement, exports. | F1, F2 | PR-094 … PR-098 |

---

### BL2 — Billing, pricing, usage, cost model, margin

| | |
|---|---|
| **Objective** | Prices become data, and Rekoda can see its own margin. |
| **Canonical sections** | spec §29, spec §30 |
| **Dependencies** | E1, F1. |
| **Schema** | `plan_versions`, `plan_prices`, `allowance_versions`, `add_ons`, `usage_packs`, `platform_cost_events`. |
| **Tests** | A price change does not alter a historical charge. A grandfathered business keeps its pinned plan version. |
| **Completion gate** | No commercial price appears in application logic. Margin reconstructs per merchant from `PlatformCostEvent`. |
| **PRs** | PR-099 … PR-103 |
| **Complexity** | Medium. |

---

### S1 — Production hardening · API-D — Developer platform

| Slice | Objective | Dependencies | PRs |
|---|---|---|---|
| S1 | Observability over financial events, load and performance, security review, runbooks and a recovery drill, plus the paused fix-plan 7 slices H7c–H7g. | Everything | PR-104 … PR-108 |
| API-D | Keys and auth, versioned contracts, Merchant API v1, webhooks, entitlement and metering, developer docs and sandbox. | A1, E1, F1, F2 | PR-109 … PR-114 |

**EMBED** is deferred and requires separate approval. No PRs are allocated.

---

## 4. Executive build summary

| Measure | Value |
|---|---|
| Total slices | 20 (plus EMBED, deferred) |
| Minimum safe PR count | 72 |
| **Baseline PR plan** | **120** (114 + PR-115 + PR-058a-1 … -5 split five ways) |
| **Working range** | **105 – 130** |
| Maximum sensible PR count | 165 |
| Likely serial PRs | 78 |
| Likely parallelisable PRs | 37 |
| PRs blocked pending the R0A-i report | 5 |
| PRs externally blocked | 18 |
| PRs safe to start now | 24 |
| Migration-heavy PRs | 21 |

### 4.1 The count is a baseline, not a completion requirement

**120 is the current baseline plan, not a target.** During implementation an L PR will occasionally prove to need two, two S PRs will occasionally prove safely mergeable, and a provider may invalidate a planned adapter outright. None of those is a deviation from the plan; they are the plan meeting reality.

```
FROZEN                          NOT FROZEN
canonical behaviour             the arithmetic count of pull requests
financial invariants            whether PR-069 is one PR or two
slice gates                     whether two S PRs merge together
migration safety
dependency correctness
```

Splits keep the parent identifier and gain a suffix — `PR-069a`, `PR-069b` — so a reference made today still resolves in six months. Merges keep the lower identifier and the higher one is recorded as merged rather than reused. **Every split or merge is recorded in this document**, which is what keeps the index a map rather than a memory.

Seventy-two is genuinely safe: group additive schema with its first inert writer, merge the three provider adapters, fold interface work into its feature. The argument against it is not review comfort. It is that **seventeen pull requests touch historical financial data**, and each needs a revert point that does not also revert a feature. Beyond 165 the review overhead exceeds the benefit and context is lost between PRs that should have been read together.

### 4.2 Highest-risk five

| Rank | PR | Why |
|---|---|---|
| 1 | **PR-032** Backfill `account_id` for every historical ledger row | Touches every financial row ever written. A wrong mapping silently changes historical statements. |
| 2 | **PR-006** Historical payment provenance migration | Assigns trust to money that has already been reported to merchants. Irreversible in perception even if reversible in data. |
| 3 | **PR-033** Readers cutover to `account_id` | Every statement, export and report at once. A regression here is visible to every merchant simultaneously. |
| 4 | **PR-039** Journal invariant triggers | A trigger that is even slightly too strict rejects legitimate writes on live paths and stops the business. |
| 5 | **PR-051** `PaymentConnection` status backfill | Derives four statuses from one blended value on live money paths. A wrong derivation disables collection for a real merchant. |
| 6 | **PR-058a-2 / -3 / -4** Conversation migration | Every conversation row and every message reader depends on the current one-thread-per-channel shape. Getting it wrong breaks Chat while building Integrate, which is why it is five PRs rather than one. |

Each of these requires a dry run against a production clone before merge. That requirement is part of their completion contract and is not optional.

---

## 5. Dependency graph

### 5.1 Strictly serial

```
R0A-i ──▶ PR-006 ──▶ PR-007 ──▶ PR-008 ──▶ PR-009 ──▶ PR-115
          (PR-003, PR-004, PR-005 are NOT behind this gate — §7)
A1 ──▶ F1 ──▶ P1 ──▶ P2 ──▶ P3
F1 ──▶ F2 ──▶ D1
F1 ──▶ B1
W1/W2 ──▶ W3 ──▶ W4
W1/W2 + P2 ──▶ W3            the transactional payment path, not merely P1
W3 + F1 + P1 ──▶ X1
E1 + F1 ──▶ BL2
everything ──▶ S1
```

Inside F1 the account cutover is strictly serial and must not be parallelised:

```
PR-029 ──▶ PR-030 ──▶ PR-031 ──▶ PR-032 ──▶ PR-033 ──▶ PR-034
```

And two F1 convergence points that the earlier index understated:

```
PR-035 ┐
PR-036 ├──▶ PR-039      every invariant the trigger enforces needs its schema first:
PR-037 │                account lifecycle, periods, currency, FX
PR-038 ┘

PR-034, PR-035, PR-036, PR-038, PR-039, PR-040, PR-042, PR-046…049 ──▶ PR-050
                        PR-050 is the F1 GATE. It certifies the kernel, so it
                        cannot merge before the kernel it certifies exists.
```

### 5.2 Parallel

```
W0                     from day one, alongside everything
R0B                    alongside E1
E1 ∥ A1                after their first two PRs each
W1/W2 ∥ F1 ∥ P1        after E1 and A1 complete
PR-069 ∥ PR-070 ∥ PR-071    the three adapters
PR-003 ∥ PR-010            both safe to start immediately
D1 ∥ BL2               after F2
```

### 5.3 Dependency kinds

| Kind | Example | Consequence |
|---|---|---|
| **Engineering** | F1 before P1 | Cannot be worked around. Reordering breaks the build. |
| **Commercial** | Kuda adapter before Kuda is live | Code may be written and merged behind a flag. Enabling it is blocked. |
| **Compliance** | Tax engine before tax review | Schema and calculator may be built. Any compliance claim is blocked. |
| **Meta approval** | W1/W2 before Advanced Access | Integration may be built against test numbers. Production is blocked. |
| **Migration** | PR-033 before PR-032 completes | Ordering is absolute; a partial backfill read as complete corrupts statements. |

---

## 6. External blockers

| Blocker | Blocks | What continues meanwhile |
|---|---|---|
| **Meta Advanced Access** (`business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`) | Production W1/W2, W3, W4 | All of W1/W2 against test numbers; routing, templates, service window, health |
| **Meta Tech Provider status** | Embedded Signup in production | The Embedded Signup flow itself, against a test app |
| **Meta billing mode** | Final BL2 unit economics | Every other part of BL2; the cost model with the mode as a parameter |
| **Paystack commercial confirmation** | P2 production enablement | All of P2 in test mode; settlement ingestion against sandbox data |
| **Mono production terms** | PR-069 enablement | The adapter, the conformance suite, the feed integration |
| **OPay production access** | PR-070 enablement | The adapter and its tests |
| **Kuda regulatory and commercial approval** | PR-071 enablement | The adapter and its tests |
| **Tax review** | Any statutory-compliance claim | The full tax model, calculator and `TaxEvent` (PR-078, PR-079) |
| **Fiscalisation review** | `FiscalisationProvider` enablement | The port definition |
| **R0A-i report approval** | PR-006 through PR-009 and PR-115 only (§7) | PR-003, PR-004, PR-005; all of R0B, E1 and A1; F1 planning. 24 PRs of work that does not wait. |

> **An external blocker never freezes safe engineering.** Every blocked capability is built behind a disabled flag and enabled when the blocker lifts. What a blocker prevents is *enabling*, not *building*.

---

## 7. What R0A-i blocks, precisely

The static investigation is complete and its semantics are corrected. That is not the same as having the answer.

```
local database  ≠  production data
```

The local database is the truncated integration-test database. It is empty by construction and has produced no counts. The corrected report must be run against production and must produce:

```
distribution by confirmation source     naira totals
remediation queue                       receipt and allocation exposure
unknown-source population
```

### 7.1 The block, stated once and precisely

> **No historical provenance assignment, backfill, remediation cutover or destructive cleanup until the R0A-i production report is approved.**

| PR | Status |
|---|---|
| PR-003 additive evidence and verification schema | **not blocked** — empty tables manufacture nothing |
| PR-004 nullable source columns, no writers | **not blocked** — no row changes |
| PR-005 correct source on new payments | **not blocked** — no history is touched |
| PR-006 historical backfill | **BLOCKED** |
| PR-007 remediation | **BLOCKED** |
| PR-008 readers cutover | **BLOCKED** |
| PR-009 `verified` retirement | **BLOCKED** |
| PR-115 `verified` column drop | **BLOCKED** |

An earlier draft of this plan blocked all additive schema and then separately claimed that A1 and R0B could continue in full. Both could not be true: PR-022 depends on PR-003 and so does PR-011. The narrow block above resolves the contradiction in the direction that also happens to be correct on the merits — **PR-005 shrinks the unknown population every day it is deployed**, so delaying it makes the problem this block exists to contain strictly larger.

## 8. Release gates

A gate is a set of conditions, not a date. Nothing ships through a gate that is amber.

| Gate | Conditions |
|---|---|
| **Accounting Tier 1** | All fourteen invariants of spec §31 hold. Golden fixture v1 ties. Every §10 invariant has a trigger and a test proving refusal. Historical statements byte-identical across the F1 cutover. |
| **Rekoda Chat** | Every §5.1 journey passes end to end. A screenshot never produces a payment. Corrections are reversing journals. Entitlement refusal proven from the chat ingress. |
| **Rekoda Integrate** | Every §5.2 journey passes. Order validated server-side. The customer's message never sets a price. Receipt delivered in the merchant thread. Meta Advanced Access granted. |
| **Rekoda Complete** | X1 cross-product journeys produce exactly one financial record per economic event. One identity space, one ledger, one set of statements. |
| **Payment Hub** | Four independent connection statuses correct for every live connection. Clearing accounts connection-scoped and idempotently provisioned. Fee bearer split proven against a real provider. |
| **Reconciliation** | The spec §22.2 golden test passes. All four tiers implemented. No AI-proposed match applies without deterministic logic or a human. |
| **Financial feeds** | Connection-scoped identity on every provider identifier. Duplicate import is a no-op. Invariant 11 holds. |
| **Pricing engine** | No commercial price in application logic. A price change leaves historical charges unaltered. Grandfathering proven. |
| **Meta / WABA** | Advanced Access for all three scopes. Per-WABA templates. Categories metered separately. Unknown `phoneNumberId` refused. |
| **Storefront** | Storefront orders converge on `PlaceOrder`. Abuse ceilings hold (fix-plan 7 H7b, merged). |
| **Developer API readiness** | Public contracts expose no Drizzle shapes. Every endpoint calls a command. API metering and entitlement enforced. Versioning policy published. |
| **Production hardening** | Financial-event tracing in place. Load targets met. Security review closed. Recovery drill executed against a real restore. H7c–H7g closed. |

---

## 9. PR master index

Identifiers are stable. Refer to a PR by its identifier for the remainder of the programme.

Size: **S** narrow and reviewable · **M** normal · **L** large but acceptable · **XL** must be split. **No PR in this index is XL.**

| PR | Slice | Title | Migr | Risk | Depends | Size | Status |
|---|---|---|---|---|---|---|---|
| PR-001 | docs | Canonical spec and end-to-end build plan | no | low | — | M |
| PR-002 | R0A-i | Provenance classifier corrected to evidence-only | no | low | — | S |
| PR-003 | R0A-ii | `PaymentEvidence` and append-only `PaymentVerification` schema | **yes** | med | — | M | ✅ **MERGED** |
| PR-004 | R0A-ii | `initialConfirmationSource` and `paymentMethod`, nullable, no writers | **yes** | med | PR-003 | S | ✅ **MERGED** |
| PR-005 | R0A-ii | Confirmation source and verification on new payments | no | med | PR-004 | M | ✅ **MERGED** |
| PR-006 | R0A-ii | Historical provenance backfill from the approved report | **yes** | **high** | PR-005 | L |
| PR-007 | R0A-ii | Remediation queue: add verifications, never rewrite | no | med | PR-006 | M |
| PR-008 | R0A-ii | Readers cutover: trust level derived from provenance | no | **high** | PR-007 | M |
| PR-009 | R0A-ii | Retire `verified` writers; column becomes trigger-maintained | **yes** | med | PR-008 | S |
| PR-010 | R0B | Revoke UPDATE and DELETE on ledger tables, with proof tests | **yes** | med | — | S | ✅ **MERGED** |
| PR-011 | R0B | Evidence retention TTL, expiry sweep and legal holds | **yes** | med | PR-003 | M | ✅ **MERGED** |
| PR-012 | E1 | Entitlement schema, additive | **yes** | low | — | M | ✅ **MERGED** |
| PR-013 | E1 | Entitlement resolver and single server-side gate | no | med | PR-012 | M | ✅ **MERGED** |
| PR-014 | E1 | Metered units expanded to the canonical seventeen | **yes** | med | PR-012 | M | ✅ **MERGED** |
| PR-015 | E1 | Pre-cost gating for AI, OCR and transcription | no | med | PR-013 | M | ✅ **MERGED** |
| PR-016 | E1 | Message-category metering: utility, marketing, auth, service | **yes** | med | PR-014 | M | ✅ **MERGED** |
| PR-017 | E1 | UI visibility rules and plan-switch impact review | no | low | PR-013 | M | ✅ **MERGED** |
| PR-017a | E1 | Shared command risk policy and high-risk confirmation | **yes** | **high** | PR-013 | L | ✅ **MERGED** |
| PR-018 | E1 | Cross-product refusal suite: no plan reaches another's capability | no | low | PR-013 | S | ✅ **MERGED** |
| PR-019 | A1 | Command layer skeleton and `IdempotencyRecord` | **yes** | med | PR-013 | L | ✅ **MERGED** |
| PR-020 | A1 | `OutboxEvent` and the dispatcher job | **yes** | med | PR-019 | M | ✅ **MERGED** |
| PR-021 | A1 | Commands: `RecordSale`, `IssueInvoice` | no | **high** | PR-019 | L | ✅ **MERGED** |
| PR-022 | A1 | Commands: payments and evidence | no | **high** | PR-021, PR-003 | L | ✅ **MERGED** |
| PR-023 | A1 | Commands: `RecordExpense`, `RecordPurchase` | no | med | PR-021 | M | ✅ **MERGED** |
| PR-024 | A1 | Commands: `PostJournal`, `ClosePeriod` | no | med | PR-021 | M | ✅ **MERGED** |
| PR-025 | A1 | Command: `PlaceOrder` | no | med | PR-021 | M | ✅ **MERGED** |
| PR-026 | A1 | Commands: `IngestFinancialTransaction`, `ConfirmReconciliation` | no | med | PR-021 | M | ✅ **MERGED** |
| PR-027 | A1 | Ingress rewiring: chat handler | no | **high** | PR-021…026 | L | ✅ **MERGED** |
| PR-028 | A1 | Ingress rewiring: dashboard and storefront | no | **high** | PR-027 | L | ✅ **MERGED** |
| PR-029 | F1 | `accounts` table, scoped roles, typed scope columns | **yes** | med | PR-024 | L | ✅ **MERGED** |
| PR-030 | F1 | Seed business-scoped accounts for every business | **yes** | med | PR-029 | M | ✅ **MERGED** |
| PR-031 | F1 | `ledger_entries.account_id` additive, dual write | **yes** | **high** | PR-030 | M | ✅ **MERGED** |
| PR-032 | F1 | Backfill `account_id` across all history, with validation | **yes** | **highest** | PR-031 | L | ✅ **MERGED** |
| PR-033 | F1 | Readers cutover to `account_id` | no | **highest** | PR-032 | L | ✅ **MERGED** |
| PR-034 | F1 | Cleanup: drop `ledger_entries.account` text | **yes** | med | PR-033 | S | ✅ **MERGED** |
| PR-035 | F1 | Account lifecycle: deactivation and mandatory-role replacement | no | low | PR-030 | M | ✅ **MERGED** |
| PR-036 | F1 | `accounting_periods` table, migrate `books_closed_through` | **yes** | med | PR-029 | M | ✅ **MERGED** |
| PR-037 | F1 | Journal currency columns, additive | **yes** | med | PR-031 | M | ✅ **MERGED** |
| PR-038 | F1 | `ExchangeRateSnapshot` and the FX requirement | **yes** | med | PR-037 | M | ✅ **MERGED** |
| PR-039 | F1 | Journal invariant triggers | **yes** | **high** | PR-035, PR-036, PR-037, PR-038 | L | ✅ **MERGED** |
| PR-040 | F1 | `postingKey`, `postingPurpose`, reversal uniqueness | **yes** | med | PR-039 | M |
| PR-041 | F1 | `JournalDraft` pair and the `PostJournal` command | **yes** | med | PR-040 | L |
| PR-042 | F1 | Posted-draft lock trigger | **yes** | low | PR-041 | S |
| PR-043 | F1 | Recognition engine in core, with the five golden cases | no | med | — | L |
| PR-044 | F1 | `ReceivableRecognitionPolicy` and contract liability | **yes** | med | PR-043, PR-030 | M |
| PR-045 | F1 | `RevenueRecognitionEvent` and its idempotency | **yes** | med | PR-044 | M |
| PR-046 | F1 | Recognition wired to orders, invoices and fulfilment | no | **high** | PR-045 | L |
| PR-047 | F1 | Proportional recognition on partial fulfilment | no | med | PR-046 | M |
| PR-048 | F1 | `CustomerCredit` subledger | **yes** | med | PR-044 | M |
| PR-049 | F1 | Append-only allocations with the full-reversal constraint | **yes** | med | PR-048 | M |
| PR-050 | F1 | Golden business fixture v1 — **the F1 convergence gate** | no | low | PR-034, PR-035, PR-036, PR-038, PR-039, PR-040, PR-042, PR-046…049 | L |
| PR-051 | P1 | `PaymentConnection` four statuses, additive and backfilled | **yes** | **high** | PR-029 | L |
| PR-052 | P1 | Provider-neutral connection attributes | **yes** | med | PR-051 | M |
| PR-053 | P1 | Connection-scoped clearing account provisioning | no | med | PR-052, PR-035 | M |
| PR-054 | P1 | `PaymentIntent` and `PaymentAttempt`, connection-scoped ids | **yes** | med | PR-052 | M |
| PR-055 | P1 | `PaymentVerification` wired into `ConfirmPayment` | no | med | PR-054, PR-022 | M |
| PR-056 | P1 | `EconomicFeeBearer` split from `ProviderFeePayer` | **yes** | med | PR-052 | M |
| PR-057 | P1 | `PaymentCharge` and the checkout breakdown | **yes** | med | PR-056 | M |
| PR-058 | W1/W2 | Embedded Signup and the WABA connection model | **yes** | med | PR-013 | L |
| PR-058a-1 | W1/W2 | Conversation: channel-neutral columns, additive | **yes** | med | PR-058 | M |
| PR-058a-2 | W1/W2 | Conversation: backfill existing threads as `conversationKind = MERCHANT` | **yes** | **high** | PR-058a-1 | M |
| PR-058a-3 | W1/W2 | Conversation: readers and writers onto the resolver, flagged | no | **high** | PR-058a-2 | L |
| PR-058a-4 | W1/W2 | Conversation: replace the broad unique, enable customer threads | **yes** | **high** | PR-058a-3 | M |
| PR-058a-5 | W1/W2 | Conversation: NOT NULL and cleanup, after soak | **yes** | low | PR-058a-4 | S |
| PR-059 | W1/W2 | `phoneNumberId` to `BusinessId` routing | no | **high** | PR-058 | M |
| PR-060 | W1/W2 | Per-WABA template registry | **yes** | med | PR-058 | M |
| PR-061 | W1/W2 | Service window and send-time category selection | no | med | PR-060, PR-016 | M |
| PR-062 | W1/W2 | Connection health and billing mode | **yes** | low | PR-059 | M |
| PR-063 | P2 | `Settlement`, `SettlementItem`, `SettlementComponent` | **yes** | med | PR-054 | L |
| PR-064 | P2 | Settlement ingestion with signed components | no | med | PR-063 | M |
| PR-065 | P2 | Settlement postings from actual provider data | no | **high** | PR-064, PR-053 | L |
| PR-066 | P2 | Chargeback and `PROVIDER_CHARGEBACK_PAYABLE` | **yes** | **high** | PR-065 | M |
| PR-067 | P2 | Refund and `PaymentReversal`, kept distinct | **yes** | med | PR-066 | M |
| PR-068 | P3 | `ProviderCapability` and `PaymentProviderResolver` | **yes** | med | PR-052 | M |
| PR-069 | P3 | Mono DirectPay adapter | no | med | PR-068 | L |
| PR-070 | P3 | OPay adapter | no | med | PR-068 | L |
| PR-071 | P3 | Kuda adapter | no | med | PR-068 | L |
| PR-072 | P3 | `ProviderCostSchedule` | **yes** | low | PR-068 | M |
| PR-073 | B1 | `FinancialAccountConnection` and connection-scoped identity | **yes** | med | PR-068 | M |
| PR-074 | B1 | Reconciliation tiers one to four | **yes** | med | PR-073 | L |
| PR-075 | B1 | Golden test: a bank credit is not revenue | no | low | PR-074 | M |
| PR-076 | B1 | Reconciliation and classification surface | no | med | PR-075 | L |
| PR-077 | F2 | Accounts payable and the bill lifecycle | **yes** | med | PR-050 | L |
| PR-078 | F2 | Tax model: codes, rates, treatments, point policies | **yes** | med | PR-050 | L |
| PR-079 | F2 | `TaxEvent` and the separated tax calculator | **yes** | **high** | PR-078 | L |
| PR-080 | F2 | Purchase lifecycle and goods returns | **yes** | med | PR-077 | L |
| PR-081 | F2 | Credit notes onto `CustomerCredit` | **yes** | med | PR-048 | M |
| PR-082 | F2 | Recurring entries on the kernel | no | low | PR-050 | M |
| PR-083 | F2 | Opening balances on the kernel | **yes** | med | PR-050 | M |
| PR-084 | F2 | Document projections on the kernel | no | med | PR-081 | L |
| PR-085 | F2 | Golden business fixture, complete | no | low | PR-077…084 | L |
| PR-086 | W3 | Catalogue synchronisation to the WABA | **yes** | med | PR-061 | L |
| PR-087 | W3 | Cart and order ingestion from WhatsApp | no | **high** | PR-086, PR-025, **PR-058a-4** | L |
| PR-088 | W3 | Server-side order validation and breakdown | no | **high** | PR-087, PR-057 | L |
| PR-089 | W3 | Payment and receipt in the merchant thread | no | med | PR-088, PR-055, **PR-065, PR-066** | L |
| PR-090 | W4 | Away assistant within configured limits | **yes** | med | PR-089 | L |
| PR-091 | W4 | Human handoff | no | low | PR-090 | M |
| PR-092 | X1 | Cross-product routing with single-record proof | no | **high** | PR-089, PR-050 | L |
| PR-093 | X1 | Send payment details, end to end across products | no | med | PR-092 | M |
| PR-094 | D1 | Accountant users and roles | **yes** | med | PR-013 | M |
| PR-095 | D1 | Statements version two on the kernel | no | **high** | PR-085 | L |
| PR-096 | D1 | Customer and supplier statements | no | med | PR-095 | L |
| PR-097 | D1 | Receipt separated from statement in the interface | no | low | PR-096 | M |
| PR-098 | D1 | Exports on the kernel | no | med | PR-095 | M |
| PR-099 | BL2 | `PlanVersion`, `PlanPrice`, `AllowanceVersion` | **yes** | med | PR-014 | L |
| PR-100 | BL2 | Hardcoded allowances migrated to data | **yes** | **high** | PR-099 | M |
| PR-101 | BL2 | Add-ons and usage packs | **yes** | med | PR-100 | M |
| PR-102 | BL2 | `PlatformCostEvent` — decision COST-1 | **yes** | med | PR-050 | M |
| PR-103 | BL2 | Margin engine and admin view | no | low | PR-102 | L |
| PR-104 | S1 | Observability over financial events | no | low | PR-050 | M |
| PR-105 | S1 | Load and performance | no | med | PR-095 | M |
| PR-106 | S1 | Security review and fixes | no | med | — | M |
| PR-107 | S1 | Runbooks and a real recovery drill | no | med | — | M |
| PR-108 | S1 | Fix-plan 7 remainder, H7c to H7g | no | med | — | L |
| PR-109 | API-D | API foundation: keys, authentication, rate limits | **yes** | med | PR-028 | L |
| PR-110 | API-D | Versioned public contract layer | no | med | PR-109 | L |
| PR-111 | API-D | Merchant API version one | no | med | PR-110 | L |
| PR-112 | API-D | Webhooks | **yes** | med | PR-110, PR-020 | L |
| PR-113 | API-D | API entitlement and metering | no | med | PR-111, PR-014 | M |
| PR-114 | API-D | Developer documentation and sandbox | no | low | PR-111 | M |
| PR-115 | S1 | Drop the `verified` compatibility column, after soak | **yes** | low | PR-009 + 2 releases | S |

---

## 10. Migration safety pattern

Any change to historical financial data follows five steps, in five separate PRs.

```
A  additive schema            new columns and tables, nullable, no writers
B  application dual write     new path writes both; readers still use the old
C  backfill and validation    history filled; a validation query proves equivalence
D  cutover                    readers switch, behind a flag, old path retained
E  cleanup                    old columns dropped, old path deleted
```

> **Destructive cleanup never shares a PR with the replacement architecture it depends on.** The exception is a table with no rows and no readers, where there is objectively nothing to lose.

Four sequences in this plan follow the pattern in full: R0A-ii provenance (PR-003 → PR-009), the F1 account cutover (PR-029 → PR-034), the conversation migration (PR-058a-1 → PR-058a-5), and the BL2 allowance migration (PR-099 → PR-101).

### 10.1 The conversation migration, step by step

Set out here because it is the one sequence a reader will reach for while Chat is live and every message path depends on the table being changed.

Expand, migrate, contract. The old constraint comes out **last**, after the new identity has been proven and soaked, and Chat stays operational at every step.

```
PR-058a-1   A. additive columns, all nullable (spec Appendix F.1)
            B. DUAL-WRITE the new identity on newly created conversations
               old unique untouched · nothing reads the new columns yet

PR-058a-2   C. backfill: derive channel account and participant ONLY where the
               evidence establishes them. Existing Chat threads become
               MERCHANT. Anything the data cannot establish becomes
               LEGACY_THREAD (spec App. F.8) — an honest third answer.
               DO NOT fabricate a participant. A blind index computed from a
               guess is indistinguishable from one computed from a fact.
            D. VALIDATE, against a production clone, before merge. Eight
               invariants, all blocking:
                 message count before  =  message count after
                 conversation-message ownership unchanged
                 no message orphaned
                 no two businesses become linkable
                 existing Chat resolves its historical thread
                 two customers on one merchant WABA give two distinct threads
                 the same customer on two merchant WABAs does not collide
                 an unknown phoneNumberId still refuses routing

PR-058a-3   E. install the replacement constraints ALONGSIDE the old one
            F. cut readers and writers to the new identity, behind a flag
               rollback is a flag flip; the old constraint still guards

PR-058a-4   G. soak
            H. drop UNIQUE (businessId, channel) LAST
               then enable CUSTOMER_COMMERCE threads

PR-058a-5   NOT NULL on what is now always populated, drop dead code
```

> **Do not drop the old constraint before the new identity is proven.** Between E and H the table carries both, which is deliberate: the old constraint is the safety net during cutover, and customer threads cannot be enabled until it is gone, so the ordering enforces itself.

Every stage has a rollback: 1 and 2 are additive, 3 is a flag flip, 4 is the only irreversible step and it runs after a soak.

**The replacement is two constraints, not zero**, and both are partial. The full model, including the `participantHashVersion` rotation path and the PostgreSQL NULL caveat, is canonical in **spec Appendix F**; PR-058a-1 … -5 implements it rather than deciding it.

```
MERCHANT   UNIQUE (businessId, channel) WHERE conversationKind = 'MERCHANT'
CUSTOMER   UNIQUE (businessId, channel, channelAccountId,
                   externalParticipantIdHash, participantHashVersion)
             WHERE conversationKind = 'CUSTOMER'
               AND externalParticipantIdHash IS NOT NULL
```

**Customer identity is opaque, scoped and versioned.** A keyed HMAC whose key material is scoped to `(businessId, channelAccountId, version)`, so the same person messaging two merchants produces two unrelated hashes and the index cannot correlate across businesses. `participantHashVersion` travels with it so the key can be rotated without stranding every thread. **A raw WhatsApp number must never become a permanent identity column on a table this size**, and it is never logged during lookup or routing. `phoneNumberId → BusinessId` routes the merchant's WABA and nothing else: **customer identity and WABA identity stay separate concepts.**

### 10.2 Blocking tests for the conversation migration

These are merge gates on PR-058a-2 through PR-058a-4, not a wish list. The migration changes infrastructure Chat depends on while enabling Integrate, so the Chat side is tested as hard as the new side.

```
REGRESSION, Chat must not move
  an existing Chat conversation still resolves
  its messages retain ordering and ownership
  no duplicate legacy rows appear

ISOLATION, tested through RLS as rekoda_app, not through application filters
  merchant A can never resolve merchant B's participant
  unknown phoneNumberId is refused, never guessed

SCALE AND IDENTITY, the shapes the old constraint made impossible
  one merchant holds 100+ customer conversations on one channel account
  the same customer reaches two different merchants
    → two UNRELATED blind indexes; the rows cannot be correlated
  key rotation V1 → V2
    → lookup resolves both, re-index completes, completeness PROVEN by count,
      and no Conversation.id changes, so no message relationship moves
  the same customer reaches one merchant through two channel accounts,
    resolving to the correct thread each time
```

---

## 11. Completion contract

Every PR states these before merge. A PR that cannot answer one of them is not ready.

```
□  all tests green, whole estate, serially
□  tenant isolation proven where the PR touches tenant data
□  migration dry-run against a production clone, where the PR migrates
□  accounting invariant tests pass, where the PR touches the kernel
□  backward compatible, or the incompatibility is named and flagged
□  feature flag state stated explicitly: default on, default off, or none
□  rollback understood and written down, not assumed
□  canonical documentation updated, or stated as unchanged
□  ADR added or amended where a decision changed
□  no secrets, no raw PII in logs, traces or error messages
□  observability available for whatever the PR introduces
```

And, per §12, every PR states:

```
canonical sections touched:  §…
build-plan slice and PR:     …
ADR changed:                 yes / no
documentation changed:       yes / no
```

---

## 12. Document maintenance

`REKODA_CANONICAL_SPEC.md`, this plan, the ADRs, the code and the tests stay synchronised. That is a hard requirement and it is checked at review.

When implementation discovers a real conflict:

```
stop  →  document the evidence  →  propose a correction
      →  receive approval       →  update the canonical source  →  continue
```

**Code does not silently become the source of truth.** A merged PR contradicting the specification is a defect in one of the two, and which one is a decision made deliberately and recorded.

---

## 13. First ten PRs in detail

These are the immediate execution queue on approval.

---

### PR-001 · Canonical specification and end-to-end build plan

- **Objective.** Establish the two permanent governing documents and stop architectural drift.
- **Repository areas.** `docs/REKODA_CANONICAL_SPEC.md`, `docs/REKODA_END_TO_END_BUILD_PLAN.md`. New files only.
- **Schema.** None.
- **Commands.** None.
- **Migrations.** None.
- **Tests.** None. Documentation.
- **Feature flags.** None.
- **Deployment sequence.** Merge to `main`. No deploy required.
- **Rollback.** Revert the commit.
- **Documentation.** This PR *is* the documentation. It supersedes v1.1 through v1.5 corrections and marks ADR 0004 and ADR 0014 as partially superseded.
- **Approval gate.** Owner approval of both documents.
- **Size.** M.

---

### PR-002 · Provenance classifier corrected to evidence-only

- **Objective.** Make the R0A-i investigation classify on evidence, so that the production run is trustworthy.
- **Repository areas.** `scripts/investigations/r0a-i-payment-provenance.sql`. Read-only SQL, no application code.
- **Schema.** None. The script writes nothing.
- **Commands.** None.
- **Migrations.** None.
- **Tests.** The script executes cleanly against the real schema; all five statements parse and run. Verified.
- **Feature flags.** None.
- **Deployment sequence.** Merge, then run against production in a read-only transaction.
- **Rollback.** Revert. Nothing was written.
- **Documentation.** Spec §7.
- **Approval gate.** Owner reviews the production output. **This is the gate that unblocks PR-006, and only PR-006 onward** (§7). PR-003, PR-004 and PR-005 do not wait on it.
- **Size.** S. *Status: complete, on branch `claude/session-task-plan-review-likv0v`.*

---

### PR-003 · `PaymentEvidence` and `PaymentVerification` additive schema

- **Objective.** Give evidence somewhere to live that is not a payment.
- **Repository areas.** `packages/db/migrations/0052_payment_evidence.sql`, `packages/db/src/schema/finance.ts`, `packages/db/src/repos/payments-hub.ts`.
- **Schema.** `payment_evidence` (business, customer, source, media reference, `resolutionState`, `resolutionDeadline`, `resolvedAt`, `rawPurgedAt`); five tables, and this is the PR where the permanent decisions get made:

  ```
  TENANT TABLES, RLS, business-scoped
  payment_evidence                    spec §6.1, spec §23, with the retention columns
  payment_verifications               spec §6.3, APPEND-ONLY, full column set
  payment_verification_revocations    spec §6.4, APPEND-ONLY, the compensating event
  payment_verification_claims         spec §6.5, MUTABLE projection, uniqueness only

  OPERATOR TABLES, NO RLS, migration role only
  migration_manifests                 id · name · cutoff_at · status
                                      · created_at · created_by
                                      · rolled_back_at? · rolled_back_by? · reason?
  migration_manifest_items            manifest_id · business_id · payment_id
                                      · old_initial_source? · new_initial_source?
                                      · verification_id?
  ```

  The manifest is **normalised, not an array**. One row holding hundreds of thousands of uuids is awkward to index, join, page and reason about during a rollback under pressure, which is exactly when it would be needed. Row-per-item scales at any historical volume, and each item carries its `business_id` so the audit record is tenant-attributable even though the manifest itself is not a tenant table.

  **The manifests are operator infrastructure, not merchant data.** A migration spans every tenant, so `migration_manifests` has no `business_id` and cannot honestly wear tenant RLS. It is owned by the migration role; `rekoda_app` and `rekoda_worker` are granted nothing at all — no `INSERT`, no `UPDATE`, no `DELETE`, and no `SELECT` unless a specific operational need is later argued and recorded. An earlier draft put all five behind tenant RLS, which was incoherent for a cross-tenant table with no tenant column.

  **The manifest is evidence, so it carries enough to prove what happened**: which migration, which version of the code, expected against actual row counts, when it started and finished, who ran it, and a checksum where one is practical. `expected_row_count` beside `affected_row_count` is what turns "the migration ran" into "the migration did what the approved report said it would". `item_set_checksum` goes further: it is a hash over the approved item set, so the population that ran can be **proven identical** to the population that was reviewed, rather than assumed identical because the counts matched. `approved_by` and `source_report_reference` tie the run back to the specific report somebody signed off. `prior_value` beside `assigned_value` on every item is what makes the rollback exact and the audit answerable.

  > **A historical migration audit record must survive its own rollback.** Rollback appends state; it never deletes the manifest or its items.

  Source idempotency, per spec §6.5, on the **claims** table, where every predicate reads a column of the table it indexes:

  ```
  UNIQUE (business_id, financial_transaction_id) WHERE financial_transaction_id IS NOT NULL
  UNIQUE (business_id, provider_source_identity) WHERE provider_source_identity IS NOT NULL
  UNIQUE (business_id, confirmation_event_id)    WHERE confirmation_event_id IS NOT NULL
  CHECK  exactly one claim key is populated
  ```

  > **The provider key is `provider_source_identity`, not `payment_attempt_id`.** `PaymentAttempt` does not arrive until **PR-054**, in P1, while **PR-005** must already record provider-verified payments correctly — roughly fifty PRs earlier. A claim keyed on a table that does not exist yet is not a constraint, it is a plan to have one.
  >
  > The identity is normalised from data the estate holds today: `businessId + paymentConnectionId + providerTransactionReference`. `payment_attempt_id` is added as a **nullable link** in PR-054 and never becomes the identity retrospectively, because changing an idempotency key after rows exist re-opens every window it was closing.

  **Claim lifecycle: row existence is the state.** No `status` column, no `RELEASED` row. Verifying inserts a claim; revoking deletes it, in the same transaction as the revocation event. A retained released row would be a mutable statement of something the immutable events already say, and the two could disagree.

  and on the event table:

  ```
  CHECK  (source <> 'LEGACY_PROVENANCE_UNKNOWN')
  ```

  > **SUPERSEDED.** An earlier draft predicated these indexes on `WHERE revoked_at IS NULL`. `payment_verifications` has no `revoked_at` — revocation is a separate table — and a partial-index predicate may reference only columns of the indexed table. It cannot see another table and cannot use a subquery. This was the sibling of the generated-column defect, and it is fixed the same way: the constraint moves to a table that actually holds the column.

  No foreign key from `payments` yet.
- **Commands.** None. No writers in this PR, deliberately.
- **Migrations.** Additive DDL only. No data writes.
- **Tests.** RLS isolation on the four tenant tables, proven as `rekoda_app`. `rekoda_app` and `rekoda_worker` have **no privileges at all** on either manifest table, proven by a refused SELECT. `UPDATE` and `DELETE` on both event tables are revoked from both application roles, with tests proving the refusal — append-only in the database, not by convention. Verification and claim are written in one transaction, in the canonical order — `INSERT PaymentVerification`, then `INSERT` its unique claim — and the unique violation on the claim is what makes a retry a no-op:

  ```
  on claim conflict:  ROLLBACK THE WHOLE TRANSACTION, then resolve
    same paymentId        idempotent retry. Return the existing verification.
    different paymentId    genuine conflict. Refuse and surface it.
  ```

  **No external work between those two writes** — no provider call, no queue publish, no outbox flush, no read outside the transaction. That window is the only place a duplicate can be born and the only safe width for it is zero. **Concurrency: two simultaneous attempts to claim the same `FinancialTransaction`, the same provider attempt reference, and the same confirmation event — exactly one succeeds in each pair, three separate tests.** A rolled-back transaction leaves neither a verification without its claim nor a claim without its verification. **Fail-closed test:** where claim integrity cannot be established the verification is REFUSED, never written hopefully. **Ordering test:** the forbidden claim-commit-then-verify-later shape is not reachable from any code path. **Source-identity test:** one `FinancialTransaction` cannot actively verify two Payments; a bank line settling several invoices produces ONE Payment with several allocations. **Integrity job tests:** each of the five inconsistency classes raises a HIGH severity alert — a verification with no claim row, two claim rows over one source identity, an invalid source identity, two payments on one authoritative source, and a claim row whose verification is revoked. **Reconstruction test:** the claim table rebuilt from verifications minus revocations matches the live table exactly. One bank line cannot actively verify two payments. Revoking deletes the claim row, so the same line can then verify the correct payment. Appending a fresh verification after an incorrect revocation succeeds, which is the correction path of spec §6.4. **Separation, three tests, spec §6.6–6.7:**
  ```
  attested + bank-verified → revoke the bank verification
      payment stays CONFIRMED · trust becomes ATTESTED · zero journal changes
  sole verification        → revoke it
      confirmationIntegrity = NEEDS_REVIEW · zero financial mutation
  explicit PaymentReversal → posted
      THE ACCOUNTING REVERSAL HAPPENS. Only this path moves money.
  ``` A verification with source `LEGACY_PROVENANCE_UNKNOWN` is refused by the CHECK. Migration applies from zero and is idempotent.
- **Why this is where it belongs.** PR-003 defines permanent, hard-to-change schema on a table that will hold financial trust. Adding revocation and idempotency later means migrating a populated append-only table, which is exactly the situation append-only makes expensive.
- **Feature flags.** None needed; nothing reads or writes these tables.
- **Deployment sequence.** Migrate, deploy. No behaviour change.
- **Rollback.** Drop all six tables. They are empty.
- **Documentation.** Spec §6.1, spec §23.
- **Approval gate.** None. Additive DDL with no writers and no readers manufactures no trust, so §2's narrow block does not cover it. **This is the change that unblocks PR-011 and A1's PR-022.**
- **Size.** M.

---

### PR-004 · Provenance columns on `payments`

- **Objective.** Give every payment somewhere to record how its truth was established.
- **Repository areas.** `packages/db/migrations/0053_payment_provenance.sql`, `packages/db/src/schema/finance.ts`.
- **Schema.** `payments.initial_confirmation_source` (nullable, CHECK against the five values of spec §6.2), `payments.payment_method` (nullable, CHECK against the eight values including `UNKNOWN`), `payments.evidence_basis` (nullable), `payments.payment_evidence_id` (nullable FK). `verified` untouched.
- **Set-once trigger.** A `BEFORE UPDATE` trigger enforces the immutability spec §6.3 claims: `NULL → value` is permitted exactly once; `value → different value` is refused. Immutable in the database, not in a comment.
- **The one exemption, made mechanical.** The trigger permits a reset only from inside a named function, and from nowhere else:
  ```
  rollback_provenance_manifest(manifest_id)   SECURITY DEFINER

  OWNERSHIP
    owned by a DEDICATED NON-LOGIN role, not by a human's account and not
    by the superuser. A SECURITY DEFINER function runs as its owner, so the
    owner IS the privilege boundary.

  PRIVILEGE
    REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC      explicitly, first
      PostgreSQL grants EXECUTE to PUBLIC by default. Not revoking is the
      single most common way a definer function becomes a public one.
    GRANT EXECUTE TO the migration/operator role ONLY
    never granted to rekoda_app or rekoda_worker

  INJECTION SURFACE
    SET search_path = rekoda_private, pg_catalog, pg_temp
      fixed on the function, and pg_temp LAST — a caller who can create a
      temporary object could otherwise shadow a referenced table
    every table, function and operator reference SCHEMA-QUALIFIED
    no dependence on the caller's search_path at any point

  SCOPE, validated by the function itself, not by its caller
    the manifest exists and its status is APPLIED
    rows touched are exactly this manifest's items
    a row changes ONLY where
        current value IS NOT DISTINCT FROM item.assigned_value
    otherwise SKIP the row and REPORT it

  AUDIT
    every invocation writes an audit event: operator, manifest, timestamp,
    rows affected, rows skipped, reason
  ```

  > **No generic bypass exists, and none may be added.** Not `bypass_immutability`, not `disable_trigger`, not `migration_mode` — no session flag, GUC or setting that application code could reach. The `initialConfirmationSource` exemption is reachable **only** through this named function. A general escape hatch is a permanent one, because the next person to need it will find it rather than justify a new one.

  The skip is the part that matters. An owner may legitimately have remediated a payment after the migration ran, and a rollback that overwrote their correction would be a second incident caused by fixing the first. Skipped rows are returned, counted and logged, never passed over in silence.

  > This is a **named, scoped exemption**, not a privileged bypass of the set-once trigger. There is no general-purpose function that can reset a confirmation source, and none may be added.
  Stated this way the exemption is a mechanism with a name, a grant and a scope, rather than "the owner can bypass the trigger". A superuser bypassing a trigger is not an exemption anybody designed; a function whose whole body is auditable is.
- **Commands.** None.
- **Migrations.** Additive. Every existing row keeps `provenance = NULL`, which is honest: nothing has been established yet.
- **Tests.** The CHECK refuses an unknown source and an unknown method. The trigger permits the first assignment and refuses the second, and a test proves remediation cannot reach the column. **Privilege tests:** `rekoda_app` executing `rollback_provenance_manifest` is DENIED; `PUBLIC` is DENIED; the migration role is allowed. **Search-path test:** a caller that creates a shadowing object in a schema earlier on its own `search_path`, and a temporary table shadowing a referenced name, both fail to redirect anything the function resolves — `pg_temp` is last and every reference is schema-qualified. **Cross-manifest test:** rows belonging to another manifest are refused, not merely skipped. **Bypass test:** no session setting, GUC or flag reachable from `rekoda_app` permits an `initialConfirmationSource` change; the named function is the only path. **Audit test:** every invocation writes an audit event naming operator, manifest, rows affected and rows skipped. **Scope tests:** only manifest rows are touched; a row whose current value differs from the manifest's assigned value is skipped and reported rather than overwritten, so post-migration merchant remediation survives the rollback intact. **Audit tests:** the rollback DELETEs no `payment_verifications` row and no manifest row — it appends revocations and marks the manifest `ROLLED_BACK`, leaving a complete auditable record of both the migration and its undoing. Existing payment tests unaffected.
- **Feature flags.** None.
- **Deployment sequence.** Migrate, deploy.
- **Rollback.** Drop the trigger and the four columns.
- **Documentation.** Spec §6.2.
- **Approval gate.** PR-003 merged. Not covered by the R0A block: nullable columns with no writers change no row.
- **Size.** S.

---

### PR-005 · Provenance writers on new payments

- **Objective.** Stop creating new payments whose provenance is unknowable, before backfilling the old ones.
- **Repository areas.** `packages/db/src/repos/settle.ts` (`bookVerifiedPayment`, `recordMerchantPayment`), `packages/db/src/repos/issue.ts` (`issueSale`), `apps/api/src/jobs/inbound-message.handler.ts`.
- **Schema.** None.
- **Commands.** Each writer sets `initialConfirmationSource` and writes one `PaymentVerification`: `bookVerifiedPayment` writes `PROVIDER_VERIFIED` with its attempt and provider reference; the chat confirmation path and the dashboard path both write `MERCHANT_ATTESTED` with the actor. **The instrument does not affect the source** — `paymentMethod` is normalised from the existing `method` column to `CASH`, `BANK_TRANSFER`, `POS` or `OTHER` and travels separately, so a POS payment no longer has to pretend to be a transfer. `verified` continues to be written unchanged.
- **Migrations.** None.
- **Tests.** Every writer sets a non-null provenance. **No path can write `MERCHANT_ATTESTED` without a confirmed draft or an authenticated actor** — this is the test that keeps spec §6.3 true. Existing behaviour is otherwise unchanged.
- **Feature flags.** None. Writing a new column that nothing reads is inert.
- **Deployment sequence.** Deploy. New payments carry provenance from that moment.
- **Rollback.** Revert. Rows written meanwhile keep a harmless extra column value.
- **Documentation.** Spec §6, spec §7.2.
- **Approval gate.** PR-004 merged.
- **Size.** M.

---

### PR-006 · Historical provenance backfill

- **Objective.** Assign honest provenance to every payment written before PR-005, and name the ones that cannot be assigned.
- **Repository areas.** `packages/db/migrations/0054_provenance_backfill.sql`, plus a validation script.
- **Schema.** None new. Data only.
- **Migrations.** The classifier of spec §7.1, applied as an UPDATE **scoped to the historical population and nothing else**. Rows failing every rung receive `LEGACY_PROVENANCE_UNKNOWN`. **The migration never invents a value.**
- **The cutoff, and why it is mandatory.** PR-005 is already writing correct sources on new payments by the time this runs. An unscoped statement would treat those rows as history.
  ```sql
  INSERT INTO migration_manifests (name, cutoff_at, actor)
  VALUES ('0054_provenance_backfill', :pr005_deployed_at, :actor)
  RETURNING id INTO :manifest;

  INSERT INTO migration_manifest_items (manifest_id, payment_id)
  SELECT :manifest, id FROM payments
   WHERE created_at < :pr005_deployed_at
     AND initial_confirmation_source IS NULL;

  UPDATE payments p SET initial_confirmation_source = ...
    FROM migration_manifest_items i
   WHERE i.manifest_id = :manifest AND i.payment_id = p.id;
  ```
  The manifest is the affected-row set, recorded permanently. It is what makes the rollback exact rather than approximate, and it is also the audit record of what this migration touched.
- **Verifications.** For every row it can establish, the migration writes one `PaymentVerification` alongside the source, so the append-only history starts populated rather than empty. Rows it cannot establish get `LEGACY_PROVENANCE_UNKNOWN` and **no** verification event, which is the honest representation of knowing nothing.
- **Tests.** The backfilled distribution matches the approved production report exactly, row count by row count. Re-running the migration changes nothing. No row moves from a stronger provenance to a weaker one or the reverse.
- **Feature flags.** None. Readers still use `verified`.
- **Deployment sequence.** **Dry run against a production clone first, with output compared to the approved report.** Then migrate in a maintenance window. Then deploy nothing.
- **Rollback.** Scoped to the manifest, never global:
  Entirely inside `rollback_provenance_manifest(manifest_id)`, and nothing is deleted:

  ```sql
  -- 1. append a revocation for every verification this migration wrote.
  --    the events stay append-only; the rollback is itself part of the history.
  INSERT INTO payment_verification_revocations
         (business_id, verification_id, reason, actor_id)
  SELECT v.business_id, v.id, 'MIGRATION_ROLLBACK', :actor
    FROM payment_verifications v
   WHERE v.source_migration = :manifest_name;

  -- 2. release the claims those verifications held
  DELETE FROM payment_verification_claims
   WHERE verification_id IN (SELECT id FROM payment_verifications
                              WHERE source_migration = :manifest_name);

  -- 3. reset the sources, joined through the manifest, never table-wide,
  --    and only where the current value is still what this migration assigned
  UPDATE payments p SET initial_confirmation_source = NULL
    FROM migration_manifest_items i
   WHERE i.manifest_id = :manifest
     AND i.payment_id = p.id
     AND p.initial_confirmation_source IS NOT DISTINCT FROM i.new_initial_source;

  -- 4. the manifest is MARKED, not deleted
  UPDATE migration_manifests
     SET status = 'ROLLED_BACK', rolled_back_at = now(),
         rolled_back_by = :actor, reason = :reason
   WHERE id = :manifest;
  ```

  > **Nothing is deleted, and that is the point.** A permanent audit record that a rollback erases is not an audit record. The manifest and its items survive with `status = ROLLED_BACK`, so the estate can always answer what this migration touched, what it set, when it was undone and by whom. And the verifications are revoked rather than deleted, because deleting an event from an append-only history to tidy up a rollback would make append-only a claim rather than a property.
  >
  > The step-3 guard matters as much as the scoping. If a merchant has since remediated a payment, its current value is no longer what the migration assigned, and the rollback leaves it alone.
  > **`UPDATE payments SET initial_confirmation_source = NULL` without a WHERE clause is forbidden.** It would erase the correct sources PR-005 has been writing since deployment, and it would do so silently. The unscoped form appeared in an earlier draft of this plan and is the reason the manifest exists.
- **Documentation.** Spec §7.5.
- **Approval gate.** The dry-run output matches the approved report, and the owner has signed off on the remediation decision for the unknown population.
- **Size.** L. **Highest risk in the programme after PR-032.**

---

### PR-007 · Remediation queue

- **Objective.** Let somebody act on the unknown-provenance population rather than leaving it as a number in a report.
- **Repository areas.** `apps/api/src/payments/`, `apps/web/src/app/app/payments/`, `packages/db/src/repos/payments-hub.ts`.
- **Schema.** None.
- **Commands.** `AddPaymentVerification` — a person adds a verification event. Which source it carries depends on what they actually have, and the command refuses the wrong one:
  ```
  they link a real bank line          → MANUAL_RECONCILIATION, financialTransactionId REQUIRED
  the merchant now attests receipt    → MERCHANT_ATTESTED, actorId REQUIRED
  ```
  **`initialConfirmationSource` is never touched.** A remediated payment keeps `LEGACY_PROVENANCE_UNKNOWN` as its origin forever, with the new verification beside it. Remediation adds evidence; it does not rewrite history (spec §6.5).
- **Endpoints.** Queue read; resolve.
- **Frontend.** A queue view, ordered by exposure: payments with receipts or allocations first, because those are the ones a merchant has already been told about.
- **Tests.** `MANUAL_RECONCILIATION` is refused without a `financialTransactionId` — this is the test that stops legacy remediation manufacturing external verification out of an opinion. `MERCHANT_ATTESTED` is refused without an actor. `initialConfirmationSource` is unchanged on every path. A resolved payment leaves the queue and never re-enters.
- **Feature flags.** `provenance_remediation`, default off until the queue is populated.
- **Deployment sequence.** Deploy, enable, work the queue.
- **Rollback.** Disable the flag. Resolutions already made are correct and stay.
- **Documentation.** Spec §6.2, spec §7.5.
- **Approval gate.** PR-006 merged and its distribution accepted.
- **Size.** M.

---

### PR-008 · Readers cutover to provenance

- **Objective.** Make provenance the truth that surfaces, and reduce `verified` to a legacy column.
- **Repository areas.** `packages/core/src/payments.ts`, `packages/db/src/repos/reports.ts`, `apps/api/src/reports/`, `apps/web/src/app/app/payments/`, receipt and statement rendering.
- **Schema.** None.
- **Commands.** Trust level (`EXTERNALLY_VERIFIED` / `ATTESTED` / `UNESTABLISHED`) is derived at read time from **the full set of verification events**, never from one column and never stored (spec §6.4).
- **Tests.** Every surface that said "verified" now says what was actually established. **A payment with no verification events must not be presented as verified anywhere.** A payment whose origin is `LEGACY_PROVENANCE_UNKNOWN` but which now carries a `BANK_FEED_MATCH` verification reads as externally verified, and its origin is still visible on the record. Receipt rendering for historical receipts is byte-identical, because a re-rendered receipt must not change what it said about a month already reported.
- **Feature flags.** `provenance_reads`, default off; enabled after the byte-identity check passes against production data.
- **Deployment sequence.** Deploy with the flag off; run the byte-identity comparison; enable.
- **Rollback.** Disable the flag. Readers return to `verified` instantly.
- **Documentation.** Spec §6.2, §15.
- **Approval gate.** Byte-identity confirmed on a sample of historical receipts and statements.
- **Size.** M. **Third-highest risk.**

---

### PR-009 · Retire `verified`

- **Objective.** Remove the column whose ambiguity started this.
- **Repository areas.** `packages/db/migrations/0055_retire_verified.sql`, the three payment writers, `packages/db/src/schema/finance.ts`.
- **Schema.** `payments.verified` writers removed; the trigger above installed; column privileges narrowed to SELECT. The column is kept for compatibility and dropped by **PR-115** after a soak of at least two releases. **It is not a generated column.**

> **SUPERSEDED — this design was impossible.** An earlier draft made `verified` a generated column derived from `payment_verifications`. PostgreSQL generation expressions may not use subqueries and may not reference any row but the current one, so a generated column cannot inspect another table at all. The migration would have failed at `ALTER TABLE`.

The valid mechanism is an ordinary column maintained by a controlled trigger:

```
payments.verified        ordinary integer column, no writers in application code
    ↑
AFTER INSERT OR UPDATE ON payment_verifications
AFTER INSERT ON payment_verification_revocations
    → recompute derived trust for the affected paymentId
    → set verified = 1 when EXTERNALLY_VERIFIED, else 0

legacy readers keep working, unchanged
application code cannot write the column: UPDATE on it is revoked
PR-115 drops it
```

A `payments_with_trust` view is the alternative where a reader can consume one without significant migration work. Either is valid; the trigger is chosen because it requires no change at the call sites, which is the whole purpose of a compatibility period.
- **Migrations.** Install the trigger, backfill `verified` once from the verification events, revoke the column's UPDATE privilege. No schema-shape change.
- **Tests.** No code path writes `verified`. The trigger-maintained compatibility value agrees with the derived trust level on every row, including after a revocation moves a payment back to `UNESTABLISHED`.
- **Straggling writers.** `UPDATE (verified)` is revoked from `rekoda_app` and `rekoda_worker`, so a writer nobody removed fails loudly while every reader carries on. That is what the generated-column design was reaching for and could not deliver.
- **Feature flags.** None. `provenance_reads` is on by now.
- **Deployment sequence.** Deploy writers-removed first, then migrate.
- **Rollback.** Drop the trigger, restore the privilege, restore the writers. The column was never anything other than an ordinary column, which is part of why this design is the safe one.
- **Documentation.** Spec §6; **ADR 0014 marked SUPERSEDED**, with a pointer to spec §6 rather than a silent overwrite.
- **Approval gate.** PR-008 enabled in production for one full week without a provenance-related incident.
- **Size.** S.

---

### PR-010 · Ledger append-only, enforced and proven

- **Objective.** Make the append-only ledger append-only in the database rather than by convention.
- **Repository areas.** `packages/db/migrations/0051_ledger_transactions_append_only.sql`, `packages/db/migrations/meta/_journal.json`, `packages/db/src/ledger-append-only.integration.test.ts`.
- **Schema.** `REVOKE UPDATE, DELETE ON ledger_transactions, ledger_entries FROM rekoda_app, rekoda_worker`.
- **Implementation finding.** `ledger_entries` was **already** protected by migrations 0001 and 0004. `ledger_transactions` was not: it took the broad `GRANT ... ON ALL TABLES` in 0001 and nothing revoked it. So the ledger was half append-only, and the unprotected half was the row carrying `memo`, `source_type`, `source_id`, `reverses_id` and `created_at` — everything about a posting except its figures. The migration closes that and re-states the entries revocation so a from-zero replay is correct whatever order the grants run in.
- **Commands.** None. Nothing updates the ledger today, which is exactly why this is safe and why it should have been done already.
- **Migrations.** Grant changes only.
- **Tests.** A test that connects as `rekoda_app`, attempts an UPDATE on a real ledger row, and asserts refusal. A second for DELETE. Both as the application role, never as owner, or the assertion is vacuous.
- **Feature flags.** None.
- **Deployment sequence.** Migrate. If any code path did update the ledger, it fails immediately and loudly, which is the desired outcome.
- **Rollback.** Re-grant. One statement.
- **Documentation.** Spec §9, §10. ADR 0004 amended: append-only becomes enforced rather than conventional.
- **Approval gate.** Full estate green. Any failure is a genuine discovery and is documented per §12 before proceeding.
- **Size.** S. **Highest value-to-effort ratio in the plan.**

---

## 14. What happens on approval

1. **PR-001** merges, carrying spec v1.6 and this plan.
2. **PR-002** merges. The corrected classifier runs against production; its output is reviewed.
3. *Immediately, in parallel, not waiting on step 2:*
   - **PR-010** ledger permission hardening — the best value-to-effort ratio in the plan
   - **PR-003**, **PR-004** additive evidence and source schema
   - **PR-005** correct confirmation source on new payments, which shrinks the unknown population daily
   - **PR-011** evidence retention, once PR-003 lands
   - **PR-012**, **PR-013** the entitlement foundation
4. **PR-006** unblocks on the owner's remediation decision, and not before.
5. **F1** begins once A1's command layer carries `PostJournal`. **PR-050 gates it closed.**

Failing tests first. One PR per slice step. A twenty-point impact map in, a twenty-point report out. Whole estate serially green before every merge.

---

## 15. Amendment log

| Version | Change |
|---|---|
| 1.0 | Initial plan, 114 PRs, canonical spec v1.5 |
| 1.1 | v1.6 patch. Recognition formula replaced (spec §12.2). Verification made append-only with sources preserved. POS normalised out of the source enum. `MANUAL_RECONCILIATION` narrowed to external evidence. PR-006 scoped to a migration manifest with an exact rollback. Posting roles completed. R0A block narrowed and the A1/R0B contradiction removed. W3 given its P2 payment-path dependency. PR-039 and PR-050 dependencies corrected. **PR-115 added** for the `verified` drop. Count reframed as a baseline of 115 within a 105–130 range. |
| 1.2 | v1.6.1 freeze hardening. **PR-009's generated-column design was impossible** and is replaced by a trigger-maintained compatibility column. PR-003 gains `PaymentVerificationRevocation`, source idempotency and normalised manifests. PR-004 gains the set-once trigger. PR-006's rollback becomes manifest-scoped. **PR-058a-1 … -5 added** for the conversation model (split five ways in 1.3). Spec gains Appendices A–E. AR/contract-liability dimensions narrowed. Contract-asset case rejected as `REQUIRES_REVIEW`. Chat/Complete boundary clarified. Baseline 116. |
| 1.3 | v1.6.2 pre-slice patch. **The idempotency indexes could not have been created** — a partial-index predicate cannot read another table — so uniqueness moves to a `PaymentVerificationClaim` projection and the event tables stay literally append-only. Revocation-of-revocation removed; an incorrect revocation is corrected by appending a fresh verification. Manifests reclassified as operator infrastructure with no tenant RLS, kept after rollback with `status = ROLLED_BACK`, and the rollback revokes rather than deletes. The set-once exemption becomes the named `rollback_provenance_manifest` SECURITY DEFINER function. **PR-058a-1 … -5 split into five sub-PRs**, with two replacement uniqueness rules and opaque customer identity. **Weighted-average returns corrected** — a return does move the average, and holding it fixed breaks quantity × average = value. Invoice status split into lifecycle, payment and collection. FX staleness measured against the requested accounting timestamp. Documentation drift cleaned. Baseline 120. |
| 1.4 | v1.6.3 implementation hardening. Verification revocation separated from payment reversal, with derived `confirmationIntegrity` (spec §6.6–6.7). Claim atomicity and per-source verification identity formalised, with concurrency tests. `rollback_provenance_manifest` hardened: fixed `search_path`, schema-qualified references, `REVOKE ... FROM PUBLIC`, value-guarded row skipping, privilege test. Manifests carry full migration evidence and survive rollback. Conversation migration resequenced as expand/migrate/contract with the old constraint dropped last, plus blocking Chat regression and RLS tests. Spec gains **Appendix F**: conversation identity, partial-index NULL caveat, `participantHashVersion` rotation. `orderId` demoted to a contextual dimension beneath generic `sourceType`/`sourceId`/`postingPurpose`. Contract-asset refusal made atomic. FX resolver returns named states. Inventory invariants and exact-arithmetic rule. AI boundary enforced by `check-boundaries.mjs`. Risk tiers bind every ingress. Invoice statuses marked derived. Readiness split into ARCHITECTURE_APPROVED / ENGINEERING_READY / PRODUCTION_ENABLEMENT_READY. **No new PRs; baseline stays 120.** |
| 1.5 | v1.6.4 corrections and consistency sweep. Six mandated corrections applied; most were already carried by 1.4 and are recorded here as confirmed rather than changed. Genuinely new: `actorType` renamed `conversationKind` (MERCHANT / CUSTOMER); **participant hash key material scoped to (businessId, channelAccountId, version)** so one customer cannot be correlated across merchants; backfill forbidden from fabricating customer participants for legacy merchant threads; customer identity and WABA identity declared separate concepts; AI boundary enforced in **both** directions, so domain and accounting code may not import provider SDKs either; away-assistant prohibition extended to destructive inventory adjustment and provider disconnect; `inventoryValue ≥ 0` and movement reconciliation added to the inventory invariants; `NEEDS_REVIEW` given exactly two permitted resolutions. Three new tests: explicit `PaymentReversal` produces the accounting reversal, `PUBLIC` cannot execute the rollback function, and the rollback DELETEs no verification or manifest row. Readiness states renamed to `ArchitectureApproval` / `EngineeringReadiness` / `ProductionEnablement` with worked examples. **Consistency sweep:** bare `§` references in the build plan qualified as `spec §` so they cannot be misread as build-plan sections; residual bare `PR-058a` references resolved to the five sub-PRs; the PR-069a/b split example marked illustrative. PR index verified at 120, matching the stated baseline. **No new PRs; no slice moved.** |
| 1.6 | v1.6.5 implementation hardening. **Every `SECURITY DEFINER` function** gains a dedicated non-login owner, `search_path = rekoda_private, pg_catalog, pg_temp` with `pg_temp` last, schema-qualified references, `REVOKE EXECUTE FROM PUBLIC`, operator-only grant, an audit event per invocation, and self-validated manifest scope; **no generic bypass flag may exist**. `PaymentVerificationClaim` reclassified as **non-authoritative but financially safety-critical**, fail-closed, with ACTIVE/RELEASED states and a HIGH-severity integrity job. Normalised per-source identities persisted, and one authoritative source verifies **one** Payment with several allocations. FX gains `ExchangeRateSelectionPolicy` with market calendar and publication time; a future rate is never substituted. Inventory returns gain RESALABLE / DAMAGED / QUARANTINED / SCRAPPED dispositions with physical quantity separated from valuation. Lifecycle may persist; collection and aging are derived, and any projection is named, timestamped and rebuildable. `reviewReason = UNSUPPORTED_CONTRACT_ASSET`, replayable. Reasoning adapter **fails closed** on raw protected fields, with content-free observability. Away-assistant prohibition moved to the authorization layer via `actorType = AUTOMATION`. Manifests gain `item_set_checksum`, `approved_by`, `source_report_reference`. Conversation identity: `participantBlindIndex` + `participantIndexKeyVersion` + `vaultedIdentityReference`, a provider conversation id is **advisory only**, and `LEGACY_THREAD` replaces fabricating a participant. **No new PRs; baseline stays 120; no dependency changed.** |
| 1.13 | **PR-017a merged.** Migration **0055**, `pending_confirmations`. Appendix D lands as three artefacts and one rule. The TIER TABLE is in `@rekoda/core`: every command with the tier it is born at, four conditional escalations for the Appendix D.2 entries that are a command in a particular shape rather than a command of their own (reconciliation override, destructive inventory adjustment, deactivating a mandatory-role account, a hand-posted journal), and context that can only ever RAISE a tier. **An unclassified command is `HIGH_RISK`**, because the failure mode of forgetting to classify something must be a command that is harder to run than it needs to be. The CONFIRMATION is a row, not a token: a token is bearer authority that survives copying and cannot be withdrawn, while a row is claimed by a single UPDATE carrying every binding in its WHERE, so two taps on a refund race into the database and one loses. Bound to tenant, actor, command, subject and ingress; a mismatched binding is reported as absent rather than named, because naming which binding failed tells a caller how to forge the next attempt. `reason` is NOT NULL with a non-blank CHECK, so Appendix D.3's "a missing reason is a refusal, not a blank field" is enforced by the column and not only by the service. The POLICY SERVICE takes a command NAME and never a tier: there is no parameter, allowlist or override by which an ingress could reach a softer answer, which is Appendix D.3's whole reason for putting the tier on the command. Every ingress is asserted individually and by name. **The away assistant is refused every `HIGH_RISK` command, including immediately after the merchant performed the identical action by hand**, and `awayAssistantMayExecute` takes no history parameter because that parameter is the mechanism by which an absolute rule stops being absolute. Erasure's exact-phrase requirement is modelled rather than flattened into a yes, and tested against the reply the product already sends. **Implementation finding, same class as PR-010:** migration 0001's `ALTER DEFAULT PRIVILEGES` grants DELETE on every new table to both application roles, so a new table needs REVOKE rather than GRANT; a declined confirmation is evidence and neither role may delete one. **Deliberately not in this PR:** per-command call sites. The policy is a shared service other slices call, and each command gets its gate in the PR that owns that command (A1 onward). |
| 1.14 | **PR-017 merged, on a canonical clarification the owner made first.** Implementation stopped and asked which half of the dashboard belonged to Chat, because spec §3.1 defines Chat as *conversational* operations ("the merchant messages Rekoda") while the public pricing page sold dashboard bookkeeping inside Chat. **Owner ruling: the dashboard is a shared merchant control plane, not owned by Chat and not a fourth product.** The product line is HOW an event enters Rekoda, never whether a merchant may see or maintain their own records. Spec gains **§3.2a**. An Integrate-only merchant keeps the whole dashboard and manual bookkeeping; what they do not get is the conversational interface. A Chat-only merchant keeps the same dashboard and gets no Integrate surface. Implemented as a CAPABILITY layer above the frozen three entitlements rather than new entitlement keys: shared capabilities need only a live plan, and `REKODA_CHAT` / `REKODA_INTEGRATE` carry the rest. Capabilities are checked, never routes. `/me` now returns the entitlements the server RESOLVED, so a support-issued `MANUAL_GRANT` is visible to the page exactly as the gate sees it, instead of the frontend re-deriving from a plan name. **Live defect fixed:** `apps/web/src/lib/plans.ts` still promised Integrate merchants "Everything in Chat", 800 processed messages and 60 voice minutes, all three refused by the gate since PR-013. PR-013 corrected `pricing-model.md` and missed the customer-facing page. Copy is now bound to enforcement by test: a plan card cannot promise a capability its entitlements refuse, and a quoted voice figure must equal what the meter would honour. The matcher for that had to be narrowed after it read "Invoices" as a voice promise. Plan changes are framed as a SWITCH with both directions shown before the price, because Chat to Integrate gains and loses, and nobody should learn what they gave up from a refusal a week later. |
| 1.15 | **PR-018 merged. E1 complete.** The suite asserts the MATRIX rather than the mechanism: every plan against every entitlement, both directions, by name, so a future plan or entitlement forces a decision rather than inheriting one. **The gap it found:** publishing a storefront compared PLAN NAMES (`plan !== 'trial' && plan !== 'integrate' && plan !== 'complete'`) while the order endpoint next door asked `requireEntitlement` for the same capability. Two doors, one question, two answers: a support-issued `MANUAL_GRANT` of `REKODA_INTEGRATE` was honoured when a customer placed an order and ignored when the merchant tried to publish the shop that order would have come from. Now entitlement-gated, with behaviour preserved exactly (trial holds `REKODA_INTEGRATE`) and the grant honoured. This is the shape spec §3.2a forbids — a product name, in a controller, deciding a capability — and it survived PR-013 because PR-013 gated the customer's side of the storefront and not the merchant's. Also asserted: a grant opens exactly one capability and no other, revoking closes it again, and one tenant's grant is never another's. |
| 1.16 | **PR-019 merged. A1 begins.** Migration **0056**, `idempotency_records`. **Repository evidence stated first, per §20:** migration 0042 is named `idempotency_keys` and is NOT spec §26's `IdempotencyRecord` — it is a handful of unique INDEXES an audit added to `products` and `subscription_charges` after finding two of them racing. Those stay; §26 asks for layered defence and they are the floor beneath this table. No canonical conflict. `response_snapshot` IS the state, so the three answers a caller can get are the three states a row can be in: absent, claimed, answered. The middle one is what an ad-hoc key check always misses — two identical requests in the same second is the ORDINARY case for a retrying client, and a design that only knows "seen" from "unseen" either runs both or tells the loser "done" with nothing in its hand. `request_hash` makes the key safe to trust: one key reused for a different payload is a client bug, and replaying the first answer would hide it behind something plausible, so it is a named refusal. The BUS fixes one order that is not arrangeable: entitlement, then risk tier, then idempotency, then the work, then the answer. Entitlement first because §4.3 rule 1 says a refused request consumes nothing, and that includes consuming a key the merchant then cannot retry with. Risk before the key so a command the away assistant may never run leaves no record suggesting it tried. The snapshot commits in the CALLER's transaction, so a command that fails after answering leaves nothing and the retry is a first attempt rather than a replay of something that never happened. `COMMAND_ENTITLEMENT` is deliberately separate from the risk table: "may this business do it at all" and "what does this demand before it acts" are different questions, and one table holding both would make a command that needs neither indistinguishable from one nobody classified. Most commands need no entitlement, which is spec §3.2a: the dashboard is shared and manual bookkeeping belongs to every plan. **Deliberately empty:** the bus runs no commands yet. A1 moves them one at a time behind a flag, and a dispatcher arriving with fourteen commands already inside it is a refactor nobody can review. |
| 1.17 | **PR-003 merged. R0A-ii begins; PR-011 and PR-022 unblocked.** Migration **0057**, not the 0052 the plan guessed: 0052 became the entitlements migration while R0A-ii waited, and the number is a sequence position rather than an identifier. Six tables, additive, no writers and no readers, no foreign key from `payments` yet. Four tenant tables under RLS; `payment_verifications` and `payment_verification_revocations` append-only by REVOKE rather than by convention. The claim projection keeps DELETE and needs it, because revoking DELETES the claim in the same transaction as the revocation event and that is what releases the evidence for a corrected verification; UPDATE it does not need, because a claim never changes what it claims. **The two manifest tables have NO RLS and the application roles are granted nothing at all** — not even SELECT. A migration spans every tenant, so `migration_manifests` has no `business_id` and cannot honestly wear a tenant policy; an earlier draft put all six behind one, which would have matched nothing and hidden the evidence from the operator holding the rollback. Proven by a refused SELECT from both roles. The manifest is normalised rather than an array, carries `expected_row_count` beside `affected_row_count` and an `item_set_checksum` so the population that ran can be proven identical to the population that was reviewed rather than merely as numerous, and survives its own rollback. `provider_source_identity` is the provider claim key, never `payment_attempt_id`: PaymentAttempt arrives in PR-054 while PR-005 must already record provider-verified payments correctly. Every partial-index predicate reads a column of the table it indexes, which is the only thing PostgreSQL accepts and the correction the superseded `WHERE revoked_at IS NULL` draft needed. Tests cover the four legal sources and the refusal of `LEGACY_PROVENANCE_UNKNOWN`, append-only on both event tables, one-source-one-payment on all three claim keys, three concurrency races with exactly one winner each, release-and-reclaim after revocation, revocation-once, blank reason or actor refused, tenant isolation on all four, and reconstruction of the live claim table from verifications minus revocations. |
| 1.18 | **PR-004 merged.** Migration **0058** (the plan guessed 0053; sequence moved on). Four nullable columns on `payments`, CHECKed against §6.2's five sources and eight methods; every existing row stays NULL, which is honest, and `verified` is untouched until PR-009. **Set-once is a database fact**: a `BEFORE UPDATE` trigger permits `NULL → value` once and refuses everything else for every writer that exists and every writer nobody has thought of — including a session that sets a made-up `migration_mode` GUC first, which is the bypass test the plan demanded. **The one exemption is the ROLE, not a flag**: `rollback_provenance_manifest` is SECURITY DEFINER, owned by `rekoda_provenance_owner` (NOLOGIN, BYPASSRLS — a manifest rollback spans every tenant and pins none), and the trigger's exemption branch consults `current_user` alone, so the only way into it is through the function. EXECUTE revoked from PUBLIC explicitly, granted to the migration role only; the application roles also hold no USAGE on `rekoda_private`, so they cannot even name the function. `search_path` fixed with `pg_temp` LAST and every reference schema-qualified — proven by a test that shadows `payments` with a temp table and watches the real row change anyway. **The skip is the point**: a row is restored only where its current value is exactly what the manifest assigned; a payment a human remediated after the migration is skipped, counted, returned and left intact, because overwriting their correction would be a second incident caused by fixing the first. Rollback appends: revocations inserted, claims released, manifest marked ROLLED_BACK with operator and reason, items and verifications never deleted, and a second rollback refused by the status machine. The rollback writes its own audit row in `rekoda_private` rather than in tenant-scoped `audit_events`, because a cross-tenant act cannot honestly wear a `business_id`. |
| 1.19 | **PR-005 merged. New payments stop being born unknowable.** The three writers R0A-i established — `bookVerifiedPayment`, `recordMerchantPayment`, `issueSale`'s paid branch — each stamp `initialConfirmationSource` at birth, normalise the instrument into `paymentMethod`, and append exactly one `PaymentVerification` with its claim through one shared function that enforces §6.5's canonical order: verification, then claim, same transaction, no external work between, fail-closed when the claim key count is not exactly one. Provider identity is `paymentConnectionId + providerTransactionReference` (falling back to `providerType` when a connection row is absent in degraded states), threaded from both call sites, and a second intent carrying the same provider transaction now aborts whole rather than booking the same money twice — a hole the reference index could not see because the references differ. `MERCHANT_ATTESTED + POS` is representable; the `method` column is untouched, PRESERVE. Two decisions recorded: **(1)** the dashboard claim identity is the form's one-shot `clientRef`, never the invoice number, because a second partial payment against one invoice is a second confirmation, not a retry — pinned by test; with no client key, the payment row itself stands as the action, keeping the claims/verifications bijection honest. **(2)** the plan's method list said `CASH, BANK_TRANSFER, POS or OTHER`; the adapter also emits `unknown`, and §6.2's semantics win: `unknown → UNKNOWN`, because OTHER claims we can name it and UNKNOWN claims we cannot, and an adapter that said `unknown` was making the second claim. Two test fixtures needed distinct draft ids per confirmation, which is what the product does — one draft, one yes, one attestation — and the reused-id shape they had is exactly what the new claim refuses. Actor semantics unchanged (chat `system`, dashboard the session actor): the chat path's authentication anchor is the confirmed draft, per the PR's own test clause. |
| 1.20 | **PR-011 merged. R0B complete.** Migration **0059**: `evidence_legal_holds` (dispute · investigation · tax_audit; active while `released_at IS NULL`; a release names who; DELETE revoked from both roles because the record that a hold existed is part of the dispute it protected), plus worker SELECT policies on `payment_evidence` and the holds — the `ops_read_businesses` shape of 0004: the worker SEES across tenants to discover what is due and mutates nothing; every write runs tenant-pinned on the app credential and RE-CHECKS what discovery saw, so a hold placed between the two is honoured. Two implementation defaults recorded rather than invented silently, since §23 fixes the mechanism but not the numbers: `evidenceResolutionDays = 14` (an unanswered claim EXPIRES, stamping `resolvedAt`, because an abandoned dispute is the most likely state for a claim) and `evidenceRawDays = 90` (raw media purged after resolution; the claim, amount and outcome survive under financial-record retention). §23 calls the deadline business configuration, so BL2 may move both to data. A NULL deadline is never due — nothing was promised about it. The sweep returns purged refs for the storage port rather than deleting objects itself: no writer stores evidence media until PR-022, and the order is pointer-then-object because an orphaned object is re-findable while a pointer to a deleted object is a claim that lies. `/privacy` gains the evidence row reading the same `RETENTION` constants the sweep enforces — the R0B completion gate that the page and the sweep cannot disagree. One driver find: `UPDATE … RETURNING` sees the post-update row, so the purged refs ride out through a self-join on the pre-update image. `sql` is now re-exported from `@rekoda/db` so no consumer imports drizzle directly. |
| 1.21 | **PR-020 merged.** Migration **0060**, `outbox_events` (the sequence moved past every number the plan could have guessed). Spec §26's shape lands exactly — `businessId · type · payload · occurredAt · dispatchedAt · attempts` — plus two mechanics the guarantees need: `locked_at`, the dispatcher's lease, and `max_attempts` (8), the dead-letter line. **Same-transaction is enforced by the API shape, not convention**: `outboxRepo.append` accepts only a `TenantDb`, so an event cannot exist without the caller's transaction and neither commits without the other — proved by commit/rollback atomicity tests. Delivery is at-least-once in arrival order: `claimBatch` leases with `FOR UPDATE SKIP LOCKED` ordered by `occurred_at`, two concurrent dispatchers deliver nothing twice (proved under `Promise.all`), a crashed dispatcher's lease is reclaimed after five minutes, and an event that fails `max_attempts` times goes VISIBLY dead via `deadEvents` rather than silently missing. Grants follow the estate's discipline: tenant RLS with a `worker_dispatch` ALL policy, app-side UPDATE/DELETE revoked (the application appends; only the dispatcher works the table), worker DELETE revoked (dead events are an alarm, not litter). `OutboxDispatcher` (apps/api) starts with an EMPTY registry on purpose — event types arrive with the commands that emit them, PR-021 onward, each registering its handler in the PR that creates its type; an unhandled type fails and retries so a rolling deploy hands it to a newer worker, and a duplicate registration throws at wiring time. It rides the pump's two-second clock in `jobs.module.ts` WITHOUT the advisory-lock leader election the sweeps use, deliberately: the lease already makes concurrent dispatchers safe, so every replica drains and adding workers speeds delivery instead of wasting passes. `buildOutboxDispatcher` is exported the way `buildRunner` is, so the integration suite runs production's wiring, not a parallel one. |
| 1.22 | **PR-021 merged. The first two commands, and the rollout pattern every later command PR copies.** `recordSaleWork` and `issueInvoiceWork` (apps/api `commands/sale-commands.ts`) are the financial work the chat handler and the quote-convert endpoint carried inline, moved to the one place spec §25 names — and BOTH flag positions call the same function: `REKODA_COMMAND_RECORD_SALE` / `REKODA_COMMAND_ISSUE_INVOICE` decide whether `CommandBus.run`'s gates (entitlement → risk → idempotency) wrap the work, never what a sale is, which is what makes the flag a rollback and not a second implementation. Old path retained exactly as the flag-off position; default off. Each command appends its outbox event (`sale.recorded`, `invoice.issued`) INSIDE the caller's transaction unconditionally — the announcement of a fact is part of the fact, not part of the rollout — and both types are registered in `buildOutboxDispatcher` (delivery today is to zero subscribers, which succeeds; PR-112 fills the bodies with webhook fan-out). Idempotency keys are the natural identities: the claimed chat draft (`draft:{id}`) and the quote (`quote-convert:{id}`). **Slice tests landed**: replay with the same key returns the first response and writes nothing (one invoice, one event, one job); the event and the state change roll back together; the convert race mints one invoice whichever hand wins; a chat sale driven end-to-end with the flag ON produces the identical reply and record plus the bus's completed claim. **Appendix C.4's mirrored boundary rules land in `check-boundaries.mjs`**: provider SDKs (`openai`, `@anthropic-ai/*`, `@aws-sdk/*`) are refused outside apps/api, and AI adapter files are refused any financial repository or `post*` posting-builder import by symbol name (the specifier alone cannot tell the quota repo from the ledger, both shipping from the `@rekoda/db` barrel). One latent bus bug fixed on the way: `requestHash`'s stable serialiser saw a `Date`'s enumerable keys as `{}`, so two payloads differing only in a date hashed identically. **Deferred to PR-027, named**: the adapter fail-closed test (a known raw protected field REFUSES the outgoing request rather than silently redacting) and the AI observability test (processor, model, purpose, tokenisation status, policy version recorded; prompt, completion and protected fields not) — they live at the interpreter seam that PR rewires, not in the sale commands. The storefront and chat-order `issueSale` sites stay on the old path deliberately: they are `PlaceOrder`'s (PR-025). |
| 1.23 | **PR-022 merged.** Three commands land on PR-021's pattern: `RecordPayment`, `ConfirmPayment`, `RecordPaymentEvidence` (`payment-commands.ts`), flags `REKODA_COMMAND_RECORD_PAYMENT` / `REKODA_COMMAND_CONFIRM_PAYMENT`, both positions calling the same work. The provenance split is the design: `recordPaymentWork` books MERCHANT_ATTESTED money the merchant reported (chat confirm + dashboard `payments/record`, unified on one input that carries either the invoice id chat resolved or the number the dashboard typed); `confirmPaymentWork` books PROVIDER_VERIFIED money a server-side verify confirmed (webhook processor + Pay-with-Transfer reconciliation poll and checkout status poll — every booking site now goes through one function). They do not share a function because they must never share a badge, pinned by tests reading `initial_confirmation_source` and `verified` off both. **One idempotency subtlety became the design rule**: a refusal (`already_settled`, `balance_moved`, `not_found`) is an OUTCOME the work returns, never a thrown error, so the claim completes beside it and a retried refusal replays as the same refusal — a thrown refusal caught outside the bus would have committed a claim stuck "running" forever. **The first `payment_evidence` writer** (`evidenceRepo.recordEvidence`): when a chat payment draft came from an IMAGE, the confirm records an evidence row — source `chat_image`, the claimed amount, born RESOLVED because the attestation it accompanies resolves it in the same transaction (§23's deadline path stays for evidence that must wait) — and the payment cites it via `payment_evidence_id`. No outbox event for evidence, deliberately: it proves nothing (§6.1), so there is no financial fact to announce. **Spec E.7's `evidence_basis` is now written**: derived from the DRAFTING message's kind (`pendingDraft` gains `messageKind` via a join) — text TYPED, voice SPOKEN, media SAW_AN_IMAGE — dashboard forms NOT_A_MESSAGE, and null when the ingress cannot honestly say; context for a human, never a trust grade. Outbox: `payment.recorded` and `payment.confirmed` registered in the production dispatcher. **Deferred with reasons, not silently**: `AllocatePayment` waits for F1's append-only `PaymentAllocation` model (allocation today is implicit in the booking writers); `CreatePaymentIntent` is dominated by a provider call that cannot sit inside command-transaction work and stays behind `PaymentIntentsService` until P1 (PR-054) restructures attempts. End-to-end proof: a chat payment driven with the flag ON produces the identical receipt, ledger and reply, plus the completed `RecordPayment` claim and a TYPED basis on the payment row. |
| 1.24 | **PR-023 merged.** `RecordExpense` and `RecordPurchase` (`spend-commands.ts`), flags `REKODA_COMMAND_RECORD_EXPENSE` / `REKODA_COMMAND_RECORD_PURCHASE`, on the established pattern. Three ingresses converge on `RecordExpense`: the chat confirm, and the RECURRING SWEEP — a standing order is an ingress too (AUTOMATION), and §25's point is exactly that September's rent must not have a cheaper path to the ledger than a sentence does; its natural idempotency key is the raise (`recurring:{scheduleId}:{dueOn}`), so a catch-up that fires the same raise twice replays and raises nothing. `RecordPurchase` converges the chat confirm and the dashboard PO receive, and CARRIES ITS DELIVERIES: `arrivals[]` on the command input, resolved to products and counted inside the work, so the goods land in the same transaction as the money whichever door it came through — chat passes the one counted mention, a received PO passes every line. Events `expense.recorded` and `purchase.recorded` registered in the production dispatcher; the expense announcement deliberately carries no description, because a merchant's sentence about money routinely names a person and the event needs the fact, not the prose. Proof: replay writes nothing and moves NO stock (fifty on the shelf stays fifty); money, goods and announcement roll back together; the sweep's exact AUTOMATION envelope replays a duplicate raise. Ingress replies and response shapes unchanged — both flag positions call the same work, and the existing chat/PO suites now exercise it on the flag-off path. |
| 1.25 | **PR-024 merged.** `PostJournal` and `ClosePeriod` (`ledger-commands.ts`), flags `REKODA_COMMAND_POST_JOURNAL` / `REKODA_COMMAND_CLOSE_PERIOD`, on the established pattern — and one deliberate asymmetry in refusal shape, now the module's documented rule: **a refusal that wrote nothing is an OUTCOME** (ClosePeriod's `not_ended` / `already_closed` complete the idempotency claim and replay truthfully — a repeated close answers `already_closed` and writes no second event), **a refusal after any write is a THROW** (PostJournal's `PeriodClosed` fires after the journal number is minted, so only a whole-transaction rollback keeps the numbering dense — the test asserts the roll-back took the posting, the event AND the idempotency claim with it, per §26). The dashboard's constrained two-account journal passes no `manual` risk context: that escalation is for a posting policy demanding review, not for the escape hatch's ordinary use, so PostJournal stays STANDARD here. Events `journal.posted` (no memo — a correction's prose can name a person) and `period.closed` registered in the production dispatcher. **`ReopenAccountingPeriod` deferred to PR-028, named**: it is HIGH_RISK (Appendix D), so running it through the bus demands a confirmation the dashboard cannot yet collect; moving it early would have meant breaking the endpoint or exempting a high-risk command from its tier, and D.3 forbids the second. |
| 1.26 | **PR-025 merged.** One work function (`placeOrderWork`, `order-commands.ts`) behind BOTH command names, because they are one financial act with two front doors: `PlaceOrder` is the customer's own hand (storefront, flag `REKODA_COMMAND_PLACE_ORDER`), `RecordOrder` is the merchant forwarding what a customer said (chat, flag `REKODA_COMMAND_RECORD_ORDER`) — the envelope's command name preserves WHO acted, which the audit trail is owed, while the entitlement table gates both with `REKODA_INTEGRATE`. The work is what both ingresses held inline: order → invoice (nothing paid; an agreed order IS a sale on credit) → linkage in the same statement → paper → payable link → stock committed → cost of goods → `order.placed` announced. Per-ingress identities preserved exactly: chat's invoice cites the confirmed draft, the storefront's cites the placed order; the storefront's `clientRef` becomes the bus idempotency key (`shop-order:{clientRef}`), the same identity `orders_external_ux` already dedupes, so a replay answers the first order instead of colliding with it. **The §4.3 rule-1 proof landed at command level**: a `chat`-plan business is refused `not_entitled` and the refusal consumes NOTHING — no order, no invoice, no event, and no idempotency claim, because entitlement runs before the key. Pricing, cart validation and catalogue re-reads stay in the ingresses — they are shape, and an ingress owns its shape. One test find worth recording: a fresh trial business holds BOTH capabilities, so the refusal fixture pins the plan to `chat` via `billingRepo.setPlan` rather than merely not granting. |
| 1.27 | **PR-026 merged.** `IngestFinancialTransaction` and `ConfirmReconciliation` (`bank-commands.ts`), flags `REKODA_COMMAND_INGEST_FINANCIAL_TRANSACTION` / `REKODA_COMMAND_CONFIRM_RECONCILIATION`. Ingestion converges its three doors — the CSV upload, the dashboard's pull-now button and the background feed sweep — on one command: same fingerprint, same dedupe, and now the same gates; `syncFeedOnce` carries the INGRESS through (DASHBOARD for the button, AUTOMATION for the sweep) because the same operation through two doors is still two doors. No idempotency key for ingestion, deliberately: the line fingerprint IS the import's identity, so a re-upload or an overlapping feed pull counts duplicates rather than replaying — and the announcement fires only when something actually LANDED, because an event about an all-duplicates import is noise a consumer has to learn to ignore. `ConfirmReconciliation` is the STANDARD case and stays STANDARD by construction: `matchByHand` refuses any line or movement a match already claims, so this door can never overrule a deterministic match — which is exactly what keeps it out of Appendix D.2's `ConfirmReconciliation override` row. **The override — overruling a deterministic match — is HIGH_RISK and deliberately has NO ingress**; it arrives with PR-028's confirmation UI, joining `ReopenAccountingPeriod` in that queue. The automatic `/reconcile` rule run stays outside the command layer, named: the timid deterministic rule decides nothing a human confirms, and dressing it as a confirmation would blur the one distinction D.2 draws. A refused match (amounts differ, movement claimed, no such line) is an outcome that writes nothing and announces nothing. Events `financial_transactions.ingested` and `reconciliation.confirmed` registered in the production dispatcher. **A1's six command PRs (PR-021…026) are now all merged; PR-027 (chat ingress rewiring) is next.** |
| 1.28 | **PR-027 merged. Every chat WRITE now reaches a command work function.** The two commands the chat handler still held inline land with the full Appendix D machinery. **`AdjustInventory`** (`stock-commands.ts`, flag `REKODA_COMMAND_ADJUST_INVENTORY`): the one command whose TIER depends on the numbers — adding stock is STANDARD and opens nothing; a delta that writes stock OFF is D.2's destructive adjustment, so under the flag the PREVIEW opens a `pending_confirmations` row recording the exact consequence the merchant read, and the yes claims it through the bus (`context: {destructive}` raises the tier; context can only ever raise). A lapsed confirmation (the D window is five minutes) gets the new `confirmationLapsed` reply asking for a fresh preview, never a shrug and never a silent write. **`EraseData`** (`privacy-commands.ts`, flag `REKODA_COMMAND_ERASE_DATA`): chat's deterministic router IS the exact-phrase check; the first ask opens the confirmation recording the consequence, the second claims it through the bus and erases; the announcement carries the COUNT and nothing else. Both proved end-to-end with the flags on: the identical replies and deletions, plus the claimed confirmation row carrying the consequence text. **Appendix C.4's two deferred tests land at the interpreter seam**: the adapter FAILS CLOSED — `detectStructuralPii` on the outgoing text, and a raw phone bound for the model throws `RawProtectedFieldError` before anything is reserved, sent or billed (no transport call, no usage row, the daily slot untouched), because a silently redacted prompt returns a confidently wrong answer about a sentence the model never read; and the observability row now carries processor, model, `purpose`, `tokenised` and `policyVersion` (`PRIVACY_POLICY_VERSION` in core/privacy, `tokenise-v1`) — never the prompt, the completion or a protected field, pinned by test. `CommandBus` exposes `riskPolicy` so an ingress that must OPEN a confirmation uses the same instance the gates claim against. Chat's ingress convergence is complete: sale, order, payment, evidence, expense, purchase, stock and erasure all run command work functions; what remains inline is shape — gating arithmetic, catalogue re-reads, consent, identity tidy-up — which is exactly what §25 says an ingress owns. |
| 1.29 | **PR-028 merged. A1 COMPLETE.** The dashboard gets its first HIGH_RISK surfaces, on Appendix D's two-step made uniform: the first call carries no confirmationId, the bus answers `confirm_first`, the endpoint OPENS a confirmation naming the exact consequence and hands it back; the merchant reads it and resubmits with the id; the claim and the work share the transaction. **`ReopenAccountingPeriod`** (flag `REKODA_COMMAND_REOPEN_PERIOD`): \"{month} opens back up, and so does every month after it. Statements you already sent can change until you close again.\" **`VoidReceipt`** (flag `REKODA_COMMAND_VOID_RECEIPT`): \"{invoice} will be voided and its posting reversed. The number stays used, and the record of the void is permanent.\" Both proved at bus level — confirm_first writes nothing, the claim executes once and announces (`period.reopened`, `invoice.voided`), a spent confirmation refuses its reuse — and both carried through contracts (`confirm` / `confirmation_lapsed` outcomes) and the web forms, which show the consequence and require the explicit second press (the Q2 pre-commit shape, applied to risk). **The A1 completion gate lands in CI**: `check-boundaries.mjs` rule five scans every `apps/api/src` file outside `commands/` for a financial WRITER call site (`issueSale`, `bookVerifiedPayment`, `writePosting`, `reopenBooks`, `eraseAllIdentities` and thirteen more) and fails the build on any hit — green today, which is the sentence the slice was building toward: **no financial write occurs outside the command layer, proven by a boundary check in CI**. The storefront needed nothing: PR-022/025 already converged its two financial writes. Deferred with names, not silence: the dashboard stock-count settle stays on `stocktakeRepo` until F1 (its posting substrate IS the kernel F1 replaces); expense void, credit notes, assets, supplier settlements and opening balances get their commands when F1 rewires the posting builders they sit on; the `ConfirmReconciliation` OVERRIDE still has no ingress (releasing a match is not overruling one). Chat's dead `postCostOfGoods` helper deleted — the gate would have flagged it. **A1's ten PRs (PR-019…028) are all merged: one command layer, idempotency, the outbox, and every ingress a thin adapter. F1 (PR-029, accounting kernel) is next.** |
| 1.30 | **PR-029 merged. F1 begins.** Migration **0061** (the sequence long past the plan's guesses): the chart of accounts becomes rows. `accounts` carries the §11 design whole — typed scope columns as REAL composite FKs on `(business_id, id)` so a scope belonging to another tenant is unrepresentable (proved by a refused cross-tenant insert); the §11.3 all-or-none CHECK; the partial unique index one-role-per-scope over a coalesce of the three scope columns (exactly one is ever set); §11.2's full twenty-one-row role/scope mapping as a CHECK, mirrored by `ROLE_SCOPE` in `@rekoda/core/chart` — and the integration suite proves the two AGREE by inserting every legal pair and being refused `ACCOUNTS_RECEIVABLE` on a connection. A BUSINESS scope can only be self (`scope_business_id = business_id` CHECK). Role, scope and TYPE are set once, by trigger (§11.4 \"refused, always\"; type added because statement placement is not editable either); the merchant's name stays theirs, and `accountByRole` resolves after a rename — the sentence the engine's contract is built on. **One prerequisite created rather than pointed at**: `financial_accounts` (bank · till · provider_settlement) lands minimally in the same migration, because §11.2 scopes BANK and CASH per financial account — a till IS one — and a scope column referencing a table that does not exist is not a design; B1 (PR-073) extends it with connection identity. `payment_connections` gains the composite `(business_id, id)` unique target the FK shape needs. **DELETE is nobody's for now**: `ledger_entries.account_id` does not exist until PR-031, so \"no postings\" is a question the database cannot yet answer, and §11.4's unposted-delete arrives with PR-035's lifecycle. Core gains `SYSTEM_ROLES` (21), `MANDATORY_ROLES` (AR · AP · retained earnings · VAT payable) and `scopeOf`; two clearing accounts for two providers proved coexisting, a second for the same connection refused. Additive only — no writer or reader changed. |
| 1.31 | **PR-030 merged.** Every business now HAS its chart, by two doors that cannot drift. `SEED_CHART` in `@rekoda/core/chart` is the single statement of it: the seventeen legacy ledger keys carried over ON THEIR EXISTING CODES — a re-rendered statement must not renumber a month already reported — plus the §11.2 roles the engine will rely on that had no legacy key (retained earnings 3100, unearned revenue 2200, customer credits 2300, opening balance equity 3900, sales returns 4100 as contra income, payment processing fees 6050, input VAT 1150, withholding receivable 1160). Twenty-three accounts and three financial accounts (the till, the bank, the Paystack settlement pocket): CASH scopes to the till, BANK twice — once per place settled money sits — which the one-role-PER-SCOPE index was built for. **New businesses**: `seedChartOfAccounts` runs inside `createBusinessWithOwner`'s transaction, so there is no window where a business exists and its chart does not. **Existing businesses**: migration **0062**, a data migration idempotent by `WHERE NOT EXISTS` — a data migration that cannot be re-run against a partially seeded estate is one nobody dares run. **The drift-proof is a test**: the suite inserts a bare pre-migration business raw, re-executes the 0062 file (its idempotence is what makes it testable), and asserts the SQL-seeded chart equals the TypeScript-seeded chart row for row. Not seeded, by design: the two PAYMENT_CONNECTION roles (clearing accounts are provisioned per connection, PR-053), and the mapping test now creates exactly those two against a real connection. `EQUIPMENT`, `ACCUMULATED_DEPRECIATION` (contra) and `DISPOSAL_RESULT` carry over roleless — no §11.2 role names them, and inventing one would be the spec drifting to fit the code. PR-029's constraint tests reworked onto the seeded baseline (a fresh business no longer has an empty chart — which the old fixtures assumed). |
| 1.32 | **PR-031 merged.** Migration **0063**: `ledger_entries.account_id`, nullable, with the composite `(business_id, account_id)` FK — the same tenant-carrying shape as every 0061 scope FK, so an entry citing another tenant's account is unrepresentable (proved by a refused direct insert). **The dual write starts now**: both ledger insert sites — `writePosting` (the shared path) and `bookVerifiedPayment`'s own — resolve every line's legacy text key through `accountIdsForKeys`, which maps key → seeded chart row BY CODE; the seed carried every key over on its existing code precisely so this lookup is a join, not a judgement. From this deploy no new entry is born unlinked, which is what makes PR-032's backfill a shrinking set instead of a moving target. A missing chart row THROWS with the seed named — the invariant is guaranteed at creation and by 0062, so absence is a broken estate, and a posting written half-linked would poison the backfill's validation quietly (proved by owner-deleting a seeded account and watching the journal refuse). The agreement is pinned per row: for a journal, a sale and a reported payment, every entry's `account_id` points at the account whose CODE equals `ACCOUNTS[key].code`. No reader changed; the partial index waits for the linked majority. |
| 1.33 | **PR-032 merged.** Migration **0064**: the historical tail relinked, and VALIDATED rather than hoped. The mapping is the same one the dual write uses live — legacy key → the seeded row that kept its code — and the file ends in a gate: a `DO` block counts what is still unlinked and what links to a row whose code disagrees with its key, and ABORTS the whole migration on either, because a backfill that reports success while rows dangle is exactly the failure such gates exist to catch. Idempotent by `WHERE account_id IS NULL`, which is also what makes it TESTABLE: the suite strips a dual-written history back to the pre-0063 shape as the owner, re-executes the migration file itself, and proves complete relinking with per-key code agreement; runs it twice to prove idempotence; and inserts a `LEGACY_MYSTERY` key nobody mapped to prove the gate refuses to declare victory (the implicit single-transaction execution rolls the UPDATE back with the raise, so an aborted run leaves the estate untouched). One SQL find: an `UPDATE … FROM` cannot reference the target inside a JOIN's ON clause — the join with `accounts` moved into the WHERE. With 0063's dual write ahead of it, the unlinked set only ever shrinks; PR-033's reader cutover is next. |
| 1.34 | **PR-033 merged.** Every reader of `ledger_entries` now derives its figures through `account_id` and the chart rows; not one query in the repos compares the legacy text key any more. The cutover is one mechanical transformation applied everywhere: `JOIN accounts ON accounts.id = ledger_entries.account_id` and a filter on `accounts.code`, with the codes taken from the seed's own constants through a single shared `codeOf` helper in the accounts repo (inlined as SQL literals — never user input, so no injection surface). Cut over: the whole reporting layer (overview, cashflow, statements, expenses-by-category, sales-by-source, AP balance), the bank position and both reconciliation movement readers, opening balances, stock valuation, supplier ageing and `owedOn`, depreciation charged/accumulated subqueries, the COGS-reversal reader on void, both posting-reversal readers (asset withdrawal, expense void) and the trial-balance `ledgerEntriesFor`. Where a text key leaves a repo, `KEY_BY_CODE` (new in core, the inverse of `ACCOUNTS`) maps the joined code back, so every key-typed consumer reads exactly what it read before — and `ledgerEntriesFor` falls back to the raw code for a post-seed account, so a row outside the seventeen-key vocabulary can never silently vanish from a trial balance; the two reversal readers instead REFUSE such a row, unchanged in spirit from their old `isAccountKey` guard (reversing what we cannot name is worse than refusing). Correctness argument: PR-031/032 proved key↔code agreement on every row, so join-by-code is pointwise identical to compare-by-key — and the entire regression net (658 db + 788 api integration tests, statements, exports, meta E2E) passed untouched. Writers still dual-write the text column; dropping it is PR-034, now unblocked. |
| 1.35 | **PR-034 merged.** The contract step, and the end of the F1 account cutover sequence: migration **0065** makes `account_id` NOT NULL and drops the `account` text column, taking the seventeen-key vocabulary's last physical trace in `ledger_entries` with it. What the dual write promised and the validated backfill proved, the database now simply enforces — an entry without its chart account, or citing another tenant's, is unrepresentable (NOT NULL + the composite FK from 0063). Indexes follow the column: the two text-key indexes drop, the vacuous partial from 0063 is retired, and one full `(business_id, account_id, created_at)` index replaces the pair — the statement schedules by full shape, every business+account balance read by prefix. Writers stop dual-writing (`writePosting`, `bookVerifiedPayment` drop the text field; `accountIdsForKeys` resolution stays — the KEY remains core's posting vocabulary, only the column dies). Test estate consequences faced honestly rather than papered over: the PR-031 dual-write agreement test is reworked into end-state proofs (per-code posting sums against the seeded chart, a 23502 on an unlinked insert, the missing-seed refusal, the cross-tenant FK), the close-period raw-insert probe now inserts by `account_id`, the settle balance probes join the chart — and two bridge-era proof files are DELETED because their subject no longer exists: the PR-032 backfill replay (re-executes 0064, which reads the dropped column) and the 0035 bank-split relabel suite (its UPDATE targets the dropped column). Both migrations remain frozen history that runs before 0065 on any fresh estate; their proofs served PR-031…033 and cannot outlive the bridge they proved. Full regression: 648 db + 788 api integration tests, turbo 24/24, boundaries clean. This is the sequence's irreversible step, taken only after the 0064 gate ABORTED-on-dangling guarantee made it safe. |
| 1.36 | **PR-035 merged.** The §11.4 lifecycle, held by the database at every door. Migration **0066**, four pieces: (1) `accounts_role_scope_ux` re-scoped to ACTIVE rows — the 0061 unique covered inactive rows too, which would have made mandatory-role replacement unrepresentable (identity is immutable, so a successor can only carry the role once uniqueness is scoped to the working chart; `accountByRole` always resolved active-only, the index now states the same sentence); (2) a BEFORE INSERT trigger on `ledger_entries` refusing a deactivated account — "post into it once inactive: refused", for every writer, at the door; (3) a DEFERRED constraint trigger `accounts_mandatory_role_guard` (UPDATE OF active OR DELETE): a mandatory role (core MANDATORY_ROLES, mirrored inline) may never be left without an active account at COMMIT — deferred precisely so the legal shape, one transaction that retires the predecessor AND installs the successor, commits, while any writer that orphans the role is refused at the exit it actually takes; with an explicit exemption for a business being erased whole (migration 0022's right-to-erasure deletes the chart with the business — a role belonging to nobody is not orphaned; found by the retention suite, not by luck); (4) the DELETE grant PR-029 withheld — `rekoda_app` may now delete, and §11.4's strictest row costs no trigger at all because the NOT NULL composite FK from 0065 refuses deleting anything ever posted into. Repo: `deactivateAccount` (outcomes deactivated / not_found / already_inactive / mandatory_needs_replacement — the mandatory path takes a `replacement {code,name}` and installs the successor with the same role, scope and statement placement in one transaction), `reactivateAccount` (role_occupied when a successor holds the slot), `deleteAccount` (has_postings and mandatory_role as honest outcomes ahead of the constraint errors). `accountIdsForKeys` now refuses a deactivated row by name — the key-based paths resolve by CODE, so a deactivated seed account is a dead end until the posting-policy engine (PR-037+) resolves by ROLE; 0066's trigger would refuse the insert anyway, this is the same refusal a sentence earlier. Deferred, named: the `DeactivateAccount` command work function and its ingress surface ship with the chart-of-accounts settings surface (risk classification already in core since PR-017a: STANDARD, raised to HIGH_RISK by the `mandatoryRole` context, per Appendix D.2). Proofs: 10-test lifecycle suite (repo outcomes, the DB backstop refusing a raw orphaning UPDATE at commit, the direct-insert refusal, unposted delete + FK refusal + sole-mandatory refusal); PR-029's expired "DELETE refused outright" test reworked into the §11.4 split it was waiting for. Full net: 659 db + 788 api, turbo 24/24. |
| 1.37 | **PR-036 merged.** The kernel's period table (spec §8), with the watermark's product semantics preserved to the letter. Migration **0067**: `accounting_periods` — one row per closed Lagos month `(business_id, period UNIQUE)`, status closed/open, who closed it and when, who reopened it and when, coherence CHECKs (`closed = never reopened`, reopen timestamp and actor together), RLS forced, DELETE revoked from both runtime roles (reopening FLIPS a row; nothing deletes one — a month once closed is history). The scalar `businesses.books_closed_through` is migrated into rows (earliest ledger activity through the watermark; the watermark month alone for a business with no postings), a 0064-style DO gate proves every business's derived watermark — MAX(period) over closed rows — equals the scalar it replaces, the 0034 triggers are re-pointed at the table with the identical refusal message, and only then does the column drop; every reader ships in the same deploy. `closeBooks` writes the row range (month after the watermark, or first activity, through the target; `onConflictDoUpdate` rehabilitates a reopened month) — and the old compare-and-set race is structurally gone, because closing only ever ADDS closed rows, so concurrent closes commute. `reopenBooks` flips rows from `from` onward AND materialises the surviving frontier: a closed row for the month before `from` when none exists, because "closed through May" protected February whether or not February had activity, and reopening March must not silently give February up — this exact divergence appeared as one failing api test mid-build and was fixed toward the canon (the repo's documented reopen contract: the watermark moves to the month before `from`), not by moving the test. New reader `periodsFor` exposes the record behind the watermark. Canon review: §10's "period is open" trigger intact on both ledger tables; reopen remains HIGH_RISK two-step at every ingress (PR-028, untouched); contracts and dashboard byte-identical (`booksClosedThrough` now derived). 660 db + 788 api, turbo 24/24. |
| 1.38 | **PR-037 merged.** §16's currency model, mapped additively onto the tables that exist. `ledger_transactions` (the JournalEntry) gains `functional_currency` (default NGN, shape-checked; `businesses.currency` from 0000 IS Business.functionalCurrency — the equality invariant becomes a PR-039 trigger). `ledger_entries` (the JournalLine): `debit_k`/`credit_k` are recognised in place as debitFunctionalMinor/creditFunctionalMinor — kobo IS the NGN minor unit, stated in schema comments rather than churned through a rename — and the line gains what the money ACTUALLY was: `transaction_currency` (default NGN, shape-checked), `transaction_amount_minor` (NOT NULL, non-negative CHECK), `exchange_rate_snapshot_id` (uuid, no FK yet — the snapshot table is PR-038's). Backfill is pure arithmetic inside migration 0068: exactly one of debit/credit is non-zero, so the same-currency transaction amount is their sum; SET NOT NULL is itself the gate. Both entry writers (`writePosting`, `bookVerifiedPayment`) stamp the amount; currency rides the default until PR-038 gives writers something else to say — no behaviour change anywhere, statements still sum functional values untouched. New suite pins: every posting path's lines carry NGN + amount = functional amount + NULL snapshot; entries carry NGN functional; a negative transaction amount is unrepresentable. Deferred, named: the FX requirement (snapshot REQUIRED exactly when currencies differ) → PR-038; §10 coherence trigger and functional-equals-business trigger → PR-039. 662 db + 788 api, turbo 24/24. |
| 1.39 | **PR-038 merged.** Appendix A.1 as a table, §16's FX requirement as a trigger, A.2's decision as pure core logic. Migration **0069**: `exchange_rate_snapshots` — a market fact, not tenant data (no business_id, no RLS), IMMUTABLE once written (UPDATE/DELETE revoked from both runtime roles, proved by a refused rewrite), `rate` numeric at full provider precision (round-trip pinned to 11 decimal places), `effective_at` the moment the rate APPLIES TO rather than fetch time, and a MANUAL_OVERRIDE that carries who decided and why by CHECK, not convention. The dangling `exchange_rate_snapshot_id` from PR-037 gains its FK, and the FX requirement lands as `ledger_entry_fx_requirement`: a snapshot exists EXACTLY when the transaction currency differs from the entry's functional currency — required when they differ, forbidden when equal ("the rate is 1 by definition", and a stored rate of anything else would be a lie that balances) — and when present it must be for the pair actually being converted, refused by name (a GBP/NGN snapshot on a USD line names both). Core gains `fx.ts`: the A.1 `ExchangeRateProvider` port (a seam, no adapter — the first consumer with a configured source brings one; rate sources are OPEN COMMERCIAL), the A.2 resolver vocabulary as named states (RATE_AVAILABLE / RATE_STALE / RATE_UNAVAILABLE / MANUAL_OVERRIDE_REQUIRED — never a bare rate, never a null), and `selectRate`, which encodes the two rules that matter: staleness is measured against the REQUESTED accounting timestamp, never wall clock (a June rate answers a June request in December, pinned by test), and — because distance is symmetric — today's rate can never silently satisfy a historical transaction, which A.2 calls the single most likely way a wrong rate enters the books. Deferred, named: A.2a selection calendars, publication-time policy and fallback ordering ship with the first live provider adapter. 5 core + 669 db + 788 api, turbo 24/24. |
| 1.40 | **PR-039 merged.** Every row of §10's invariant table is now held by the database. Migration **0070**: (row 2) `ledger_entries_one_sided` CHECK — exactly one of debit/credit non-zero per line, gated 0064-style before constraining, with `assertBalanced` tightened in core to refuse a 0/0 line first with a better message (and the two builders that could emit one — zero-revenue, zero-equity — now skip it); (row 4) the tenant wall as a FOREIGN KEY: `ledger_transactions` gains `(business_id, id)` UNIQUE and `ledger_entries` a composite FK, so a line citing another tenant's journal entry is unrepresentable, the 0063 shape again; (row 7) `ledger_tx_currency_valid` — §16's invariant that the entry's functional currency IS the business's currency, as a BEFORE INSERT trigger; (row 8) `ledger_entry_amount_coherent` — a same-currency line's transaction amount must equal its functional amount to the kobo (the cross-currency tolerance ships with the first writer that can post one, because a tolerance nobody exercises is a rule nobody has proved); (rows 1 and 3) the DEFERRED pair — `ledger_entry_shape` on lines and `ledger_tx_has_lines` on entries, both checked at COMMIT because the lines of one entry arrive as separate rows: at least two lines, and debits equal credits summing FUNCTIONAL amounts only, never a transaction amount (§16's balance rule, stated in the function). Rows 5, 6 and 9 were already held (0066, 0034/0067, 0069). Test probes that committed scaffolding transactions (a journal entry with zero lines) were themselves illegal under row 1 and were reworked into single balanced transactions — the invariant caught its own test suite, which is the point of invariants. The strongest proof is the regression net itself: every posting path in the system — sales, payments, expenses, purchases, journals, opening balances, stock counts, depreciation, disposals, reversals, voids, settlements — commits under the full trigger set unchanged: 679 db + 788 api, turbo 24/24. |
| 1.11 | **Owner decision register, 26 Aug 2026.** Eight rulings, applied without redesign. **(1) A/C collapsed into one gate**: PR-002 / R0A-i is the read-only production classifier that produces the provenance report; the owner reviews and explicitly approves that output; only then is PR-006 unblocked. **PR-006 is the backfill, never "the report"** — the pre-slice gate wording is corrected accordingly. **(2) `MetaBillingMode` stays OPEN COMMERCIAL** until W0 confirms it; architecture must support merchant-direct and Rekoda-funded billing without a code branch. **(3) ADR 0029 amended, not ratified**: message usage metering and Meta cost attribution are INDEPENDENT axes. Usage is metered per business regardless of who Meta bills; `MetaBillingMode` decides whether a metered message also produces a `PlatformCostEvent`. Provider-cost attribution is never inferred from usage metering alone. A plan may include a message allowance even under `MERCHANT_DIRECT`, for packaging, abuse control and support economics. **(4) W0 scope wording corrected**: track Advanced Access for the scopes Embedded Signup documents as requiring it (`business_management`, `whatsapp_business_management`) and separately ensure `whatsapp_business_messaging` is approved and configured; do not assert Meta requires all three for Embedded Signup without the App Review surface confirming it. **(5) UI visibility (PR-017)**: hide unavailable capabilities from operational surfaces, show the full capability matrix under Plans/Billing, render `EntitlementRefusal` on deep links and explicit attempts, and never fill the dashboard with permanent upgrade nags. **(6) Plan switching (PR-017)**: every switch that removes a capability requires a pre-commit impact screen naming capabilities gained and lost, effective date, retained records and operational consequences, then explicit confirmation. Framed as a plan SWITCH rather than a downgrade, because Chat→Integrate both gains and loses. **(7) PR-017a added**: risk tiers leave the UI PR. Shared server-side risk policy, high-risk confirmation primitive with expiry and actor, business and command binding, audit events, and enforcement identical at every ingress. The away assistant can never execute a `HIGH_RISK` command. Baseline moves 120 → 121. **(8) PR-014 ratified** with explicit semantics: `0` means zero included units and NEVER unlimited; unlimited, if ever needed, gets its own representation. Entitlement, allowance, feature flag and provider readiness must all permit execution independently. |
| 1.12 | **PR-015 overturned and corrected before merge.** The first implementation concluded that because neither the WhatsApp webhook nor the media endpoint reports a duration, only the transcriber can know one, and turned `VOICE_NOTE_MAX_DURATION_SECONDS` from a rejection limit into a reservation window — losing the "send it in shorter parts" reply `rekoda-chat-v1` §2 promised. **Owner ruling: wrong, and reverted.** The media binary is downloaded before anything is spent and the container carries its own length. `AudioMetadataProbe` is a port; `ContainerAudioProbe` reads OGG, MP4/M4A, AMR, MP3 and AAC in process. The flow is now entitlement → download → local duration probe → reject if over the limit → take exactly the seconds it runs → transcribe. Unreadable audio is never sent to a provider on the hope that it is short: the merchant is asked to record it again, and nothing is metered. `reserveUpTo` is deleted — with an exact duration known before the spend, the primitive has no caller. Also ratified from the same register: rate multiples are effective-dated observations derived from `ProviderCostSchedule`, never stored constants, so a Meta repricing moves them with no code edit. |
| 1.10 | **PR-013 merged.** Implementation reached a genuine canonical conflict and stopped for the owner, per §20.5 and the reopen protocol: the repository's `integrate` plan carried a full merchant-side allowance set LARGER than `chat`, with a deliberate comment defending it, which made Integrate a superset of Chat and left Complete selling only volume — contradicting spec §3.3's "Complete is the pair". **Owner decision, 26 Aug 2026: `integrate` holds `REKODA_INTEGRATE` only.** The canonical spec did not change; the repository was the drift. Consequences carried in the same PR so the product never lies: `integrate` messaging, voice and documents-understood allowances go to zero (document GENERATION stays — it is Integrate's own consumable), the pricing page is corrected, and the "ladder never walks backwards" test is rewritten as a within-capability invariant, since the ladder is now two capabilities meeting at Complete rather than one line. Accepted cost, stated explicitly: a Chat merchant moving to Integrate loses merchant-side recording. |
| 1.9 | **PR-012 merged.** Migration **0052**. Two tables: `entitlements`, the catalogue, seeded with the three canonical keys and made read-only to both application roles, because a service that can insert its own entitlement key has no product boundary left; and `business_entitlements`, the explicit grants, under tenant RLS. `source` (`PLAN` / `TRIAL` / `MANUAL_GRANT`) is carried from the start so a downgrade can tell a plan grant from a support-issued one. `REKODA_COMPLETE` is deliberately absent: Complete is the pair. **Deferred deliberately:** the `plan_version_id` grandfathering pin of spec §4.5 is NOT added here — the table it would reference arrives in BL2 (PR-099), and a nullable column pointing at nothing is speculation. BL2 adds it. No dependency changed. |
| 1.8 | **PR-010 merged.** Implementation finding, recorded rather than treated as a canonical conflict: `ledger_entries` was already append-only from migrations 0001 and 0004, but `ledger_transactions` never was — it took the broad grant in 0001 and nothing revoked it. The canonical decision did not change; its scope in the repository was half-complete. Migration is **0051**, not the 0056 the plan guessed, because 0050 is the real tail. Registering a migration also requires an entry in `migrations/meta/_journal.json`, which the plan did not mention and every later migration PR needs. |
| 1.7 | v1.6.6 implementation consistency. `PaymentVerificationClaim` lifecycle resolved to one model: **row existence is the state**, no `status` column and no `RELEASED` row; revoking deletes the row in the revocation's transaction, and the immutable events remain the reconstruction source. **PR-003's provider claim key becomes `provider_source_identity`** (`businessId + paymentConnectionId + providerTransactionReference`) rather than `payment_attempt_id`, because `PaymentAttempt` arrives in PR-054 while PR-005 must already record provider-verified payments; the attempt is linked additively later and never becomes the identity retrospectively. Canonical atomic write order stated: verification then claim, same transaction, **no external work between them**, and a claim conflict rolls back the whole transaction before resolving same-payment retry against different-payment conflict. Repository-reality drift row corrected to the actual source and trust model. Journeys header moved to v1.6.6. Baseline wording corrected from 115 to **120**, range 105–130 retained. **No new PRs; no dependency changed.** |

Record every approved split, merge or scope change here. An index nobody amends stops being a map.

## 16. Readiness vocabulary

"Unblocked" was doing three jobs at once and is retired. Three separate statuses, and a PR needs all three that apply to it.

```
ArchitectureApproval     APPROVED · OPEN
                         the canonical spec settles it. Review is closed.

EngineeringReadiness     READY · WAITING_FOR_<dependency>
                         prerequisite PRs are MERGED, not merely planned.

ProductionEnablement     ENABLED · BLOCKED_<gate> · NOT_APPLICABLE
                         Meta approval, provider terms, an approved data report.
```

Worked example, because this is the confusion the three states exist to end:

```
F1
  ArchitectureApproval = APPROVED
  EngineeringReadiness = WAITING_FOR_A1_POSTJOURNAL
  ProductionEnablement = NOT_APPLICABLE

KudaPaymentProvider
  ArchitectureApproval = APPROVED
  EngineeringReadiness = READY            the adapter can be written and merged
  ProductionEnablement = BLOCKED_COMMERCIAL_COMPLIANCE
```

An architectural correction does not erase a code dependency, and a merged adapter is not a live one.

> **Architecture approval is not permission to start.** F1's hold is released, and F1 still waits on A1's command layer carrying `PostJournal` because that is an engineering dependency and no review can dissolve it. W1/W2 may build additive onboarding infrastructure against test numbers, and production enablement still waits on W0.

| Work | Architecture | Engineering | Production |
|---|---|---|---|
| W0 | n/a | n/a | owner action |
| PR-002 | approved | **ready** | ready |
| PR-010 | approved | **ready** | ready |
| PR-012 | approved | **ready** | ready |
| PR-013 | approved | after PR-012 | ready |
| PR-003 | approved | **ready** | ready |
| PR-004, PR-005 | approved | after PR-003 | ready |
| PR-006 | approved | after PR-005 | **BLOCKED — production provenance report** |
| A1 | approved | after E1 begins | ready |
| F1 | approved | **after A1 carries `PostJournal`** | ready |
| P1 | approved | after F1 | ready |
| W1/W2 | approved | after E1 and A1 | **blocked — Meta Advanced Access** |
| W3 | approved | after PR-058a-4, P2 | blocked — Meta |
| P3 adapters | approved | after PR-068 | blocked — provider terms |
| F2 tax | approved | after F1 | blocked — tax review |

---

## 17. Pre-slice gates

| Before | What must be in place |
|---|---|
| **PR-003** | The claim projection with **row existence as the state**, the `provider_source_identity` claim key (never `payment_attempt_id`), the canonical verification-then-claim write order with no external work between them, operator-scoped manifests, and the hardened `SECURITY DEFINER` rollback function. **PR-003 must be built against this corrected schema before merge.** |
| **F1** | Spec §12.3 dimensions, §12 atomic contract-asset refusal, Appendix A FX states, Appendix B costing invariants and exact arithmetic, Appendix E derived statuses. |
| **A1** | Spec Appendix C.4, enforced by the boundary check rather than by review. |
| **E1** | Spec Appendix D, applied identically to every ingress. |
| **W1/W2** | Spec Appendix F. PR-058a-1 … -5 implement the identity model; they do not decide it. |
| **PR-009** | The trigger-maintained compatibility column, never a generated one. |
| **PR-006** | **PR-006 is the historical backfill, not the report.** The report is PR-002 / R0A-i, run read-only against production. It must be run, reviewed, reconciled against its expected row counts and totals, its remediation population understood, and **explicitly owner-approved** before this backfill executes. None of the five is optional and application progress elsewhere is not a substitute for any of them. |

---

## 18. Implementation mode

Architecture review is closed. The loop from here:

```
IMPLEMENT → TEST → REVIEW PR AGAINST THE CANONICAL SPEC
          → MIGRATION DRY RUN WHERE REQUIRED
          → MERGE → UPDATE BUILD PLAN STATUS → NEXT PR
```

Reopen the architecture only for a demonstrated financial-integrity defect, a database or platform impossibility, a provider capability contradiction, legal or compliance evidence, a security defect, or production evidence invalidating an invariant.

**Not because another structure looks cleaner.**
