<!-- The PR is an evidence document. The linked issue is the specification;
     do not restate or replace it here (AGENTS.md §8). -->

## Implements

Closes #NNN

## Builder

<!-- Claude | Codex | human — must match the issue's builder label. -->

## Risk

<!-- One of R0 / R1 / R2 / R3 per AGENTS.md §4, matching the issue's label.
     R3 additionally requires the owner's recorded decision — link it. -->

## What changed

<!-- One or two sentences. -->

## Acceptance criteria evidence

<!-- One line per criterion from the issue: the criterion, and the concrete
     evidence it holds at HEAD (test name/output, file:line, screenshot). -->

## Verification

<!-- What ran, what passed, what was skipped and why, at the risk level
     AGENTS.md §5 requires. For provider-touching changes: live/sandbox
     validation evidence, or why deterministic contract tests suffice. -->

## Known non-goals

<!-- What this PR deliberately does not do, per the issue's Non-goals. -->

## Review contract

The linked issue is authoritative; reviewers evaluate the current HEAD.
Any push invalidates prior agent approvals (AGENTS.md §8).

## Checklist

- [ ] Conventional Commit title
- [ ] Tests cover the change (regression test for fixes)
- [ ] No financial value touches a float; ledger postings balance
- [ ] Every new query is tenant-scoped (`businessId`)
- [ ] No PII outside the vault/gateway paths; no secrets in code or fixtures
- [ ] New dependency? Justified in the description
- [ ] Decision-level change? ADR added or superseded
- [ ] Findings from Reviewer 1 and Gemini reproduced-and-fixed or answered with evidence
- [ ] R3 only: owner decision linked and owner review requested
