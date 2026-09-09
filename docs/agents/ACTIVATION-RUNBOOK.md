# Control-Plane Activation Runbook

How the owner takes the autonomous engineering control plane from
**DRAFT / INACTIVE** to **ACTIVE** (`docs/AUTONOMOUS-ENGINEERING.md` §5).
Activation is based on **behavioural evidence** — a required check existing
by name proves nothing. Record the evidence for each drill (a link to the
run or PR) in this file's checklist when it is executed; nothing here is
pre-marked as done, because none of it has been executed yet.

**The bootstrap is two-phase.** The privileged gates execute from the
default branch, so the hardening PR cannot exercise them on itself.
Phase 1: the owner manually reviews and merges with everything INACTIVE —
no secrets, no keys, no App, no ruleset, no auto-merge. Phase 2 (this
runbook): App/key/environment setup, configuration, then the drills on
small throwaway activation PRs, and only then ACTIVE.

## A. Deterministic policy tests (local/CI, no live GitHub)

The merge policy lives in `scripts/agents/evaluator.mjs` (pure — no
network) and its behavioural evidence in
`scripts/agents/evaluator.test.mjs`: the §5.B BLOCK cases, the positive
cases, and the provenance, protocol-scheme (V4), replay/sequence,
refresh-generation, enrollment, owner-decision, lane-lease,
contract-history, sticky-enrollment/pagination, build-admission, WIP,
verdict-ordering, thread-completeness, and workflow_run
target-resolution properties. Run `node --test` on it for the current
count — the suite is the source of truth, not a number written here.

- Run locally: `node --test scripts/agents/evaluator.test.mjs`
- Runs automatically: every gates run executes the suite as a self-test
  step before evaluating — a gate whose own evidence fails cannot pass
  anything.

- [ ] Suite green at the activation commit (record the run link).

## B. The dedicated Rekoda Gate Publisher App (create FIRST)

The generic GitHub Actions app is **not** a sufficient publisher
identity: any same-repository workflow — including one proposed on an
**unmerged PR branch**, which CODEOWNERS review cannot stop from
_executing_ — can obtain `checks: write` on its own `GITHUB_TOKEN` and
publish check runs under the exact required names against ANY commit,
including another PR's HEAD. The required checks must therefore be
**source-bound to a dedicated App id**, and no repository workflow may
hold `checks: write` on `GITHUB_TOKEN` (the suite statically asserts
none does).

1. Create the GitHub App (Settings → Developer settings → GitHub Apps →
   New): name **Rekoda Gate Publisher** (slug `rekoda-gate-publisher` —
   the slug the evaluator's `GATE_PUBLISHER_APP_SLUG` names; if GitHub
   assigns a different slug, update that constant in the same commit).
   - Permissions: **Repository → Checks: Read & write.** Nothing else.
     No webhook, no OAuth, not public.
2. Install it on **this repository only**.
3. Generate ONE private key; record the **App ID**. The key exists only
   in the environment secret below — never on disk, never in the repo.
4. Note the App id shown on the app page — the ruleset source binding
   (§C.5) uses it.

