# Rekoda Design System Reference

| Field | Value |
|---|---|
| Status | **CANONICAL — consolidates the existing system, extends it to spec v1.6.6** |
| Version | 1.0 |
| Effective date | 25 August 2026 |
| Token source of truth | `design-system/rekoda/MASTER.md` → generates `apps/web/src/styles/tokens.css` |
| Governed by | `docs/REKODA_CANONICAL_SPEC.md` v1.6.6 |

> **This document does not replace the existing design system. It consolidates it and extends it.** Rekoda already has a working system with real tokens, a stated brief and non-negotiable rules. The design direction below is that system, not a new one.

## 0. Where truth lives

Duplicating tokens into this file would create a second answer to every colour question, so it does not.

| Concern | Authority |
|---|---|
| Token values, palette rationale, typography choice | `design-system/rekoda/MASTER.md` |
| The generated tokens the app actually consumes | `apps/web/src/styles/tokens.css` |
| Base element styles, utilities, component CSS | `apps/web/src/styles/globals.css` |
| Which patterns must exist and what they may claim | **this document** |
| What a screen is allowed to assert about money | **the canonical spec**, always |

**A raw hex in a component is a bug.** Edit `MASTER.md`, regenerate `tokens.css`, then use the token.

---

## 1. The brief

> **A money product for people who have been let down by money products.**

The job is not to look modern. It is to make a merchant with a ₦40,000 Android phone, an intermittent connection and no accounting vocabulary believe — **correctly** — that the numbers are true.

Direction: **conventional, calm, legible.** Nothing experimental. Brutalism and asymmetry sell agencies; they do not sell ledgers.

---

## 2. Foundations, as built

```
Display     Calistoga           headings only, weight 400
Body        Inter, Noto Sans    Noto ahead of system fallbacks because the ₦
                                (U+20A6) is missing from many system faces and
                                a fallback glyph makes every price look broken
Mono        ui-monospace stack

Scale       xs .75 · sm .875 · base 1 · lg 1.125 · xl 1.375
            2xl 1.75 · 3xl 2.25 · 4xl 3rem

Space       4 · 8 · 12 · 16 · 24 · 32 · 48 · 64
Radius      6 · 10 · 14 · full
Elevation   three shadows, re-stated for dark rather than reused
Motion      fast 150ms · base 220ms · slow 320ms
            cubic-bezier(0.2, 0, 0.2, 1)
            low motion tier on /app/* — overshoot on dense data reads as sloppy
Container   1120px
Breakpoints 360 → 375 → 768 → 1440, and 360 is where design STARTS
```

### Colour

Teal on warm sand, deliberately kept against a generated recommendation of indigo on violet-tint. The reasons are recorded in `MASTER.md` §0 and are worth preserving: the predecessor shipped teal-on-warm-neutral to real Nigerian merchants and it tested well, and warm neutral reads friendlier than a tech-forward violet to a market vendor on a budget phone.

```
--rk-bg · --rk-surface · --rk-surface-sunk · --rk-border
--rk-text · --rk-text-muted
--rk-accent · --rk-accent-hover · --rk-on-accent · --rk-focus
--rk-warn-surface · --rk-warn-border · --rk-warn-text
--rk-danger
```

Dark mode is real and complete: `prefers-color-scheme` guarded by `:root:not([data-theme='light'])`, plus an explicit `[data-theme='dark']` block so the toggle wins in both directions.

### Charts

```
--rk-chart-in   #0d9488   money in, brand teal
--rk-chart-out  #9d3557   money out, WINE
```

Wine rather than an orange because every warm-orange candidate sat within ΔE 3 of `--rk-attention`, and **a spend bar must never read as a warning.** Fixed assignment, never cycled. Re-stepped and re-validated for dark rather than flipped.

---

## 3. Money truth states — the most important thing in the system

### 3.1 DRIFT: `MoneyBadge` predates the frozen provenance model

