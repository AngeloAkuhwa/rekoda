# Rekoda Design System — MASTER

**Version:** 1.0 · 19 August 2026 · **Global source of truth for every surface.**

> **Provenance — reconciled against the real skill, 19 Aug 2026.**
>
> The full `ui-ux-pro-max` skill (scripts + 192 palettes, 74 font pairings, 119
> UX guidelines, 1,935 Google Fonts) is now **vendored at
> [`../reference/ui-ux-pro-max/`](../reference/ui-ux-pro-max/)** and runs from
> this repo — no session depends on the skill being synced. Its raw output for
> Rekoda is persisted verbatim at
> [`../rekoda-generated/MASTER.md`](../rekoda-generated/MASTER.md).
>
> **This file is the binding artefact.** Where it differs from the generated one,
> the difference is deliberate and recorded in §0.

```bash
# regenerate the raw output (from the repo root)
python3 design-system/reference/ui-ux-pro-max/scripts/search.py \
  "fintech bookkeeping SaaS small business mobile-first" \
  --design-system --persist -p "Rekoda Generated" --output-dir . \
  --variance 3 --motion 4 --density 6

# targeted lookups
python3 design-system/reference/ui-ux-pro-max/scripts/search.py "<query>" --domain ux
```

---

## 0. Where this differs from the generated system, and why

**The skill independently confirmed the two decisions that matter most:**

| Decision | Skill output | Verdict |
|---|---|---|
| **Typography — Calistoga + Inter** | Same pairing, matched to *"B2B SaaS mobile, **fintech apps**, analytics dashboards"*, mood *"fintech, business, dual font, human warmth"* | ✅ **Independently confirmed.** Chosen here from predecessor testing; the database agrees. |
| **Style — Minimalism & Swiss** | *"Clean, functional, high contrast, grid-based… best for dashboards, SaaS platforms, professional tools"* | ✅ Matches the `--variance 3` brief exactly |
| **Pattern — Trust & Authority + Conversion** | *"Security badges. Transparent pricing. Low-friction form."* | ✅ Matches "trust is the conversion barrier, not features" |

