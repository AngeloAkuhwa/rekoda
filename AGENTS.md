# Rekoda Engineering Constitution

Provider-neutral rules for every AI agent (Claude, Gemini, Codex, or any
successor) working in this repository. Load this first, every session. Role
instructions live in `CLAUDE.md` (engineer: builder or technical reviewer)
and `GEMINI.md` (planner and system acceptance reviewer); the full
operating model is `docs/AUTONOMOUS-ENGINEERING.md`. The roles and review
rules are §7–§9 of this file.

## 1. Priority: launch first

The 132-PR build plan is complete through PR #231. The remaining work is
launch closeout: owner-held items (`docs/REKODA_OWNER_DECISIONS.md` §2) and
release-candidate drills. **No agent may expand launch scope.** Post-launch
improvements, speculative features, and re-opened milestones are out of
bounds unless the owner asks for them in writing. The NestJS 12 Dependabot
PRs (#225–#227) are deliberately deferred; do not merge or rebase them.

## 2. Canonical documents outrank model memory

Repository evidence outranks anything a model remembers or assumes. When a
claim matters, verify it against the tree at HEAD. If two documents
conflict, the newer accepted ADR wins; raise the conflict rather than
guessing.

| Question                         | Read                                                     |
| -------------------------------- | -------------------------------------------------------- |
| Current status, open items       | `docs/HANDOFF.md`                                        |
| The plan and prime directives    | `docs/MASTER-PLAN.md` (Part 0.2)                         |
| Product/system spec              | `docs/architecture.md`                                   |
| Why a decision was made          | `docs/adr/` (check Status — superseded ADRs are history) |
| What is safe / gated / forbidden | `docs/safety-review.md` (GREEN/AMBER/RED)                |
| Owner-held launch items          | `docs/REKODA_OWNER_DECISIONS.md` §2                      |
| Where code for an area lives     | `docs/agents/CONTEXT-MAP.md`                             |
| The agent operating model        | `docs/AUTONOMOUS-ENGINEERING.md`                         |
| Test environment/secrets design  | `docs/agents/TEST-ENVIRONMENT.md`                        |
| Standing engineering process     | `docs/SYSTEM-PLAN.md`                                    |

## 3. Non-negotiable invariants

These mirror `docs/MASTER-PLAN.md` §0.2 and `docs/safety-review.md`.
Violating any of them is a bug, never a style preference.

1. **Money is integer kobo.** No float ever touches a financial value.
2. **AI proposes, deterministic code disposes.** No AI-produced number is
   authoritative; user-facing figures come from the deterministic layer.
3. **Tenant-owned queries are scoped by `businessId` in code AND by
   Postgres RLS.** Two independent layers, always. `withBusiness()` is the
   only sanctioned path to tenant data.
4. **Customer PII lives in the vault**, travels as tokens, and is
   rehydrated only in the authorised output layer. Never log a message
   body, a customer name, or a token→identity mapping.
5. **Webhooks: verify signature → check idempotency → process.** In that
   order, every time. Processing is idempotent.
6. **Financial records are append-only.** Corrections are reversing
   postings or credit notes — never an `UPDATE` on an issued document, and
   never a silently absorbed discrepancy.
7. **Ledger postings balance or throw.**
8. **Secrets never enter source control, fixtures, or logs.** Compose test
   secrets from one another; gitleaks scans full history.
9. **Accepted ADRs are immutable.** Changing course requires a superseding
   ADR — which is an R3 owner decision.
10. **Every bug fix lands with a regression test that fails before the fix.**
    Never skip, disable, or quarantine a failing test to get green.
11. **No direct push to `main`.** All change flows through a PR that
    clears every merge gate (§9). The builder never approves its own PR,
    and no agent ever uses an admin or bypass merge.
12. **Never hold, route, or delay funds** and never take on KYC of a
    merchant's customers (`docs/safety-review.md` §3 — RED items are
    company-ending, not expensive).

## 4. Risk levels

Every issue and PR carries exactly one risk label.

| Level  | Meaning                            | Examples                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0** | Docs/copy/non-behavioural cleanup  | typo fixes, doc updates, comments                                                                                                                                                                                                                                                                                                                                |
| **R1** | Ordinary isolated behaviour change | one-module feature, refactor, UI, API tweak                                                                                                                                                                                                                                                                                                                      |
| **R2** | Structural or cross-cutting change | DB schema/migrations, external integrations, background jobs, cross-module changes, significant API behaviour                                                                                                                                                                                                                                                    |
| **R3** | Owner decision required            | money movement; ledger/accounting invariants; billing; Paystack financial behaviour; authn/authz; tenant isolation/RLS; privacy/PII boundary; encryption/key management; retention/deletion; irreversible migrations; legal/compliance claims; a new AI/data processor; a new financial provider; superseding an accepted ADR; production destructive operations |

**R3 requires an explicit owner decision before implementation and owner
review before merge.** When unsure between two levels, take the higher.

