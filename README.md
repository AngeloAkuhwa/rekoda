# Rekoda

**You run the business. Rekoda builds the records.**

Rekoda is a WhatsApp-first financial operating assistant for small businesses in Nigeria.
A merchant talks to Rekoda — text or voice note — or connects their WhatsApp Business
catalogue, and Rekoda turns business activity into structured financial records:
invoices, receipts, customer balances, inventory, a double-entry ledger, and
**reconciliation** — matching what _should_ have happened against what _actually_
happened when money moved.

```
  WhatsApp / User
        │
        ▼
    Rekoda API
        │
        ├────────────────────────┬──────────────────────┐
        ▼                        ▼                      ▼
  Text / structured        Voice note             Document photo
        │                        │                      │
        │                  OpenAI STT            Claude vision
        │               (transcription only)  (reads the page into text)
        │                        │                      │
        └────────────────────────┴──────────┬───────────┘
                                            ▼
                    PRIVACY GATEWAY  ← supported customer identifiers
                                       tokenised before reasoning
                                            ▼
                    Anthropic Claude (reasoning; never computes money)
                                            ▼
                    Validated Rekoda command → CONFIRMATION GATE
                                            ▼
             DETERMINISTIC FINANCIAL CORE → ledger / invoice / receipt
                                            ▼
                                     RECONCILIATION
```

The three input paths are deliberately not identical (ADR 0032): typed text
is tokenised before any model sees it; a voice note must reach OpenAI as
audio to become text; a photographed document must reach Claude vision as
pixels to be read. Raw media is processed transiently and never persisted;
the transcript or extracted text then walks the same gateway typed text
walks before the reasoning model sees anything.

## Status

**M0 complete.** The deterministic financial core: money engine (integer kobo),
double-entry ledger with its balancing invariant, reconciliation engine,
document numbering, the AI border-checkpoint schemas, and the Postgres schema
with row-level-security policies.

**M1 identity complete.** A merchant goes from a phone number to an
authenticated dashboard: OTP over `apps/api`, business creation under RLS, and
a revocable session, all against PostgreSQL and covered end to end. Sign-in
codes go out as a WhatsApp authentication template, which needs an approved
template on the WABA (`META_OTP_TEMPLATE`).

**M2 chat and dashboard, feature complete.** An inbound WhatsApp message runs
through the privacy gateway, a routed model call, the conversation gates, and
the transaction engine: sales, expenses, purchases and merchant-reported
payments all become confirmed, balanced, numbered, audited records with a PDF.
Paystack payments are verified server-side, booked, receipted, settlement
tracked and exception queued. The dashboard carries an overview, the four
statements, and registers for invoices, receipts and payments. Usage is metered
against exhaustible plan allowances, and there is an operator health surface.

**Not yet.** Voice (M3), conversational reporting from SQL, Excel export,
accountant access, and self-service purchase. Paystack stays in test mode until
written confirmation (spec §47).

```bash
# see the core prove itself: a balanced sale, trial balance, reconciliation
pnpm install && pnpm demo:m0
pnpm test        # unit tests across core + contracts
```

### Running the stack locally

```bash
docker compose -f docker-compose.dev.yml up -d      # PostgreSQL 16

# Migrations run as the OWNER. The application never does — `rekoda_app` is
# not the table owner and has no BYPASSRLS, which is what keeps the tenant
# policies live for every query it makes.
DATABASE_URL=postgres://rekoda@localhost:5432/rekoda \
  pnpm --filter @rekoda/db migrate:apply

pnpm turbo build
pnpm --filter @rekoda/api start   # :3001 — needs DATABASE_URL (rekoda_app),
                                  # OTP_PEPPER, REKODA_API_SECRET
pnpm --filter @rekoda/web dev     # :3000 — needs REKODA_API_URL
```

`.env.example` documents every variable and says which are test-only.

```bash
# integration + end-to-end, against a real database
DATABASE_URL=... APP_DATABASE_URL=... pnpm --filter @rekoda/db test:integration
DATABASE_URL=... APP_DATABASE_URL=... pnpm --filter @rekoda/api test:integration
DATABASE_URL=... APP_DATABASE_URL=... pnpm --filter @rekoda/web e2e
node scripts/check-boundaries.mjs   # architectural boundaries
```

These suites **fail rather than skip** when the database is missing: an
integration run that quietly passes with nothing behind it reports the same
green tick as one that proved something.

## Documentation

| Document                                             | Purpose                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)         | The V1 product & system architecture specification              |
| [docs/engineering-plan.md](docs/engineering-plan.md) | Review findings, stack decisions, milestones                    |
| [docs/pricing-model.md](docs/pricing-model.md)       | Commercial model: plans, COGS, unit economics                   |
| [docs/content-plan.md](docs/content-plan.md)         | SEO keyword map and content calendar                            |
| [docs/adr/](docs/adr/)                               | Architecture Decision Records — why things are the way they are |
| [docs/runbooks/](docs/runbooks/)                     | Operational runbooks (deploy, backup, incident)                 |

## Stack (decided — see ADRs)

TypeScript end-to-end. **NestJS** (Fastify) API · **Next.js 15** web ·
**PostgreSQL 16** with row-level security + **Drizzle** · **pg-boss** jobs ·
**OpenAI** transcription (voice, opt-in) · **Anthropic** Claude (reasoning + vision) ·
**PDFKit**/exceljs documents · **Paystack** billing · pnpm + Turborepo monorepo ·
Hetzner + Cloudflare + R2 hosting.

Planned layout:

```
apps/api          NestJS — webhooks, api/v1, auth, jobs
apps/web          Next.js — marketing, guides, /business, /admin, legal
packages/core     Pure domain: money, ledger, reconciliation (no framework, no IO)
packages/db       Drizzle schema, migrations, RLS policies, seeds
packages/contracts  zod schemas shared API ↔ web
packages/shared   Branded types, utilities
```

There is no self-hosted STT or OCR service in the launch architecture
(ADR 0032): OpenAI transcribes, Claude reads and reasons, and each media
feature is an explicit opt-in that refuses to boot without its provider
key.

## Engineering standards

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, …) — enforced by review.
- All work lands on `main` through PRs with green CI (typecheck, lint, tests, secret scan).
- Every significant decision gets an **ADR** before or with the code that implements it.
- **Money is integer kobo, always.** Floats never touch a financial value.
- **AI proposes, deterministic code disposes.** No AI-computed figure is ever authoritative.
- Every business-owned row is tenant-scoped by `businessId` — and enforced again by
  Postgres RLS.
- Secrets never enter the repository. `.env.example` documents every variable; a boot-time
  doctor validates them.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy and the
security principles the codebase holds to.

## License

Proprietary — see [LICENSE](LICENSE). © 2026 Angelo Akuhwa. All rights reserved.
