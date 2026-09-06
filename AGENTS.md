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

**The launch is NGN-only** (accepted ADR 0033). Multicurrency and embedded
FX are a dark capability behind the FX graduation gate: no agent task may
surface them to any merchant, customer, API, chat, storefront, or
dashboard path.

## 2. Canonical documents outrank model memory

Repository evidence outranks anything a model remembers or assumes. When a
claim matters, verify it against the tree at HEAD.

**Precedence when documents disagree** (surface a conflict you cannot
place; never resolve one by guessing):

1. **The latest approved instrument for the specific decision** — a
   superseding accepted ADR, an approved canonical-spec correction
   (`docs/REKODA_CANONICAL_SPEC.md` §1.1), or a recorded owner ruling
   (`docs/REKODA_OWNER_DECISIONS.md` §1: "the ruling is later and wins").
   A conflict _between_ these is `status:blocked-decision`, not a judgment
   call.
2. **`docs/REKODA_CANONICAL_SPEC.md`** (APPROVED — FROZEN, v1.6.6) — the
   authoritative product and architecture specification. Older plans,
   ADRs, comments and implementations do not override it; it changes only
   through its own §1.1 correction process.
3. **`docs/REKODA_END_TO_END_BUILD_PLAN.md`** (APPROVED, v1.7) — the
   approved implementation scope, order, and completion gates.
4. **`docs/MASTER-PLAN.md` / `docs/architecture.md`** — broader
   product/system context; where they conflict with the spec, the spec
   wins.
5. **`docs/HANDOFF.md`** — current operational/project status.
6. Historical or superseded material — history only, never authority.

| Question                         | Read                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| Product/architecture rule        | `docs/REKODA_CANONICAL_SPEC.md` (find it via `docs/REKODA_DECISION_REGISTER.md`, a generated index) |
| Implementation scope/state/gates | `docs/REKODA_END_TO_END_BUILD_PLAN.md`                                                              |
| Why a decision was made          | `docs/adr/` (check Status — superseded ADRs are history)                                            |
| Owner rulings + owner-held items | `docs/REKODA_OWNER_DECISIONS.md` (§1 rulings, §2 go-live register)                                  |
| Current status, open items       | `docs/HANDOFF.md`                                                                                   |
| The plan and prime directives    | `docs/MASTER-PLAN.md` (Part 0.2)                                                                    |
| Broader system context           | `docs/architecture.md`                                                                              |
| What is safe / gated / forbidden | `docs/safety-review.md` (GREEN/AMBER/RED)                                                           |
| Where code for an area lives     | `docs/agents/CONTEXT-MAP.md`                                                                        |
| The agent operating model        | `docs/AUTONOMOUS-ENGINEERING.md`                                                                    |
| Test environment/secrets design  | `docs/agents/TEST-ENVIRONMENT.md`                                                                   |
| Standing engineering process     | `docs/SYSTEM-PLAN.md` (as reconciled in `docs/AUTONOMOUS-ENGINEERING.md` §9)                        |

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
6. **Posted financial truth is immutable.** The accounting effect of a
   posted journal, the content of an issued document, and recorded payment
   evidence are never edited; corrections are reversing postings, credit
   notes, or compensating events (spec §6.3–§6.4, §9.3, §14.2), and a
   discrepancy is never silently absorbed. Lifecycle transitions the
   canonical spec defines (e.g. invoice `DRAFT → ISSUED → VOID`, spec
   Appendix E.3) are legitimate persisted state changes, and derived
   projections/status fields are rebuildable views, named as such — not
   mutations of the accounting truth.
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

This risk-proportional ladder deliberately supersedes `docs/SYSTEM-PLAN.md`
§1's blanket "whole estate green before every push" for agent work; the
reconciliation is recorded in `docs/AUTONOMOUS-ENGINEERING.md` §9.

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
- **Where each agent's instructions live:** Claude reads `CLAUDE.md`;
  Gemini reads `GEMINI.md`; **Codex's permanent build and review rules
  live in this file** — §7–§9 plus the `## Code Review Rules` section,
  which Codex's native review is documented to load. There is
  deliberately no `CODEX.md`: this file is the one source Codex tooling
  reliably reads, and a second source of truth for symmetry's sake would
  only drift.

## 8. Code review rules

Every implementation review evaluates **three contracts**, in this order:

1. **The linked GitHub issue** — the task-specific contract. The issue is
   authoritative for Outcome, Scope, Non-goals, Acceptance criteria,
   Required tests, Risk, Codex review focus, Gemini review focus, and
   required merge evidence. The builder provides **evidence against** the
   acceptance criteria; it may not rewrite the criteria to fit the
   implementation — not by editing the issue, and not by "interpreting"
   them in the PR.
2. **Canonical repository state and accepted ADRs** — the
   system/invariant contract (§2, §3).
3. **The current PR HEAD plus executable evidence** — the implementation
   contract. Reviewers evaluate what is actually at HEAD, not the PR's
   description of it.

**Contract revisions.** When implementation starts, the issue's
specification state is **contract revision 1**. A genuine requirement
change after that point is made only by a **contract revision**:

- **Who authorizes:** after implementation begins, a revision becomes
  authoritative ONLY through the owner-dispatched contract-authority
  transaction (which freezes every linked PR's merge checks before the
  new revision takes effect, then requires fresh reviews). Anyone —
  planner included — may PROPOSE a change on the issue, but a proposal,
  like a direct body edit, never moves the active merge contract; it
  simply blocks the gates until the owner's transaction lands. The
  builder never authorizes a change to its own contract.
