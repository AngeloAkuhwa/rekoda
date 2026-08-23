# Rekoda — Session Handoff & Project Memory

**Purpose:** this file lets any new session (human or Claude) resume the
project with zero context loss. Read this first, then the documents it
points to. Keep it updated at the end of every working session — it is the
project's memory, and it lives in the repo so it can never be lost with a
chat.

**Last updated:** 22 August 2026 · through PR #114. M4 complete; Doors 1 and
2 shipped. Since #100 the books became auditable and reconcilable: a shelf can
be counted, a month can be closed against a database trigger, a correction can
be written by hand, the merchant's own bank is separate from provider
settlements, a downloaded statement can be imported and matched against the
ledger, both directions of payment can be recorded from the dashboard, and
equipment is an asset that depreciates rather than a month's expense. The
chart of accounts is fifteen and still fixed. Not launched, and still almost
none of it code: see "What is still missing" below.

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

| Thing                 | Location                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions and why     | [adr/](adr/) — 26 ADRs. Two superseded (0002 by 0011, 0009 by 0012) and one still Proposed: **0013**, deferred to Phase 2. 0003 is Accepted, not pending: it was reinstated as the default          |
| Product & system spec | [architecture.md](architecture.md)                                                                                                                                                                  |
| Commercial model      | [pricing-model.md](pricing-model.md) — incl. standing review triggers                                                                                                                               |
| Milestones M0–M5      | [engineering-plan.md](engineering-plan.md) §11                                                                                                                                                      |
| SEO/content plan      | [content-plan.md](content-plan.md)                                                                                                                                                                  |
| Ops procedures        | [runbooks/](runbooks/)                                                                                                                                                                              |
| Code                  | `packages/core` (money/ledger/costing/statements — most-tested), `packages/contracts` (AI border schemas), `packages/db` (schema + RLS, migrations through 0040), `packages/shared` (branded types) |

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

