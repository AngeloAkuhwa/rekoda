# Rekoda — Session Handoff & Project Memory

**Purpose:** this file lets any new session (human or Claude) resume the
project with zero context loss. Read this first, then the documents it
points to. Keep it updated at the end of every working session — it is the
project's memory, and it lives in the repo so it can never be lost with a
chat.

**Last updated:** 20 August 2026 · M2 chat and dashboard feature complete
(through PR #51). Not launched: see "What is still missing" below.

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
  receipts and payments, with the sign-out and empty states each page needs.
- **Commercial.** Exhaustible monthly allowances consumed atomically, a
  30-day trial that actually expires, an operator plan endpoint, and cost
  telemetry per provider call including the ones that time out.
- **Operations.** A stranger messaging the number gets answered once,
  `GET /v1/ops/health` reports queue depth and webhook intake as numbers with
  no tenant named, and the job runner, attribution pump, settlement sweep and
  stranger sweep all ride the worker credential on their own clocks.
- **Margin.** `GET /v1/ops/margin?period=YYYY-MM` reads what `usage_events`
  has been collecting since metering shipped: plan revenue against provider
  cost, per business and per provider, for one Lagos billing month. Same
  operator secret, same worker credential, business ids and never names.
  Revenue is the plan price only, because add-on packs are priced in
  `docs/pricing-model.md` and recorded in no table yet.

**What is still missing before merchants.** In rough order:

1. **A Meta-approved authentication template.** Sign-in codes go out as a
   template (`META_OTP_TEMPLATE`); without an approved one on the WABA, nobody
   can sign in. The API refuses to boot in production if the token is set and
   the template is not, so this fails loudly rather than silently.
2. **Credentials.** Meta WABA, Paystack test keys, and the four secrets
   (`REKODA_API_SECRET`, `REKODA_OPERATOR_SECRET`, `VAULT_KEY`, `MATCH_KEY`).
   Paystack stays in test mode until written confirmation (spec §47).
3. **The remaining legal pages** — messaging policy, refund policy, contact.
   These need real business facts (address, support address, refund terms) and
   must not be invented.
4. **Model realignment.** GPT-4.1 retires from the API on 14 Oct 2026. The
   Sonnet default costs ≈₦12 a call at its standard rate, roughly 30% of the
   ₦9,900 Chat subscription for a heavy merchant; Haiku is ≈₦4, about 10%.
   See `docs/ai-model-strategy.md`.
5. **M3** — voice, conversational reporting from SQL, Excel export, accountant
   access.

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

- **Get an authentication template approved on the WABA** and set
  `META_OTP_TEMPLATE`. Nobody can sign in until this exists.
- **Written confirmation before Paystack goes live** (spec §47). Until then
  the platform stays in test mode.
- **The three legal pages** — messaging policy, refund policy, contact. These
  need real business facts and must not be written from guesses.
- Revoke the two burned PATs.
- Secure `rekoda.app` (and ideally `rekoda.ng`) — needed before M1 ships
  pages with canonical URLs.
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

---

_Update discipline: at the end of each session, amend §3 (status), §4
(new operational facts), and §6 (open items) in the same PR as the work._