## C. Live GitHub configuration verification

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
   - `agents-gate-publisher`: `REKODA_GATE_PUBLISHER_APP_ID`,
     `REKODA_GATE_PUBLISHER_APP_PRIVATE_KEY` — the ONLY place the App
     credential exists. Only the gate-publisher jobs (the gates'
     ambiguity revocation, pre-review invalidation, and finalize, plus
     the authority's red-only amendment barrier) reference this
     environment. No request workflow, builder, planner, watcher,
     reviewer AI job, reviewer signer, or Codex lane may ever reference
     it — the static suite pins the exact reference count.
   - `test`: created empty (its `TEST_REKODA_…` secrets arrive with the
     first live-smoke lane).

   On EVERY `agents-*` environment set _Deployment branches and tags_ →
   selected branches → `main` only. **This is a REQUIRED secret
   boundary, not optional defense in depth**: a `workflow_dispatch`
   run's _definition_ must exist on the default branch, but the run can
   be dispatched against ANY ref — the workflows additionally
   hard-reject non-main refs, and the environment restriction is the
   wall that holds even if a guard is ever bypassed.

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
   For the three agent gates, set each check's **source app** to
   **Rekoda Gate Publisher** (the App id from §B) — GitHub's ruleset
   model binds a required check to the app that must set it
   (`RequiredStatusCheckInput.appId`). The CI checks keep the GitHub
   Actions app as their source. After this binding, a same-named check
   published by ANY GITHUB_TOKEN workflow (merged or not) may still be
   _displayed_ by GitHub, but the ruleset never accepts it for the
   requirement — drill 34 proves it live.

- [ ] All verified on the live repository (record screenshots/date).

## D. Live PR negative drills — merge must be BLOCKED

Open one small throwaway agent-governed PR (an R1 docs-touching issue
created via the Agent task form, `builder:claude`; the authority enrolls
the PR — drill 40 exercises the un-enrolled state first). GitHub must
refuse the merge in every one:

- [ ] 1. No technical verdict yet → `Technical Review Gate` red, merge
      impossible.
- [ ] 2. Push a new commit after a verdict → gates re-run red for the new
      HEAD (stale approval does not carry).
- [ ] 3. A `REKODA_CODEX_APPROVAL` marker posted by a non-Codex account →
      rejected (wrong identity / self-review).
- [ ] 4. A malformed marker (missing CONTRACT_REVISION or
      REFRESH_GENERATION line) → rejected.
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
- [ ] 17–18. Label the drill PR `risk:R3`: red without a current
      snapshot-bound `REKODA_OWNER_DECISION` marker on the issue; still
      red with it until the owner's approving review of the exact HEAD
      exists.
- [ ] 19. Attempt `gh pr merge --admin` / a direct push to `main` as a
      non-bypass actor → refused by the ruleset.
- [ ] 20. Break CI on the drill branch → merge impossible with gates
      otherwise green.
- [ ] 21. Forgery drill: post a hand-written `REKODA_GEMINI_APPROVAL`
      comment with correct fields but no — or a wrong-key — SIGNATURE,
      from a write-access account → rejected (`GEMINI_UNAUTHORIZED`);
      same for `REKODA_CLAUDE_APPROVAL` on a `builder:codex` drill
      (cross-role key reuse must also fail).
- [ ] 22. Amendment-transaction drill: the owner FIRST obtains and
      reviews the proposed snapshot from trusted main —
      `node scripts/agents/amendment-context.mjs --repo <o/n> --issue <n>`
      — then dispatches with `expected_snapshot_hash`; the authority
      refuses (plan job AND signer) if the proposal drifts. The run log
      must show the transaction order: signed
      `REKODA_CONTRACT_AMENDMENT_FREEZE` FIRST (from that comment on,
      every gate evaluation returns `CONTRACT_AMENDMENT_IN_PROGRESS`),
      then the per-target red barriers (gate-publisher identity, SHA
      lanes), the signed revision only after every barrier, then the
      redispatch — and the merge box must never be green between the
      freeze existing and fresh new-revision verdicts landing, including
      an amendment whose body hash is unchanged. Also verify a human
      issue-body edit alone (a PROPOSAL) blocks the gates without ever
      becoming the active contract, and that a risk or builder label
      change without an authorized revision blocks
      (`CONTRACT_LABELS_DIVERGED`).
- [ ] 23. Escape drill: remove the drill PR's risk and builder labels
      AND its closing reference → the gates stay red (sticky enrollment
      from exhaustively-paginated label history), never neutral.
- [ ] 24. Trust-boundary drill: open a throwaway same-repo PR that edits
      `agent-review-request.yml` (or adds a workflow referencing
      `agents-gemini-reviewer` or `agents-gate-publisher`) → verify the
      PR-branch runs receive NO secret (the environments refuse the PR
      ref) and that the privileged `Agent — gates` run that evaluates
      the PR executed the DEFAULT-branch definition.
- [ ] 25. Unauthorized dispatch drill: confirm a non-write account
      cannot dispatch `Agent — Claude builder`, and that a direct
      builder dispatch against an issue the authority never claimed is
      refused by the preflight (`START_LEASE_MISSING`) before any
      secret-bearing job starts.
- [ ] 26. Simultaneous-admission drill: label two READY `builder:claude`
      issues within seconds → exactly one build is admitted; the second
      serializes on `rekoda-implementation-lane` and refuses
      (`ADMIT_LANE_OCCUPIED`).
- [ ] 27. Unauthorized amendment drill: a non-owner write collaborator
      dispatches the contract-authority revision → refused (owner-only);
      an unsigned revision comment from that collaborator is ignored by
      the evaluator and the amendment blocks.
- [ ] 28. Codex binding drill: after a push, verify an old Codex review
      whose marker names the new HEAD but whose review `commit_id` is
      the old commit does NOT pass the Technical Review Gate.
- [ ] 29. Check-spoof drill (same-repo workflow): a throwaway PR defines
      a job named `Technical Review Gate` that exits 0 → the ruleset's
      App-bound required check ignores the GITHUB_TOKEN-sourced run;
      record exactly what GitHub showed.
- [ ] 30. Same-HEAD revision check-state drill: with all gates green at
      revision 1, dispatch an owner-authorized revision 2 → verify the
      finalizer flips the same-named check runs on the unchanged HEAD to
      failure and the merge box goes red until revision-2 verdicts land.
- [ ] 31. Baseline-sequencing drill: label a fresh `builder:claude`
      agent-task issue `status:ready` and verify the deterministic
      chain — baseline FIRST, then admission, signed lane claim, label
      transition, builder dispatch; the builder preflight independently
      verifies the claim. A manual builder dispatch against a
      never-claimed issue must be refused with NO secret-bearing job.
- [ ] 32. Degraded-revocation drill (newest-run-wins live proof): with a
      gate check SUCCESS on the drill HEAD, run `post-check.mjs` with a
      failure conclusion while the lookup is forced to fail, so the
      BLIND failure POST executes — then verify the NEWEST run governs:
      the required check shows the failure, the merge box is red, and a
      later healthy success upsert PATCHes that latest run back green.
      (Blind-red duplicates are a DELIBERATE fail-closed revocation
      path — "duplicates impossible" was never the claim; one name+SHA
      never carries ambiguous duplicate conclusions on the healthy
      path, and the degraded path only ever adds a newer FAILURE.)
- [ ] 33. Late-governance drill: open a plain (ungoverned) PR, let the
      gates publish the three neutral successes, then add `risk:R1` +
      `builder:claude` and a closing reference to an agent-task issue —
      the next finalizer must re-resolve CURRENT governance and flip all
      three gates to governed evaluation (red until enrollment and real
      evidence), never repeating the neutral pass.

## E. Phase-2 hardening drills (new in this pass)

- [ ] 34. **Cross-PR App-spoof drill (X6)**: a malicious throwaway PR A
      carries a workflow that uses its GITHUB_TOKEN (`checks: write` on
      its own token) to publish all three gate names with SUCCESS
      against target PR B's HEAD SHA. Expected: GitHub may display the
      fake runs, but PR B's merge box stays blocked — the ruleset's
      required checks accept only the Rekoda Gate Publisher App id.
      Record what GitHub showed. (Not live-proven until the App exists
      and this drill is actually executed.)
- [ ] 35. **Non-main dispatch drill**: dispatch `Agent — gates` and the
      contract authority against a non-main branch ref → the run refuses
      in its first step, and the environment (main-only deployment
      branches) refuses the secret even if a step were bypassed. No
      publisher or signer secret is ever materialized.
- [ ] 36. **Evidence replay drill (X2)**: with a signed APPROVE
      (sequence N) and a later signed BLOCK (sequence N+1) on the drill
      PR, copy the APPROVE comment text verbatim into a new comment →
      the gates keep the BLOCK (the replay keeps its old sequence).
- [ ] 37. **Failed forced-refresh drill (X3)**: with a valid APPROVE,
      the owner forces a fresh review and the AI lane is made to fail
      (e.g. temporarily revoke the AI credential) → the signed
      `REKODA_REVIEW_REFRESH` marker exists, the gate is red, and NO
      ordinary redispatch/finalizer ever restores the pre-refresh
      APPROVE; only a fresh verdict binding the new generation can.
- [ ] 38. **Enrollment-mutation amendment drill (X4)**: during an
      amendment transaction, edit an unrelated open PR's body to add
      `Closes #<drill issue>` → the transaction completes on its
      determinate set; the latecomer PR is re-evaluated by its own
      request run and blocks with `PR_NOT_ENROLLED`; its old neutral
      checks never authorize a merge of the drill issue's work.
- [ ] 39. **Shared-SHA stale-finalizer drill (X5)**: create two open PRs
      sharing one HEAD while a finalizer for the first is in flight →
      the ambiguity revocation forces the SHA red inside the SHA lane,
      and the finalizer (same lane, association re-check before any
      pass) cannot restore green.
- [ ] 40. **Un-enrolled PR drill (X4)**: open the drill PR before the
      authority enrolls it → all gates red with `PR_NOT_ENROLLED`; the
      gates request enrollment; after the authority's signed enrollment
      the PR is freshly evaluated (still red until real evidence).
- [ ] 41. **R3 admission drill (X7)**: a `risk:R3` READY issue with no
      owner decision → the authority refuses baseline/claim/dispatch;
      with a decision bound to the WRONG snapshot → still refused; with
      the correct snapshot-bound decision → admitted (merge still gated
      on the owner's HEAD review).
- [ ] 42. **Gemini runtime drill (X8/Y5)**: a normal pinned-action
      acceptance review reaches verdict handoff (the runtime files are
      allowlisted and cleaned); then make the review write a tracked
      file → the integrity guard fails the lane and no verdict is
      handed over. Verify both lanes ran with the pinned
      `gemini_cli_version`.
- [ ] 43. **Watcher-storm drill (Y1)**: an authorized issue edit
      immediately followed by many unauthorized marker-looking comments
      from a non-collaborator → the authorized redispatch is still
      delivered; the storm dies in authorize jobs without cancelling
      anything.
- [ ] 44. **Bot-force drill (Y2)**: a write-permission App/bot account
      attempts `force_review=true` → refused before any AI lane; only
      the owner's human account succeeds.
- [ ] 45. **Lane drill (Y3)**: with >100 open labelled issues, occupy
      the lane with an issue that lists on page 2 → admission refuses.
      Then remove the occupying issue's status labels (simulating a
      compromised builder) → admission STILL refuses via the signed
      lease scan; only the owner's `mode=release-lane` frees it.
- [ ] 46. **Thread-101 drill (Y6)**: open >100 review threads on the
      drill PR, leave exactly the 101st unresolved → the gates block
      (`THREADS_UNRESOLVED`), proving cursor-paginated completeness.

## F. Positive auto-merge drill

- [ ] On the same drill PR (back at R1, all evidence valid: baseline
      posted, enrollment active, Codex marker APPROVE, Gemini APPROVE,
      threads resolved, CI green): enable `gh pr merge --auto --squash`
      **before** the last gate is green and verify GitHub holds the
      merge until every required check passes, then merges without any
      human click — and that nothing merged earlier than that.

## G. R3 owner-gate drill

- [ ] A second throwaway issue/PR labelled `risk:R3` with a recorded
      snapshot-bound owner decision: verify the merge stays blocked
      until the owner's approving review of the exact final HEAD, and
      that a push after the owner's approval re-blocks until a fresh
      approval.

## Afterwards

Delete the drill branches/issues, record every checked box's evidence
link here in one commit, and only then change the status banner in
`docs/AUTONOMOUS-ENGINEERING.md` from DRAFT / INACTIVE to ACTIVE — that
edit is the activation act, and it is the owner's to make.
