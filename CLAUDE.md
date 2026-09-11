# CLAUDE.md — the engineering entry point for Rekoda

> **Do not design or rebuild a capability until you have checked the
> existing implementation, the current product-state document, the
> canonical specification, the relevant ADRs and the tests.**
>
> **LACK OF CHAT CONTEXT IS NOT EVIDENCE THAT A FEATURE DOES NOT EXIST.**
> Rekoda is a finished 132-PR build with roughly 2,300 integration tests.
> Before implementing anything, search the code, the tests, the
> migrations, the docs, and where necessary the git history. If you cannot
> find it, say what you searched for before you conclude it is missing.

Claude Code is the engineering assistant on this repository. The workflow
is deliberately simple: Angelo assigns a task, Claude reads the canonical
docs and current state, Claude implements, normal CI runs, Angelo reviews,
the PR merges. There is no planner agent, no reviewer agent, no signed
evidence, no agent labels. (Do not confuse this with the **product's** AI:
Rekoda the product calls Anthropic Claude to interpret merchants'
messages. That is application code under `apps/api/src/ai/`, not this
file.)

## 1. What Rekoda is

**You run the business. Rekoda builds the records.** A WhatsApp-first
financial operating assistant for Nigerian small businesses. A merchant
sends a text, a voice note or a photo on WhatsApp (or uses the web
dashboard); Rekoda turns it into confirmed, numbered, audited financial
records: sales, invoices, receipts, expenses, purchases, stock, customer
balances, a double-entry ledger, the four statements, and reconciliation
of what should have happened against what actually happened when money
moved. Three products over one ledger: **Chat** (merchant talks to
Rekoda), **Integrate** (the merchant's customers transact on the
merchant's own WhatsApp and storefront), **Complete** (both). Launch is
Nigeria, NGN-only. Full definition: `docs/REKODA_CANONICAL_SPEC.md` §2–§3.

## 2. Documents, in authority order

Read in this order. When two disagree: inspect the implementation, then
tests and migrations, then accepted or superseding ADRs, then the newest
explicit owner decision; determine the actual state; fix the document.
Never resolve a conflict by picking the convenient one, and record any
material contradiction in `docs/REKODA_LAUNCH_READINESS.md`.

| #   | Document                               | Answers                                                                                        |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `docs/REKODA_CANONICAL_SPEC.md`        | What Rekoda is supposed to do (APPROVED, FROZEN, v1.6.6). Product intent, required behaviour   |
| 2   | `docs/REKODA_CURRENT_STATE.md`         | What actually exists in code today, capability by capability, with evidence                    |
| 3   | `docs/REKODA_LAUNCH_READINESS.md`      | What prevents real users, the gates, the gaps, the test journeys, the staging plan             |
| 4   | `docs/REKODA_USER_JOURNEYS.md`         | How a merchant and a customer experience each journey                                          |
| 5   | `docs/REKODA_OWNER_DECISIONS.md`       | Owner rulings (later wins until the spec absorbs them) and the external go-live register       |
| 6   | `docs/adr/`                            | Why technical decisions were made; check the Status line, superseded ADRs are history          |
| 7   | `docs/REKODA_DESIGN_SYSTEM.md`         | What a screen may claim and which UI patterns exist (tokens: `design-system/rekoda/MASTER.md`) |
| 8   | `docs/HANDOFF.md`                      | Session continuity: current SHA, last work, next actions. Operational memory, not spec         |
| 9   | `docs/REKODA_END_TO_END_BUILD_PLAN.md` | BUILD HISTORY. The completed 132-PR plan and its amendment log. Never a to-do list             |

`docs/REKODA_REFERENCE_MANIFEST.md` lists every document with its status,
authority and supersession. `docs/archive/` is history and never authority.

## 3. What is already built (do not rebuild)

Everything below exists at HEAD with tests. The evidence for each row is
in `docs/REKODA_CURRENT_STATE.md`; the short list is here so a fresh
session never starts a capability from zero.

- **Identity:** OTP over WhatsApp, setup grant, sessions, owner, accountant
  and delegate roles, operator plane with OIDC identities (`apps/api/src/auth/`).
- **Tenancy:** `withBusiness()` is the only path to tenant data; RLS on
  every business-owned table; three DB roles (owner, `rekoda_app`,
  `rekoda_worker`); an RLS exemption register enforced by tests.
- **WhatsApp channel:** Meta Cloud API webhook (signature, verify token,
  idempotency), sender with templates, STOP/START, stranger handling
  (`apps/api/src/channels/`).
- **Chat engine:** privacy gateway (PII tokenised before any model),
  deterministic router, Anthropic interpretation into a zod-validated
  command, conversation gates CG1–CG3 and CG5 (CG4 is open as G-29),
  draft/confirm by database ordinal,
  free deterministic commands (`who owes me`, `records`, `stock`,
  `resend`, `payment details`, `help`, `upgrade`, STOP/START).
- **Media:** OpenAI transcription for voice notes, Anthropic Claude vision
  for document photos, hard daily ceilings, no self-hosted sidecars
  (ADR 0032).
- **Books:** sales, invoices (issue/void), receipts, expenses, purchases,
  supplier bills, credit notes, refund, reversal and chargeback records
  (wired to provider events, G-06; live envelopes under G-05), stock
  movements and stocktakes
  with weighted-average costing, fixed assets with depreciation,
  recurring spend, opening balances, period close; append-only balanced
  ledger in integer kobo; chart of accounts per spec §11.
- **Payments:** Paystack connection, intents, server-side verification,
  attribution, booking, receipts, settlement tracking, exception queue,
  operator-recorded refunds (`POST /v1/ops/refund`; provider refund
  webhooks are G-06), bank feeds (Mono adapter, production disabled by
  readiness axes; OPay, Kuda and MonoDirectPay payment adapters exist with
  no runtime binding), bank statement matching and reconciliation tiers. Money is never held by Rekoda.
- **Reporting:** dashboard, four statements (screen, PDF, Excel),
  registers, receivables/payables, portability export, audit trail.
- **Commercial:** plans, 30-day trial, allowances and packs, subscriptions,
  renewals, grace and read-only, usage metering, provider-cost telemetry,
  margin view.
- **Operations:** in-schema job queue with worker role, sweeps, health and
  ops endpoints, retention sweep and two-ask erasure, public API with keys,
  hosted storefront `/s/<slug>`, legal pages gated at boot.

## 4. Invariants that always hold

1. **Money is integer kobo.** No float touches a financial value.
2. **AI proposes, deterministic code disposes.** The model returns a
   structured command; zod validates it; `@rekoda/core` computes every
   figure; the merchant confirms before anything posts. No AI-produced
   number is authoritative and no reply contains a figure the
   deterministic layer did not compute.
3. **Tenant data is scoped by `businessId` in code and by Postgres RLS.**
   `withBusiness()` is the only sanctioned path. The worker role reads
   across tenants only to claim a job.
4. **Customer PII lives in the vault** and travels as tokens; rehydration
   happens only in the authorised output layer. Never log a message body,
   a customer name, or a token-to-identity mapping.
5. **Webhooks: verify signature, then idempotency, then process.** Every
   time, in that order, over the raw body.
6. **Posted financial truth is immutable.** Corrections are reversing
   postings, credit notes or compensating events; a discrepancy is never
   silently absorbed. Spec-defined lifecycle transitions are allowed.
7. **Ledger postings balance or throw.**
8. **Provider failures fail safely.** A missing key degrades the feature
   honestly; a bad config value refuses to boot; a missing signature
   secret rejects every webhook.
9. **Secrets never enter source, fixtures or logs.** gitleaks scans the
   whole history in CI. `.env.example` is meant to document every variable
   the code reads; G-08 in `docs/REKODA_LAUNCH_READINESS.md` tracks the
   names where it currently disagrees with the code.
10. **Never hold, route or delay funds; never KYC a merchant's customer;
    never accept a screenshot as payment evidence** (`docs/safety-review.md`
    RED list).
11. **Every bug fix lands with a regression test that fails before the fix.**
    Never skip, disable or quarantine a failing test to get green.
12. **Accepted ADRs are immutable.** Changing course needs a superseding ADR
    or a recorded owner ruling.

## 5. How the code is laid out

Monorepo (pnpm + turbo, Node from `.nvmrc`): `apps/api` (NestJS on
Fastify: webhooks, `/v1`, auth, jobs), `apps/web` (Next.js: marketing,
legal, dashboard `/app`, storefront `/s/[slug]`), `packages/core` (pure
rules, no IO), `packages/db` (Drizzle schema, SQL migrations `0000`–`0151`,
RLS, repos in `src/repos/`), `packages/contracts` (zod borders),
`packages/shared` (branded types).

Settled idioms, match them: `withBusiness()` for tenant data; SQL in
repos under `packages/db/src/repos/`; rules in `@rekoda/core` with no
database and no clock; replies are templates fed computed values; counts
come from SQL, never `rows.length`; every double-clickable write carries a
client idempotency key; numeric config is parsed fail-closed.

| Area                      | Source                                                                                                                                                                           | Tests                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Ledger, statements, close | `packages/core/src/{ledger,chart,money,periods,statements,recognition,costing}.ts`; `packages/db/src/repos/{journal,accounts,close,opening,reports}.ts`; `apps/api/src/reports/` | `packages/core/src/*.test.ts`; `packages/db/src/{journal*,close,ledger-append-only}.integration.test.ts`          |
| Payments, Paystack, bank  | `apps/api/src/payments/`; `apps/api/src/bank/`; `packages/core/src/{payments,reconciliation,bank-matching}.ts`                                                                   | `apps/api/src/payments/*.integration.test.ts`; `packages/db/src/{payments-hub,settle*,bank*}.integration.test.ts` |
| Billing (Rekoda's own)    | `apps/api/src/billing/`; `packages/core/src/{billing,allowances,entitlements,gates}.ts`                                                                                          | `apps/api/src/billing/*.integration.test.ts`; `packages/db/src/{subscriptions,usage,quota}.integration.test.ts`   |
| Privacy, vault, retention | `apps/api/src/privacy/`; `packages/core/src/{privacy,vault,retention}.ts`                                                                                                        | `apps/api/src/privacy/*.integration.test.ts`                                                                      |
| Auth, identity, operator  | `apps/api/src/auth/`; `apps/api/src/api/`; `packages/db/src/repos/identity.ts`; `apps/web/src/server/`                                                                           | `apps/api/src/auth/*.integration.test.ts`; `apps/web/e2e/onboarding.spec.ts`                                      |
| Database, RLS             | `packages/db/migrations/`; `packages/db/src/schema/`; `packages/db/src/client.ts`                                                                                                | `packages/db/src/{rls-invariants,tenancy,tenant-fk-group-*}.integration.test.ts`                                  |
| AI, media                 | `apps/api/src/ai/`; `packages/core/src/{router,assistant,ai-cost}.ts`                                                                                                            | `apps/api/src/ai/*.test.ts`, `interpreter.integration.test.ts`, `eval/`                                           |
| WhatsApp channel          | `apps/api/src/channels/`; `apps/api/src/replies/`; `packages/core/src/{messaging,replies}.ts`                                                                                    | `apps/api/src/channels/*.integration.test.ts`; `packages/core/src/replies.test.ts`                                |
| Documents, PDF, Excel     | `apps/api/src/documents/`; `packages/core/src/{invoice-layout,receipt-layout,statement-layout,xlsx}.ts`                                                                          | `apps/api/src/documents/pdf.integration.test.ts`                                                                  |
| Dashboard, storefront     | `apps/web/src/app/app/`; `apps/web/src/app/s/[slug]/`                                                                                                                            | `apps/web/src/**/*.test.ts(x)`; `apps/web/e2e/`                                                                   |
| Stock, catalogue, orders  | `apps/api/src/catalogue/`; `apps/api/src/commands/`; `packages/db/src/repos/{stock,stocktake,catalogue,orders}.ts`                                                               | `packages/db/src/{stock,stocktake,orders}.integration.test.ts`                                                    |
| Jobs, queue, sweeps       | `apps/api/src/jobs/`; `apps/api/src/commands/{command-bus.service,outbox-dispatcher}.ts`                                                                                         | `apps/api/src/jobs/jobs.integration.test.ts`; `packages/db/src/{jobs,outbox}.integration.test.ts`                 |
| Ops, health, exceptions   | `apps/api/src/health/`; `apps/api/src/risk/`                                                                                                                                     | `apps/api/src/health/ops.integration.test.ts`                                                                     |
| Legal, compliance copy    | `apps/web/src/app/{terms,privacy,refunds,security,ai-privacy,data-deletion}/`; `apps/web/legal-gate.mjs`; `docs/compliance/`                                                     | `apps/web/src/lib/legal-gate.test.ts`; `scripts/check-retired-claims.mjs`                                         |
| Public API                | `apps/api/src/api/public/`; `packages/contracts/src/public/v1/`; `docs/openapi.json`                                                                                             | `scripts/check-openapi.mjs`                                                                                       |

## 6. How to start every task

1. Read `docs/HANDOFF.md` top section (five minutes: SHA, state, next
   actions, blockers).
2. Find the capability in `docs/REKODA_CURRENT_STATE.md`. If the task
   touches launch, find its gap ID in `docs/REKODA_LAUNCH_READINESS.md`.
3. Read the spec section and ADRs the current-state row names. Verify
   them against HEAD: open the source, the tests, the migrations.
4. Search before you design: `grep` the code and tests for the concept,
   `git log -S` when history matters. Only then decide what is missing.
5. State assumptions and any contradiction you found, then implement the
   smallest complete change with its tests.

## 7. How to finish every task

1. Verify at the depth the change warrants (`CONTRIBUTING.md` §Verification):
   targeted tests, then `pnpm turbo typecheck lint test build` and the
   guard scripts; the db then api integration suites **serially** when
   data, migrations, payments, auth or jobs changed; Playwright when web
   routes or guards changed. Rebuild packages before the api suite.
2. Report honestly what ran, what passed, what was skipped and why.
3. Update `docs/REKODA_CURRENT_STATE.md` when a capability's status
   changed, `docs/REKODA_LAUNCH_READINESS.md` when a gap opened or closed,
   and the top of `docs/HANDOFF.md` when durable project state changed.
4. Open a PR from a `feat/`, `fix/`, `docs/` or `chore/` branch with a
   Conventional Commit title and the template filled. Never push to
   `main`. Never bypass a check. Do not merge; Angelo does.
5. Before calling it merge-ready, get an independent review from a fresh
   Claude context that did not build it (read-only; given only the PR, the
   exact head SHA, the requirements, the diff, the canonical docs and the
   test evidence). Fix every valid BLOCKING or IMPORTANT finding and every
   valid Codex thread; a new SHA gets a new review. Report READY FOR OWNER
   MERGE only when CI is green on that exact SHA and no blocking finding or
   thread remains (`CONTRIBUTING.md`, "Independent review before merge").

## 8. Blocked?

- **Decision-level ambiguity** (two defensible readings with different
  product outcomes, money movement, ledger invariants, auth, tenancy,
  privacy, legal claims, a new provider): write the question, the options
  and a recommendation in the PR or in `docs/REKODA_LAUNCH_READINESS.md`
  as an OPEN OWNER DECISION. Do not guess.
- **Mechanically blocked** (missing credential, provider outage): note it
  and continue whatever is not blocked.
