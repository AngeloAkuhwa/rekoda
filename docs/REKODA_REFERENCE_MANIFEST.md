# Rekoda Reference Manifest

| Field         | Value                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Purpose       | The one list of Rekoda's documents: what each is, whether it is authoritative, what it supersedes, and when it was last verified |
| Last verified | 10 September 2026, against `main` at `7155a2b` plus the repository-reset branch                                                  |
| Replaces      | The 25 August 2026 bundle manifest (spec v1.6.6, "120-PR index"), which is superseded by this file                               |

> A new session should read this file, then follow the reading order in §5.
> `CLAUDE.md` carries the same hierarchy in short form and is the entry point.

## 1. The authority hierarchy

When two documents disagree, the lower number wins **only after** the actual
state has been established from code, tests and migrations, then accepted or
superseding ADRs, then the newest explicit owner decision. A document that
loses is corrected, never left to be rediscovered.

| Rank | Document                                         | Answers                                                                                               | Status                                                                                                                                                   |
| ---- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | `REKODA_CANONICAL_SPEC.md` (v1.6.6, 25 Aug 2026) | What Rekoda is supposed to do: products, entitlements, payment truth, accounting kernel, privacy, API | **AUTHORITATIVE, FROZEN.** Changes only through its own §1.1 correction process. Inline amendment blocks record ADR 0032 (media) and ADR 0033 (NGN-only) |
| B    | `REKODA_CURRENT_STATE.md` (new, 10 Sep 2026)     | What exists in code today, capability by capability, with evidence and the build-plan reconciliation  | **AUTHORITATIVE for implementation status.** Updated whenever a capability's status changes                                                              |
| C    | `REKODA_LAUNCH_READINESS.md` (new, 10 Sep 2026)  | What prevents real users; gates, gaps, test journeys, staging plan, external dependencies             | **AUTHORITATIVE for launch control.** The single control board                                                                                           |
| D    | `REKODA_USER_JOURNEYS.md` (v1.0)                 | How each Chat, Integrate and Complete journey behaves end to end                                      | AUTHORITATIVE for journeys; subordinate to the spec                                                                                                      |
| E    | `REKODA_OWNER_DECISIONS.md`                      | Owner rulings (OWN-n) and the external go-live register                                               | AUTHORITATIVE for rulings until the spec absorbs them; a later ruling wins                                                                               |
| F    | `adr/` (0001–0034, 0030 unused)                  | Why technical decisions were made                                                                     | AUTHORITATIVE per ADR; the Status line records supersession                                                                                              |
| G    | `REKODA_DESIGN_SYSTEM.md` (v1.0)                 | Which UI patterns exist and what a screen may claim about money                                       | AUTHORITATIVE for patterns; tokens live in `design-system/rekoda/MASTER.md`                                                                              |
| H    | `HANDOFF.md`                                     | Session continuity: current SHA, state, next actions, then the historical log                         | OPERATIONAL MEMORY, not specification                                                                                                                    |
| I    | `REKODA_END_TO_END_BUILD_PLAN.md` (v1.7)         | The completed build plan and its amendment log (§15)                                                  | **BUILD HISTORY / COMPLETED PLAN.** Never a to-do list. Kept because §15 is the authoritative amendment record                                           |

## 2. Every document, classified

Classes: **CURRENT AUTHORITATIVE** (a rank above) · **CURRENT SUPPORTING**
(accurate, subordinate) · **RUNBOOK** · **HISTORICAL** (kept, banner added)
· **ARCHIVED** (`docs/archive/`, not authoritative).

### 2.1 Top level

