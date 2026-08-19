# Rekoda — Session Handoff & Project Memory

**Purpose:** this file lets any new session (human or Claude) resume the
project with zero context loss. Read this first, then the documents it
points to. Keep it updated at the end of every working session — it is the
project's memory, and it lives in the repo so it can never be lost with a
chat.

**Last updated:** 19 August 2026 · end of M0.

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

**M0 complete, 45 tests green.** `pnpm install && pnpm test` proves it;
`pnpm demo:m0` runs the exit criterion (balanced sale → trial balance →
reconciliation MATCHED). Ten commits total on `main`.

**Next: M1** (engineering-plan §11): WhatsApp OTP onboarding → business
creation; magic links → sessions; roles; marketing site + pricing + the six
legal pages (port from VoiceReceipt's `services/legal.js`, re-skin for
Rekoda); first 6–8 SEO guides; Plausible. Design system generated with the
UI/UX Pro Max skill and persisted to `design-system/rekoda/MASTER.md`
before any page is built.

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
