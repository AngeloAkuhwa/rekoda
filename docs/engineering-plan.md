# Rekoda V1 — Engineering Review & Delivery Plan (v2)

> **Media-architecture supersession (ADR 0032, 29 Aug 2026).** Sections of
> this document describing self-hosted STT/OCR sidecars, `services/stt`,
> `STT_URL`, `STT_FALLBACK`, `OCR_URL` or the "audio never leaves Rekoda"
> posture are HISTORICAL and do not describe the current production
> media-processing architecture. The launch architecture is OpenAI for
> voice transcription and Anthropic Claude for reasoning and vision, with
> no self-hosted media sidecars — see
> [ADR 0032](adr/0032-launch-media-architecture.md).


**Prepared for:** Angelo Akuhwa
**Date:** 19 August 2026 · v2 — revised after your feedback: no Azure, strongest affordable AI, STT clarified (no hardware), UI inventory + SEO/content plan added.
**Inputs reviewed:** _Rekoda V1 Complete Product and Architecture Specification_ + the commercial/pricing model (₦9,900 / ₦19,900 / ₦29,900), against the research and the working VoiceReceipt codebase.

---

## 1. Verdict

The spec is good. It is the right shape for the product, and the three ideas at its centre are the correct ones:

1. **One financial engine, two capture channels.** Chat and Integrate as two doors into the same ledger is the single most important architectural decision in the document, and it is right.
2. **Reconciliation as the moat.** "Payment Recorded vs Payment Verified" — invoice says _should pay_, merchant says _says paid_, Paystack says _money moved_, and Rekoda connects the three — is genuinely stronger than anything Kippa, Bumpa or the invoice-generator crowd ship today.
3. **AI proposes, deterministic code disposes.** Rules 7–14 of the spec (AI never computes money, never posts to the ledger) are exactly the discipline VoiceReceipt already runs on and already has 118 tests for.

Is it new? The _combination_ is. Conversational bookkeeping exists (Kippa — dead, pivoted away), WhatsApp commerce exists (Bumpa is the closest live competitor), invoice tools exist everywhere. Nobody in this market closes the loop from catalogue order → payment webhook → reconciled ledger → "who owes me?" over voice note, with a PII boundary in front of the AI. The reconciliation loop and the privacy gateway are the two parts I could not find shipped anywhere in this segment.

---

## 2. Corrections and findings (the honest review)

### F1 — The pricing doc's biggest cost assumption is avoidable: drop Twilio for Rekoda Chat

The commercial model prices Twilio at $0.005 per message **in both directions** and builds all COGS on top of it. But Rekoda Chat runs on **Rekoda's own WhatsApp number** — and the **Meta Cloud API direct** channel is already built and tested in VoiceReceipt (webhook verification, native buttons, list replies, delivery statuses, media). Going Meta-direct for Chat removes Twilio's ₦7.25/message _entirely_; free-form service replies inside the 24-hour window currently carry **no Meta per-message fee at all**.

At 400 messages/month per Chat merchant, that is roughly **₦2,900/month of COGS that disappears** — the difference between ~45–60% and ~75%+ gross margin on the ₦9,900 plan. This surplus is also what funds the stronger AI model choice in §4.

Caveats: **Meta makes service messages chargeable on 1 October 2026** (rates publish ~1 September) — re-run the maths that day; whatever the rates, Meta-direct stays strictly cheaper than Twilio-over-Meta, since Twilio passes Meta's fees through _and_ adds its own $0.005. Twilio still earns its place in **Integrate** (per-merchant WABAs via the Tech Provider programme).

### F2 — Don't pay Twilio Verify ₦80+ per OTP; you own a WhatsApp number

Verify numbers by **sending the OTP from Rekoda's own WhatsApp number** (~₦10 authentication template), or better: the user taps a wa.me link with a prefilled code and _sends it to us_ — costs nothing and proves number control in one gesture. SMS fallback (Termii) for edge cases. This cuts the doc's ₦800–₦1,200 trial acquisition cost meaningfully.

### F3 — The privacy gateway is right, but scope it honestly

Detecting that "Ada" in a raw sentence is a person **is itself a language task** — you cannot fully de-identify text with AI before AI sees it. The workable V1:

