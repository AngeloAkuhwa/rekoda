# 0001 — Modular monolith on TypeScript (NestJS + Next.js + PostgreSQL)

**Status:** Accepted
**Date:** 2026-08-19

## Context

Rekoda V1 needs a multi-tenant financial engine, two capture channels
(Chat, Integrate), a dashboard, an admin surface, and heavy provider
integrations — built by a very small team, on a tight infrastructure budget,
with a large amount of proven prior art in TypeScript (the VoiceReceipt
codebase: money engine, PDF engine, channel layer, webhook handling,
conversation gates — all tested).

The architecture spec (§37–38) prescribes one domain, one deployment, and
logically separated modules.

## Decision

- **TypeScript end-to-end**, Node 22.
- **NestJS (Fastify adapter)** for the API: the spec's module tree maps
  one-to-one onto Nest modules; DI + guards enforce tenant scoping at the
  framework level.
- **Next.js 15 (App Router)** for marketing, guides, merchant dashboard and
  admin — SSR for SEO and fast first paint on mobile connections.
- **PostgreSQL 16** as the only database; **Drizzle ORM** (SQL-first, typed).
- **pg-boss** for background jobs (transactional enqueue with the business
  event; no Redis to operate at V1).
- **pnpm + Turborepo monorepo** with a pure, framework-free `packages/core`
  holding money, ledger, reconciliation and validation logic.
- Explicitly **not** microservices, and not a BaaS — a ledger is owned, not
  rented.

## Consequences

One deployable unit keeps ops cheap and deploys atomic. Module boundaries +
the pure core keep later extraction possible (the STT sidecar is already a
separate container, proving the seam). The cost: discipline is required to
stop modules importing each other's internals — enforced by lint rules on
import paths and by `packages/core` having zero framework dependencies.
Revisit if a single module's load profile (likely STT or document
generation) demands independent scaling beyond what job queues absorb.
