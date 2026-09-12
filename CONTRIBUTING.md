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

- **Docs or copy only:** `pnpm lint` does not look at Markdown (every
  workspace lints its own `src`), so run `pnpm docs:check` (Prettier over
  every root, `docs/` and `.github/` Markdown file); links resolve; any status
  claim matches the code.
- **Ordinary behaviour change:** targeted tests for the change, then
  `pnpm turbo typecheck lint test build` and the guard scripts CI runs
  (`node scripts/check-boundaries.mjs`, `check-env-example.mjs` after its
  fixture test `node --test scripts/check-env-example.test.mjs`,
  `check-deploy.mjs` after `node --test scripts/check-deploy.test.mjs`,
  `check-node-version.mjs`, `check-ui-copy.mjs`, `check-retired-claims.mjs`,
  `check-openapi.mjs`).
- **Deployment files** (`Dockerfile`, `docker-compose.prod.yml`, `deploy/`):
  `pnpm deploy:check` and `pnpm env:check`, then the CI "Deployment (Docker)"
  job, which boots the stack with `bash scripts/deploy-smoke.sh` (it needs a
  Docker engine and free ports 80 and 443; it refuses to run where a `.env`
  already exists).
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

## Independent review before merge

Every feature or fix gets a second look from a Claude session that did not
build it, before the builder calls it merge-ready. The reviewer starts from
a fresh context with no access to the builder's reasoning, receives only the
PR number, the exact head SHA, the task requirements, the diff, the canonical
docs and the test evidence, and is read-only: no edits, commits, pushes or
merges. It hunts for functional defects, regressions, money and accounting
errors, tenant and RLS leaks, idempotency and concurrency holes, unverified
provider assumptions, missing edge cases, weak tests and documentation that
promises behaviour the code does not implement, and reports each finding as
BLOCKING, IMPORTANT or NON-BLOCKING. The builder fixes every valid BLOCKING
and IMPORTANT finding; a fix that changes the SHA gets a fresh review of the
new SHA. Codex review threads on the PR (Codex is the GitHub review app that
comments on pull requests, not a pipeline or a gate) are fetched and
answered the same way: valid findings fixed, invalid ones answered with code
evidence. A PR is reported READY FOR OWNER MERGE only when CI is green on the
exact head, the fresh review has no BLOCKING or IMPORTANT findings, valid
Codex findings are fixed, no blocking thread is unresolved, and the docs
match the code. This is a lightweight human-in-the-loop process: no bots,
gates, labels or signed evidence. Angelo merges.

## Tests

`packages/core` is the most-tested code in the repo: every money/ledger
invariant gets a test, and bug fixes land with a regression test that fails
before the fix. Webhook handlers get signature + idempotency + race tests.

## Environment

Node version from `.nvmrc` (currently 24), pnpm via corepack. Copy `.env.example` to
`.env` — the application refuses to boot with missing or malformed
configuration and tells you exactly what is wrong.
