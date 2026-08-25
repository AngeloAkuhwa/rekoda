# Rekoda Amendment Log

> **GENERATED VIEW — NOT A SOURCE OF TRUTH.**
> The authoritative amendment log lives in `docs/REKODA_END_TO_END_BUILD_PLAN.md` §15. This file is an index for finding an amendment by version; it adds nothing.

| Field | Value |
|---|---|
| Status | Generated index |
| Authority | `docs/REKODA_END_TO_END_BUILD_PLAN.md` §15 |
| Generated against | commit `77ff16c` |

## Canonical specification

| Version | Commit | What it settled |
|---|---|---|
| 1.5 | `856fe3f` (artifact) | First consolidated canonical spec: product model, entitlements, accounting kernel, payment hub, privacy, API |
| 1.6 | `83cd0b6` | Recognition formula replaced after it double-counted contract liability. Verification append-only with sources preserved. POS normalised out of the source enum. `MANUAL_RECONCILIATION` narrowed. Posting roles completed. Chat/Complete boundary clarified |
| 1.6.1 | `ae51bcf` | Freeze hardening. PR-009's generated column was impossible. Conversation schema found to block Integrate structurally. Appendices A–E added: FX, inventory costing, AI processor boundary, risk tiers, lifecycle statuses |
| 1.6.2 | `80322ec` | Idempotency indexes could not have been created; claim projection introduced. Manifests reclassified as operator infrastructure. Weighted-average returns corrected. Invoice status split. FX staleness measured against the accounting timestamp |
| 1.6.3 | `7530c7f` | Evidence and money separated as axes. `confirmationIntegrity`. Per-source verification identity. SECURITY DEFINER hardening. Conversation migration resequenced. `orderId` demoted. Contract-asset refusal made atomic. Readiness split three ways |
| **1.6.4** | **`77ff16c`** | Participant hash scoped against cross-merchant correlation. `conversationKind`. Backfill forbidden from fabricating participants. AI boundary enforced both directions. Away-assistant list extended. Consistency sweep: ambiguous references, stale PR ids |

## Build plan

| Version | Baseline | Change |
|---|---|---|
| 1.0 | 114 | Initial plan against spec v1.5 |
| 1.1 | 115 | PR-115 added for the `verified` drop |
| 1.2 | 116 | PR-058a added for the conversation model |
| 1.3 | 120 | PR-058a split five ways |
| 1.4 | 120 | No new PRs; eighteen hardening rules folded into existing PRs |
| **1.5** | **120** | No new PRs; six corrections folded in, plus the consistency sweep |

## PR identity changes

| Original | Now | Reason |
|---|---|---|
| PR-058a | PR-058a-1 … PR-058a-5 | One L PR over live Chat infrastructure split into expand / migrate / contract |

**No other PR has been split, merged or renumbered.** Splits keep the parent identifier so an old reference still resolves; merges keep the lower identifier and the higher is recorded as merged, never reused.