1. **Known customers: deterministic, fully private.** Fuzzy-match against the business's own customer list inside Rekoda; replace with tokens before anything leaves. After a merchant's first week this covers most traffic, with no AI at all.
2. **Structural PII: deterministic.** Phones, emails, account numbers, addresses by rule.
3. **New, never-seen names: minimise, then vault.** A brand-new name reaches the LLM once, under Anthropic's no-training API terms; the result is vaulted and tokenised forever after.
4. **Voice: Rekoda-controlled STT from day one** — see §5, and no, this does not mean buying hardware.

Marketing must say what is true — as amended by ADR 0032: _supported customer identifiers are tokenised; voice notes and receipt photos go only to the processors named on /ai-privacy (OpenAI for transcription, Anthropic for vision), under API terms that exclude training, solely to become text; that text is tokenised before any reasoning model sees it._ There is no self-hosted media path in the launch architecture and the "audio never leaves our infrastructure" sentence is retired (ADR 0032). Never "AI never sees any name ever" and never "all PII".

### F4 — The ledger must be double-entry, and the spec doesn't say so

Commit now. Reconciliation, "financial truth," accountant trust, and every report depend on entries that always balance. Small fixed V1 chart of accounts (Cash, Bank/Paystack, AR, AP, Sales, Inventory, COGS, Expenses, VAT Payable, Equity), postings in **integer kobo** (the VoiceReceipt money engine ports directly, tests included).

### F5 — Decide how Integrate connects to a merchant's Paystack

Three routes exist: merchant's **own account + vaulted API key**, **subaccounts/split payments** ([split](https://paystack.com/docs/payments/split-payments/), [multi-split](https://paystack.com/docs/payments/multi-split-payments/)), or Paystack's **Connect** platform product. **Recommendation for V1:** merchant's own account, key stored AES-256-GCM (the vendor-SMTP vault pattern already built). Money never touches Rekoda — no settlement liability, cleanest compliance story. Record as an ADR.

### F6 — Integrate onboarding is the hardest 20%. Sequence it honestly.

Per-merchant WABAs via [Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/) / [Twilio Tech Provider](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide) mean four external approval gates per merchant (Meta business verification, display name, catalogue, Paystack). **Ship Chat publicly first; run Integrate as a concierge alpha** with 5–10 hand-held merchants before self-serve.

### F7 — Pricing: sound, with four adjustments

Launch the ladder as designed (₦9,900 / ₦19,900 / ₦29,900, 30-day/5-doc trial, add-on packs, no marketing messages, Paystack fees separate, no exposed "AI credits"), with: (1) COGS re-run on Meta-direct; (2) **soft limits** — never cut a merchant off mid-transaction, hard-stop only document generation between transactions; (3) grandfather the first cohort at launch pricing for 12+ months; (4) the §20 cost-telemetry table is an M0 build item, not an aspiration.

### F8 — What the spec is missing (and VoiceReceipt already solved)

| Gap in spec                                                               | Existing solution to port                         |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| Confirm-before-post gates, atomic claims (two rapid "yes" = one document) | CG1–CG5, `claimPendingReceipt`, race tests        |
| Webhook retry idempotency                                                 | inbound dedupe by provider message ID             |
| Paystack webhook traps (`plan: {}` truthiness bug)                        | string-only extraction + HMAC-SHA512, tested      |
| AI cost abuse                                                             | global + per-tier daily quotas, race-proof        |
| Sequential numbering, snapshots, SHA-256 hashes, audit trail              | full NG-2026.1 compliance layer, live-tested      |
| NDPA 2023 legal surface + real erasure + STOP/START                       | six env-driven pages + erasure engine, tested     |
| PDF quality (transparent-logo bug, ₦ glyphs, templates, signatures)       | imagePrep + pdfGenerator, root-caused empirically |
| Backups, environment doctor                                               | backup script + `npm run doctor`                  |

**Rekoda is a re-architecture around a bigger domain model, not a rewrite from zero.** Roughly a third of the hard-won logic ports directly.

### F9 — Two small spec nits

Distinct, non-assignable TypeScript types for `CustomerToken` / `MagicLinkToken` / `SessionId` / `ApiKeyRef` (spec §7). And one rule the spec implies but doesn't state: **AI-generated replies never contain a figure that didn't come from the deterministic layer** — reply templates receive computed numbers as parameters; the LLM never free-writes an amount.

