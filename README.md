# Rekoda

**You run the business. Rekoda builds the records.**

Rekoda is a WhatsApp-first financial operating assistant for small businesses in Nigeria.
A merchant talks to Rekoda — text or voice note — or connects their WhatsApp Business
catalogue, and Rekoda turns business activity into structured financial records:
invoices, receipts, customer balances, inventory, a double-entry ledger, and
**reconciliation** — matching what *should* have happened against what *actually*
happened when money moved.

```
  HUMAN SAYS IT                SYSTEM SEES IT
       │                            │
  Rekoda Chat               Rekoda Integrate
  (text · voice)         (catalogue · Paystack)
       └─────────────┬──────────────┘
                     ▼
              BUSINESS EVENT
                     ▼
             PRIVACY GATEWAY        ← customer PII tokenised; audio never leaves Rekoda
                     ▼
      DETERMINISTIC FINANCIAL CORE  ← AI never computes money
                     ▼
              RECONCILIATION
                     ▼
             FINANCIAL TRUTH
          │          │         │
      WhatsApp   Dashboard   PDF / Excel
```

## Status

**M0 complete.** The deterministic financial core is built and tested: money
engine (integer kobo), double-entry ledger with balancing invariant,
reconciliation engine, document numbering, the AI border-checkpoint schemas,
and the full 30-table Postgres schema with row-level-security policies.
Milestones M1 (identity + public surface) → M5 (Integrate alpha) follow —
see [docs/engineering-plan.md](docs/engineering-plan.md).

```bash
# see the core prove itself: a balanced sale, trial balance, reconciliation
pnpm install && pnpm demo:m0
pnpm test        # 45 tests across core + contracts
```

## Documentation

| Document | Purpose |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The V1 product & system architecture specification |
| [docs/engineering-plan.md](docs/engineering-plan.md) | Review findings, stack decisions, milestones |
| [docs/pricing-model.md](docs/pricing-model.md) | Commercial model: plans, COGS, unit economics |
| [docs/content-plan.md](docs/content-plan.md) | SEO keyword map and content calendar |
| [docs/adr/](docs/adr/) | Architecture Decision Records — why things are the way they are |
| [docs/runbooks/](docs/runbooks/) | Operational runbooks (deploy, backup, incident) |

## Stack (decided — see ADRs)

TypeScript end-to-end. **NestJS** (Fastify) API · **Next.js 15** web ·
**PostgreSQL 16** with row-level security + **Drizzle** · **pg-boss** jobs ·
self-hosted **faster-whisper** STT sidecar · **Anthropic** (Sonnet-default router) ·
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
services/stt      faster-whisper sidecar (containerised)
```

## Engineering standards

* **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, …) — enforced by review.
* All work lands on `main` through PRs with green CI (typecheck, lint, tests, secret scan).
* Every significant decision gets an **ADR** before or with the code that implements it.
* **Money is integer kobo, always.** Floats never touch a financial value.
* **AI proposes, deterministic code disposes.** No AI-computed figure is ever authoritative.
* Every business-owned row is tenant-scoped by `businessId` — and enforced again by
  Postgres RLS.
* Secrets never enter the repository. `.env.example` documents every variable; a boot-time
  doctor validates them.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy and the
security principles the codebase holds to.

## License

Proprietary — see [LICENSE](LICENSE). © 2026 Angelo Akuhwa. All rights reserved.
