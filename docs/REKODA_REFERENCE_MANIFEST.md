# Rekoda Canonical Reference Manifest

| Field | Value |
|---|---|
| Bundle generated | 25 August 2026 |
| **Canonical baseline commit** | `80322ec` (spec v1.6.2, named in the consolidation instruction) |
| **Current canonical head** | `77ff16c` (spec v1.6.4, build plan v1.5) |
| Branch | `claude/session-task-plan-review-likv0v` |

> **Note on the baseline.** The instruction named `80322ec` as the foundation. That commit is spec **v1.6.2**; two approved correction rounds have landed since — v1.6.3 (`7530c7f`) and v1.6.4 (`77ff16c`). This bundle is generated from the **current head**, because generating from `80322ec` would reintroduce defects those rounds fixed, including the impossible partial indexes and the unscoped participant hash. Both are recorded in the amendment log.

## Documents

| Document | Version | Status | Governs | Supersedes |
|---|---|---|---|---|
| `REKODA_CANONICAL_SPEC.md` | 1.6.4 | **AUTHORITATIVE** | Product, architecture, accounting, payments, privacy, entitlements, API, lifecycle | Canonical Product Architecture v2.0; corrections v1.1–v1.6.3; ADR 0004 and ADR 0014 in part |
| `REKODA_END_TO_END_BUILD_PLAN.md` | 1.5 | **AUTHORITATIVE** | Slices, 120-PR index, dependencies, gates, migration safety, completion contracts | Prior build plans |
| `REKODA_USER_JOURNEYS.md` | 1.0 | **AUTHORITATIVE** for journeys, subordinate to the spec | Chat, Integrate and Complete journeys end to end | Chat & Integrate Journey Spec v1.0; `rekoda-chat-v1.md` and `integrate-explained.md` where they conflict |
| `REKODA_DESIGN_SYSTEM.md` | 1.0 | **AUTHORITATIVE** for patterns; token values live elsewhere | Which patterns exist and what a screen may claim | Nothing. It consolidates `design-system/rekoda/MASTER.md` |
| `REKODA_DECISION_REGISTER.md` | 1.0 | **GENERATED VIEW** | Nothing. An index into the two authoritative documents | — |
| `REKODA_AMENDMENT_LOG.md` | 1.0 | **GENERATED VIEW** | Nothing. An index into build plan §15 | — |

## Non-document authorities

| Artifact | Role |
|---|---|
| `design-system/rekoda/MASTER.md` | **Token source of truth.** Generates `tokens.css` |
| `apps/web/src/styles/tokens.css` | Generated tokens the application consumes |
| `scripts/investigations/r0a-i-payment-provenance.sql` | The corrected R0A-i provenance classifier. Read-only. Never run against production yet |
| `scripts/check-boundaries.mjs` | Enforces the AI and persistence boundaries in CI |

## ADR status

| ADR | Status |
|---|---|
| 0004 double-entry ledger, integer kobo | **Partly superseded.** Append-only and integer kobo stand; the fixed chart of accounts is replaced by spec §11 |
| 0014 payment verification, anti-fake-alert | **Superseded** by spec §6. Its instinct — that money has more than two states — is preserved and is why the canonical model looks as it does |
| 0021 privacy gateway | Active. Extended by spec Appendix C |
| 0022 job queue in our own schema | Active |
| 0024 commercial terms | Active for structure; prices are candidates under spec §30 |
| 0025 bank account split | Active |
| 0026 fixed assets | Active |
| 0027 hosted AI at launch | Active. Its processor exception is now canonical in spec Appendix C.2 |
| All others | Active unless the spec marks them superseded |

## Reading order for a new engineer

```
1  REKODA_CANONICAL_SPEC.md 1-3        what Rekoda is, and its boundaries
2  REKODA_USER_JOURNEYS.md Part 4      the fourteen journey invariants
3  REKODA_CANONICAL_SPEC.md 6-7        payment truth. The heart of it.
4  REKODA_CANONICAL_SPEC.md 8-16       the accounting kernel
5  REKODA_END_TO_END_BUILD_PLAN.md 1   what the repository actually is today
6  REKODA_END_TO_END_BUILD_PLAN.md 9   the PR index, and where you are in it
7  REKODA_DESIGN_SYSTEM.md 3           what a screen may claim about money
```

## Verification at generation time

```
spec dangling section references        0
appendix references unresolved          0
PR index entries                        120     matches the stated baseline
superseded rules presented as current   0       all inside SUPERSEDED blocks
PR-006 status                           BLOCKED
```


