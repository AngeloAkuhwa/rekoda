# AI launch readiness: the gates, and what enforces each one

Status: **gates wired; live measurement pending an owner-run eval.**
Dataset: `apps/api/src/ai/eval/dataset.ts`, version 1.
Harness: `apps/api/src/ai/eval/harness.ts`; live runner `run-eval.ts`.

This page is the launch gate for the AI layer, in two halves. The
**structural gates** are properties of the code, each enforced by a
mechanism and pinned by tests that run on every push — they cannot
regress silently. The **quality gates** are properties of the model, which
no CI stub can measure honestly: they are measured by running the
versioned dataset against the live model, by a person, before launch and
after any model or prompt change.

Do not claim the AI layer is perfect. The design target is
**accepted-answer accuracy over coverage**: a lower coverage rate with
honest clarification is safer than a higher coverage rate containing
silent accounting errors.

## Structural gates (enforced in code, pinned in CI)

| Gate | Mechanism | Pinned by |
|---|---|---|
| Zero invalid model outputs cross the schema border | `parseBusinessCommand` on every reply; unusable never becomes a draft | `interpreter.integration.test.ts` ("a call that produced nothing usable", the ₦10bn ceiling) |
| Every financial write requires explicit confirmation | Command drafts + the conversation confirm gate; no model output posts to the ledger | `meta.integration.test.ts` (confirm flows), command-bus suites |
| No model computes authoritative money | `@rekoda/core` recomputes deterministically; model amounts are testimony | core gates/costing suites |
| 100% of high-value extraction disagreements are blocked | Dual extraction fails CLOSED: no draft from either reading (PR-126) | `interpreter.integration.test.ts` ("high-value dual extraction"), `meta.integration.test.ts` (end-to-end disagreement) |
| 100% of over-limit media rejected before provider spend | Local duration probe + `VOICE_NOTE_MAX_DURATION_SECONDS` before the transcriber; allowances and the daily document ceiling reserved before any provider call (PR-124) | voice boundary tests (at-limit/over-limit), doc-ceiling tests |
| Every hosted call is priced or visibly `priced:false` | Boot refuses unpriced roles and transcribers; maybe-billed timeouts write reconciliation rows (PR-122/123) | `model-prices.test.ts`, telemetry integration tests |
| Concurrency cannot exceed ceilings | Limits live in SQL WHERE clauses, never read-then-decide | `quota.integration.test.ts` (20-parallel tests) |
| Uncertainty is never converted into a guessed command | Escalation is bounded and falls back to the merchant's question (PR-125) | escalation tests; eval harness scores a guess on ambiguity as the failure |
| Raw PII never reaches a reasoning model | Gateway tokenisation + `detectStructuralPii` fail-close | privacy suites; the dataset integrity test runs the same detector |

## Quality gates (measured live, recorded here)

Run:

```
ANTHROPIC_API_KEY=... DATABASE_URL=... npx tsx src/ai/eval/run-eval.ts
```

from `apps/api`, against a non-production database. Each run spends real
provider money on ~30 calls plus escalations. Record the metric block
below, dated, with the model ids in force.

| Metric | Gate | Latest measured |
|---|---|---|
| Accepted-answer accuracy | ≥ threshold the owner signs (recommend ≥ 0.95) | _not yet run_ |
| Amount exact match | ≥ 0.98 recommended — a wrong amount is the worst outcome | _not yet run_ |
| Quantity exact match | ≥ 0.95 recommended | _not yet run_ |
| Customer-token handling | 1.00 — a token swap is a mis-filed customer | _not yet run_ |
| Abstained on ambiguous | 1.00 — the "never guess" gate | _not yet run_ |
| Injection resisted | 1.00 | _not yet run_ |
| Clarification rate | informational — high is a UX cost, not a safety fault | _not yet run_ |
| Escalation rate | informational — drives the Opus line in the margin view | _not yet run_ |
| Cost per correct accepted draft | informational — printed by the runner | _not yet run_ |

The recommended thresholds are recommendations; **the owner sets and
signs the final numbers** before launch. A model or prompt change resets
the "latest measured" column.

## What the harness deliberately does not do

- **Run against the live model in CI.** A gate measured on every push
  burns provider budget to reconfirm yesterday's number.
- **Carry raw evaluation media.** Voice and photograph cases appear as
  the transcripts and extracted text those pipelines hand the
  interpreter, which is the layer under evaluation. Raw audio/image
  evaluation belongs to the transcription/vision bench (ADR 0008's
  M3 benchmark), run outside the repository.
- **Tolerate a fixture that breaks the rules.** The dataset test runs
  the structural-PII detector over every input and requires every
  category present, so the dataset stays de-identified and complete as
  cases are added.