---

## 3. Hosting — outside Azure, cheap and solid

Everything is containerised, so this choice is reversible in an afternoon. My recommendation:

| Piece                   | Choice                                                                                                                                                | Monthly cost (approx)   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Server                  | **Hetzner Cloud CPX31** (4 vCPU, 8 GB RAM, 160 GB SSD, Falkenstein or Helsinki) running Docker Compose: Caddy → web + api + stt + Postgres            | **€13.6 (~₦23k)**       |
| Edge/CDN                | **Cloudflare free tier** in front — CDN caching for Nigerian latency, WAF, free TLS, DDoS protection. Big for both page speed and SEO Core Web Vitals | ₦0                      |
| Document/object storage | **Cloudflare R2** for generated PDFs/exports (S3-compatible, **zero egress fees** — matters because customers download documents)                     | ~₦2–5k at launch volume |
| Backups                 | Nightly Postgres dumps + PDFs to **Backblaze B2**, plus Hetzner snapshots                                                                             | ~₦2–4k                  |
| Email                   | **Zoho Mail** for hello@/support@rekoda.app                                                                                                           | ₦0–3k                   |
| Transactional email     | Brevo/Resend free tier initially                                                                                                                      | ₦0                      |
| **Total at launch**     |                                                                                                                                                       | **~₦30–40k/month**      |

That is a quarter of the pricing doc's ₦75–150k early budget, and roughly **the revenue of four Chat subscribers** covers all infrastructure. Growth path: CPX41/CPX51 (vertical, minutes of downtime), then split Postgres onto its own instance or managed Postgres (Neon/Supabase-DB-only/DigitalOcean) when revenue justifies it — a compose-file change, not a rewrite.

Why Hetzner over the alternatives: DigitalOcean/Vultr are fine but ~2× the price for the same compute; Contabo is cheaper but with reliability stories I wouldn't attach to a financial product; AWS/GCP/Azure are 4–8× at this scale and buy nothing V1 needs. EU→Lagos latency (~100–140ms) is irrelevant for WhatsApp webhooks (Meta's servers are the caller) and masked by Cloudflare for the dashboard.

---

## 4. AI model strategy — strongest results the fees can afford

Your instruction: best results, not too expensive; go up when revenue allows. Here is the structure that delivers exactly that:

```
Merchant message
      ↓
Deterministic parser (₦0)          — greetings, menus, confirmations, "who owes me",
      ↓                              known commands: the majority of messages
Haiku 4.5 (~₦2/call)               — trivial classification only
      ↓
SONNET — THE DEFAULT BRAIN         — every transaction extraction, every
(~₦8 per typical call)               ambiguous sentence, financial Q&A phrasing
      ↓
Escalation tier (config flag)      — hardest disambiguations only, off at launch
```

**The call: Sonnet is the runtime default for everything that matters.** Not Haiku-first-Sonnet-on-failure — extraction quality is the product experience, and the maths says you can afford the better model outright:

- Typical extraction call ≈ 1,500 input + 250 output tokens ≈ **₦8**.
- A _heavy_ Chat merchant hitting ~250 AI-routed messages/month ≈ **₦2,000/month of AI** — comfortably inside ₦9,900, especially with the ~₦2,900 Twilio saving from F1 funding it.
- **Prompt caching** on the (large, static) system prompt cuts input cost further — cached input tokens are ~10× cheaper, and our prompts are 90% static.

Where the _very_ top model (Fable/Opus-class, ~5× Sonnet) fits: **build-time and evals, not runtime.** It writes and reviews the code, generates test cases, and referees offline evaluation of the router — places where its strength compounds. At runtime, structured extraction with a strict JSON schema is a task Sonnet does essentially at ceiling; paying 5× for it buys latency, not accuracy. The escalation tier stays in the config so that the day telemetry shows a class of message Sonnet fumbles — or the day margins make it a rounding error — flipping the strongest model on for that class is one env var, not a refactor.

Guardrails regardless of model: strict JSON-schema outputs, zod-validated before anything touches the core; per-tier daily AI quotas; the §20 cost telemetry making per-merchant AI spend visible from week one.

---

