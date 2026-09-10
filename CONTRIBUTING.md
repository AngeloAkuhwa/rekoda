# Contributing to Rekoda

## Workflow

1. Branch from `main`: `feat/<short-name>`, `fix/<short-name>`,
   `docs/<short-name>`, `chore/<short-name>`.
2. Open a PR into `main`. Fill the PR template. CI must be green.
3. Squash-merge with a Conventional Commit title.

Direct pushes to `main` are reserved for repository bootstrap and emergencies.
The working loop is deliberately simple: a task is assigned, the canonical
docs and `docs/REKODA_CURRENT_STATE.md` are read first, the change is
implemented with its tests, normal CI runs, the owner reviews, the PR is
squash-merged. Start every task from `CLAUDE.md` §6.

## Commit messages — Conventional Commits

```
<type>(<optional scope>): <imperative summary>

feat(core): allocate partial payments oldest-invoice-first
fix(webhooks): reject Paystack events with empty plan object
docs(adr): record hosting decision
```

Types: `feat` `fix` `docs` `chore` `refactor` `test` `perf` `ci` `build`.

## Non-negotiable code rules

These mirror the invariants in `CLAUDE.md` and `docs/REKODA_CANONICAL_SPEC.md` and are enforced in review:

- **Money is integer kobo.** No floats in any financial path.
- **AI proposes, deterministic code disposes.** AI output is a
  `StructuredBusinessCommand` validated by zod; only the transaction engine
  writes financial records; ledger postings must balance.
- **Every tenant-owned query is scoped by `businessId`** — RLS is the net,
  not the primary mechanism.
- **PII stays in the vault.** New code paths that move customer identity
  must go through the Privacy Gateway and be called out explicitly in the PR.
- **Webhooks: verify signature, then idempotency, then process.** In that order.
- **No new dependency without justification in the PR description.**

## Architecture Decision Records

Significant decisions (new dependency category, provider, data-model change,
security mechanism) require an ADR in `docs/adr/` — copy `0000-template.md`,
number it sequentially, and link it from the PR. ADRs are immutable once
accepted; supersede rather than edit.

## Verification before a PR

Verify at the depth the change warrants, and report honestly what ran,
what passed and what was skipped:

- **Docs or copy only:** `pnpm lint` over the touched files; links resolve.
- **Ordinary behaviour change:** targeted tests for the change, then
  `pnpm turbo typecheck lint test build` and the guard scripts CI runs
  (`node scripts/check-boundaries.mjs`, `check-node-version.mjs`,
  `check-ui-copy.mjs`, `check-retired-claims.mjs`, `check-openapi.mjs`).
- **Schema, migrations, payments, auth, privacy, jobs, or anything
  cross-cutting:** all of the above plus the integration suites,
  **serially, never in parallel** (they share one PostgreSQL):
  `pnpm --filter @rekoda/db test:integration` then
  `pnpm --filter @rekoda/api test:integration`. The api suite runs against
  the packages' built `dist`, so `pnpm turbo build` first. A migration also
  needs a clean replay (CI's foreign-owner job is the reference).
- **Web routes, guards or session behaviour:** Playwright
  (`pnpm --filter @rekoda/web e2e`).
- **Provider behaviour:** sandbox or live evidence, or a written reason
  why deterministic contract tests suffice.

A green tick that ran nothing is a lie. Never skip, disable or quarantine
a failing test to get green.

## Tests

`packages/core` is the most-tested code in the repo: every money/ledger
invariant gets a test, and bug fixes land with a regression test that fails
before the fix. Webhook handlers get signature + idempotency + race tests.

## Environment

Node version from `.nvmrc` (currently 24), pnpm via corepack. Copy `.env.example` to
`.env` — the application refuses to boot with missing or malformed
configuration and tells you exactly what is wrong.