| Document                                                    | Class                                            | Purpose                                                                                              | Supersedes / superseded by                                                                                                             | Verified                 |
| ----------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `REKODA_CANONICAL_SPEC.md`                                  | CURRENT AUTHORITATIVE                            | Product and architecture specification                                                               | Supersedes Canonical Product Architecture v2.0, `archive/architecture.md`, ADR 0004 (chart) and 0014 (in part)                         | 10 Sep 2026              |
| `REKODA_CURRENT_STATE.md`                                   | CURRENT AUTHORITATIVE                            | Evidence-based implementation inventory                                                              | Supersedes the status sections of `HANDOFF.md` and the milestone tables of the archived plans                                          | 10 Sep 2026              |
| `REKODA_LAUNCH_READINESS.md`                                | CURRENT AUTHORITATIVE                            | Launch verdict, gates, gaps, journeys, staging plan                                                  | Absorbs `archive/SYSTEM-PLAN.md` §4 Phase D, `ai-launch-readiness.md` gates, `REKODA_OWNER_DECISIONS.md` §2 into one board             | 10 Sep 2026              |
| `REKODA_USER_JOURNEYS.md`                                   | CURRENT AUTHORITATIVE                            | The journeys                                                                                         | Supersedes `rekoda-chat-v1.md` and `integrate-explained.md` where they conflict                                                        | 10 Sep 2026              |
| `REKODA_OWNER_DECISIONS.md`                                 | CURRENT AUTHORITATIVE                            | Owner rulings; external go-live register                                                             | Supersedes ADR 0024's report-cap clause (OWN-4)                                                                                        | 10 Sep 2026              |
| `REKODA_DESIGN_SYSTEM.md`                                   | CURRENT AUTHORITATIVE                            | UI patterns and money-claim rules                                                                    | Consolidates `design-system/rekoda/MASTER.md` (tokens remain there)                                                                    | 10 Sep 2026              |
| `HANDOFF.md`                                                | OPERATIONAL MEMORY                               | Session continuity; historical session log below the fold                                            | —                                                                                                                                      | 10 Sep 2026              |
| `REKODA_END_TO_END_BUILD_PLAN.md`                           | HISTORICAL (build history)                       | The 138-row, PR-001…PR-132 plan, all merged except the five R0A-i-gated rows; §15 amendment log      | Supersedes `archive/MASTER-PLAN.md` and `archive/engineering-plan.md`                                                                  | 10 Sep 2026              |
| `REKODA_DECISION_REGISTER.md`                               | CURRENT SUPPORTING (generated view)              | Find a decision by name; points at its authority                                                     | —                                                                                                                                      | 25 Aug 2026 (index only) |
| `REKODA_AMENDMENT_LOG.md`                                   | CURRENT SUPPORTING (generated view)              | Spec versions by commit; build-plan baseline history (114 → 120)                                     | Build plan §15 is the source; growth to PR-132 is recorded there, not here                                                             | 25 Aug 2026 (index only) |
| `REKODA_REFERENCE_MANIFEST.md`                              | CURRENT SUPPORTING                               | This file                                                                                            | Supersedes the 25 Aug bundle manifest                                                                                                  | 10 Sep 2026              |
| `ai-model-strategy.md`                                      | CURRENT SUPPORTING                               | One AI port, five roles, model per role, revised for ADR 0032                                        | —                                                                                                                                      | 10 Sep 2026              |
| `ai-launch-readiness.md`                                    | CURRENT SUPPORTING                               | The AI quality gates; every live metric still "not yet run"                                          | Gate list mirrored in `REKODA_LAUNCH_READINESS.md` GATE 5                                                                              | 10 Sep 2026              |
| `metering-v1.md`                                            | CURRENT SUPPORTING                               | Allowances, the seventeen units, top-up and upgrade                                                  | Written against spec §4.2                                                                                                              | 10 Sep 2026              |
| `pricing-model.md`                                          | CURRENT SUPPORTING                               | Commercial ladder and unit economics                                                                 | Prices are candidates (spec §30); annual plans stay on the public page by owner ruling of 4–5 Sep 2026 while the backend bills monthly | 10 Sep 2026              |
| `payments-v1.md`                                            | CURRENT SUPPORTING (partly superseded)           | Payment Hub architecture; §47 is the live Paystack release gate                                      | Payment truth is spec §6–§7; this file keeps the hub design and §47                                                                    | 10 Sep 2026              |
| `rekoda-chat-v1.md`                                         | CURRENT SUPPORTING (partly superseded)           | The Chat/Integrate distinction narrative                                                             | Journeys and spec win where they conflict                                                                                              | 10 Sep 2026              |
| `integrate-explained.md`                                    | CURRENT SUPPORTING (partly superseded)           | Integrate from the vendor's side                                                                     | Journeys and spec win; its Twilio cost arithmetic is historical (ADR 0017/0018)                                                        | 10 Sep 2026              |
| `safety-review.md`                                          | CURRENT SUPPORTING                               | GREEN / AMBER / RED register; the RED list is still binding                                          | —                                                                                                                                      | 10 Sep 2026              |
| `design-plan.md`                                            | CURRENT SUPPORTING                               | How surfaces are designed and reviewed                                                               | Companion to the design system                                                                                                         | 10 Sep 2026              |
| `content-plan.md`                                           | CURRENT SUPPORTING                               | SEO keyword and content plan                                                                         | —                                                                                                                                      | unchanged                |
| `public-api.md`, `public-api-versioning.md`, `openapi.json` | CURRENT SUPPORTING                               | Developer reference for `/api/v1`; `scripts/check-openapi.mjs` keeps it honest                       | —                                                                                                                                      | 10 Sep 2026              |
| `rls-exemption-register.md`                                 | CURRENT SUPPORTING                               | Every `business_id` table without a tenant policy, and why; test-enforced both ways                  | Baseline text says head `0130`; the test asserts against the live catalogue at head `0149`                                             | 10 Sep 2026              |
| `compliance/*` (5 files)                                    | CURRENT SUPPORTING (DRAFT, legal review pending) | Subprocessor register, RoPA, transfer assessment, incident register                                  | —                                                                                                                                      | 29 Aug 2026              |
| `runbooks/*` (8 files)                                      | RUNBOOK                                          | Deploy, backup and restore, incident, key rotation, privacy incident, data erasure, R0A-i provenance | Two planned runbooks do not exist yet: `meta-submission.md`, `integrate-onboarding.md`                                                 | 10 Sep 2026              |
| `audits/*` (4 files, 1 Sep 2026)                            | HISTORICAL                                       | The R1 schema and R2 security audits and their plans                                                 | Remediated in migrations 0130–0149; banner added                                                                                       | 10 Sep 2026              |

