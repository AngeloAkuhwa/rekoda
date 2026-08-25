# Rekoda End-to-End Build Plan

| Field | Value |
|---|---|
| Status | **APPROVED — EXECUTION PLAN** |
| Version | 1.5 (v1.6.4 corrections + consistency sweep) |
| Effective date | 25 August 2026 |
| Governs | `docs/REKODA_CANONICAL_SPEC.md` v1.6.4 |
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
| Payment provenance | `payments.verified` integer plus `method` text | Six provenance values, two derived trust levels | R0A-ii |
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
| **Target state** | Tech Provider approved; Advanced Access granted for `business_management`, `whatsapp_business_management` and `whatsapp_business_messaging`; Embedded Signup prerequisites met; coexistence capability confirmed; **billing mode confirmed** as one of `MERCHANT_DIRECT`, `REKODA_CREDIT_LINE`, `PARTNER_BILLED`. |
| **Dependencies** | None. Runs in parallel from day one. |
| **Schema / commands / endpoints / jobs / frontend** | None. This slice ships no code. |
| **Tests** | None. |
| **Rollout / flags / rollback** | n/a |
| **Doc updates** | Spec spec §24 billing mode becomes CORRECT rather than OPEN COMMERCIAL. |
| **Completion gate** | Written Meta confirmation of Advanced Access for all three scopes, and a recorded billing-mode decision. |
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
| **PRs** | PR-012 … PR-018 |
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
| **Tests** | Replaying any command with the same idempotency key returns the first response and writes nothing. An outbox event and its state change commit or roll back together. **`scripts/check-boundaries.mjs` gains a rule: AI adapters may not import financial repositories or the accounting engine, so the boundary of spec Appendix C.4 fails a build rather than a review.** |
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
| **Tests** | Every invariant of §10 has a test that proves the trigger refuses. All five recognition cases post exactly the journals of spec §12.4. **A refused contract-asset case leaves NO journal at all, proven by asserting zero rows, and produces a review item instead.** Inventory invariants hold after every movement and the costing path uses exact arithmetic throughout. A stale or unavailable FX rate refuses the posting rather than falling back to today's rate. The golden fixture v1 ties. |
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
| **Schema** | Bills, tax model, returns, credit notes, recurring, opening balances, document projections. |
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

**115 is the plan, not the target.** During implementation an L PR will occasionally prove to need two, two S PRs will occasionally prove safely mergeable, and a provider may invalidate a planned adapter outright. None of those is a deviation from the plan; they are the plan meeting reality.

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

