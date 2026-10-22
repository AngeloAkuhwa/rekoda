## What

<!-- One or two sentences: what does this PR do? -->

## Why

<!-- The problem solved, and the gap or build ID (docs/REKODA_LAUNCH_READINESS.md), or "none" with a
     reason. If this implements or changes a decision, link the ADR or owner ruling (OWN-*). -->

## Expected behaviour

<!-- What the system does after this change, in the merchant's or operator's terms. -->

## What changed

<!-- The code, schema and docs that changed, and where. -->

## Financial and security implications

<!-- Which invariants this touches (integer kobo, balanced postings, one event one financial truth,
     idempotency, tenancy/RLS, roles, PII, webhook trust) and which test covers each; or "none" with a
     reason. -->

## How verified

<!-- Test evidence: the tests and suites that ran and their results. For a bug fix, the RED test that
     failed before the fix and passes after it. What was skipped and why. Screenshots for UI. For
     provider-touching changes: sandbox/live evidence, or why contract tests suffice. -->

## Migration, deployment and rollback

<!-- Database migration impact (or "none"); deployment impact; rollback considerations. A rollback
     across a migration is done by hand (docs/runbooks/deploy.md). -->

## Owner decision

<!-- Was an owner policy decision needed? Name the OWN-* ruling, or say "none needed". If one is
     needed and missing, say so here and do not guess. -->

Documentation-only PRs fill every section; any section other than What, Why and How verified may say "none: documentation only".

## Checklist

- [ ] Conventional Commit title
- [ ] Tests cover the change (regression test for fixes)
- [ ] No financial value touches a float; ledger postings balance
- [ ] Every new query is tenant-scoped (`businessId`) under `withBusiness()`
- [ ] No PII outside the vault/gateway paths; no secrets in code or fixtures
- [ ] New dependency? Justified in the description
- [ ] Decision-level change? ADR added or superseded, or owner ruling recorded
- [ ] `docs/REKODA_CURRENT_STATE.md`, `docs/REKODA_LAUNCH_READINESS.md` (a gap opened or closed) and `docs/HANDOFF.md` updated if product or launch state changed