### 2.2 Archived (`docs/archive/`, not authoritative)

| Document                      | Why archived                                                                                            | Replaced by                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `archive/architecture.md`     | The original V1 specification; presents Twilio, WABA catalogue capture and per-customer DVAs as current | `REKODA_CANONICAL_SPEC.md`                                             |
| `archive/MASTER-PLAN.md`      | The M0–M5 master build plan (v4.0, 19 Aug 2026)                                                         | Spec + build plan + `REKODA_CURRENT_STATE.md`                          |
| `archive/engineering-plan.md` | The 19 Aug engineering review and M0–M5 milestones                                                      | Same                                                                   |
| `archive/SYSTEM-PLAN.md`      | The 23 Aug process contract and phases A–D                                                              | `CONTRIBUTING.md` (process) and `REKODA_LAUNCH_READINESS.md` (Phase D) |
| `archive/FIX-PLAN-2.md`       | The second adversarial sweep, all batches shipped                                                       | History only                                                           |

### 2.3 Deleted on 10 September 2026

The multi-provider autonomous engineering control plane (planner, builder,
technical reviewer, acceptance reviewer, signed evidence gates) was
abandoned. Deleted: `AGENTS.md`, `GEMINI.md`, `docs/AUTONOMOUS-ENGINEERING.md`,
`docs/agents/` (3 files), `scripts/agents/` (11 files), seven
`.github/workflows/agent-*.yml` workflows and the `agent-task` issue form.
PR #234 (`fix/autonomous-control-plane-activation-hardening`, final SHA
`fc7468b`) was closed unmerged. Nothing product-facing lived in those files.