## 5. STT, in plain language — you are not buying any hardware

To be completely clear about what "self-hosted faster-whisper in a sidecar container" means:

- **Whisper is a free, openly released speech-recognition model.** `faster-whisper` is an optimised program that runs it.
- **It runs on the same rented cloud server from §3** — one more Docker container next to the API and the database. "Self-hosted" means _on our rented server_ instead of _sent to OpenAI's API_. There is no machine in your house, no GPU to buy, nothing to plug in — ever.
- A typical 45-second voice note transcribes in a few seconds on the CPX31's ordinary CPU. No per-minute fee — the cost is already inside the ₦23k server rent.
- **Why bother?** It is what makes the spec's strongest promise real: _the audio recording of your merchant saying customer names never leaves Rekoda's infrastructure._ **ADR 0027 (24 Aug 2026): this section describes the RETAINED option, not the launch configuration** — launch runs hosted transcription, named on /ai-privacy, and setting `STT_URL` brings this sidecar (and the stronger sentence) back with no code change.
- **Safety net:** a config flag can route transcription to OpenAI's API (~₦7/minute) if the M3 accent benchmark shows self-hosted accuracy isn't good enough yet for pidgin/strong accents — with the privacy page updated honestly while we tune. Either way: no hardware, no capex, no ops beyond the server we already run.

---

## 6. Stack recommendation

| Layer            | Choice                                                                                             | Why                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language         | **TypeScript (Node 24 LTS)**                                                                       | Direct reuse of proven money/PDF/webhook/conversation code; one language everywhere; strongest AI-SDK ecosystem; deep local hiring pool                    |
| API framework    | **NestJS (Fastify adapter)**                                                                       | Spec §38's module tree maps one-to-one onto Nest modules; DI + guards enforce tenant scoping at framework level                                            |
| Database         | **PostgreSQL 16 + Drizzle ORM**                                                                    | Real multi-tenant Postgres; SQL-first so every ledger query is readable; money as `BIGINT` kobo, never floats                                              |
| Tenant isolation | **Postgres Row-Level Security** keyed by per-request `app.business_id`, _plus_ query-level scoping | A forgotten `WHERE businessId` becomes a zero-rows bug, not a breach                                                                                       |
| Jobs             | **pg-boss** (Postgres-backed)                                                                      | Transactional enqueue in the same commit as the business event; no Redis to operate. BullMQ later only if throughput demands                               |
| Web              | **Next.js 15 (App Router)**                                                                        | One app: marketing + `/business/*` + `/admin/*` + legal; SSR for SEO and fast first paint on Nigerian mobile                                               |
| Monorepo         | **pnpm + Turborepo**                                                                               | `packages/core` (pure domain, zero framework imports, most-tested code), `packages/db`, `packages/contracts` (zod), `apps/api`, `apps/web`, `services/stt` |
| STT              | **OpenAI whisper-1, opt-in (ADR 0032)**                                                            | The only transcriber; no self-hosted engine exists, and enabling voice without the OpenAI key refuses to boot                                              |
| AI               | **Anthropic SDK, Sonnet-default router** (§4)                                                      | Best affordable results; strict schemas; prompt caching                                                                                                    |
| PDF / Excel      | **PDFKit (ported engine) + exceljs**                                                               | Templates, fonts, image pipeline already commercial-grade                                                                                                  |
| Payments         | Paystack (Rekoda billing; merchant-key model for Integrate per F5)                                 |                                                                                                                                                            |
| Auth             | Phone → OTP over WhatsApp (F2) → hashed single-use magic links → HTTP-only sessions                | Spec §36; discipline already exists in VoiceReceipt                                                                                                        |
| Hosting          | **Hetzner + Cloudflare + R2** (§3)                                                                 | ~₦30–40k/month all-in at launch                                                                                                                            |
| CI/CD            | GitHub Actions: typecheck, lint, tests, build, migration check per PR; deploy on tag               |                                                                                                                                                            |
| Analytics        | **Plausible (self-hosted)** — cookieless, fast, no consent-banner clutter                          | SEO-friendly and NDPA-friendly                                                                                                                             |

Rejected: Azure/AWS/GCP (cost, §3), Laravel/Django (discard the TS reuse), Go (wrong place for novelty budget), BaaS platforms (never outsource a ledger you must own), microservices (spec is right — modular monolith).

