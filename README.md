# Rekoda

**You run the business. Rekoda builds the records.**

Rekoda is a WhatsApp-first financial operating assistant for small businesses
in Nigeria. A merchant talks to Rekoda on WhatsApp (text, a voice note, a
photo of a receipt) or uses the web dashboard, and Rekoda turns that activity
into records that hold up: invoices, receipts, customer and supplier balances,
stock, a double-entry ledger, the four financial statements, and
**reconciliation** of what should have happened against what actually
happened when money moved.

**Who it is for.** Nigerian traders and small service businesses that already
run their business in WhatsApp and cannot produce books when a bank, a buyer
or the tax authority asks. Launch is Nigeria and naira only.

**Maturity.** Pre-launch. The build plan is complete and the test estate is
large, but Rekoda has never been deployed and no live provider has been
exercised. The launch verdict and every open gap are in
[docs/REKODA_LAUNCH_READINESS.md](docs/REKODA_LAUNCH_READINESS.md).

## Product surfaces

| Surface                    | What it does                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Rekoda Chat** (WhatsApp) | The merchant tells Rekoda what happened; Rekoda previews, the merchant confirms, a numbered, audited record and a PDF come back. Free deterministic commands: `who owes me`, `records`, `stock`, `resend`, `payment details`, `help`, STOP/START |
| **Dashboard** (`/app`)     | Overview, invoices and quotes, receipts, debtors, expenses and purchases, stock and catalogue, bank reconciliation, payments, reports (P&L, balance sheet, cash flow, trial balance, VAT), audit trail, team, billing, settings, exports         |
| **Rekoda Integrate**       | The merchant's customers order on a hosted storefront (`/s/<slug>`) or the merchant's own WhatsApp catalogue and pay by transfer; the same ledger receives the sale. Merchant-owned WhatsApp connection waits on Meta app review                 |
| **Public API** (`/api/v1`) | Keys, sales and payments writes, customers, products and invoices reads, signed outbound webhooks. Reference: [docs/public-api.md](docs/public-api.md)                                                                                           |
| **Marketing and legal**    | `/`, `/pricing`, `/privacy`, `/terms`, `/refunds`, `/security`, `/ai-privacy`, `/data-deletion`                                                                                                                                                  |

## Architecture in one picture

```
WhatsApp (Meta Cloud API)          Web dashboard / storefront / public API
        │  signed webhook                       │  session or API key
        ▼                                       ▼
  ┌──────────────────────── apps/api (NestJS on Fastify) ────────────────────────┐
  │ verify signature → idempotency → job queue (rekoda_worker)                     │
  │ text ──► PRIVACY GATEWAY (PII tokenised) ──► deterministic router             │
  │ voice ─► OpenAI transcription ─┐            └─► Anthropic Claude interprets    │
  │ photo ─► Claude vision reads ──┘                 into a zod-validated command  │
  │                     CONVERSATION GATES: arithmetic check, preview, one "yes"   │
  │                     COMMAND LAYER → DETERMINISTIC FINANCIAL CORE (@rekoda/core)│
  │                     integer kobo · balanced postings · append-only ledger      │
  └───────────────────────────────┬────────────────────────────────────────────────┘
                                  ▼
             PostgreSQL 16 with row-level security (packages/db)
             one business, one ledger, whichever door the event came through
```

Money is integer kobo. AI proposes; deterministic code disposes. Tenant data
is scoped in code and again by Postgres RLS. Customer PII lives in an
encrypted vault and travels as tokens. Webhooks are verified, then
deduplicated, then processed. Posted financial truth is never edited;
corrections are new postings. Raw voice and image media are processed by
the disclosed hosted provider and never persisted (ADR 0032).

## Repository layout

```
apps/api            NestJS: webhooks, /v1 and /api/v1, auth, jobs, sweeps
apps/web            Next.js: marketing, legal, dashboard (/app), storefront (/s)
packages/core       Pure domain rules: money, ledger, statements, gates, replies (no IO)
packages/db         Drizzle schema, SQL migrations 0000–0149, RLS policies, repos
packages/contracts  zod schemas shared between api, web and the AI border
packages/shared     Branded types and utilities
scripts/            CI guard scripts (boundaries, node version, UI copy, retired claims, OpenAPI)
docs/               Canonical documentation (see below)
```

