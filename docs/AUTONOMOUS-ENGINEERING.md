# Autonomous Engineering — the Operating Model

How Rekoda's launch work continues with minimal owner involvement. This is
a **control plane over the existing repository**, not a redesign of it:
nothing here changes an accepted architecture decision, the existing CI, or
the standing process in `docs/SYSTEM-PLAN.md`. The constitution every agent
loads is `AGENTS.md`; roles are `CLAUDE.md` and `GEMINI.md`.

## 1. The four roles

| Role                        | Who                                        | Does                                                                                                                                                                      | Does not                                 |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Planner / issue manager** | Gemini                                     | audits state, creates implementation-ready issues, classifies R0–R3, tracks dependencies, keeps WIP limits                                                                | modify product code; merge; approve      |
| **Implementer**             | Claude                                     | takes `status:ready` issues, investigates, implements, tests, opens PRs, repairs findings                                                                                 | merge its own PRs; work unlabelled scope |
| **Adversarial reviewer**    | Codex (OpenAI's native GitHub code review) | tries to break the implementation: financial correctness, tenancy, privacy, security, races, idempotency, migrations, failure paths, tests that pass for the wrong reason | become the primary implementer           |
| **State & audit**           | GitHub                                     | issues, PRs, labels, CI, branch policy, the `test` environment, durable history                                                                                           | —                                        |

**Angelo** decides R3 items and launch/business/legal/provider questions —
and nothing routine. `docs/REKODA_OWNER_DECISIONS.md` §2 stays the
canonical register of owner-held items.

## 2. Labels

| Label                     | Meaning                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `agent-task`              | created via the Agent task template; participates in this lifecycle |
| `risk:R0` … `risk:R3`     | exactly one per issue and per PR (`AGENTS.md` §4)                   |
| `status:ready`            | implementable now, no open decision (max **2**)                     |
| `status:building`         | an implementer owns it (max **1**)                                  |
| `status:in-review`        | PR open, review loop running                                        |
| `status:blocked-decision` | needs the owner; carries the exact question                         |
| `backlog`                 | real but not launch-blocking; stays out of the READY queue          |
| `needs-owner-decision`    | mirror of the template's NEEDS-OWNER-DECISION status                |

## 3. Issue lifecycle

```
finding → backlog → status:ready → status:building → status:in-review → closed by merged PR
                 ↘ status:blocked-decision → (owner answers) → status:ready
```

1. Gemini (or a human) files an **Agent task** issue with evidence, context
   routing, scope, acceptance criteria, required tests, risk, dependencies,
   and decision status.
2. `READY` requires: no unanswered decision, dependencies landed, risk ≤ R2
   (R3 becomes READY only after the owner's recorded decision).
3. Claude picks up the oldest `status:ready`, moves it to
   `status:building`, verifies its claims against HEAD, implements.
4. Decision-level ambiguity discovered mid-build → `status:blocked-decision`
   with the question; Claude moves to other non-blocked work.

## 4. PR lifecycle and the review/repair loop

1. Claude opens a PR from a `feat/fix/docs/chore` branch, filling the
   template: linked issue (`Closes #NNN`), risk level, verification
   evidence. Issue → `status:in-review`.
2. Existing CI runs (secret scan, typecheck/lint/test/build + guard
   scripts, foreign-owner migration replay, integration, e2e). These are
   untouched by the control plane.
3. **Codex reviews.** Automatic on PR open where enabled; otherwise anyone
   comments `@codex review`. After each substantive push, review of the new
   HEAD is requested again — a review of an old commit does not cover the
   new one.
4. **Claude repairs.** Every finding is a hypothesis: reproduce it first.
   Valid → fix in-branch with a regression test. Invalid → answer on the
   thread with evidence (a test, a trace, a line). Findings are never
   dismissed unexamined and never "fixed" by weakening a test.
5. The **agent policy gate** (below) reports its verdict as a stable check.
6. Merge: squash, Conventional Commit title, by someone other than the
   PR's author-agent. R3 merges require Angelo's approval (CODEOWNERS
   enforces this on sensitive paths; the gate enforces the label rule).

## 5. Merge criteria

A PR merges when all of:

- linked issue with matching risk label;
- all required CI checks green on the current HEAD;
- Codex has reviewed the current HEAD and no blocking finding is
  unresolved (fixed, or answered with evidence and the thread resolved);
- R3 only: the owner's decision is linked and the owner approved the PR;
- HANDOFF updated in the same PR if durable state changed.

## 6. The agent policy gate

A deterministic workflow check (`.github/workflows/agent-policy-gate.yml`)
that inspects only structured GitHub data — labels, PR body, the reviews
API, review threads — never free-text scraping. It enforces, for PRs
carrying a `risk:*` label (agent PRs always do):

- exactly one risk label; a linked issue reference in the body;
- R3 → an approving review from the owner on the current HEAD;
- R1+ → a Codex review whose `commit_id` equals the current HEAD SHA;
- no unresolved review threads on the PR.

PRs without a risk label (humans, Dependabot) pass the gate neutrally —
the gate governs agent work and tightens only when the owner decides to
label everything.

**Honest limitation.** Codex's native integration posts a real GitHub PR
review (login `chatgpt-codex-connector[bot]`), and every review carries a
`commit_id` — that pair is the machine signal the gate uses. But Codex is
not documented to APPROVE or REQUEST_CHANGES (observed state: COMMENTED),
is not guaranteed to re-review every push, and publishes no per-SHA
completion contract. So the gate checks "a Codex review exists for this
exact HEAD SHA" and otherwise fails with the instruction to comment
`@codex review` — it does not infer approval from silence, and it does not
parse review prose for verdicts. If OpenAI later ships a firmer signal,
the gate upgrades; until then this is the safest deterministic mechanism
that exists.

## 7. Context strategy

Implementation sessions stay small by routing, not by re-exploration:

- Issues name their **Required context** (docs, ADRs, source paths) using
  `docs/agents/CONTEXT-MAP.md`.
- Agents load `AGENTS.md` + their role file every session; everything else
  is pulled on demand via the map.
- Repository evidence outranks model memory; anything load-bearing is
  verified at HEAD before it is built on.

## 8. Test strategy

- The existing CI is the merge gate's backbone and is preserved unchanged.
- Every defect fix carries a regression test that fails before the fix.
- Integration suites run serially (shared PostgreSQL); packages are
  rebuilt before the api suite runs against them.
- **Providers get two layers** (`docs/agents/TEST-ENVIRONMENT.md`):
  deterministic contract tests everywhere, plus narrow path-aware live
  sandbox smokes under stable job names — a provider outage never makes
  the repository untestable.
- Never skip, disable, or quarantine a failing test to get green.

## 9. Secret handling

- Agent credentials and Rekoda runtime credentials are separate namespaces
  (`docs/agents/TEST-ENVIRONMENT.md`): `CLAUDE_CODE_OAUTH_TOKEN` and
  `GEMINI_API_KEY` are agent credentials; runtime test values carry the
  `TEST_REKODA_` prefix and are mapped in workflow `env:` blocks.
- No secret value ever appears in the tree, an issue, a PR body, a log, or
  a fixture; CI keys are generated per run. gitleaks scans full history.
- Workflows run least-privilege, pin non-first-party actions by commit
  SHA, and never expose secrets to forked PRs or arbitrary issue authors
  (agent triggers require write access; fork PRs get no secrets by
  GitHub's own rules — do not reintroduce them via `pull_request_target`).
- No live production credential exists in the `test` environment, ever.

## 10. Scope freeze

Launch completion is the only programme. Until the owner declares launch
done:

- no new product surfaces, no post-launch improvements, no speculative
  refactors; genuine findings go to `backlog`;
- completed milestones stay completed absent concrete evidence of a defect;
- the NestJS 12 migration (#225–#227) stays parked as one coordinated
  post-launch change;
- accepted ADRs stay accepted; superseding one is R3 by definition;
- the owner-held items in `docs/REKODA_OWNER_DECISIONS.md` §2 are not
  worked around, simulated, or marked done by anyone but the owner.
