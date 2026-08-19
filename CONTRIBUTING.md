# Contributing to Rekoda

## Workflow

1. Branch from `main`: `feat/<short-name>`, `fix/<short-name>`,
   `docs/<short-name>`, `chore/<short-name>`.
2. Open a PR into `main`. Fill the PR template. CI must be green.
3. Squash-merge with a Conventional Commit title.

Direct pushes to `main` are reserved for repository bootstrap and emergencies.

## Commit messages — Conventional Commits

```
<type>(<optional scope>): <imperative summary>

feat(core): allocate partial payments oldest-invoice-first
fix(webhooks): reject Paystack events with empty plan object
docs(adr): record hosting decision
```

Types: `feat` `fix` `docs` `chore` `refactor` `test` `perf` `ci` `build`.

## Non-negotiable code rules

These mirror `docs/architecture.md` §53 and are enforced in review:

* **Money is integer kobo.** No floats in any financial path.
* **AI proposes, deterministic code disposes.** AI output is a
  `StructuredBusinessCommand` validated by zod; only the transaction engine
  writes financial records; ledger postings must balance.
* **Every tenant-owned query is scoped by `businessId`** — RLS is the net,
  not the primary mechanism.
* **PII stays in the vault.** New code paths that move customer identity
  must go through the Privacy Gateway and be called out explicitly in the PR.
* **Webhooks: verify signature, then idempotency, then process.** In that order.
* **No new dependency without justification in the PR description.**

## Architecture Decision Records

Significant decisions (new dependency category, provider, data-model change,
security mechanism) require an ADR in `docs/adr/` — copy `0000-template.md`,
number it sequentially, and link it from the PR. ADRs are immutable once
accepted; supersede rather than edit.

## Tests

`packages/core` is the most-tested code in the repo: every money/ledger
invariant gets a test, and bug fixes land with a regression test that fails
before the fix. Webhook handlers get signature + idempotency + race tests.

## Environment

Node version from `.nvmrc` (22), pnpm via corepack. Copy `.env.example` to
`.env` — the application refuses to boot with missing or malformed
configuration and tells you exactly what is wrong.