---

## 7. The UIs — full inventory

Four surfaces, and the first one is the one people forget is a UI at all.

### Surface 0 — The WhatsApp conversation (the primary product UI)

Conversation design is first-class design work: message voice and tone, confirmation cards, native buttons/lists (≤3/≤10 — already built), error recovery wording, Nigerian English/pidgin register, emoji discipline. Every conversational flow (record sale → confirm → document; "who owes me"; corrections; upgrade moments) gets specced like a screen, with copy reviewed the way pixels are.

### Surface 1 — Marketing site (public, the SEO engine)

| Page                        | Job                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                         | The promise: _"You run the business. Rekoda builds the records."_ Hero with live phone-mock demo (the animated WhatsApp mock from VoiceReceipt's landing, evolved) |
| `/chat`                     | Rekoda Chat product page — voice-note-to-records story                                                                                                             |
| `/integrate`                | Rekoda Integrate product page — catalogue → reconciliation story                                                                                                   |
| `/pricing`                  | Three-tier ladder + trial; feature comparison; Paystack-fee transparency                                                                                           |
| `/how-it-works`             | The capture → reconcile → know loop, illustrated                                                                                                                   |
| `/features`                 | Deep feature grid                                                                                                                                                  |
| `/security` + `/ai-privacy` | The tokenisation/vault/audio-never-leaves story — a trust page competitors cannot honestly copy                                                                    |
| `/guides/*`                 | The content/SEO library (§8)                                                                                                                                       |
| Legal ×6                    | privacy, terms, data-deletion, messaging-policy, refund, contact — ported from VoiceReceipt, re-skinned                                                            |
| `/start`                    | Onboarding entry                                                                                                                                                   |

### Surface 2 — Onboarding flow

`/start` → `/verify` (WhatsApp OTP) → `/setup/business` (name, type, currency) → product choice → _(Integrate path: `/setup/whatsapp` → `/setup/catalogue` → `/setup/payments`)_ → `/setup/complete` → straight into WhatsApp. Designed as a stepper, mobile-first, with the Chat path completable in under 90 seconds.

### Surface 3 — Merchant dashboard `/business/*`

Overview (financial pulse: sales, received, expenses, outstanding, unreconciled) · Transactions · Sales/Orders · Invoices · Receipts · Payments · Expenses · Customers (list + detail with balance/history) · Products & Inventory · **Reconciliation** (the needs-attention queue — the screen that sells Complete) · Reports (PDF/Excel) · Connections · Settings (profile, team/accountant, plan & billing, usage meters). Mobile-first, light+dark, read-mostly — the spec is right that WhatsApp is work and the dashboard is visibility.

### Surface 4 — Admin `/admin/*`

Platform overview · businesses · Integrate onboarding pipeline · provider health (Meta/Twilio/Paystack) · failed webhooks · reconciliation exceptions · document templates · support inbox · **per-business cost & margin** (the §20 telemetry, visualised) · admin audit.

### Design direction and tooling

- **UI/UX Pro Max** drives the design system: at M1 kickoff we generate and persist a Rekoda design system (`design-system/rekoda/MASTER.md`) — typography pairing, palette, spacing, motion tiers — then every page is built against it and checked against the skill's accessibility/pre-delivery rules (44px touch targets, 4.5:1 contrast, dark-mode parity, reduced-motion).
- **21st.dev** feeds component inspiration per milestone — already scouted: [financial hero with scroll-reveal dashboard mock](https://21st.dev/@uilayout.contact/components/hero-financial), [animated monthly/yearly pricing tables](https://21st.dev/@chowlol202/components/modern-pricing-table), [financial dashboard hub](https://21st.dev/@ravikatiyar162/components/financial-dashboard), [stat/score cards](https://21st.dev/@designali-in/components/financial-score-cards).
- Brand: evolve, don't discard — the teal-on-warm-neutral system, Calistoga/Inter pairing and dark/light toggle from VoiceReceipt tested well; M1 revisits them under the Rekoda name with the design-system pass. **Mobile-first is non-negotiable** — the median merchant will only ever see these screens on a phone.

---

## 8. SEO, content and marketing — from day one, not after launch

### Technical SEO (built into M1, free)

Next.js SSR + Cloudflare CDN for Core Web Vitals; schema.org on every page (`SoftwareApplication`, `FAQPage`, `Article`, `BreadcrumbList` — the pattern already proven on VoiceReceipt's landing); per-page OG images; sitemap/robots discipline (index marketing + guides, never documents/dashboards); clean semantic HTML from the design system; Plausible for measurement with UTM discipline on every wa.me link so we know which page converts to a WhatsApp conversation.

### Keyword strategy (the demand that already exists)

Three intent clusters, all researched earlier in this project as real Nigerian search demand:

1. **Tool-seeking:** "invoice app for small business Nigeria", "receipt maker Nigeria", "bookkeeping app for small business", "how to send invoice on WhatsApp".
2. **Problem-seeking:** "how to track customers owing me", "debtors book", "how to keep records for my business", "how to know if my business is making profit".
3. **Integrate-adjacent:** "WhatsApp Business catalogue setup", "how to receive payments on WhatsApp", "Paystack payment link WhatsApp".

### Content engine

- **Launch with 12–16 indexed guide pages**, written during M1–M2 (2/week): e.g. _Invoice requirements in Nigeria (2026)_, _How to set up a WhatsApp Business catalogue_, _VAT for small businesses: when you must and must not charge it_, _A debtors book that runs itself_, _What the 2027 e-invoicing mandate means for small businesses_. Each ends with a wa.me CTA. The compliance research is already done — these pages write themselves from work we've already verified.
- **Programmatic vertical pages** once the pattern proves: "Bookkeeping for fashion vendors / tailors / pharmacies / caterers…" — template + genuinely specific content per business type (the business-type intelligence already exists in the product's template system).
- **Distribution:** vendor communities (WhatsApp groups, Nairaland, X/NaijaTech, Instagram vendor niches), accountant partnerships (**one accountant brings 10–30 merchants** — the accountant portal is a growth wedge, not just a feature), and the built-in loop: the free-tier document credit line ("Created with Rekoda") puts the product in front of exactly the next merchant, with paid tiers clean — mechanic already built and tier-gated.
- **Launch sequencing follows F6:** content + SEO warm up during the build (domain gains age and index), Chat launches publicly to a warm channel, Integrate alpha recruits from Chat's best users.

---

## 9. Repository layout

```
rekoda/
├── apps/
│   ├── api/                  # NestJS — webhooks, api/v1, auth, jobs
│   └── web/                  # Next.js — marketing, guides, /business, /admin, legal
├── packages/
│   ├── core/                 # PURE domain: money, ledger, reconciliation,
│   │                         #   validation, numbering. No framework, no IO.
│   ├── db/                   # Drizzle schema, migrations, RLS policies, seeds
│   ├── contracts/            # zod: StructuredBusinessCommand, API DTOs
│   └── shared/               # branded types (CustomerToken ≠ MagicLinkToken), utils
├── services/
│   └── stt/                  # faster-whisper sidecar (containerised; §5)
├── design-system/rekoda/     # MASTER.md + page overrides (UI/UX Pro Max)
├── docs/
│   ├── adr/                  # 0001 modular monolith · 0002 Meta-direct Chat ·
│   │                         # 0003 Paystack merchant-key · 0004 double-entry ·
│   │                         # 0005 PII gateway scope · 0006 hosting · 0007 AI router
│   ├── architecture.md       # the spec, versioned with the code
│   ├── pricing-model.md      # the commercial doc, versioned with the code
│   ├── content-plan.md       # §8 keyword map + guide calendar
│   └── runbooks/             # deploy, backup/restore, incident, Meta submission
├── docker-compose.yml / docker-compose.dev.yml
├── .github/workflows/ci.yml
├── turbo.json / pnpm-workspace.yaml
└── README.md
```

Standards from commit one: conventional commits; PRs into `main` with CI green; ADRs for every §2 decision; `.env.example` validated by a doctor on boot; secrets never in the repo; tagged releases; issue templates matching milestones.

---

## 10. What ports from VoiceReceipt (the de-risk map)

Direct ports: money engine (integer kobo, VAT inclusive/exclusive), PDF engine (templates, styles, amount-in-words, signatures/stamps, imagePrep), Meta + Twilio channel layer, Paystack webhook handling, conversation gates, compliance layer (numbering, snapshots, hashes, audit, records export), legal surface + erasure engine + STOP/START, quotas, doctor + backup.

Redesigned: tenant model (phone-keyed vendor → Business/Membership/Roles), storage (SQLite → Postgres+RLS), intent handling (switch → BusinessEvent pipeline), and everything Integrate (new). VoiceReceipt stays runnable as the reference implementation and test oracle.

---

## 11. Delivery plan

**M0 — Foundation.** Repo scaffold, CI, docker-compose dev, `packages/core` with ported money engine + new double-entry ledger (balanced-posting invariant, property tests), full Drizzle schema for spec §39, RLS, cost-telemetry table, ADRs 0001–0007. _Exit: core invariants green; a seeded business posts a balanced sale in code._

**M1 — Identity, public surface & design system.** Rekoda design system generated and persisted (UI/UX Pro Max); WhatsApp OTP → business creation; magic links → sessions; roles; marketing site + pricing + legal pages; first 6–8 SEO guides live; Plausible wired. _Exit: a stranger goes from rekoda.app to a created business and an authenticated dashboard shell on their phone; site indexing._

**M2 — Chat MVP (text), Meta-direct.** Webhook ingress → privacy gateway v1 → Sonnet-default router → StructuredBusinessCommand → validation → transaction engine → ledger → PDFs → read-only dashboard (overview, transactions, customers, debtors). _Exit: "Ada bought 3 wigs for 150k, paid 100k" produces a confirmed, balanced, numbered, audited record and a PDF on a real WhatsApp number._

**M3 — Voice + reports.** STT sidecar live; accent benchmark vs provider baseline (go/no-go on the marketing claim); conversational reporting from SQL; PDF snapshot + Excel; accountant access; remaining guides published. _Exit: full Chat product as specced, voice included._

**M4 — Billing & metering.** Paystack subscriptions, 30-day/5-doc trial, allowance metering with soft limits, add-on packs, per-business margin view in admin. _Exit: a merchant pays ₦9,900 and their real COGS sits next to it in admin._

**M5 — Integrate alpha (concierge).** Embedded-signup onboarding for hand-held merchants; catalogue order webhooks → OrderPlaced; merchant Paystack vault; full reconciliation state machine fed by two independent sources; exception surfacing in chat + dashboard. _Exit: one real catalogue sale reconciles automatically against a real Paystack payment, untouched by hands._

---

## 12. Open decisions (yours)

1. **Repo home & license** — GitHub org/repo name; private + proprietary assumed.
2. **Domain** — is rekoda.app secured? (Grab rekoda.ng too if available.)
3. **Paystack model for Integrate** — merchant's own account with vaulted key (my recommendation) vs subaccounts.
4. **Trial detail** — confirm Integrate connection allowed during trial (doc says yes; I agree).
5. **VoiceReceipt's fate** — keep running for current testers and migrate them at M3 (my recommendation), or freeze now.

_(Hosting is now decided: Hetzner + Cloudflare + R2, no Azure. AI is decided: Sonnet-default router with an escalation flag.)_

---

## 13. What I need to start

Share the repository (URL + write access — a fine-grained PAT with contents+PR write, or connect GitHub to this workspace) and answers to §12. M0 lands as the first pushes: scaffold, CI, ported core with tests, schema, ADRs — reviewable commits, never a zip file again.

---

_Sources:_ [Paystack split payments](https://paystack.com/docs/payments/split-payments/) · [Paystack multi-split](https://paystack.com/docs/payments/multi-split-payments/) · [Paystack developers](https://paystack.com/developers) · [Meta Embedded Signup](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/) · [Meta Tech Provider onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers) · [Twilio Tech Provider guide](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide) · 21st.dev inspiration: [financial hero](https://21st.dev/@uilayout.contact/components/hero-financial), [pricing table](https://21st.dev/@chowlol202/components/modern-pricing-table), [financial dashboard](https://21st.dev/@ravikatiyar162/components/financial-dashboard), [score cards](https://21st.dev/@designali-in/components/financial-score-cards) · plus the Meta pricing, NDPA/e-invoicing and market-demand research from earlier in this project.