`MASTER.md` §6 says **"`MoneyBadge` is the most important component in the system"** and encodes ADR 0014's three states: `VERIFIED` · `RECORDED` · `NOT SEEN`.

**ADR 0014 is SUPERSEDED by canonical spec §6.** The component is not wrong in spirit — its instinct, that money has more than two states and that "recorded" is neither a warning nor a failure, is exactly right and is why the canonical model looks the way it does. But the state set no longer matches.

```
CLASSIFICATION: REFACTOR — not REPLACE.
The component, its restraint and its colour discipline are preserved.
Its state enum is remapped onto derived trust.
Lands in PR-008 (readers cutover), spec §6.8.
```

### 3.2 The canonical mapping

```
derived trust (spec §6.8)          badge            token
─────────────────────────────────────────────────────────────────
EXTERNALLY_VERIFIED                Bank verified    --rk-verified
  provider verify · bank feed        or
  match · manual reconciliation    Provider verified

ATTESTED                           Merchant         --rk-recorded
  merchant confirmed it            confirmed        NEVER a warning

UNESTABLISHED                      Not seen         --rk-notseen
  no active verification                            NEVER a failure

confirmationIntegrity              Needs review     --rk-attention
  = NEEDS_REVIEW (spec §6.7)                        a genuine open question

PaymentEvidence, unresolved        Payment          --rk-notseen
  a screenshot and nothing more    reported         NEVER "Paid"
```

### 3.3 The language rule

> **User-visible language must never imply stronger truth than Rekoda possesses.**

```
merchant said a transfer arrived      "Merchant confirmed"      ✓
                                      "Bank verified"           ✗
provider verified server-side         "Provider verified"       ✓
bank feed matched the line            "Bank verified"           ✓
a customer sent a screenshot          "Payment reported"        ✓
                                      "Paid"                    ✗
                                      "Payment received"        ✗
a bank credit nobody has classified   "Needs review"            ✓
                                      "Income"                  ✗
```

This is not copy preference. It is the anti-fake-alert defence the entire product rests on, expressed at the only place a merchant actually reads it.

---

## 4. Component inventory

**Built** (`apps/web/src/components/ui/`): `Button` · `Field` · `Money` · `MoneyBadge` · `PendingButton` · `RegisterPager` · `Stepper` · `ThemeToggle`

**Specified in MASTER.md, to build as slices need them:** `Input` · `Select` · `Textarea` · `Card` · `Table` · `Badge` · `StatTile` · `Toast` · `Dialog` · `Tabs` · `Skeleton` · `EmptyState`

**Added by the canonical spec, owned by the slice that needs them:**

| Component | Slice | What it must express |
|---|---|---|
| `TrustBadge` | PR-008 | The five states of §3.2, and no sixth |
| `EvidenceCard` | R0A-ii | A reported payment, its resolution state and its deadline |
| `VerificationTimeline` | R0A-ii | Append-only history, revocations shown struck but present |
| `HighRiskConfirm` | E1 | Names the consequence in the merchant's own words |
| `EntitlementRefusal` | E1 | What is unavailable, why, and what would change it |
| `UsageMeter` | E1 / BL2 | Units used against the allowance, never a surprise |
| `ReconciliationConfidence` | B1 | Exact · strong · suggested · manual, visibly different |
| `ConnectionHealth` | P1 | Four independent statuses, never blended into one dot |
| `CollectionStatus` | D1 | Lifecycle, payment and aging as three separate readings |
| `AuditTimeline` | D1 | Who did what, when, with what reason |
| `AccountantView` | D1 | Dense, keyboard-first, tabular-numeral throughout |

---

## 5. Rekoda-specific patterns

### 5.1 Confirmation, by risk tier (spec App. D)