Stack: TypeScript end to end, NestJS 11 on Fastify, Next.js 16, PostgreSQL 16
with Drizzle, an in-schema job queue (ADR 0022), pdfkit and a hand-rolled
xlsx writer, Anthropic Claude (reasoning and vision), OpenAI (transcription),
Meta WhatsApp Cloud API, Paystack, Cloudflare R2. pnpm 9 and Turborepo. Node
version from `.nvmrc`.

## Local setup

Prerequisites: Node per `.nvmrc` (24), pnpm via corepack, Docker (for
PostgreSQL) or a local PostgreSQL 16.

```bash
pnpm install --frozen-lockfile
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL 16 on 127.0.0.1:5432

# Migrations run as the OWNER role. The application runs as rekoda_app, which
# is not the table owner and cannot bypass RLS.
DATABASE_URL=postgres://rekoda@127.0.0.1:5432/rekoda pnpm --filter @rekoda/db migrate:apply

pnpm turbo build
cp .env.example .env            # fill the required keys; the API names any missing value at boot
pnpm --filter @rekoda/api start  # :3001 (set REKODA_WORKER=1 to also run the queue and sweeps)
pnpm --filter @rekoda/web dev    # :3000, needs REKODA_API_URL
```

Without provider keys the stack still boots: inbound messages are recorded
and answered in the database, the deterministic router answers without a
model, and voice and image features answer honestly that they are off.

## Test commands

```bash
pnpm turbo typecheck lint test build          # unit tests across every package
node scripts/check-boundaries.mjs             # architectural boundaries (CI runs five guard scripts)

# Integration suites need a real PostgreSQL and three roles; run them SERIALLY.
DATABASE_URL=postgres://rekoda@127.0.0.1:5432/rekoda \
APP_DATABASE_URL=postgres://rekoda_app@127.0.0.1:5432/rekoda \
WORKER_DATABASE_URL=postgres://rekoda_worker@127.0.0.1:5432/rekoda \
  pnpm --filter @rekoda/db test:integration
# then, with the same variables:
  pnpm --filter @rekoda/api test:integration

pnpm --filter @rekoda/web e2e                 # Playwright against a production build (CI shape)
```

These suites fail rather than skip when the database is missing. CI runs a
full-history secret scan, typecheck/lint/test/build with the guard scripts, a
foreign-owner migration replay, the two integration suites and Playwright on
every pull request.

## Documentation

Start at [CLAUDE.md](CLAUDE.md) (the engineering entry point and the rules),
then [docs/REKODA_REFERENCE_MANIFEST.md](docs/REKODA_REFERENCE_MANIFEST.md),
which classifies every document.

| Document                                                           | Purpose                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [docs/REKODA_CANONICAL_SPEC.md](docs/REKODA_CANONICAL_SPEC.md)     | What Rekoda is supposed to do (authoritative, frozen)            |
| [docs/REKODA_CURRENT_STATE.md](docs/REKODA_CURRENT_STATE.md)       | What exists in code today, with evidence                         |
| [docs/REKODA_LAUNCH_READINESS.md](docs/REKODA_LAUNCH_READINESS.md) | What blocks real users: gates, gaps, test journeys, staging plan |
| [docs/REKODA_USER_JOURNEYS.md](docs/REKODA_USER_JOURNEYS.md)       | The merchant and customer journeys                               |
| [docs/REKODA_OWNER_DECISIONS.md](docs/REKODA_OWNER_DECISIONS.md)   | Owner rulings and the external go-live register                  |
| [docs/adr/](docs/adr/)                                             | Why technical decisions were made                                |
| [docs/runbooks/](docs/runbooks/)                                   | Deploy, backup and restore, incident, key rotation, data erasure |
| [docs/HANDOFF.md](docs/HANDOFF.md)                                 | Session continuity: current SHA, last work, next actions         |

## Contributing and security

Branch from `main`, open a pull request, keep CI green, squash-merge with a
Conventional Commit title: [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerability
disclosure and the security principles the codebase holds to:
[SECURITY.md](SECURITY.md).

## License

Proprietary. See [LICENSE](LICENSE). © 2026 Angelo Akuhwa. All rights reserved.
