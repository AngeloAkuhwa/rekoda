## What

<!-- One or two sentences: what does this PR do? -->

## Why

<!-- Link the issue this implements (required for agent work: "Closes #NNN").
     If this implements or changes a decision, link the ADR. -->

## Risk

<!-- One of R0 / R1 / R2 / R3 per AGENTS.md §4, matching the issue's label.
     R3 additionally requires the owner's recorded decision — link it. -->

## How verified

<!-- Test evidence at the risk level AGENTS.md §5 requires: what ran, what
     passed, what was skipped and why. Manual steps and screenshots for UI.
     For provider-touching changes: live/sandbox validation evidence, or why
     the deterministic contract tests suffice. -->

## Checklist

- [ ] Conventional Commit title
- [ ] Tests cover the change (regression test for fixes)
- [ ] No financial value touches a float; ledger postings balance
- [ ] Every new query is tenant-scoped (`businessId`)
- [ ] No PII outside the vault/gateway paths; no secrets in code or fixtures
- [ ] New dependency? Justified in the description
- [ ] Decision-level change? ADR added or superseded
- [ ] Codex review requested; findings reproduced-and-fixed or answered with evidence
- [ ] R3 only: owner decision linked and owner review requested
