# Rekoda — Session Handoff & Project Memory

**Purpose:** this file lets any new session (human or Claude) resume the
project with zero context loss. Read this first, then the documents it
points to. Keep it updated at the end of every working session — it is the
project's memory, and it lives in the repo so it can never be lost with a
chat.

**Last updated:** 19 August 2026 · M1 identity complete (PR #9 merged, identity
persistence follow-on in review).

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

| Thing | Location |
|---|---|
| Decisions and why | [adr/](adr/) — 7 ADRs, all Accepted except 0003 (Paystack model, awaiting Angelo) |
| Product & system spec | [architecture.md](architecture.md) |
| Commercial model | [pricing-model.md](pricing-model.md) — incl. standing review triggers |
| Milestones M0–M5 | [engineering-plan.md](engineering-plan.md) §11 |
| SEO/content plan | [content-plan.md](content-plan.md) |
| Ops procedures | [runbooks/](runbooks/) |
| Code | `packages/core` (money/ledger/reconciliation — most-tested), `packages/contracts` (AI border schemas), `packages/db` (30-table schema + RLS), `packages/shared` (branded types) |

## 3. Status at handoff

**M0 complete, 45 tests green — independently re-verified 19 Aug 2026** from
the delivered bundle: `pnpm test` 45 passed (39 core + 6 contracts),
`pnpm typecheck` and `pnpm lint` clean, `pnpm demo:m0` balances
(₦160,000 = ₦160,000, MATCHED, exit ✔). The bundle has been merged with the
repository's README commit; history is now on `main` plus this branch.

**Plan revised to v3 (19 Aug 2026).** Four new ADRs and one supersession:

| ADR | Effect |
|---|---|
| **0011** (supersedes 0002) | Meta charges service messages from 1 Oct 2026. ₦9,900 Chat margin is **39–60%**, not 75%+. Allowance redefined as messages **processed** (inbound + outbound). |
| **0008** | STT baseline becomes `intronhealth/afrispeech-whisper-medium-all` — stock `large-v3` is 30–45% WER on African-accented English. Gate metric is entity accuracy, not WER. No training flywheel without NDPA consent. |
| **0009** (superseded by 0012) | Paystack DVAs make bank transfers verifiable per *customer*. Mechanism kept; position wrong — CAC-only, so it serves a minority. |
| **0012** | **Integrate no longer requires CAC.** Meta verification needed CAC *too*, so both halves excluded most vendors. Two ladders: capture via Rekoda storefront `/s/<handle>` or order-forwarding (no Meta); verification via open banking on the merchant's existing account (BVN + consent, no CAC). Registered-only rungs become upgrades, not gates. |
| **0010** | Continuous WAL archiving (PITR), RPO minutes not 24 hours, with a scripted restore drill that sweeps the ledger-balance invariant. |

**VoiceReceipt source supplied and verified** — `voicereceipt-ai-v5.1.zip`
delivered; **118 tests pass, 0 failed**; ~10,500 LOC / 15 service modules. The
Part 4.3 port map is now against verified-working code.

**M0 follow-ups are listed in MASTER-PLAN Part 4.4.** Three are now **done**
(#1 boundary ban, #2 pooled-connection leakage test, #5 `businesses` INSERT
helper). Still open: **#3** pg-boss jobs must run inside `withBusiness`,
**#4** composite indexes on the debtors and reconciliation queues, and the two
money-engine consistency fixes — **#6 is a real defect**: `computeMoney`
silently clamps overpayment while `applyPayment` refuses it, so "sold for
₦100k, she paid ₦150k" becomes ₦100k instead of surfacing as an exception.
That contradicts the rule that mismatches are flagged, never fixed.

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
four-step onboarding flow shipped in PR #9. The follow-on replaced the dev-only
in-memory store with real persistence:

* **`apps/api`** — NestJS on Fastify. Auth module (OTP request/verify, business
  creation, sessions, role guard), health endpoint reporting the applied
  migration count rather than just a live socket.