## 5. Required verification

Before any PR is opened or updated:

- **R0**: `pnpm lint` (Prettier) over the touched files; links resolve.
- **R1**: targeted tests for the change, then `pnpm turbo typecheck lint
test build` and the guard scripts CI runs (`scripts/check-*.mjs`).
- **R2**: all of R1, plus the affected integration suite(s)
  (`@rekoda/db` and/or `@rekoda/api` — **serially, never in parallel**;
  they share one PostgreSQL) and, for migrations, a clean replay
  (CI's foreign-owner job is the reference). Playwright when web routes
  or guards change.
- **R3**: all of R2, plus whatever evidence the owner's decision names
  (e.g. a live sandbox drill for provider behaviour).

Report verification honestly: what ran, what passed, what was skipped and
why. A green tick that ran nothing is a lie.

## 6. Traceability

- Every implementation PR links a GitHub issue; every issue carries risk
  and decision-status labels.
- Branches: `feat/…`, `fix/…`, `docs/…`, `chore/…`; Conventional Commit
  titles; squash-merge (see `CONTRIBUTING.md`).
- Update `docs/HANDOFF.md` in the same PR **only when durable project
  state actually changes** (status, operational facts, open items). Routine
  work needs no HANDOFF edit.
- Decision-level ambiguity is marked `status:blocked-decision` on the
  issue, never resolved by guessing.

## 7. Peer engineers and the one-builder rule

- **Claude and Codex are peer principal implementation engineers.**
  **Gemini** is the planner / issue owner and the system acceptance
  reviewer. **GitHub** is the engineering control plane and the final
  merge authority. **Angelo** decides R3 and launch/business/legal/
  provider questions — nothing routine.
- Every implementation issue carries **exactly one** builder label —
  `builder:claude` or `builder:codex` — assigned by the planner from the
  evidence in the issue (routing guidance: `GEMINI.md`). Once the
  autonomous system is active, no implementation PR may have both or
  neither.
- The non-building engineer is **Reviewer 1** (technical/adversarial
  review). Gemini is always **Reviewer 2** (system acceptance). The
  builder **never** approves, reviews-for-the-gate, or otherwise signs off
  its own implementation, and never satisfies its own technical-review
  requirement.

## 8. Code review rules

Every implementation review evaluates **three contracts**, in this order:

1. **The linked GitHub issue** — the task-specific contract. The issue is
   authoritative for Outcome, Scope, Non-goals, Acceptance criteria,
   Required tests, Risk, Codex review focus, Gemini review focus, and
   required merge evidence. The builder provides **evidence against** the
   acceptance criteria; it may not rewrite the criteria to fit the
   implementation. If a genuine requirement must change after
   implementation starts, the change and its reason are recorded
   transparently on the issue — never silently edited in.
2. **Canonical repository state and accepted ADRs** — the
   system/invariant contract (§2, §3).
3. **The current PR HEAD plus executable evidence** — the implementation
   contract. Reviewers evaluate what is actually at HEAD, not the PR's
   description of it.

Approvals bind to an **exact HEAD SHA**. Any push changes HEAD and
invalidates **both** agent approvals; a previous SHA never approves a new
SHA. Silence is never approval, and a malformed or wrong-identity approval
is no approval.

## 9. Merge authority

GitHub — branch protection plus the deterministic gates — is the final
merge authority. A PR is eligible to merge only when **all** of:

1. every required deterministic CI check is green for the current HEAD;
2. the non-builder technical reviewer approves the current HEAD;
3. Gemini approves system acceptance for the current HEAD;
4. no blocking review thread remains unresolved;
5. the Agent policy gate passes;
6. R3 only: Angelo's explicit approving review of the current HEAD, with
   the recorded owner decision.

The builder may **request or enable GitHub auto-merge** (squash), which
GitHub holds until the gates pass. No agent may ever: use an admin merge
or `--admin`, bypass branch protection, push or force-push `main`
directly, fabricate a review approval, or approve itself.

## Code Review Rules

When reviewing a pull request in this repository (this section is also
read by Codex's native review):

- Evaluate the three contracts of §8: the linked issue, the accepted
  ADRs/invariants of §3, and the actual code at the PR's current HEAD.
- Probe hardest at: financial correctness (integer kobo, balanced
  postings, append-only history), tenant isolation/RLS, privacy/PII
  boundaries, security, races and concurrency, idempotency, migrations,
  failure paths, and tests that pass for the wrong reason. Add the
  issue's task-specific review focus.
- End **every** review — including reviews with no findings — with this
  exact block, using the PR's current HEAD commit SHA:

  ```
  REKODA_CODEX_APPROVAL
  PR: <number>
  ISSUE: <linked issue number>
  HEAD_SHA: <40-char SHA of the commit reviewed>
  VERDICT: APPROVE|BLOCK
  ```

  BLOCK if any blocking issue remains; APPROVE only if none does. Never
  emit a marker for a commit other than the one actually reviewed.
