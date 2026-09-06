# Control-Plane Activation Runbook

How the owner takes the autonomous engineering control plane from
**DRAFT / INACTIVE** to **ACTIVE** (`docs/AUTONOMOUS-ENGINEERING.md` §5).
Activation is based on **behavioural evidence** — a required check existing
by name proves nothing. Record the evidence for each drill (a link to the
run or PR) in this file's checklist when it is executed; nothing here is
pre-marked as done, because none of it has been executed yet.

**The bootstrap is two-phase.** The privileged gates execute from the
default branch, so PR #233 cannot exercise them on itself. Phase 1: the
owner manually reviews and merges PR #233 with everything INACTIVE — no
secrets, no keys, no ruleset, no auto-merge. Phase 2 (this runbook):
key/environment setup, configuration, then the drills on small throwaway
activation PRs, and only then ACTIVE.

## A. Deterministic policy tests (local/CI, no live GitHub)

The merge policy lives in `scripts/agents/evaluator.mjs` (pure — no
network) and its behavioural evidence in
`scripts/agents/evaluator.test.mjs`: all twenty §5.B BLOCK cases, the
positive cases, and the provenance, protocol-scheme, contract-history,
sticky-enrollment/pagination, build-admission (incl.
baseline-before-admission), WIP, verdict-ordering, and workflow_run
target-resolution properties. Run `node --test` on it for the current
count — the suite is the source of truth, not a number written here.

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
     outside its one environment. On EVERY `agents-*` environment set
     _Deployment branches and tags_ → selected branches → `main` only —
     GitHub then refuses the environment to any PR-ref job.
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
   For each required check, set its **source** to the **GitHub Actions**
   app — GitHub's ruleset model binds a required check to the app that
   must set it (`RequiredStatusCheckInput.appId`), which shuts out
   third-party-app spoofing. Same-app spoofing (a PR-defined Actions job
   using the same name) remains the platform residual, countered by
   CODEOWNERS on workflow files — drill 29 exercises it.

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
- [ ] 21. Forgery drill (item H): post a hand-written
      `REKODA_GEMINI_APPROVAL` comment with correct fields but no — or a
      wrong-key — SIGNATURE, from a write-access account → rejected
      (`GEMINI_UNAUTHORIZED`); same for `REKODA_CLAUDE_APPROVAL` on a
      `builder:codex` drill (cross-role key reuse must also fail).
- [ ] 22. Amendment-transaction drill (items C + D1): with all gates
      green at revision 1, the owner dispatches a contract revision and
      the run log must show the full freeze-before-mutate order — every
      linked PR's three required checks forced red FIRST, the signed
      revision posted only after, then the direct gate redispatch — and
      the merge box must never be green between the revision existing
      and fresh rev-2 verdicts landing. Also verify a human issue-body
      edit alone (a PROPOSAL) blocks the gates without ever becoming the
      active contract.
- [ ] 23. Escape drill (item E): remove the drill PR's risk and builder
      labels AND its closing reference → the gates stay red (sticky
      enrollment from exhaustively-paginated label history), never
      neutral.
- [ ] 24. Trust-boundary drill (items A/B): open a throwaway same-repo
      PR that edits `agent-review-request.yml` (or adds a workflow
      referencing `agents-gemini-reviewer`) → verify the PR-branch runs
      receive NO reviewer secret (the environment refuses the PR ref)
      and that the privileged `Agent — gates` run that evaluates the PR
      executed the DEFAULT-branch definition (its logged trust-root SHA
      is a main commit, not the PR's).
- [ ] 25. Unauthorized dispatch drill (item D): confirm a non-write
      account cannot dispatch `Agent — Claude builder` (GitHub refuses
      the dispatch), and that labelling by a triage-only account is
      refused by the preflight's write+ actor check before any
      secret-bearing job starts. (The `@claude` mention path no longer
      exists.)
- [ ] 26. Simultaneous-admission drill (item F): label two READY
      `builder:claude` issues within seconds → exactly one build is
      admitted; the second run serializes on the
      `rekoda-implementation-lane` group and refuses
      (`ADMIT_LANE_OCCUPIED`).
- [ ] 27. Unauthorized amendment drill (item I): a non-owner write
      collaborator dispatches the contract-authority revision → refused
      (owner-only); an unsigned revision comment from that collaborator
      is ignored by the evaluator and the amendment blocks.
- [ ] 28. Codex binding drill (item G): after a push, verify an old
      Codex review whose marker names the new HEAD but whose review
      `commit_id` is the old commit does NOT pass the Technical Review
      Gate.
- [ ] 29. Check-spoof drill: a throwaway PR defines a job named
      `Technical Review Gate` that exits 0 → verify the ruleset's
      app-bound required check plus CODEOWNERS review on the workflow
      change prevent the PR from merging on the spoofed green, and
      record exactly what GitHub showed.
- [ ] 30. Same-HEAD revision check-state drill: with all gates green at
      revision 1, dispatch an owner-authorized revision 2 → verify the
      authority's redispatch UPDATES the same-named check runs on the
      unchanged HEAD to failure (upsert-in-place, no ambiguous
      duplicates) and the merge box goes red until revision-2 verdicts
      land. This proves the required-check state cannot remain
      merge-authorizing on stale-revision evidence.
- [ ] 31. Baseline-sequencing drill: label a fresh `builder:claude`
      agent-task issue `status:ready` and verify the deterministic
      chain — the contract authority records the baseline FIRST and
      only then dispatches the builder, whose admission independently
      re-verifies the baseline before claiming the lane. A manual
      builder dispatch against a never-baselined issue must be refused
      with NO lane claim and NO secret-bearing builder job.

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