```
READ_ONLY     no confirmation. A question is not a transaction.

STANDARD      a preview that names amounts, customer and effect, then a
              plain yes. This is the existing draft mechanism and it is
              the reason attestation is provable at all.

HIGH_RISK     names the CONSEQUENCE, not the action:
                "Refund ₦20,000 to Ada. The money leaves your account."
              never "Confirm?"
              requires an authenticated actor and records a reason.
              NEVER available to the away assistant.
```

### 5.2 Entitlement refusal

A refusal is a sentence a merchant can act on, never a dead end:

```
what they tried · why it is unavailable · what would change it
"Customer orders are part of Rekoda Integrate. Your plan is Chat."
```

Never "permission denied". Never a silently hidden control that fails on click — the frontend hides what cannot be used, and the server refuses it anyway.

### 5.3 Connection health

Four statuses, four readings. Blending them makes "operationally healthy but commercially suspended" unrepresentable, which is a state that will happen.

```
operational · kyc · commercial · compliance  →  productionEnabled (derived)
```

### 5.4 Chat composer, voice, upload

```
composer      the merchant's own words. No command syntax, ever.
voice         recording state is visible and stoppable; the transcript is
              shown before it is acted on
upload        the file, its progress, and what will happen to it
              never claims to have read a document it could not read
```

---

## 6. Non-negotiable rules

Carried unchanged from `MASTER.md` §7, because they are correct:

1. **Every money figure renders through `formatKobo`.** Hand-rolled currency formatting is a review rejection.
2. **Money never shifts on load.** A figure that reflows after hydration reads as an unreliable figure.
3. **Mobile-first is literal.** Design at 360px, enhance upward.
4. **Touch targets ≥ 44×44px, ≥ 8px apart.** No hover-only affordances.
5. **SVG icons only — never emoji as an icon**, in the UI or in WhatsApp copy.
6. **Skeletons, not spinners.** CLS < 0.1.
7. **Empty states teach the next action.**
8. **Visible focus rings**, never removed. Full keyboard path.
9. **Light and dark both meet 4.5:1.** No colour-only meaning.
10. **Payload budgets:** marketing and storefront < 120 KB JS, dashboard < 250 KB. **Data costs the user money.**

Added by this document:

11. **No screen claims more certainty than the record supports** (§3.3).
12. **Every screen traces to a canonical capability, a journey, an entitlement, a risk tier and a state model.** A screen that cannot name all five has been designed in isolation and will force domain logic to bend to it later.

---

## 7. Accessibility

```
contrast          4.5:1 minimum, light AND dark, verified not assumed
keyboard          complete path; icon-only controls labelled
focus             always visible, never removed
semantics         real labels, errors associated with their field
screen readers    state announced, not implied by colour
touch             ≥44×44, ≥8px apart
motion            prefers-reduced-motion honoured
responsive        360 · 375 · 768 · 1440, no horizontal page scroll
```

---

## 8. Voice and content

```
concise                  a merchant is reading on a phone, one-handed
trustworthy              never overstate what is known
businesslike             not chatty, not stiff
understandable           no accounting jargon where plain words exist,
                         and plain words where jargon would hide something
exact                    amounts and currency, always in full
irreversible actions     say what will happen, in the merchant's own terms
no em dashes in UI copy  a standing product rule
```

---

## 9. Pre-delivery checklist

Every UI PR. Carried from `MASTER.md` §8 with two additions.

```
[ ] built from tokens · zero raw hex
[ ] 360 / 375 / 768 / 1440 — no horizontal page scroll
[ ] light AND dark, both ≥ 4.5:1
[ ] touch ≥44×44, ≥8px apart
[ ] keyboard path complete; focus visible; icon-only controls labelled
[ ] prefers-reduced-motion honoured
[ ] skeletons for async; no layout shift
[ ] money via formatKobo, tabular numerals
[ ] empty states teach
[ ] cursor: pointer on every clickable element
[ ] screenshots (light + dark × mobile + desktop) to the owner
[ ] NEW: no state label claims more truth than the record supports (§3.3)
[ ] NEW: the screen names its capability, journey, entitlement, risk tier
        and state model
```
