# Control-Plane Activation Runbook

How the owner takes the autonomous engineering control plane from
**DRAFT / INACTIVE** to **ACTIVE** (`docs/AUTONOMOUS-ENGINEERING.md` §5).
Activation is based on **behavioural evidence** — a required check existing
by name proves nothing. Record the evidence for each drill (a link to the
run or PR) in this file's checklist when it is executed; nothing here is
pre-marked as done, because none of it has been executed yet.

## A. Deterministic policy tests (local/CI, no live GitHub)

The merge policy lives in `scripts/agents/evaluator.mjs` (pure — no
network) and its behavioural evidence in
`scripts/agents/evaluator.test.mjs`, which covers all twenty negative
BLOCK cases of §5.B plus the four positive cases (valid R0/R1/R2 and
owner-authorized R3), same-SHA verdict supersession, new-HEAD
invalidation, and contract-revision invalidation without a push.

- Run locally: `node --test scripts/agents/evaluator.test.mjs`
- Runs automatically: every `Agent policy gate` execution runs the suite
  as a self-test step before evaluating — a gate whose own evidence fails
  cannot pass anything.

- [ ] Suite green at the activation commit (record the run link).

## B. Live GitHub configuration verification

Settings to create, then verify by looking at the live repository (not by
memory):

1. Signing authorities: run `node scripts/agents/generate-signing-keys.mjs`
   locally, commit the three `scripts/agents/keys/*.pub.pem` files it
   writes, and paste each printed private key into its environment secret
   (next step). Private keys exist only in the environment secrets.
2. Environments (Settings → Environments), each with exactly its secrets
   per `docs/agents/TEST-ENVIRONMENT.md` §A:
   - `agents-builder`: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`);
   - `agents-claude-reviewer`: `CLAUDE_CODE_OAUTH_TOKEN`,
     `CLAUDE_REVIEWER_SIGNING_KEY`;
   - `agents-gemini-reviewer`: `GEMINI_API_KEY`,
     `GEMINI_REVIEWER_SIGNING_KEY`;
   - `agents-planner`: `GEMINI_API_KEY`;
   - `agents-contract-authority`: `CONTRACT_AUTHORITY_SIGNING_KEY`;
   - `test`: created empty (its `TEST_REKODA_…` secrets arrive with the
     first live-smoke lane).
     No agent credential in `test`, no runtime credential in any
     `agents-*`, no production credential anywhere, and no signing key
     outside its one environment.
3. Codex: ChatGPT Codex Connector installed on the repo, Code review +
   Automatic reviews enabled (chatgpt.com/codex/settings/code-review).
4. Repository → Settings → General → Pull Requests: **Allow auto-merge**
   on, squash merging on.
5. Ruleset `protect-main` (Active, default branch): require a PR before
   merging; Require review from Code Owners; required approvals 0; require
   conversation resolution; block force pushes; no bypass actors; required
   status checks: `Secret scan (gitleaks)`,
   `Typecheck · lint · test · build`, `Migrations (foreign owner)`,
   `Integration (PostgreSQL)`, `End-to-end (Playwright)`,
   `Agent policy gate`, `Technical Review Gate`, `Gemini Acceptance Gate`.
   (A check name appears in the picker only after it has run once.)

- [ ] All five verified on the live repository (record screenshots/date).

## C. Live PR negative drills — merge must be BLOCKED

Open one small throwaway agent-governed PR (an R1 docs-touching issue
created via the Agent task form, `builder:claude`) and drive it through
the failure states. GitHub must refuse the merge in every one:

- [ ] 1. No technical verdict yet → `Technical Review Gate` red, merge
     impossible.
- [ ] 2. Push a new commit after a verdict → gates re-run red for the new
     HEAD (stale approval does not carry).
- [ ] 3. A `REKODA_CODEX_APPROVAL` marker posted by a non-Codex account →
     rejected (wrong identity / self-review).
- [ ] 4. A malformed marker (missing CONTRACT_REVISION line) → rejected.
- [ ] 5. A BLOCK verdict → gate red.
- [ ] 6–8. Same three for the Gemini lane (`Gemini Acceptance Gate`).
- [ ] 9–11. A marker naming the wrong PR, wrong issue, wrong revision →
      rejected.
- [ ] 12. Edit the issue body without an authorized
      `REKODA_CONTRACT_REVISION` marker → `Agent policy gate` red
      (unauthorized amendment), both reviewer gates red on next run
      (revision mismatch).
- [ ] 13–14. Flip the PR's risk or builder label away from the issue's →
      `Agent policy gate` red (mismatch).
- [ ] 15. Remove the closing reference from the PR body → red (no
      authoritative issue). Also verify removing the labels does NOT go
      neutral while the linked issue is an agent-task.
- [ ] 16. Leave a review thread unresolved → red.
- [ ] 17–18. Label the drill PR `risk:R3`: red without an owner-decision
      reference on the issue; still red with the reference until the
      owner's approving review of the exact HEAD exists.
- [ ] 19. Attempt `gh pr merge --admin` / a direct push to `main` as a
      non-bypass actor → refused by the ruleset.
- [ ] 20. Break CI on the drill branch → merge impossible with gates
      otherwise green.
- [ ] 21. Forgery drill: post a hand-written `REKODA_GEMINI_APPROVAL`
      comment with correct fields but no (or a wrong) SIGNATURE, from a
      write-access account → rejected (`GEMINI_UNAUTHORIZED`); same for
      `REKODA_CLAUDE_APPROVAL` on a `builder:codex` drill.
- [ ] 22. Redispatch drill: edit the drill issue's body (with an
      authorized signed revision) and verify the contract-watch workflow
      re-runs all three gates on the unchanged code HEAD, which then
      demand fresh verdicts for the new revision.
- [ ] 23. Escape drill: remove the drill PR's risk and builder labels AND
      its closing reference → the gates stay red (sticky enrollment from
      label history), never neutral.

## D. Positive auto-merge drill

- [ ] On the same drill PR (back at R1, all evidence valid: baseline
      posted, Codex marker APPROVE, Gemini APPROVE, threads resolved, CI
      green): enable `gh pr merge --auto --squash` **before** the last
      gate is green and verify GitHub holds the merge until every
      required check passes, then merges without any human click — and
      that nothing merged earlier than that.

## E. R3 owner-gate drill

- [ ] A second throwaway issue/PR labelled `risk:R3` with a recorded
      owner-decision reference: verify the merge stays blocked until the
      owner's approving review of the exact final HEAD, and that a push
      after the owner's approval re-blocks until a fresh approval.

## Afterwards

Delete the drill branches/issues, record every checked box's evidence
link here in one commit, and only then change the status banner in
`docs/AUTONOMOUS-ENGINEERING.md` from DRAFT / INACTIVE to ACTIVE — that
edit is the activation act, and it is the owner's to make.
