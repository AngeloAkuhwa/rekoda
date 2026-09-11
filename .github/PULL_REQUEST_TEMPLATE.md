## What

<!-- One or two sentences: what does this PR do? -->

## Why

<!-- Link the issue or the launch-readiness gap ID (docs/REKODA_LAUNCH_READINESS.md).
     If this implements or changes a decision, link the ADR or owner ruling. -->

## How verified

<!-- What ran, what passed, what was skipped and why. Tests added/updated,
     manual verification steps, screenshots for UI. For provider-touching
     changes: sandbox/live evidence, or why contract tests suffice. -->

## Checklist

- [ ] Conventional Commit title
- [ ] Tests cover the change (regression test for fixes)
- [ ] No financial value touches a float; ledger postings balance
- [ ] Every new query is tenant-scoped (`businessId`) under `withBusiness()`
- [ ] No PII outside the vault/gateway paths; no secrets in code or fixtures
- [ ] New dependency? Justified in the description
- [ ] Decision-level change? ADR added or superseded, or owner ruling recorded
- [ ] `docs/REKODA_CURRENT_STATE.md`, `docs/REKODA_LAUNCH_READINESS.md` (a gap opened or closed) and `docs/HANDOFF.md` updated if product or launch state changed