* **`packages/db/src/repos/identity.ts`** — the only place identity SQL lives.
  Rules stay in `@rekoda/core` (no database, no clock); this holds locking and
  transaction boundaries and no rules of its own.
* **ADR 0020** records the three decisions worth not rediscovering: the setup
  grant (a session is bound to a business, so onboarding needs its own
  artefact), `app.user_id` as a second narrow pin for the bootstrap read, and
  the fact that the OTP attempt limit did not survive concurrency until the
  decision moved inside an advisory lock.
* **`apps/web` can no longer assert identity** — no pool, no signing secret, no
  tenant pin. The interim signed-cookie marker is deleted.

**Known gap, deliberate:** OTP delivery. The code is issued and verified
against a real row, but nothing sends it over WhatsApp until the M2 channel
layer. `REKODA_REVEAL_OTP` exists for the test suite and the API refuses to
boot with it set when `NODE_ENV=production`.

**Recommended next**, in order:
1. **Self-host the fonts** (`next/font/google`). `layout.tsx` currently loads
   Calistoga + Inter via a render-blocking `fonts.googleapis.com` stylesheet —
   a third-party round trip on the critical path for merchants on exactly the
   slow mobile networks Rekoda targets. Small change, measurable win.
2. **MASTER-PLAN 4.4 #6** — the overpayment clamp. It is a correctness bug in
   the money engine, and money bugs get more expensive the longer they sit.
3. **M2 channel layer** — which unblocks real OTP delivery and the magic-link
   HTTP surface in one go.
4. Remaining marketing and the six legal pages (port from VoiceReceipt's
   `services/legal.js`).

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
   gitleaks scans full history on every push.

## 5. Working agreements with Angelo (standing preferences)

* **Security and scalability are default requirements**, not features to
  ask about. Two-layer tenant isolation, hashed tokens, encrypted vaults,
  audit trails — always.
* **No Azure** (cost). Hosting is Hetzner + Cloudflare + R2 (ADR 0006).
* **AI:** strongest affordable model — Sonnet is the runtime default
  (ADR 0007); top-tier models for build/evals; escalation is a config flag.
  No hardware purchases ever — STT is self-hosted on the rented server.
* **No zip-file deliveries** — everything through the repo as reviewable
  conventional commits. (Bundles were a one-time workaround for the proxy.)
* **UI work uses the UI/UX Pro Max skill + 21st.dev inspiration**, and
  Angelo wants to **see screenshots of UIs in chat** (light + dark, mobile
  included) when pages are built.
* Angelo welcomes **honest pushback with reasoning** — he has accepted
  several reversals of his own suggestions when argued properly (e.g. no
  WhatsApp caption branding, STOP semantics, tiered honesty copy). State
  disagreement plainly, then do what he decides.
* Plans before builds: for substantial new work, write the plan, let him
  review, then execute on "go".
* Money rules are absolute: integer kobo, deterministic computation, AI
  proposes / code disposes, no figure in any reply that didn't come from
  the deterministic layer.

## 6. Open items owned by Angelo

* Confirm ADR 0003 (Paystack: merchant-owned account with vaulted key).
* Revoke the two burned PATs.
* Secure `rekoda.app` (and ideally `rekoda.ng`) — needed before M1 ships
  pages with canonical URLs.
* Decide VoiceReceipt's fate for current testers (recommendation: keep it
  running, migrate testers at M3).
* CAC name alignment for the eventual Meta business verification (legal
  name must match everywhere, character for character).

## 7. Standing review triggers (do not lose these)

* **1 Sep 2026** — Meta publishes post-October service-message rates →
  re-run every COGS table in pricing-model.md (ADR 0002 assumption).
* **First 50 paying merchants** — replace pricing assumptions with
  `usage_events` telemetry.
* **M3 accent benchmark** — self-hosted STT vs provider baseline gates the
  "audio never leaves Rekoda" marketing claim (ADR 0005).

---

*Update discipline: at the end of each session, amend §3 (status), §4
(new operational facts), and §6 (open items) in the same PR as the work.*