## 3. Non-document authorities

| Artifact                                                              | Role                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/db/migrations/0000`–`0149`                                  | The schema as it actually is; 150 files, contiguous                                                                      |
| `packages/db/src/rls-invariants.integration.test.ts`                  | Makes the RLS exemption register executable                                                                              |
| `packages/db/src/golden-fixture.integration.test.ts`                  | Proves the accounting ties for the golden business (spec §32)                                                            |
| `design-system/rekoda/MASTER.md`                                      | Token source of truth; generates `apps/web/src/styles/tokens.css`                                                        |
| `scripts/check-boundaries.mjs`                                        | Enforces the AI and persistence boundaries in CI                                                                         |
| `scripts/check-retired-claims.mjs`                                    | Keeps retired architecture claims off current surfaces                                                                   |
| `scripts/check-openapi.mjs`                                           | Keeps `docs/openapi.json` equal to the served API                                                                        |
| `scripts/investigations/r0a-i-payment-provenance.sql`, `run-r0a-i.sh` | The R0A-i provenance classifier; never run against production, and there is no production data yet                       |
| `.env.example`                                                        | Every environment variable, with its reason. Six documented names are read by no code (see current state §Configuration) |

## 4. ADR status summary

| ADR                                                                              | Status                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 0002, 0008, 0009                                                                 | Superseded (by 0011, 0032, 0012 respectively)                                 |
| 0004                                                                             | Accepted; chart of accounts replaced by spec §11; amended by 0025, 0026       |
| 0005                                                                             | Accepted; self-hosted STT half superseded by 0032                             |
| 0007                                                                             | Accepted; default model superseded by 0023 then 0031                          |
| 0013                                                                             | Proposed, deferred (platform-owned Paystack); positioning superseded by 0019  |
| 0014                                                                             | Accepted; two-state model superseded in part by spec §6                       |
| 0024                                                                             | Accepted; report-cap clause superseded by OWN-4; media claims amended by 0032 |
| 0027                                                                             | Accepted; sidecar clause superseded by 0032                                   |
| 0001                                                                             | Accepted; its `pg-boss` and STT-sidecar mechanisms replaced by 0022 and 0032  |
| 0030                                                                             | Number never used                                                             |
| All others (0003, 0006, 0010–0012, 0015–0023, 0025, 0026, 0028, 0029, 0031–0034) | Accepted and current                                                          |

## 5. Reading order for a new session

```
1  CLAUDE.md                              the rules and the map (5 minutes)
2  HANDOFF.md, top section                 where we are right now
3  REKODA_LAUNCH_READINESS.md §1–§3        the verdict and the blockers
4  REKODA_CURRENT_STATE.md, the capability table   what exists, at a glance
5  REKODA_CANONICAL_SPEC.md §2–§3, §5–§6   what Rekoda is; payment truth
6  REKODA_USER_JOURNEYS.md Part 4          the fourteen journey invariants
7  REKODA_CANONICAL_SPEC.md §8–§16         the accounting kernel
8  the ADRs and current-state rows for the area you are about to touch
```

## 6. Why the build plan says 120 and the handoff says 132

Both were true when written and both are imprecise now. The plan started at
114 items (amendment 1.0). The 25 August freeze added PR-115 and split
PR-058a five ways: the stated baseline became 120, though the §9 table
already held 121 rows (PR-017a is an extra row). Between 28 August and
1 September three tranches of owner work were appended, all recorded in §15
and none of them engineering splits: PR-116 to PR-121 (the 28 August owner
rulings), PR-122 to PR-127 (the 29 August AI directive) and PR-128 to
PR-132 (the 29 August launch-readiness review). The index at HEAD holds 138
rows with 132 distinct identifiers. The plan's own header and §4 were never
updated; the 25 August manifest was never regenerated. The reconciliation
row by row is in `REKODA_CURRENT_STATE.md` Appendix A.