| PR | Slice | Title | Migr | Risk | Depends | Size |
|---|---|---|---|---|---|---|
| PR-001 | docs | Canonical spec and end-to-end build plan | no | low | — | M |
| PR-002 | R0A-i | Provenance classifier corrected to evidence-only | no | low | — | S |
| PR-003 | R0A-ii | `PaymentEvidence` and append-only `PaymentVerification` schema | **yes** | med | — | M |
| PR-004 | R0A-ii | `initialConfirmationSource` and `paymentMethod`, nullable, no writers | **yes** | med | PR-003 | S |
| PR-005 | R0A-ii | Confirmation source and verification on new payments | no | med | PR-004 | M |
| PR-006 | R0A-ii | Historical provenance backfill from the approved report | **yes** | **high** | PR-005 | L |
| PR-007 | R0A-ii | Remediation queue: add verifications, never rewrite | no | med | PR-006 | M |
| PR-008 | R0A-ii | Readers cutover: trust level derived from provenance | no | **high** | PR-007 | M |
| PR-009 | R0A-ii | Retire `verified` writers; column becomes trigger-maintained | **yes** | med | PR-008 | S |
| PR-010 | R0B | Revoke UPDATE and DELETE on ledger tables, with proof tests | **yes** | med | — | S |
| PR-011 | R0B | Evidence retention TTL, expiry sweep and legal holds | **yes** | med | PR-003 | M |
| PR-012 | E1 | Entitlement schema, additive | **yes** | low | — | M |
| PR-013 | E1 | Entitlement resolver and single server-side gate | no | med | PR-012 | M |
| PR-014 | E1 | Metered units expanded to the canonical seventeen | **yes** | med | PR-012 | M |
| PR-015 | E1 | Pre-cost gating for AI, OCR and transcription | no | med | PR-013 | M |
| PR-016 | E1 | Message-category metering: utility, marketing, auth, service | no | med | PR-014 | M |
| PR-017 | E1 | UI visibility rules and downgrade behaviour | no | low | PR-013 | M |
| PR-018 | E1 | Cross-product refusal suite: no plan reaches another's capability | no | low | PR-013 | S |
| PR-019 | A1 | Command layer skeleton and `IdempotencyRecord` | **yes** | med | PR-013 | L |
| PR-020 | A1 | `OutboxEvent` and the dispatcher job | **yes** | med | PR-019 | M |
| PR-021 | A1 | Commands: `RecordSale`, `IssueInvoice` | no | **high** | PR-019 | L |
| PR-022 | A1 | Commands: payments and evidence | no | **high** | PR-021, PR-003 | L |
| PR-023 | A1 | Commands: `RecordExpense`, `RecordPurchase` | no | med | PR-021 | M |
| PR-024 | A1 | Commands: `PostJournal`, `ClosePeriod` | no | med | PR-021 | M |
| PR-025 | A1 | Command: `PlaceOrder` | no | med | PR-021 | M |
| PR-026 | A1 | Commands: `IngestFinancialTransaction`, `ConfirmReconciliation` | no | med | PR-021 | M |
| PR-027 | A1 | Ingress rewiring: chat handler | no | **high** | PR-021…026 | L |
| PR-028 | A1 | Ingress rewiring: dashboard and storefront | no | **high** | PR-027 | L |
| PR-029 | F1 | `accounts` table, scoped roles, typed scope columns | **yes** | med | PR-024 | L |
| PR-030 | F1 | Seed business-scoped accounts for every business | **yes** | med | PR-029 | M |
| PR-031 | F1 | `ledger_entries.account_id` additive, dual write | **yes** | **high** | PR-030 | M |
| PR-032 | F1 | Backfill `account_id` across all history, with validation | **yes** | **highest** | PR-031 | L |
| PR-033 | F1 | Readers cutover to `account_id` | no | **highest** | PR-032 | L |
| PR-034 | F1 | Cleanup: drop `ledger_entries.account` text | **yes** | med | PR-033 | S |
| PR-035 | F1 | Account lifecycle: deactivation and mandatory-role replacement | no | low | PR-030 | M |
| PR-036 | F1 | `accounting_periods` table, migrate `books_closed_through` | **yes** | med | PR-029 | M |
| PR-037 | F1 | Journal currency columns, additive | **yes** | med | PR-031 | M |
| PR-038 | F1 | `ExchangeRateSnapshot` and the FX requirement | **yes** | med | PR-037 | M |
| PR-039 | F1 | Journal invariant triggers | **yes** | **high** | PR-035, PR-036, PR-037, PR-038 | L |
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

PR-058a-2   C. backfill every existing conversation as conversationKind = MERCHANT
               DO NOT fabricate a customer participant for a legacy thread:
               there was no customer on the other end, there was Rekoda
            D. VALIDATE, against a production clone, before merge:
                 zero unresolved rows
                 zero unexpected duplicates
                 every message still points at exactly one valid conversation
                 row count and conversation ids unchanged

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
    → two UNRELATED hashes; the rows cannot be correlated
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

  **The manifest is evidence, so it carries enough to prove what happened**: which migration, which version of the code, expected against actual row counts, when it started and finished, who ran it, and a checksum where one is practical. `expected_row_count` beside `affected_row_count` is what turns "the migration ran" into "the migration did what the approved report said it would". `prior_value` beside `assigned_value` on every item is what makes the rollback exact and the audit answerable.

  > **A historical migration audit record must survive its own rollback.** Rollback appends state; it never deletes the manifest or its items.

  Source idempotency, per spec §6.5, on the **claims** table, where every predicate reads a column of the table it indexes:

  ```
  UNIQUE (business_id, financial_transaction_id) WHERE financial_transaction_id IS NOT NULL
  UNIQUE (business_id, payment_attempt_id)       WHERE payment_attempt_id IS NOT NULL
  UNIQUE (business_id, confirmation_event_id)    WHERE confirmation_event_id IS NOT NULL
  CHECK  exactly one claim key is populated
  ```

  and on the event table:

  ```
  CHECK  (source <> 'LEGACY_PROVENANCE_UNKNOWN')
  ```

  > **SUPERSEDED.** An earlier draft predicated these indexes on `WHERE revoked_at IS NULL`. `payment_verifications` has no `revoked_at` — revocation is a separate table — and a partial-index predicate may reference only columns of the indexed table. It cannot see another table and cannot use a subquery. This was the sibling of the generated-column defect, and it is fixed the same way: the constraint moves to a table that actually holds the column.

  No foreign key from `payments` yet.