- **How it is recorded:** an issue comment (or issue-body edit that a
  comment announces) stating the new revision number, exactly what
  changed, and why — the previous wording stays visible in the issue's
  edit/comment history and is never deleted.
- **What it invalidates:** a contract revision invalidates **all existing
  reviewer approvals, even when the code HEAD did not change**. Both the
  technical reviewer and Gemini re-review against the new contract. The
  risk label and builder assignment are re-checked and must still match.

Approvals bind to an **exact HEAD SHA and contract revision**. Any push
changes HEAD and invalidates **both** agent approvals; any contract
revision invalidates them too; a previous SHA or revision never approves a
new one. Silence is never approval, and a malformed, stale, or
wrong-identity approval is no approval.

## 9. Merge authority

GitHub — branch protection plus the deterministic gates — is the final
merge authority. A PR is eligible to merge only when **all** of:

1. every required deterministic CI check is green for the current HEAD;
2. the non-builder technical reviewer has an explicit **APPROVE** verdict
   for the current HEAD and contract revision (Codex when Claude built;
   Claude when Codex built);
3. Gemini has an explicit system-acceptance **APPROVE** for the current
   HEAD and contract revision;
4. no blocking review thread remains unresolved;
5. the Agent policy gate passes;
6. R3 only: Angelo's explicit approving review of the current HEAD, with
   the recorded owner decision linked.

**What never counts as approval:** the mere existence of a review; a
COMMENTED review without an APPROVE verdict; resolved threads; a reaction;
silence; a verdict for a previous SHA or contract revision; a malformed
marker. **Owner approval is additive** — it is required on top for R3 and
may be required by CODEOWNERS paths, but it never substitutes for the
non-builder technical reviewer's APPROVE. Missing, malformed, or stale
approval blocks the merge.

**Control-plane activation.** These rules are the contract; GitHub
enforces them only once the owner has activated the configuration
(`docs/AUTONOMOUS-ENGINEERING.md` §5 lists the activation checklist).
**Until the owner confirms activation, the control plane is DRAFT/INACTIVE
and no autonomous merge happens at all.** After activation, the builder
may request or enable GitHub squash auto-merge; whether GitHub's
auto-merge feature holds or drops a queued merge on a later push is
GitHub's internal behaviour — our policy stands independently of it: a new
HEAD or contract revision means the old approvals are invalid, whatever
the auto-merge state says. No agent may ever: use an admin merge or
`--admin`, bypass branch protection, push or force-push `main` directly,
fabricate a review approval, or approve itself.

## Code Review Rules

Every reviewer publishes its verdict as its **own** marker — never another
reviewer's:

| Reviewer                           | Marker                   |
| ---------------------------------- | ------------------------ |
| Codex, technical (Claude built)    | `REKODA_CODEX_APPROVAL`  |
| Claude, technical (Codex built)    | `REKODA_CLAUDE_APPROVAL` |
| Gemini, system acceptance (always) | `REKODA_GEMINI_APPROVAL` |

Each marker binds the protocol scheme, the PR number, the linked issue,
the exact current HEAD SHA, the contract revision (§8), the contract
SNAPSHOT hash (the hash of the authoritative snapshot: issue, revision,
risk, builder, body hash), and an APPROVE or BLOCK verdict. A marker for
any other commit, revision, snapshot, or reviewer identity counts for
nothing.

The rest of this section is **Codex's** review instruction (Codex's native
review is documented to load it):

- FIRST obtain the trusted review contract by running, from the
  repository root at the PR's current HEAD:

  ```
  node scripts/agents/review-context.mjs --repo <owner/name> --pr <number> --out /tmp/contract-snapshot.md
  ```

  It prints the exact `head_sha`, `issue`, `contract_revision`,
  `contract_snapshot_sha256`, `risk`, and `builder` values, writes the
  ACTIVE contract snapshot text (hash-verified) to the `--out` file, and
  prints the marker template to copy. Review THAT snapshot file — never
  the live issue text, which is mutable and may carry pending proposals
  that are not the active contract. NEVER invent or hand-compute the
  snapshot hash from raw issue text; only the script's value is valid.
  If the script exits non-zero there is no authorized contract to review
  against: report that as the finding and emit VERDICT: BLOCK with the
  values the gates published on the PR's checks, or no marker at all —
  a missing marker is already a BLOCK.

- Evaluate the three contracts of §8: the contract snapshot, the accepted
  ADRs/invariants of §3, and the actual code at the PR's current HEAD.
- Probe hardest at: financial correctness (integer kobo, balanced
  postings, immutable posted truth), tenant isolation/RLS, privacy/PII
  boundaries, security, races and concurrency, idempotency, migrations,
  failure paths, and tests that pass for the wrong reason. Add the
  issue's task-specific review focus.
- End **every** review — including reviews with no findings — with this
  exact block, copying every value verbatim from the review-context
  output:

  ```
  REKODA_CODEX_APPROVAL
  SCHEME: REKODA_AGENT_EVIDENCE_V3
  PR: <number>
  ISSUE: <linked issue number>
  HEAD_SHA: <40-char SHA of the commit reviewed>
  CONTRACT_REVISION: <integer from review-context>
  CONTRACT_SNAPSHOT_SHA256: <64-char hash from review-context>
  VERDICT: APPROVE|BLOCK
  ```

  BLOCK if any blocking issue remains; APPROVE only if none does. Never
  emit a marker for a commit other than the one actually reviewed. Codex
  does not sign: the platform is the provenance — the marker counts only
  inside a non-dismissed GitHub review authored by the Codex connector
  whose review commit_id equals the PR's current HEAD, with every field
  matching the gates' own computation.
