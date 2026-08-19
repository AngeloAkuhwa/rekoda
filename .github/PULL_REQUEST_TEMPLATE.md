## What

<!-- One or two sentences: what does this PR do? -->

## Why

<!-- Link the issue/milestone. If this implements or changes a decision, link the ADR. -->

## How verified

<!-- Tests added/updated, manual verification steps, screenshots for UI. -->

## Checklist

- [ ] Conventional Commit title
- [ ] Tests cover the change (regression test for fixes)
- [ ] No financial value touches a float; ledger postings balance
- [ ] Every new query is tenant-scoped (`businessId`)
- [ ] No PII outside the vault/gateway paths; no secrets in code or fixtures
- [ ] New dependency? Justified in the description
- [ ] Decision-level change? ADR added or superseded