- **Commands.** None. No writers in this PR, deliberately.
- **Migrations.** Additive DDL only. No data writes.
- **Tests.** RLS isolation on the four tenant tables, proven as `rekoda_app`. `rekoda_app` and `rekoda_worker` have **no privileges at all** on either manifest table, proven by a refused SELECT. `UPDATE` and `DELETE` on both event tables are revoked from both application roles, with tests proving the refusal — append-only in the database, not by convention. Verification and claim are written in one transaction, and the unique violation on the claim is what makes a retry a no-op. **Concurrency: two simultaneous attempts to claim the same `FinancialTransaction`, the same provider attempt reference, and the same confirmation event — exactly one succeeds in each pair, three separate tests.** A rolled-back transaction leaves neither a verification without its claim nor a claim without its verification. One bank line cannot actively verify two payments. Revoking releases the claim, so the same line can then verify the correct payment. Appending a fresh verification after an incorrect revocation succeeds, which is the correction path of spec §6.4. **Separation, three tests, spec §6.6–6.7:**
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
- **Documentation.** Spec spec §6.1, spec §23.
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

  PRIVILEGE
    REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC          explicitly, first
    GRANT  EXECUTE TO the migration/operator role ONLY
    never granted to rekoda_app or rekoda_worker

  INJECTION SURFACE
    SET search_path = pg_catalog, rekoda      fixed, on the function
    every table and function reference schema-qualified
    no dependence on the caller's search_path at any point

  SCOPE, validated by the function itself
    the manifest exists and its status is APPLIED
    rows touched are exactly this manifest's items
    a row changes ONLY where
        current value IS NOT DISTINCT FROM item.assigned_value
    otherwise SKIP the row and REPORT it
  ```

  The skip is the part that matters. An owner may legitimately have remediated a payment after the migration ran, and a rollback that overwrote their correction would be a second incident caused by fixing the first. Skipped rows are returned, counted and logged, never passed over in silence.

  > This is a **named, scoped exemption**, not a privileged bypass of the set-once trigger. There is no general-purpose function that can reset a confirmation source, and none may be added.
  Stated this way the exemption is a mechanism with a name, a grant and a scope, rather than "the owner can bypass the trigger". A superuser bypassing a trigger is not an exemption anybody designed; a function whose whole body is auditable is.
- **Commands.** None.
- **Migrations.** Additive. Every existing row keeps `provenance = NULL`, which is honest: nothing has been established yet.
- **Tests.** The CHECK refuses an unknown source and an unknown method. The trigger permits the first assignment and refuses the second, and a test proves remediation cannot reach the column. **Privilege tests:** `rekoda_app` executing `rollback_provenance_manifest` is DENIED; `PUBLIC` is DENIED; the migration role is allowed. **Scope tests:** only manifest rows are touched; a row whose current value differs from the manifest's assigned value is skipped and reported rather than overwritten, so post-migration merchant remediation survives the rollback intact. **Audit tests:** the rollback DELETEs no `payment_verifications` row and no manifest row — it appends revocations and marks the manifest `ROLLED_BACK`, leaving a complete auditable record of both the migration and its undoing. Existing payment tests unaffected.
- **Feature flags.** None.
- **Deployment sequence.** Migrate, deploy.
- **Rollback.** Drop the trigger and the four columns.
- **Documentation.** Spec spec §6.2.
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
- **Documentation.** Spec spec §7.5.
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
- **Documentation.** Spec spec §6.2, spec §7.5.
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
- **Documentation.** Spec spec §6.2, §15.
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
- **Repository areas.** `packages/db/migrations/0056_ledger_grants.sql`, `packages/db/src/ledger.integration.test.ts`.
- **Schema.** `REVOKE UPDATE, DELETE ON ledger_transactions, ledger_entries FROM rekoda_app, rekoda_worker`.
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
| 1.5 | v1.6.4 corrections and consistency sweep. Six mandated corrections applied; most were already carried by 1.4 and are recorded here as confirmed rather than changed. Genuinely new: `actorType` renamed `conversationKind` (MERCHANT / CUSTOMER); **participant hash key material scoped to (businessId, channelAccountId, version)** so one customer cannot be correlated across merchants; backfill forbidden from fabricating customer participants for legacy merchant threads; customer identity and WABA identity declared separate concepts; AI boundary enforced in **both** directions, so domain and accounting code may not import provider SDKs either; away-assistant prohibition extended to destructive inventory adjustment and provider disconnect; `inventoryValue ≥ 0` and movement reconciliation added to the inventory invariants; `NEEDS_REVIEW` given exactly two permitted resolutions. Three new tests: explicit `PaymentReversal` produces the accounting reversal, `PUBLIC` cannot execute the rollback function, and the rollback DELETEs no verification or manifest row. Readiness states renamed to `ArchitectureApproval` / `EngineeringReadiness` / `ProductionEnablement` with worked examples. **Consistency sweep:** bare `§` references in the build plan qualified as `spec §` so they cannot be misread as build-plan sections; residual bare `PR-058a` references resolved to the five sub-PRs; the PR-069a/b split example marked illustrative. PR index verified at 120, matching the stated baseline. **No new PRs; no slice moved.** |
| 1.4 | v1.6.3 implementation hardening. Verification revocation separated from payment reversal, with derived `confirmationIntegrity` (spec §6.6–6.7). Claim atomicity and per-source verification identity formalised, with concurrency tests. `rollback_provenance_manifest` hardened: fixed `search_path`, schema-qualified references, `REVOKE ... FROM PUBLIC`, value-guarded row skipping, privilege test. Manifests carry full migration evidence and survive rollback. Conversation migration resequenced as expand/migrate/contract with the old constraint dropped last, plus blocking Chat regression and RLS tests. Spec gains **Appendix F**: conversation identity, partial-index NULL caveat, `participantHashVersion` rotation. `orderId` demoted to a contextual dimension beneath generic `sourceType`/`sourceId`/`postingPurpose`. Contract-asset refusal made atomic. FX resolver returns named states. Inventory invariants and exact-arithmetic rule. AI boundary enforced by `check-boundaries.mjs`. Risk tiers bind every ingress. Invoice statuses marked derived. Readiness split into ARCHITECTURE_APPROVED / ENGINEERING_READY / PRODUCTION_ENABLEMENT_READY. **No new PRs; baseline stays 120.** |
| 1.3 | v1.6.2 pre-slice patch. **The idempotency indexes could not have been created** — a partial-index predicate cannot read another table — so uniqueness moves to a `PaymentVerificationClaim` projection and the event tables stay literally append-only. Revocation-of-revocation removed; an incorrect revocation is corrected by appending a fresh verification. Manifests reclassified as operator infrastructure with no tenant RLS, kept after rollback with `status = ROLLED_BACK`, and the rollback revokes rather than deletes. The set-once exemption becomes the named `rollback_provenance_manifest` SECURITY DEFINER function. **PR-058a-1 … -5 split into five sub-PRs**, with two replacement uniqueness rules and opaque customer identity. **Weighted-average returns corrected** — a return does move the average, and holding it fixed breaks quantity × average = value. Invoice status split into lifecycle, payment and collection. FX staleness measured against the requested accounting timestamp. Documentation drift cleaned. Baseline 120. |

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
| **PR-003** | v1.6.2's claim projection and operator manifests, and v1.6.3's SECURITY DEFINER hardening, source-specific identity, atomicity and concurrency tests. |
| **F1** | Spec spec §12.3 dimensions, §12 atomic contract-asset refusal, Appendix A FX states, Appendix B costing invariants and exact arithmetic, Appendix E derived statuses. |
| **A1** | Spec Appendix C.4, enforced by the boundary check rather than by review. |
| **E1** | Spec Appendix D, applied identically to every ingress. |
| **W1/W2** | Spec Appendix F. PR-058a-1 … -5 implement the identity model; they do not decide it. |
| **PR-009** | The trigger-maintained compatibility column, never a generated one. |
| **PR-006** | **The production provenance report: run, reviewed, reconciled against its expected row counts and totals, remediation population understood, explicitly owner-approved.** None of the four is optional and application progress elsewhere is not a substitute for any of them. |

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