**One deliberate override — colour.** The generated system proposes **indigo
`#6366F1` + emerald `#059669` on a violet-tinted ground `#F5F3FF`** ("Navy/Grey
corporate. Trust blue."). **Rekoda keeps teal-on-warm-sand**, for reasons the
database cannot see:

1. **Market evidence beats a category match.** The predecessor (VoiceReceipt)
   shipped teal-on-warm-neutral to real Nigerian merchants and it tested well.
   MASTER-PLAN Part 5.2.1 says *evolve, don't discard*.
2. **The exact values are in the database anyway** — a `--domain color` search
   returns **Primary `#0F766E`, Secondary `#14B8A6`**, the precise teals used
   here, just filed under a different product type. The palette is validated;
   only its category label differs.
3. **Warm beats cool for this audience.** A violet-tinted ground reads
   tech-forward; the buyer is a market vendor on a budget Android, and warm
   neutral is friendlier without being unserious.

**Adopted from the generated output**: the `On-*` colour-role convention
(already used here), `--rk-danger`/`ring` roles, the anti-pattern list, and two
checklist items this file was missing — **`cursor: pointer` on every clickable
element**, and testing at **375px** as well as 360.

**Motion note from the skill's stagger preset, worth keeping:** *"Don't use
`back.out` on dense data tables — the overshoot reads as sloppy on informational
UI."* That is exactly why Rekoda runs a **low** motion tier on `/business/*`.

---

## 1. The brief in one line

**A money product for people who have been let down by money products.** The job
is not to look modern; it is to make a merchant with a ₦40,000 Android phone, an
intermittent connection and no accounting vocabulary believe — correctly — that
the numbers are true.

Design direction: **conventional, calm, legible**. Nothing experimental. Brutalism
and asymmetry sell agencies; they do not sell ledgers.

---

## 2. Colour tokens

Evolved from the predecessor's tested teal-on-warm-neutral. Teal reads as
trustworthy-but-not-a-bank in this market; the warm ground keeps it from feeling
clinical.

```css
:root {
  /* Brand */
  --rk-teal-50:  #f0fdfa;  --rk-teal-100: #ccfbf1;  --rk-teal-200: #99f6e4;
  --rk-teal-500: #14b8a6;  --rk-teal-600: #0d9488;  --rk-teal-700: #0f766e;
  --rk-teal-800: #115e59;  --rk-teal-900: #134e4a;

  /* Warm neutral ground */
  --rk-sand-50:  #fcfcfb;  --rk-sand-100: #f7f6f3;  --rk-sand-200: #eceae4;
  --rk-sand-300: #ddd9d0;  --rk-sand-600: #6b6862;  --rk-sand-700: #4a4843;
  --rk-sand-900: #1c1b19;

  /* Semantic — money states (ADR 0014: three states, never two) */
  --rk-verified:   #0d9488;  /* provider-confirmed. Quiet affirmative. */
  --rk-recorded:   #6b6862;  /* merchant said so. NEUTRAL — never a warning. */
  --rk-notseen:    #8a877f;  /* not observed yet. NEVER styled as failure.  */
  --rk-attention:  #b45309;  /* genuine mismatch only                       */
  --rk-danger:     #b91c1c;

  /* Applied */
  --rk-bg:            var(--rk-sand-50);
  --rk-surface:       #ffffff;
  --rk-surface-sunk:  var(--rk-sand-100);
  --rk-border:        var(--rk-sand-300);
  --rk-text:          var(--rk-sand-900);
  --rk-text-muted:    var(--rk-sand-600);
  --rk-accent:        var(--rk-teal-700);
  --rk-accent-hover:  var(--rk-teal-800);
  --rk-focus:         var(--rk-teal-600);
}

:root:not([data-theme="light"]) { /* dark via system */ }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --rk-bg:           #14140f;
    --rk-surface:      #1c1b18;
    --rk-surface-sunk: #232220;
    --rk-border:       #35332e;
    --rk-text:         #f2f1ec;
    --rk-text-muted:   #a8a49b;
    --rk-accent:       var(--rk-teal-500);
    --rk-accent-hover: var(--rk-teal-200);
    --rk-verified:     #2dd4bf;
    --rk-recorded:     #a8a49b;
    --rk-notseen:      #8a877f;
    --rk-attention:    #f59e0b;
    --rk-danger:       #f87171;
  }
}
:root[data-theme="dark"] { /* same overrides — toggle must win both ways */ }
```

**Contrast, verified targets (P1):** `--rk-text` on `--rk-bg` ≥ 15:1 ·
`--rk-text-muted` on `--rk-bg` ≥ 4.6:1 · white on `--rk-accent` ≥ 4.5:1 ·
dark-mode `--rk-accent` on `--rk-bg` ≥ 7:1.

**Rule: a raw hex in a component is a bug.** Semantic tokens only.

### Chart series (dashboard)

Two fixed series, assigned by entity and never cycled: money **in** wears the
brand teal, money **out** wears wine. Wine and not orange, deliberately: every
warm orange candidate sat within ΔE 3 of `--rk-attention`, and a spend bar must
never read as a warning. Each mode's steps were validated separately against
its own surface with the dataviz six-checks script (lightness band, chroma
floor, CVD ΔE ≥ 8 adjacent, ≥ 3:1 contrast) — dark is a re-step, not a flip.

```css
--rk-chart-in:  #0d9488;  /* light */   --rk-chart-out: #9d3557;
--rk-chart-in:  #11a897;  /* dark  */   --rk-chart-out: #a84368;
```

Status colours (`--rk-attention`, `--rk-danger`) are never chart series.

---

## 3. Typography

| Role | Family | Notes |
|---|---|---|
| Display | **Calistoga** | Headings only. Tested well on the predecessor. One weight (400). |
| Body / UI | **Inter** | 400/500/600. `font-feature-settings: "tnum"` on **all** money. |
| Mono | `ui-monospace, SFMono-Regular, Menlo, monospace` | Document numbers, references |

```css
--rk-text-xs: 0.75rem;  --rk-text-sm: 0.875rem; --rk-text-base: 1rem;
--rk-text-lg: 1.125rem; --rk-text-xl: 1.375rem; --rk-text-2xl: 1.75rem;
--rk-text-3xl: 2.25rem; --rk-text-4xl: 3rem;
--rk-leading-tight: 1.2; --rk-leading-normal: 1.5; --rk-leading-relaxed: 1.65;
```

**Rules (P6):** body base **16px minimum**, never below 12px anywhere.
Line-height 1.5 on body. Max **two font files** — the data budget is real.
**Tabular numerals on every money figure**, so columns align and digits do not
jitter on update.

---

## 4. Spacing, radius, elevation

```css
--rk-space-1: 4px;  --rk-space-2: 8px;  --rk-space-3: 12px; --rk-space-4: 16px;
--rk-space-5: 24px; --rk-space-6: 32px; --rk-space-8: 48px; --rk-space-10: 64px;

--rk-radius-sm: 6px; --rk-radius-md: 10px; --rk-radius-lg: 14px; --rk-radius-full: 999px;

--rk-shadow-sm: 0 1px 2px rgb(28 27 25 / 0.06);
--rk-shadow-md: 0 2px 8px rgb(28 27 25 / 0.08);
--rk-shadow-lg: 0 8px 24px rgb(28 27 25 / 0.10);
```

**Density:** marketing and storefront use 4–8 (spacious); `/business/*` uses
3–6 (financial tables need tighter rhythm); `/admin/*` uses 2–5 (operator tool).

---

## 5. Motion

```css
--rk-dur-fast: 120ms;  /* state feedback            */
--rk-dur-base: 200ms;  /* enters, reveals           */
--rk-dur-slow: 320ms;  /* page-level transitions    */
--rk-ease: cubic-bezier(0.2, 0, 0.2, 1);
--rk-ease-out: cubic-bezier(0, 0, 0.2, 1);
```

Motion tier **low**. It clarifies state change and nothing else — no
scroll-jacking, no decorative choreography. **Exits faster than entrances.**
Animate `transform`/`opacity` only, never `width`/`height`.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important; scroll-behavior: auto !important;
  }
}
```

---

## 6. Component inventory (M1)

`Button` (primary/secondary/ghost/danger) · `Input` · `Select` · `Textarea` ·
`Card` · `Table` · `Badge` · `MoneyBadge` (the three states) · `StatTile` ·
`Toast` · `Dialog` · `Tabs` · `Skeleton` · `EmptyState` · `Stepper` ·
`ThemeToggle`

**`MoneyBadge` is the most important component in the system** and encodes ADR
0014: `VERIFIED` (quiet affirmative, `--rk-verified`) · `RECORDED` (neutral,
`--rk-recorded`, **never a warning**) · `NOT SEEN` (`--rk-notseen`, **never a
failure**). Only genuine mismatches use `--rk-attention`.

---

## 7. Non-negotiable rules

1. **Every money figure renders through `formatKobo`.** Hand-rolled currency
   formatting anywhere in `apps/web` is a review rejection.
2. **Money never shifts on load.** Reserve exact space; a figure that reflows
   after hydration reads as an unreliable figure.
3. **Mobile-first is literal.** Design at **360px**, enhance upward.
4. **Touch targets ≥44×44px, ≥8px apart.** No hover-only affordances.
5. **SVG icons only — never emoji as an icon**, in the UI or in WhatsApp copy.
6. **Skeletons, not spinners.** Reserve space; CLS < 0.1.
7. **Empty states teach the next action.**
8. **Visible focus rings**, never removed. Full keyboard path.
9. **Light and dark both meet 4.5:1.** No colour-only meaning.
10. **Payload budgets:** marketing/storefront **< 120 KB JS**; dashboard
    **< 250 KB**. Data costs the user money.

---

## 8. Pre-delivery checklist (every UI PR)

- [ ] Built from these tokens · **zero raw hex**
- [ ] 360 / 768 / 1440 — no horizontal page scroll
- [ ] Light **and** dark, both ≥ 4.5:1
- [ ] Touch ≥44×44, ≥8px apart
- [ ] Keyboard path complete; focus visible; icon-only controls labelled
- [ ] `prefers-reduced-motion` honoured
- [ ] Skeletons for async; no layout shift
- [ ] Money via `formatKobo`, tabular numerals
- [ ] Empty states teach
- [ ] `cursor: pointer` on every clickable element
- [ ] Checked at **375px** as well as 360 / 768 / 1440
- [ ] Screenshots (light + dark × mobile + desktop) to the owner
