# Rekoda — Session Handoff & Project Memory

**Purpose:** this file lets any new session (human or Claude) resume the
project with zero context loss. Read this first, then the documents it
points to. Keep it updated at the end of every working session — it is the
project's memory, and it lives in the repo so it can never be lost with a
chat.

**Last updated:** 21 August 2026 · M4 complete end to end (through PR #79).
Not launched: see "What is still missing" below, which is now three WhatsApp
templates, two deployments and a set of company facts rather than code.

---

## 1. What this project is (30 seconds)

Rekoda is a WhatsApp-first financial operating assistant for Nigerian small
businesses. Merchants talk to it (text/voice) or connect their WhatsApp
catalogue + Paystack; Rekoda turns activity into invoices, receipts, a
double-entry ledger, and **reconciliation** — matching what should have
happened against what actually happened when money moved. Full story:
[architecture.md](architecture.md) (the spec) and
[engineering-plan.md](engineering-plan.md) (review, stack, milestones).

Rekoda supersedes **VoiceReceipt AI**, a working single-vendor WhatsApp
receipt bot built first (118-test Node/SQLite codebase). Rekoda is a
re-architecture, not a rewrite: the money engine, PDF engine, channel
layer, webhook handling, conversation gates, compliance layer and legal
pages port from it. The VoiceReceipt code was delivered to Angelo as
`voicereceipt-ai-v5.1.zip` — keep that file; it is the porting reference
for M2/M3 (PDF templates, Meta/Twilio channel code, conversation gates).

## 2. Where everything lives

| Thing                 | Location                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions and why     | [adr/](adr/) — 7 ADRs, all Accepted except 0003 (Paystack model, awaiting Angelo)                                                                                               |
| Product & system spec | [architecture.md](architecture.md)                                                                                                                                              |
| Commercial model      | [pricing-model.md](pricing-model.md) — incl. standing review triggers                                                                                                           |
| Milestones M0–M5      | [engineering-plan.md](engineering-plan.md) §11                                                                                                                                  |
| SEO/content plan      | [content-plan.md](content-plan.md)                                                                                                                                              |
| Ops procedures        | [runbooks/](runbooks/)                                                                                                                                                          |
| Code                  | `packages/core` (money/ledger/reconciliation — most-tested), `packages/contracts` (AI border schemas), `packages/db` (30-table schema + RLS), `packages/shared` (branded types) |

## 3. Status at handoff

**M0 complete, 45 tests green — independently re-verified 19 Aug 2026** from
the delivered bundle: `pnpm test` 45 passed (39 core + 6 contracts),
`pnpm typecheck` and `pnpm lint` clean, `pnpm demo:m0` balances
(₦160,000 = ₦160,000, MATCHED, exit ✔). The bundle has been merged with the
repository's README commit; history is now on `main` plus this branch.

**Plan revised to v3 (19 Aug 2026).** Four new ADRs and one supersession:

| ADR                           | Effect                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0011** (supersedes 0002)    | Meta charges service messages from 1 Oct 2026. ₦9,900 Chat margin is **39–60%**, not 75%+. Allowance redefined as messages **processed** (inbound + outbound).                                                                                                                                                                                      |
| **0008**                      | STT baseline becomes `intronhealth/afrispeech-whisper-medium-all` — stock `large-v3` is 30–45% WER on African-accented English. Gate metric is entity accuracy, not WER. No training flywheel without NDPA consent.                                                                                                                                 |
| **0009** (superseded by 0012) | Paystack DVAs make bank transfers verifiable per _customer_. Mechanism kept; position wrong — CAC-only, so it serves a minority.                                                                                                                                                                                                                    |
| **0012**                      | **Integrate no longer requires CAC.** Meta verification needed CAC _too_, so both halves excluded most vendors. Two ladders: capture via Rekoda storefront `/s/<handle>` or order-forwarding (no Meta); verification via open banking on the merchant's existing account (BVN + consent, no CAC). Registered-only rungs become upgrades, not gates. |
| **0010**                      | Continuous WAL archiving (PITR), RPO minutes not 24 hours, with a scripted restore drill that sweeps the ledger-balance invariant.                                                                                                                                                                                                                  |

**VoiceReceipt source supplied and verified** — `voicereceipt-ai-v5.1.zip`
delivered; **118 tests pass, 0 failed**; ~10,500 LOC / 15 service modules. The
Part 4.3 port map is now against verified-working code.

**M0 follow-ups (MASTER-PLAN Part 4.4) are all closed.** The boundary ban and
the pooled-connection leakage test are enforced in CI, jobs run pinned inside
`withBusiness` under their own row-level-security policy (ADR 0022 replaced
pg-boss with a queue in our own schema), the composite indexes landed with the
reporting layer, and the overpayment clamp is fixed: an overpayment is now a
CG1 question the merchant answers, never a figure the books round away.

**`docs/safety-review.md` is the one-page risk view** — GREEN (safe to build
now), AMBER (needs written confirmation from Paystack / counsel / Mono /
Flutterwave first), RED (never build, never claim). Its §4 lists the five that
matter most; its §5 carries the diarised review triggers.

**Design/UX method now lives in `docs/design-plan.md`** — the `ui-ux-pro-max`
and 21st.dev pipelines, ten non-negotiable UI rules, per-surface UX intent, and
the review gate. Note the verified caveat: in remote sessions only the skill's
`SKILL.md` is synced, so the design-system generation must run in a local
session with the full skill payload and be committed.

**M1 identity is complete.** The design system, marketing surface and the
four-step onboarding flow shipped in PR #9; the follow-on replaced the dev-only
in-memory store with real persistence.

- **`apps/api`** — NestJS on Fastify. Auth module (OTP request/verify, business
  creation, sessions, role guard), health endpoint reporting the applied
  migration count rather than just a live socket.
- **`packages/db/src/repos/identity.ts`** — the only place identity SQL lives.
  Rules stay in `@rekoda/core` (no database, no clock); this holds locking and
  transaction boundaries and no rules of its own.
- **ADR 0020** records the three decisions worth not rediscovering: the setup
  grant (a session is bound to a business, so onboarding needs its own
  artefact), `app.user_id` as a second narrow pin for the bootstrap read, and
  the fact that the OTP attempt limit did not survive concurrency until the
  decision moved inside an advisory lock.
- **`apps/web` can no longer assert identity** — no pool, no signing secret, no
  tenant pin.

**M2 is feature complete.** What a merchant can now do, end to end, against a
real database in CI:

- **Chat.** Inbound WhatsApp message → privacy gateway (PII tokenised before
  the model) → routed model call → conversation gates CG1-CG5 → transaction
  engine. Sales, expenses, purchases and merchant-reported payments each become
  a confirmed, balanced, numbered, audited record with a PDF that is rendered
  and delivered. Free deterministic commands answer from rows and cost nothing:
  `who owes me`, `payment details`, `records`, `resend`, `help`, `upgrade`,
  STOP/START, and a two-ask erasure.
- **Payments.** Paystack connection onboarding, intent minting, webhook
  verification server-side, attribution across tenants on the worker
  credential, booking, receipt, settlement tracking, and an exception queue a
  human can resolve. VERIFIED and RECORDED stay distinguishable everywhere they
  surface (ADR 0014) — chat, register, receipt PDF and activity feed.
- **Dashboard.** Overview, the four statements, and registers for invoices,
  receipts, spending and payments, with the sign-out and empty states each
  page needs. `/app/expenses` is the money-out half of the books: operating
  expenses, stock purchases and the accounts payable balance are three
  separate figures on purpose, because one combined "spent" number overstates
  the cost of trading by the value of the inventory still on the shelf.
  All four statements download as one dated A4 PDF from the reports page
  (`GET /v1/reports/statements.pdf?period=YYYY-MM`), which is the artefact a
  bank, a landlord or a grant officer asks for and a screen is not, and as an
  Excel workbook (`statements.xlsx`) with one sheet per statement and every
  figure a real number. The xlsx writer is ours, in `@rekoda/core`: a few
  hundred lines against a large dependency that would also be a parser, and a
  parser is attack surface for something that only ever writes. Zip entries
  are stored rather than deflated, so it pulls in no node built-in and stays
  importable anywhere core is.
- **Commercial.** Exhaustible monthly allowances consumed atomically, a
  30-day trial that actually expires, an operator plan endpoint, and cost
  telemetry per provider call including the ones that time out.
- **Operations.** A stranger messaging the number gets answered once,
  `GET /v1/ops/health` reports queue depth and webhook intake as numbers with
  no tenant named, and the job runner, attribution pump, settlement sweep and
  stranger sweep all ride the worker credential on their own clocks.
- **Stock.** On-hand is `SUM(delta)` over an append-only movement ledger and
  is never stored. A merchant counts stock in chat ("add 20 bags of rice",
  previewed and confirmed like every write), asks "stock" for what is left
  free of any model call, and a confirmed sale takes its lines off the shelf
  in the same transaction as the invoice. The dashboard has the same register.
  A recorded PURCHASE restocks the shelf too, in the same transaction as the
  money, but only when the merchant named a countable thing and a number for
  it: `RecordPurchase` carries a nullable `productMention` and `quantity`, and
  a purchase described only in prose ("restocked the shop") or a purchase of
  a service moves nothing. The prompt is explicit that a quantity must never
  be inferred from an amount, because 50k of ankara is not 50 crates and a
  guess there becomes a stock count the merchant never took.
- **M3, complete.** Voice notes transcribe through the same gates as text,
  the books answer questions from SQL with the model computing nothing, an
  owner can invite an accountant who is kept out of settings by the guard
  rather than by row-level security, and the four statements download as a
  dated A4 PDF or an Excel workbook. A profit and loss carries the prior
  month beside it, as every accounting package does.
- **The model.** There is no OpenAI default any more, so GPT-4.1 leaving the
  API on 14 Oct 2026 costs this deployment nothing: `AI_MODEL_DEFAULT` is
  `claude-haiku-4-5` (ADR 0023). At ₦1,450/$ that is ≈₦4 a call, about 10% of
  the ₦9,900 Chat subscription for a heavy merchant, where the previous
  Sonnet default was ≈₦12 and 30%. See `docs/ai-model-strategy.md`.
- **Margin.** `GET /v1/ops/margin?period=YYYY-MM` reads what `usage_events`
  has been collecting since metering shipped: plan revenue against provider
  cost, per business and per provider, for one Lagos billing month. Same
  operator secret, same worker credential, business ids and never names.
  Revenue is the plan price only, because add-on packs are priced in
  `docs/pricing-model.md` and recorded in no table yet.

**M4 is built (PRs #68 to #71).** ADR 0024 records the commercial terms
Angelo decided; `@rekoda/core/billing` implements the arithmetic, migration
0020 stores the cycle and every charge Rekoda makes, `/v1/billing` and
`/app/billing` are the merchant's surface, and the grace sweep runs the seven
days after a card fails: reminders on days 1 and 5, then read-only with the
books intact. The plan never moves on a merchant's say-so alone, only when a
provider confirms, and §47 refuses a paid change BEFORE opening a charge so
lifting the gate leaves nothing to reconcile.

**The retention schedule is published AND enforced (PRs #72, #73).**
`/privacy#retention` states maximums; `apps/api/src/privacy/retention-sweep.ts`
keeps them. Anyone who ever completed a subscription charge is excluded from
both stages. The deletion is a `SECURITY DEFINER` function the worker may
execute and nothing else: the capability is "delete a business the schedule
says is due", not "delete a business". `/refunds` publishes the matrix.

**Receipt OCR is built behind a port (PR #74).** Photo, self-hosted OCR, PII
tokenisation, then the model, with NO raw-image fallback: a failed extraction
answers the merchant and reaches no model at all, and a test asserts that
rather than a comment claiming it.

**The billing loop closes (PRs #75, #76).** `sweepRenewals` raises the charge
when a cycle ends and starts the grace clock AT the renewal date, so a sweep
that runs late neither shortens the month nor lengthens the grace. It
deliberately takes no money: card-on-file needs an authorization from a
previous payment and §47 means there has been none, so the merchant is billed
and the grace period they already have takes over. A subscription payment now
has a path at all - `billing.process`, split from `payment.process` IN THE
PUMP so our revenue can never meet their ledger. A partial payment does not
unlock a plan; an overpayment does, and the excess is a human's decision.

**Two customer records for one person, and the rule Angelo chose (PR #77).**
The gateway resolves each identity independently, so a message naming
somebody by phone AND email minted two customers. Merging automatically was
refused as a design: "Ada 0803..., send it to accounts@bigco.com" is the same
shape to a regular expression, and a wrong merge puts one customer's address
on another's invoice. The merchant is ASKED, inside the sale preview they are
already reading, and one `yes` covers both. It only fires on a real split -
exactly two customers, at least one created by that message, on a sale - and
the proposal is stored only when the question actually reached them, so a CG1
arithmetic question cannot lead to a link nobody was asked about.

**The operator can refund and can see who asked to pay (PR #78).**
`GET /v1/ops/business/:id` and `POST /v1/ops/refund`. The refund RECORDS and
does not move money, `reason` is one of ADR 0024's five published rows rather
than free text, and the plan is deliberately untouched: the matrix refunds
money in several situations that all leave the merchant with the period they
paid for.

**An invoice can be withdrawn (PR #79).** Not deleted: the invoice stays
marked `voided`, the books get the mirror of its posting, and the reason and
actor go in the audit trail. Every account nets to zero and BOTH transactions
remain, because a sale and its reversal is a different story from a sale that
never happened. Refuses any invoice money has arrived against - that wants a
refund and a credit, which is a different instrument.

**A note on how the last six were found.** By grepping for exported functions
with no production caller. Every hit was a missing surface rather than dead
code: `dueForRenewal`, `applySettledCharge`, `businessForCharge`,
`refundCharge`, `upgradeRequestsFor` and `recordVoidedDocument`. The script is
worth re-running after any large slice; a function written and never called is
usually a feature somebody designed and then could not reach.

**What that sweep still shows, triaged and NOT yet built.** None of these is
a bug today; each is a surface that does not exist. Listed so the next session
inherits the triage instead of repeating it:

- **A whole magic-link path** (`issueMagicLink`, `validateMagicLink`,
  `insertMagicLink`, `findMagicLinkByHash`, `consumeMagicLink`, and the
  `magic_links` table). Sign-in is OTP over WhatsApp and always has been.
  This looks like the intended accountant or delegate invite, beside
  `addMembership`, which is also uncalled. Decide whether delegates are
  invited by link before building either.
- **No chat-history surface** (`threadFor`, `messagesFor`, `draftsFor`). A
  merchant cannot read back what they told Rekoda, only what it recorded.
- **Ops visibility gaps**: `jobsForBusiness`, `callsToday`, `usageTotals`,
  `unprocessedEvents`. The exception queue that the Paystack pump's comments
  describe is still only readable as a count.
- **`addIdentityFacet` remains uncalled**, and deliberately. PR #77 joins two
  customer records by UPDATE-ing the facet's `customer_id` rather than
  inserting a new facet, so the vault is never opened by a merge. The
  function is the right tool for a future "add this customer's email"
  flow and the wrong one for linking.
- **`settlementCipherFor`** reads back the encrypted settlement account and
  nothing needs to yet. It stays write-only until something does.

**What is still missing before merchants.** Almost none of it is code:

1. **Three Meta-approved templates.** Authentication for sign-in codes
   (`META_OTP_TEMPLATE`), and two Utility templates: the grace reminder
   (`META_BILLING_TEMPLATE`) and the retention warning
   (`META_RETENTION_TEMPLATE`). Each has two body parameters and each fails
   in the safe direction while unset. The retention one has teeth: no
   template means no warnings means no deletions, so the published schedule
   is not actually being kept until it is approved.
2. **Two sidecars to deploy.** `STT_URL` for AfriSpeech transcription (ADR 0008) and `OCR_URL` for receipt text (ADR 0024). Both are promises the
   privacy pages make out loud, both refuse honestly while unset, and NEITHER
   may be pointed at a hosted provider without changing the page first.
3. **Credentials.** Meta WABA, Paystack test keys, and the four secrets
   (`REKODA_API_SECRET`, `REKODA_OPERATOR_SECRET`, `VAULT_KEY`, `MATCH_KEY`).
   Paystack stays in test mode until written confirmation (spec §47).
4. **Company facts for the legal pages.** Registered entity, address and
   support address. `/terms`, `/refunds` and `/privacy` render a visible "not
   set yet" badge wherever one is missing, so nothing can go live naming the
   wrong body, but they mean little until the facts are real.
5. **The voice benchmark** (ADR 0024, C11). 30 to 50 real Nigerian voice
   notes spanning male and female voices, Lagos and non-Lagos accents, noisy
   shops, code-switching and spoken amounts. The metric is whether the
   financial instruction came out right, not word accuracy.
6. **M5 Integrate** — deferred from launch by ADR 0024 and to be re-specified
   against real merchant usage. When it resumes, the priority is ingesting
   and reconciling EXTERNAL orders rather than building a native catalogue:
   the product is a bookkeeper, and turning it into commerce software before
   the bookkeeping is validated would blur what it is.

## 4. Operational facts a new session must know

1. **Pushing:** the Claude GitHub App is installed on the `AngeloAkuhwa`
   account with `rekoda` granted. A session can push **only if the repo was
   attached to it at start** (the sandbox git proxy enforces a per-session
   allowlist; pasted tokens are ignored by design). Start every working
   session with the repo attached.
2. **Two GitHub accounts exist:** `AngeloAkuhwa` (owns this repo — use
   this one) and `AngeloKindred` (collaborator). Don't mix them.
3. **Tokens:** two fine-grained PATs were pasted into chat during setup and
   are burned — Angelo must revoke them (github.com → Settings → Developer
   settings → Fine-grained tokens). The installed app replaces them; never
   request a PAT again.
4. **drizzle-kit** reads the compiled schema (`dist/schema/index.js`) —
   build `@rekoda/db` before `generate`. Migration 0001 is hand-written
   RLS; keep custom SQL migrations for policy work.
5. **CI** activates fully once `pnpm-lock.yaml` exists at root (it does);
   gitleaks scans full history on every push, and it reads a high-entropy
   string literal in a test as a credential. Compose test secrets from one
   another rather than writing new ones down.
6. **Three database URLs** are needed for the integration suites, and they are
   three different roles on purpose: `DATABASE_URL` (owner, runs migrations),
   `APP_DATABASE_URL` (`rekoda_app`, what the API holds), `WORKER_DATABASE_URL`
   (`rekoda_worker`, the only credential that reads across tenants). Running a
   suite as the owner makes every tenancy assertion pass for the wrong reason.
7. **postgres-js cannot bind a JS `Date` or an array into raw SQL.** Cast
   explicitly (`${d.toISOString()}::timestamptz`) or use the drizzle query
   builder. Coming back the other way, `tx.execute` returns `timestamptz` as a
   **string**, so wrap it in `new Date(...)` before it reaches a caller that
   expects one.
8. **Secrets are not interchangeable.** `REKODA_API_SECRET` signs setup grants;
   `REKODA_OPERATOR_SECRET` is the plaintext header for operator endpoints and
   must differ (config refuses to boot otherwise); `VAULT_KEY` seals payloads
   and `MATCH_KEY` derives match keys, and they are deliberately not the same
   as `CONNECTION_KEY`.

## 5. Working agreements with Angelo (standing preferences)

- **Security and scalability are default requirements**, not features to
  ask about. Two-layer tenant isolation, hashed tokens, encrypted vaults,
  audit trails — always.
- **No Azure** (cost). Hosting is Hetzner + Cloudflare + R2 (ADR 0006).
- **AI:** strongest affordable model — Sonnet is the runtime default
  (ADR 0007); top-tier models for build/evals; escalation is a config flag.
  No hardware purchases ever — STT is self-hosted on the rented server.
- **No zip-file deliveries** — everything through the repo as reviewable
  conventional commits. (Bundles were a one-time workaround for the proxy.)
- **UI work uses the UI/UX Pro Max skill + 21st.dev inspiration**, and
  Angelo wants to **see screenshots of UIs in chat** (light + dark, mobile
  included) when pages are built.
- Angelo welcomes **honest pushback with reasoning** — he has accepted
  several reversals of his own suggestions when argued properly (e.g. no
  WhatsApp caption branding, STOP semantics, tiered honesty copy). State
  disagreement plainly, then do what he decides.
- Plans before builds: for substantial new work, write the plan, let him
  review, then execute on "go".
- Money rules are absolute: integer kobo, deterministic computation, AI
  proposes / code disposes, no figure in any reply that didn't come from
  the deterministic layer.

## 6. Open items owned by Angelo

- **Three WhatsApp templates approved on the WABA.** Authentication for
  sign-in (`META_OTP_TEMPLATE`) — nobody can sign in until this exists — and
  two Utility templates, `META_BILLING_TEMPLATE` (days of grace left, date
  grace ends) and `META_RETENTION_TEMPLATE` (days until deletion, date).
- **Deploy the two sidecars**, `STT_URL` and `OCR_URL`. Both are marketing
  claims until they exist, and neither may be swapped for a hosted provider
  without the privacy page changing first.
- **Written confirmation before Paystack goes live** (spec §47), after live
  account verification, secured credentials, confirmed webhook verification,
  the published refund policy, and one controlled live transaction.
- **The company facts** — registered entity, address, support address — for
  `/terms`, `/refunds` and `/privacy`.
- **30 to 50 Nigerian voice notes** for the accent benchmark (ADR 0024, C11).
- Revoke the two burned PATs.
- Secure `rekoda.app` (and ideally `rekoda.ng`).
- Decide VoiceReceipt's fate for current testers (recommendation: keep it
  running, migrate testers at M3).
- CAC name alignment for the eventual Meta business verification (legal
  name must match everywhere, character for character).

## 7. Standing review triggers (do not lose these)

- **1 Sep 2026** — Meta publishes post-October service-message rates →
  re-run every COGS table in pricing-model.md (ADR 0002 assumption).
- **First 50 paying merchants** — replace pricing assumptions with
  `usage_events` telemetry.
- **M3 accent benchmark** — self-hosted STT vs provider baseline gates the
  "audio never leaves Rekoda" marketing claim (ADR 0005).
- **The first abandoned trial reaching 90 days** — the retention sweep must
  have a working `META_RETENTION_TEMPLATE` by then, or the schedule
  `/privacy` publishes stops being kept (ADR 0024).

---

_Update discipline: at the end of each session, amend §3 (status), §4
(new operational facts), and §6 (open items) in the same PR as the work._
