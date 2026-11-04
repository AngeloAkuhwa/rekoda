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
  already exists or beside a running `rekoda-prod` stack, and runs as its own
  compose project).
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
new SHA. CodeRabbit is the primary AI reviewer and Codex is optional (OWN-35;
`docs/REKODA_MVP_AUTOPILOT_PLAYBOOK.md`, "Reviewer hierarchy"). Their review
threads are fetched and answered the same way: valid findings fixed, invalid
ones answered with code evidence. A Codex usage limit is recorded as
`Codex: UNAVAILABLE — QUOTA` and never blocks a merge. A PR is reported READY
FOR OWNER MERGE only when CI is green on the exact head, CodeRabbit has
completed a review of that exact head (or the owner has waived it for that
PR), the fresh review has no BLOCKING or IMPORTANT findings, valid review
findings are fixed, no review thread is unresolved, and the docs match the
code. Angelo merges, except for the MVP Autopilot's own closeout PRs under
OWN-26 and the playbook's merge gates.

## Where tests go

One rule set, enforced by `scripts/check-test-layout.mjs` (a CI step). The
feature-to-test index is `docs/TEST_MAP.md`.

| Layer       | File name                       | Lives                                                 | Needs                                                                                                                 | Run with                                                                                                                                                     |
| ----------- | ------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `<subject>.test.ts(x)`          | next to the code it tests                             | nothing                                                                                                               | `pnpm test`                                                                                                                                                  |
| Integration | `<subject>.integration.test.ts` | next to the code it tests (db: in the feature folder) | PostgreSQL                                                                                                            | `pnpm test:integration` in `apps/api` and `packages/db` only (the packages with an integration runner)                                                       |
| End to end  | `<journey>.spec.ts`             | `apps/web/e2e/` only                                  | PostgreSQL and production builds of the API and web app (Playwright applies migrations and starts the servers itself) | `pnpm --filter @rekoda/web e2e`, plus `e2e:journey` (the `billing-journey*` specs) and `e2e:reminders` (`reminders.spec.ts`), which the default run excludes |
| Script      | `<script>.test.mjs`             | `scripts/`, beside the script                         | node only                                                                                                             | `node --test scripts/<file>` (and name it in the CI step that runs script tests; CI runs only the files it names)                                            |

- **End-to-end databases.** Every Playwright suite generates new vault and
  match keys on each run, and the API rejects new keys when its database
  already holds enrolled fingerprints, so each suite needs a **disposable
  database**, never your development one. `e2e`: use a scratch database (CI
  uses `rekoda` on a fresh service container) and recreate it before each local
  run. `e2e:journey`: a fresh database too (CI creates `rekoda_journey`).
  `e2e:reminders`: `rekoda_reminders`, which you create first because the
  development Compose file does not; drop and recreate it before a second run.
  Set `DATABASE_URL`, `APP_DATABASE_URL` and (journey) `WORKER_DATABASE_URL`
  to point at the scratch database, as `.github/workflows/ci.yml` does.
- **Which layer.** Pure rules (`@rekoda/core`, zod contracts, copy, parsing)
  are unit tests. Anything that depends on SQL, RLS, locks, `ON CONFLICT`,
  transactions or an HTTP route is an integration test, because a mock of the
  thing under test proves nothing. A browser journey is e2e.
- **Where.** Beside the code, in the feature's folder. In `packages/db` the
  folder is the feature (`billing/`, `ledger/`, `tenancy/` ...), not `src/`
  itself. Never create a top-level `tests/` tree.
- **Name.** `<feature>-<concern>`, for example `billing/plan-change`. A suffix
  other than the three above is rejected.
- **Size.** Split a test file at about 600 lines, by concern. The check fails
  on a new test file over 600 lines. The files that were already larger are
  listed in `scripts/test-layout-baseline.json` with their size then. One of
  them may not go past its recorded size, and once it is split to 600 lines or
  fewer its entry must be removed. On a pull request the check also fails if
  the baseline gains an entry or raises one compared with the target branch:
  split the file instead.
- **Keep the map.** When you rename or move a test, update `docs/TEST_MAP.md`;
  the check fails on a path that no longer exists.

## Tests

`packages/core` is the most-tested code in the repo: every money/ledger
invariant gets a test, and bug fixes land with a regression test that fails
before the fix. Webhook handlers get signature + idempotency + race tests.

## Environment

Node version from `.nvmrc` (currently 24), pnpm via corepack. Copy `.env.example` to
`.env` — the application refuses to boot with missing or malformed
configuration and tells you exactly what is wrong.