**A spend entry can be withdrawn too (PR #83).** Same instrument as the
invoice void: the entry stays, gets marked, and the books carry the mirror of
its posting. The reversal is built from the ENTRIES that were written rather
than rebuilt from the row, because a purchase's posting depends on how much
was paid at the time and the row has never stored that - rebuilding would have
left whatever went to ACCOUNTS_PAYABLE standing. Stock is deliberately not
reversed and the outcome says so, because what is on the shelf is a physical
fact and only the merchant knows it.

**Both void paths had the same race, and neither was tested for it (PR #83).**
The reversal was written BEFORE the row was claimed, so two operators voiding
at once wrote two reversals and one got told `already_void` - an unexplained
entry in an append-only ledger, which is the exact thing a void exists to
prevent. The status read settles nothing: both transactions read `issued`
before either writes. Only the UPDATE decides, so the posting now comes after
it. Two concurrency tests, each verified by restoring the old order.

**The audit trail is finally readable (PR #85).** `audit_events` had been
written since M1 by five repos and read by NOTHING - the compliance record
Rekoda keeps for a merchant had never been shown to one. `/app/audit` is the
QuickBooks Audit Log equivalent and the surface an accountant asks for by
name. It is not the overview's activity strip: that answers "what happened to
my money" and this answers "who changed something, and why".

Sentences are built by `describeAuditEvent` in @rekoda/core, one case per
stored shape, with the unknown case falling back to naming the entity rather
than printing what it held. That fallback is the rule to keep: whatever a
future writer puts in `new_value` is what a merchant reads here, so a shape
this file has not seen must be DULL on the page, never loud. Every current
writer was inventoried before it was built and none stores a customer name or
a CUSTOMER_ token.

**Chat finally links somewhere (PR #86).** Until this shipped, nothing Rekoda
ever said linked anywhere at all - `REKODA_WEB_URL` appeared twice in the
whole codebase and neither was a reply. A merchant who wanted their statements
had to leave the thread, recall an address, type their number and wait for a
code that arrived back in the thread they had just left. Now "dashboard",
"my books" or "sign in" gets a one-tap link, and `/enter` exchanges it for a
session.

This is what the magic-link code was always for: the schema comment has said
"the raw token exists only in the WhatsApp message" since M1. It is NOT a
second sign-in method, and the distinction matters if anyone extends it. The
thread is already the credential - it is where the OTP is delivered and what a
CG2 confirmation moves money on - so a link into it is no weaker than the code
it saves. What keeps it narrow is that it is issued for one MEMBER, resolved
from the sending phone, so it can never carry more access than the sender
already had. A stranger gets nothing.

Delegate invites were never the use for it: those have worked by phone and OTP
since `POST /v1/auth/members` shipped, with `/app/team` in front.

**An invoice can be credited (PR #87).** The void refused any invoice with a
payment on it and told the merchant a credit note was the right instrument;
there was no such instrument, so that refusal was a dead end. Now the two
cover every invoice between them and overlap on none: the void takes unpaid
ones and mirrors the whole posting, the credit note takes the rest and reduces
without touching the cash that already moved.

The receivable is allowed to go NEGATIVE, and that is the design rather than a
bug to guard. A customer credited past what they still owe is in credit, and a
negative receivable is how a ledger says so - inventing a refunds-payable
account would have put customer credits in with what the shop owes suppliers.
VAT comes back proportionally, and the final credit on an invoice takes the
whole remaining VAT so repeated partial credits cannot strand a kobo.

`credited_k + amount <= total_k` lives inside the UPDATE. Two credits racing
would otherwise both read the same `credited_k`, both conclude there was room,
and between them take back more than the invoice was ever worth.

**Two things the browser found that the tests did not.** The register showed
nothing when an invoice had been partly credited, so a credit note existed and
the row a merchant looks at was unchanged; there is a Credited column now, in
the page and in the CSV. And all three corrections were writing
`source_type: 'system'` on their audit rows, which rendered as "Automatic"
beside a change a person had deliberately made from the dashboard. Both void
paths carried that from the start. All three now say `dashboard`.

**What is owed to suppliers is aged now (PR #88).** The receivable side has
been bucketed since the debtors page shipped and this side was one number,
which left a merchant deciding who to pay this week with no help from the half
that costs them money.

It ages differently on purpose, and the difference is not cosmetic. An invoice
carries a due date the merchant agreed, so the receivable ages by how LATE a
debt is. A purchase carries no terms - Rekoda never asks, because it stores
nothing about suppliers at all - so this ages by how long the debt has STOOD.
Calling both "overdue" would invent a deadline nobody set, and the page says
which it is.

The amount owed comes from the LEDGER, not the row: `expenses` stores what a
purchase cost and never what was paid on it, so the remainder exists only as
the ACCOUNTS_PAYABLE credit its posting wrote. That link is `ledger_transaction_id`,
added by migration 0024 for the withdraw path and reused here. Withdrawn
entries drop out by their status, which is why their reversals need no special
handling.

**A note on how the last six were found.** By grepping for exported functions
with no production caller. Every hit was a missing surface rather than dead
code: `dueForRenewal`, `applySettledCharge`, `businessForCharge`,
`refundCharge`, `upgradeRequestsFor` and `recordVoidedDocument`. The script is
worth re-running after any large slice; a function written and never called is
usually a feature somebody designed and then could not reach.

**What that sweep still shows, triaged and NOT yet built.** None of these is
a bug today; each is a surface that does not exist. Listed so the next session
inherits the triage instead of repeating it:

- **No chat-history surface** (`threadFor`, `messagesFor`, `draftsFor`), and
  Angelo decided against building one. Neither QuickBooks nor HelloBooks has a
  transcript, because neither has a chat input; what they have is an Audit Log,
  and that is what PR #85 built instead (`/app/audit`). A transcript would
  also need the vault opened on a second path besides `ReplySender`, since
  `conversation_messages.body` is stored tokenised. If it is ever revisited,
  that is the cost to weigh.
- **Ops visibility gaps**: `jobsForBusiness`, `callsToday`, `usageTotals`.
  The exception queue is now workable (PR #84) - `GET /v1/ops/exceptions` and
  `POST /v1/ops/exceptions/:id/resolve` - and it is the ONE place on that
  surface that returns rows. Angelo took that decision deliberately. Read the
  method comment before adding a second: everything else there is numbers so
  that a cross-tenant console never quietly becomes a feature, and this earns
  its exception only because an unattributed event belongs to no tenant, so if
  no operator can see it then nobody can. There is no UI: the ops surface is
  secret-gated rather than session-gated, so it has no place under `/app`, and
  `/v1/ops/margin` has been curl-only since it shipped. A small operator
  console is the natural follow-on and a deliberate one.
- **These read-backs are not dead code.** Every function in the two entries
  above is called by the integration suites as a read-back, which is a real
  and intended role - `expensesFor` was one until `spendFor` gave the
  dashboard its own query and left it where it was. The no-caller sweep means
  "no PRODUCTION caller"; check the tests before deleting anything it names.
- **`addIdentityFacet` remains uncalled**, and deliberately. PR #77 joins two
  customer records by UPDATE-ing the facet's `customer_id` rather than
  inserting a new facet, so the vault is never opened by a merge. The
  function is the right tool for a future "add this customer's email"
  flow and the wrong one for linking.
- **`settlementCipherFor`** reads back the encrypted settlement account and
  nothing needs to yet. It stays write-only until something does.

### Since PR #87: the doors, and the books becoming books

**Money out got its remaining halves (PRs #88, #89).** Accounts payable is
aged in the same buckets receivables are, because "what do I owe" with no age
on it is a number a supplier's phone call cannot be answered from. And a cost
that arrives every month whether or not anybody mentions it is a schedule now:
`recurring_entries` plus a daily sweep that CLAIMS a row before raising it, so
two sweeps racing cannot raise a month's rent twice. Entries are dated the day
they fell due, not the day the sweep caught up: a quarter of rent stamped on
one day would put three months of cost into one month's profit.

**A price list a merchant can manage (PR #90).** Prices, descriptions, photos
and a listed/hidden flag, all edited from `/app/catalogue`. Absent and null are
different throughout: a form that submits only what it changed must not wipe
what it did not, which is what `CatalogueEdit` exists to express.

**Door 2, orders somebody else wrote (PRs #91, #92).** A merchant forwards the
message a customer sent them; Rekoda parses it into names and quantities with
NO money in it, because the person who wrote it does not set the prices, and
prices it from the merchant's own catalogue. `RecordOrder` carrying no amount
is the whole design. The catalogue is re-read at the yes rather than carried on
the draft, so a price changed in between cannot issue at yesterday's figure.
The order then becomes an invoice and a payment link a customer can open.

**Door 1, the first page with no session behind it (PR #93).** `rekoda.app/s/<handle>`
is a merchant's own shop, open to anybody. The design turns on one problem: a
public page has to resolve a slug to a tenant, and `businesses` is under
row-level security keyed on the pinned tenant. A policy letting anyone read a
published business would expose the WHOLE row — plan, TIN, RC number, owner id,
the date a card last failed. So the public face of a business is its own table
holding only what the merchant published, readable by anyone and writable only
under a pin. No cart and no checkout: every item is a wa.me link with the order
already typed, which hands Door 1 to Door 2.

**What a shared link looks like (PR #94).** Icons and Open Graph cards. Two
bugs came out of asking for the images rather than trusting the build: the shop
card 500'd for every shop that had a product (Satori refuses a div with two
children, and `{count} items · order on WhatsApp` is two), and every shop page
declared the HOMEPAGE as its canonical while asking to be indexed. `apps/web`
got its first unit test and it renders to bytes, because nothing else catches a
layout the type system accepts and the renderer refuses.

**Both halves of the profit and loss now show their working (PRs #95, #97).**
`expenses.category` was free text nothing read and `invoices.sale_source` was
written and never read. Both are fixed sets now, folded deterministically —
the model's word is a hint, never the decision, because a category is what a
whole P&L groups by and a prompt revision would otherwise regroup a year of
history. Both schedules are built from LEDGER movement rather than from the
registers, which is the part to keep: a provider fee has no expense row, a
credit note is its own posting, and a void is a mirror that must come off the
month it is written in. Reading the ledger and joining outward for a label
makes each schedule tie to its statement line by construction.

That needed a column `invoices` never had. `expenses` and `credit_notes` have
carried `ledger_transaction_id` since they existed; invoices did not, so
`reverses_id` sat in the schema unwritten and nothing could get from a credit
on SALES_REVENUE back to the invoice behind it. Migration 0031 closes both.

**Open shops are in the sitemap, and the form says so (PR #96).** Slugs and
dates only: every merchant's name and number is public on their own page, and
gathering all of them into one downloadable file would be a directory rather
than a sitemap. The publish control now says an open shop is findable by search
engines and listed on rekoda.app, because "open to customers" should not
quietly mean more than a merchant read.

**The books can be opened (PR #98).** `OWNERS_EQUITY` had been in the chart
since ADR 0004 with nothing ever posted to it, so every business came into
existence holding nothing and a merchant who spent from money they already had
read a NEGATIVE cash balance. One posting, once, enforced by a partial unique
index rather than by a check the caller is trusted to make. Deliberately no box
for what customers owe: an opening receivable has no invoice behind it, so the
debtors page and the ledger would answer the same question differently.

**A sale costs something (PRs #99, #100).** `COGS` sat at code 5000 with
nothing ever posted to it, so inventory only grew and gross profit equalled
revenue. Weighted average per product, moved by deliveries, with the null
load-bearing: a product nobody has priced posts no cost and the statements say
how much revenue that was. Two postings per sale, because a sale is exact and
a cost is an estimate — which also means a void has to mirror both, a bug
caught by re-reading the diff rather than by a test. The statement gained the
shape an accountant reads: revenue, cost of sales, gross profit, running costs,
net. A merchant can state a cost by hand for stock they counted or already had.

**The chart of accounts started being touched by reporting.** At PR #100 ADR
0004's ten accounts were still unchanged, but four of them carried something
they never had: `OWNERS_EQUITY`, `COGS`, and the two schedules that break
`EXPENSES` and `SALES_REVENUE` out by category and channel WITHOUT adding
accounts. That remains the pattern to reach for first: a supporting schedule
tied to a ledger line, not a wider chart. It has since been widened twice, and
both times the reason was written down before the diff (ADR 0025, ADR 0026).

### Since PR #100: the books become auditable, and reconcile against a bank

**A shelf can be counted, and a month can be closed (PRs #101, #102).**
Inventory drifted from the ledger the moment reality did, so a stock take
posts the difference rather than overwriting a number. Then `closed_through`
plus a trigger on BOTH `ledger_transactions` and `ledger_entries`: a filed
month cannot silently change, and the refusal comes from the database rather
than from a check a caller is trusted to make. It is invoker-rights on
purpose, and the file says why. Reopening is the owner's to do, with an audit
event, because pretending otherwise just teaches merchants never to close.

**A correction a merchant can write by hand (PR #103).** Every other posting
is derived; this is the one an accountant asks for and did not find. Two
accounts and one amount, never a free line list, so there is no arrangement of
inputs that fails to balance. What it cannot express is a genuine multi-line
journal, which is a real limit and a deliberate one — and it is exactly the
limit that later made equipment disposal impossible to fake (see #114).

**The merchant's own bank, apart from settlements (PR #104, ADR 0025).**
`cashOrBank()` sent every transfer to `BANK_PAYSTACK`, so a customer paying
into a merchant's GTB account landed in an account labelled "Bank (Paystack)"
— wrong for every merchant who could currently exist, since Paystack is gated
on §47. Worse, one account holding both produced a balance matching no
statement anybody holds, so reconciliation would have been incoherent before
it was built.

That PR also found something worth remembering: **FORCE RLS applies to the
table owner**, so a data migration relabelling tenant rows updates ZERO rows
in production while passing in dev and CI, both of which run as superuser.
`applyMigrations` now refuses to run as a role without superuser or BYPASSRLS,
which is why a production migration role is on Angelo's list.

**Every statement was dropping the last days of the month (PR #105).** March
lost three days, May and July one each, and it reached all four statements
including the cumulative balance sheet. The period window added a month to a
Lagos-shifted timestamp instead of adding it to the DATE and shifting after.
Found by driving July, not by a test.

**Bank reconciliation, in five slices (PRs #106 to #109, #112).** A statement
is read from CSV or Excel with the date order inferred across the WHOLE file
and `mixed_date_order` refused outright; lines are stored append-only, keyed
by a fingerprint so re-uploading the same file changes nothing. The matching
rule is deliberately timid: exact amounts, four days either side, and a
pairing only when the line has one candidate AND that posting has one line
wanting it. A wrong match reports agreement between books and bank that does
not exist, which is the single failure the whole surface exists to catch.

What the rule refuses, a merchant decides: they may lift the date window and
the ambiguity, never the amount, because two figures a bank charge apart are
two facts. Releasing is a DELETE, so an automatic match is safe to offer at
all. `bank_line_matches` holds two unique indexes, one each way, so a
reconciliation cannot explain the same money twice.

#112 is the test that proves the SEAM: import a statement, record the payment
from the dashboard, watch it become a pairable bank movement, pair it, read a
difference of zero. Its mirror matters as much — a CASH payment must never
reach the bank reconciliation.

**Both directions of payment, from the dashboard (PRs #110, #111).** Paying a
supplier did not exist at all, and the payable ageing joined only the
purchase's OWN ledger transaction: settling a debt by journal dropped the
register to zero while the ageing reported it standing, ageing past ninety
days, forever. Two figures in one accounting product disagreeing. The ageing
now nets attributed payments and returns whatever no purchase accounts for as
`unlinkedK`, derived by subtraction, so buckets plus unlinked equal the balance
by construction rather than by diligence.

Recording money RECEIVED had existed since M1 and was reachable only from
WhatsApp: a merchant on the Bank page looking at an unexplained transfer had
to leave the dashboard to record it. It is RECORDED, never VERIFIED (ADR
0014), and the receipt register shows it as "Payment recorded".

**Equipment is not a month's expense (PRs #113, #114, ADR 0026).** A ₦450,000
generator reached `EXPENSES`, so the month of purchase reported a loss the
business did not make and every month after reported a profit it did not.
Three accounts: `EQUIPMENT`, `ACCUMULATED_DEPRECIATION` (a contra-asset
needing no special handling, because `naturalBalance` already nets debits
against credits for assets) and `DEPRECIATION`. Straight line, monthly, no
salvage; the last month absorbs the rounding so an asset depreciates to
EXACTLY its cost.

The monthly sweep shipped in the same PR deliberately: without it the feature
would be a NEW misstatement in place of the old one, holding a generator at
full price forever under a page promising a monthly charge that nothing made.

#114 exists because #113's copy told merchants to record a sale as a journal
entry, and that is impossible: `postJournal` is two accounts, a disposal needs
four lines, and there was no gain-or-loss account. ADR 0026 is amended with
the original claim STRUCK rather than rewritten. The result is measured against
BOOK VALUE, not the price paid, so depreciation already charged is never
counted twice.

**The chart is fifteen accounts now**, and the guard test in
`apps/api/src/reports/accounts.test.ts` pins the number on purpose: it is what
makes the next addition a decision somebody writes down rather than a diff.

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
   `CONNECTION_KEY` is deliberately NOT `VAULT_KEY`: account numbers are
   stored as cipher plus last4 and never echoed anywhere.
4. **A production migration role with superuser or BYPASSRLS.** New at PR
   #104 and easy to miss because nothing fails loudly: FORCE RLS applies to
   the table owner, so a data migration touching tenant rows silently updates
   ZERO of them under an ordinary role. Dev and CI both run as superuser, so
   neither can demonstrate it. `applyMigrations` now refuses to start without
   one, which turns a silent no-op into a startup error.
5. **Company facts for the legal pages.** Registered entity, address and
   support address. `/terms`, `/refunds` and `/privacy` render a visible "not
   set yet" badge wherever one is missing, so nothing can go live naming the
   wrong body, but they mean little until the facts are real.
6. **The voice benchmark** (ADR 0024, C11). 30 to 50 real Nigerian voice
   notes spanning male and female voices, Lagos and non-Lagos accents, noisy
   shops, code-switching and spoken amounts. The metric is whether the
   financial instruction came out right, not word accuracy.
7. **M5 Integrate** — the WhatsApp catalogue webhook (Door 3) is what remains,
   and it waits on Meta approval rather than on us. The note that used to sit
   here said the priority was ingesting external orders rather than building a
   native catalogue; PRs #90 to #93 built the catalogue and the shop anyway,
   and that was right: Doors 1 and 2 need no approval from anybody and they
   feed the bookkeeping rather than replacing it. Every price on the shop is
   the merchant's own, every order still becomes an invoice through the same
   engine, and Rekoda still holds no money.

### Since PR #114: one bug, found eight times

PRs #115 to #122 are almost entirely one defect wearing different clothes: a
page or a reply that describes ITS OWN PAGE and presents that as the business.
Worth reading as a group, because the shape recurs and the next one will look
new.

**Where it was only a wrong number.** The stock reply handed a merchant twenty
products as though that were the shop, and counted the empty shelves it could
see rather than the ones they have (#116). The dashboard's stock footer told a
205-product merchant they had 200. The bank page said "412 lines" above a table
of 100 (#120). The asset register, the catalogue footer, the orders list, the
billing history and the payments list all did some version of it (#119, #121,
#122).

**Where it stopped somebody working.** Order pricing scanned a 300-row page and
answered "I cannot find it in what you sell" about a product the shop stocks
and has priced (#117). Bank entries and asset disposals could not be reached at
all from the only screens that offer them (#118, #119). The catalogue's pickers
stopped at product 300, and the twelve unpriced products a merchant needed to
fix were the twelve they could not reach (#121).

**The worst one was a zero.** `unpriced` on the catalogue is what the contract
calls the number that stops a shop selling. Counted off the page it came back
as ZERO for a shop with twelve listed products nobody could buy, so the page
rendered no warning at all. Not a count that was low: a warning that was
absent.

Three shapes of fix, and which one applies is a real decision each time:

1. **Ask for what you need.** Order pricing looks products up by the names in
   the order (`catalogueByNames`); the bank page asks for movements matching
   the amounts on its own lines; `matchByHand` asks for the one id it was
   handed. The cap stops mattering rather than getting bigger.
2. **Sort so the cap drops history, not work.** The asset register puts what
   is still owned ahead of what was sold; the statement page puts lines still
   needing a decision ahead of settled ones. Only works where order is free —
   the catalogue is name-ordered ON PURPOSE, because a list that reorders
   itself when a sale lands is a list where the row you were about to change
   moves.
3. **Carry enough, and say what is missing.** Counts come from SQL over the
   whole table, never from `rows.length`, and the page says what it left out.
   All nine registers now do this; six already did.

Both limits first recorded here as open tasks are now fixed. The public shop
pages at sixty products per page (#55): sellable is filtered AND paged in SQL,
each page is self-canonical, a page past the end is a 404 and a mangled page
parameter opens page one. And `reconcile` reads the whole statement (#56):
`allBankLinesFor` walks the table in bounded chunks by id keyset, the matching
rule still runs once over the complete list (batching the RULE would let a
pairing depend on chunk placement), and the chunk size is a documented test
seam so a test can prove the walk crosses a boundary.

**A fixture that drifted by 13% of dates (#120).** Two depreciation tests went
red with no code change. `buyMonthsAgo` built its date as `monthsAgo * 30.5
days`, so on 23 August "one month ago" landed on 24 July, and an asset bought
on the 24th has not completed a month by the 23rd. `monthsElapsed` was right
and the fixture was lying. Swept across two years at three times of day it
disagreed on 1,764 of 13,140 combinations. Anything that means "a month ago"
in a test steps calendar months now.

**And one test that read as coverage and was not.** The sweep named "every
reply" ran over twelve of the sixty-two builders in `replies.ts`. It covers all
sixty-two now, with a guard that fails when somebody adds one and forgets. The
same trap caught the catalogue's api-level count test, which cannot detect the
bug it was written for (twelve products under a thousand-row cap cannot
diverge); rather than inflate the fixture it is named for what it proves and
points at the repo test that does the real work.

### The full-system audit and its five remediation PRs (23 Aug 2026)

After the cap-class campaign closed, a three-lane adversarial audit
(scalability, safety, correctness) produced roughly thirty verified findings.
Five PRs closed all of them, in severity order:

- **#124 role matrix** — RolesGuard existed on six routes; it now guards
  every write on every controller AND the chat surface. Owners do
  everything; delegates record trade; accountants read and export, plus bank
  reconciliation (annotates, moves nothing). The web turns 403s into
  sentences via ApiForbidden.
- **#125 name tokenisation** — the gateway's known-name pass replaces every
  stored customer name before a model sees it; a first mention becomes an
  encrypted facet with a token in the same transaction, and no raw name is
  persisted anywhere along the way (drafts, previews, the inbound row).
- **#126 scale and lost work** — hash-indexed matcher; (business_id, id) on
  bank lines; webhooks allow-listed past the per-IP limiter (Meta delivers
  everyone's traffic from a handful of IPs); the Meta webhook answers non-200
  on storage failure; record+enqueue in one transaction; the pump's stranded
  lane; paySupplier FOR UPDATE.
- **#127 idempotency** — clientRef on merchant payments; one pending charge
  per upgrade/pack target; folded-name unique index behind
  findOrCreateProduct; delivery lock on weighted average; stocktake advisory
  lock; closeBooks compare-and-set; Lagos years in the last three UTC
  numbering sites; the renewal backdate floor; released grace claims.
- **#128 sweeps and hardening** — every sweep drains until a short page with
  a progress guard; runExclusively elects one replica per sweep; documentById
  for deliveries; SQL-bounded exception queue; v2 AAD-bound vault blobs;
  hash-compared operator secret; strict UUID guards; a 16 MB media ceiling.

Lessons that cost time, so they are written down:

- **A batched IN over an RLS table returns nothing.** The sign-in
  membership loop is one pinned read per membership BY DESIGN; "optimising"
  it broke every invited-member test within minutes. RLS makes the pin per
  business the price of the policy.
- **The api integration suite runs against packages' BUILT dist.** After
  editing packages/db or core, rebuild before running the api suite, or the
  failures point at code that no longer exists.
- **drizzle's sql template does not bind JS arrays as postgres arrays** in
  raw execute: `= ANY(${ids})` sends a scalar. Use `IN (${sql.join(...)})`
  like openMovements does.
- **REKODA_TRUSTED_PROXIES must be set in any deployment behind a proxy**,
  or the per-IP limiter trusts any X-Forwarded-For. Unset means trust-all,
  which is only acceptable in development.

The standing process from here is docs/SYSTEM-PLAN.md: plan first, a failing
test per fix, the whole estate green serially before any push, one PR in
flight at a time.

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
9. **Never run the db and api integration suites at the same time.** They
   share one PostgreSQL and each truncates the other's fixtures, so the
   failures land in files nowhere near your change — a run once came back with
   24 failures in `auth.integration.test.ts` for a bank-page edit. Run them
   serially, and treat a surprising failure list as a scheduling question
   before a code question.
10. **A backslash inside a `sql` tagged template never reaches Postgres.**
    `regexp_replace(x, '\s+', ' ', 'g')` arrives as `'s+'` and quietly
    replaces runs of the letter s, mangling every value it touches. Use POSIX
    classes — `'[[:space:]]+'` — which need no escape. The two name-folding
    queries in `stock.ts` and `catalogue.ts` are the only regexes in any SQL
    template; keep it that way.
11. **A CI "all green" derived from an empty pending-list can be a lie.**
    GitHub registers this repo's five checks over several seconds, so a poll
    that asks "is anything pending" too early sees two registered checks, none
    pending, and reports success while three jobs are still running. Require
    the count as well as the state before merging on a poller's word, and
    confirm against the API.
12. **A page and a reply may only state numbers about the BUSINESS, never
    about their own page.** Counts come from SQL over the whole table; a
    caller that shows a page says what it left out. This is not a style
    preference — it is eight merged bug fixes (#115 to #122), and §3 has the
    three shapes of fix and when each applies.

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
- **`REKODA_WEB_URL`** on the API deployment. Chat replies link to the
  dashboard and the shop settings page shows a merchant their own
  `rekoda.app/s/<handle>`; both fall back to a local default while it is
  unset, which is right for development and wrong the moment a real merchant
  reads one.
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
- **5,000 published shops** — `/v1/shops` caps the sitemap there and reports
  `truncated`. At that point the answer is a sitemap index with one file per
  slice, not a bigger number in `SITEMAP_SHOPS`.
- **The first merchant to query their gross margin** — weighted average is
  the method (PR #99) and it is only as good as the deliveries recorded. If
  merchants routinely buy without naming a product, the honest response is to
  make the stock page's "no cost recorded" line louder, not to start
  inferring costs from amounts.
- **The first merchant whose bank statement will not parse** — the parser
  names six distinct reasons and the page translates each into something a
  person can act on. If one reason dominates real files, fix the parser for
  that bank rather than widening the rules: `mixed_date_order` in particular
  is refused on purpose, because guessing a date order across a file is how a
  reconciliation quietly matches the wrong month.
- **The first depreciation charge a merchant disputes** — straight line with
  no salvage is ADR 0026's choice, and it is defensible rather than
  universal. If merchants' accountants routinely expect reducing balance, that
  is an ADR amendment with a rate somebody has an opinion about, not a
  setting to expose.
- **Before anyone caps `reconciliationsFor`** — it is the one query on the
  payments page with no limit, and that is load-bearing rather than an
  oversight. The page says "Nothing. Every verified payment matched what was
  expected" whenever the OPEN exceptions filtered out of it come to zero, and
  that sentence is only true because the filter runs over the complete set.
  Cap it the way `paymentsFor` was capped and the sentence becomes a lie the
  first time fifty resolved rows crowd an unresolved one off the page: a
  merchant told their money is fine while it is not. If it ever needs a cap
  for load, it needs an open COUNT alongside it, and the page must read that
  rather than the array. Checked and true as of PR #122; nothing enforces it.
- **The first merchant past 10,000 invoices, receipts or expense entries** —
  every export link says "Download ALL ... as a spreadsheet" and `EXPORT_ROWS`
  stops at ten thousand with nothing reporting truncation. The number was
  chosen deliberately as roughly a decade of a busy shop, and the reasoning is
  in the controller; the word "all" is what makes it a promise rather than a
  page. Whoever gets there needs either a report of what was left out or a
  streamed export, not a bigger constant.
- **Any run where `assetsDue` returns more than a handful** — the
  depreciation sweep bounds catch-up at twelve months per asset per pass, and
  logs what it charged. A count that stays high across passes means the sweep
  is not running often enough, not that the bound is wrong.

---

_Update discipline: at the end of each session, amend §3 (status), §4
(new operational facts), and §6 (open items) in the same PR as the work._
