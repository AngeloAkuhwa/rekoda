# Rekoda — Design & UX Plan

**Version:** 1.0 · 19 August 2026
**Owns:** how every Rekoda surface is designed, built and reviewed.
**Companion to:** `MASTER-PLAN.md` Part 6 (which lists *what* screens exist —
this document says *how they are made good*).

---

## 1. The design problem, stated honestly

Rekoda is a **money product for people who have been let down by money
products**. That single sentence drives every decision below. The design job is
not to look modern; it is to make a merchant with a ₦40,000 Android phone, an
intermittent connection and no accounting vocabulary believe — correctly — that
the numbers on the screen are true.

Four constraints fall out of the market and none of them are negotiable:

| Constraint | Consequence for design |
|---|---|
| **The median device is a budget Android at 360–390 CSS px** | Mobile-first is literal, not aspirational. Every screen is designed at 360px *first* and enhanced upward. A layout that only works at 1440 has failed. |
| **Data costs real money to the user** | Payload is a design constraint. Performance budget: **< 120 KB JS on first load** for marketing, **< 250 KB** for the dashboard shell. No web fonts over 2 files. Images WebP/AVIF, lazy, with reserved space (CLS < 0.1). |
| **The network is flaky** | Skeletons not spinners; optimistic states only where reversible; every failed action states what happened and how to retry. Never a dead screen. |
| **Trust is the conversion barrier, not features** | Money figures get typographic weight and never move on load. `RECORDED` vs `VERIFIED` is a visual distinction, not a tooltip. Trust pages (`/security`, `/ai-privacy`) are designed, not dumped. |

---

## 2. Tooling pipeline

Two installed capabilities, used at different altitudes. They are not
interchangeable.

### 2.1 `ui-ux-pro-max` — the system layer

Owns tokens, palette, type pairing, spacing, motion tiers, and the
accessibility gate. Run **once at M1 kickoff**, persisted, then treated as law:

```bash
python3 "$SKILL/scripts/search.py" \
  "fintech bookkeeping SaaS small business mobile-first" \
  --design-system --persist -p "Rekoda" \
  --output-dir "$(git rev-parse --show-toplevel)" \
  --density 6 --motion 4 --variance 3
```

* `--density 6` — financial tables need tighter rhythm than a marketing page;
  generate a second pass at `--density 8 --page dashboard` for `/business/*`.
* `--motion 4` — this is a trust product. Motion clarifies state change and
  nothing else. No scroll-jacking, no decorative choreography.
* `--variance 3` — conventional, centred, unsurprising. Brutalism and
  asymmetry sell agencies; they do not sell ledgers.

Output lands at `design-system/rekoda/MASTER.md` with page overrides under
`design-system/rekoda/pages/`. Read MASTER before every UI PR; `--force` only
with explicit owner authorisation.

> **Environment caveat, verified 19 Aug 2026.** In the remote Claude Code
> session only the skill's `SKILL.md` is synced — `scripts/search.py` and the
> style/palette/font datasets are **not present**, so the command above cannot
> run there and returns nothing. Generate the design system in a session where
> the full skill payload is installed (local Claude Code), commit
> `design-system/rekoda/`, and every later session reads the committed files.
> Until that exists, UI work follows the fallback rules in §3 and §5 and must
> be labelled as built-in defaults, not database-matched recommendations.

### 2.2 `21st.dev` — the component layer

Verified working in this session. Returns installable shadcn components:

```
npx shadcn@latest add "https://21st.dev/r/<author>/<component>?api_key=$API_KEY_21ST"
```

**Rule: 21st.dev supplies structure and interaction ideas, never tokens.**
Every imported component is immediately re-skinned onto Rekoda tokens in the
same commit. A component that still carries its author's palette after review
is a bug. Scouted starting points:

| Surface | Component | Use for |
|---|---|---|
| `/business` overview | [Financial Dashboard](https://21st.dev/@ravikatiyar162/components/financial-dashboard) | Hub layout, quick actions, recent-transaction rhythm |
| Stat tiles | [Financial Score Cards](https://21st.dev/@designali-in/components/financial-score-cards) | Staggered entrance, badge treatment |
| Reports | [Advanced Stats](https://21st.dev/@uilayout.contact/components/advanced-stats) | KPI row + area chart pairing |
| Payments summary | [Payment Summary Card](https://21st.dev/@kavikatiyar/components/card-3) | Primary metric + clickable sub-section |
| `/pricing` | Search `pricing table monthly annual toggle` | Tier ladder |
| `/` hero | Search `financial hero scroll reveal` | Phone-mock hero |

---

## 3. Non-negotiable UI rules

Derived from `ui-ux-pro-max` priority categories 1–10, ordered by their
priority, with Rekoda-specific bindings.

**P1 Accessibility.** 4.5:1 contrast in *both* themes. Every icon-only control
carries an accessible label. Focus rings visible and never removed. Keyboard
path through every flow. Decorative icons `aria-hidden`.

**P2 Touch & interaction.** 44×44px minimum, 8px minimum separation. Every
action gives feedback within 100ms. Nothing depends on hover — the primary
device has no pointer.

**P3 Performance.** Budgets in §1. Reserve space for every async region.
Virtualise any list that can exceed ~200 rows (transactions, customers).

**P4 Style.** SVG icons only — **never emoji as an icon**, in the UI or in
WhatsApp copy. One icon family throughout.

**P5 Layout.** Mobile-first breakpoints. No horizontal page scroll, ever —
wide tables scroll inside their own container. Never disable zoom.

**P6 Typography & colour.** 16px base body minimum; 1.5 line-height; no body
text under 12px. **Semantic tokens only — a raw hex in a component is a bug.**

**P7 Motion.** Motion carries meaning: state changes, spatial continuity.
Different durations for different intents; exits faster than entrances.
`prefers-reduced-motion` respected everywhere.

**P8 Forms.** Visible labels — never placeholder-as-label. Errors inline, next
to the field, in words, not codes. Progressive disclosure over walls of input.

**P9 Navigation.** Bottom nav ≤5 items on mobile. Predictable back. Deep links
work — a magic link must land on the intended page.

**P10 Charts.** Never colour alone to convey meaning: pair with label, shape or
pattern. Legends and tooltips always.

### 3.1 Rekoda-specific additions

* **Every money figure renders through `formatKobo`.** Hand-rolled currency
  formatting anywhere in `apps/web` is a review rejection. One function, one
  truth, matching the PDFs exactly.
* **`RECORDED` and `VERIFIED` are visually distinct and equally calm.** Both
  are normal states. `VERIFIED` gets a quiet affirmative mark; `RECORDED` gets
  a neutral one. Neither is styled as a warning — see §4.3.
* **Money never shifts on load.** Reserve the exact space; a figure that
  reflows after hydration reads as an unreliable figure.
* **Empty states teach.** "No invoices yet" is a failure. "Send Rekoda a
  message on WhatsApp and your first invoice appears here" is the product.

---

## 4. Surface-by-surface UX intent

### 4.0 Surface 0 — the WhatsApp conversation *(the primary UI)*

The highest-traffic interface in the product renders no HTML. It gets the same
rigour as a screen and the same review process.

* **Voice:** warm, direct, Nigerian English. Pidgin *understood*, never
  performed — writing pidgin back at a merchant who wrote standard English is
  condescending and will be read that way.
* **Every flow is specced like a screen**: happy path, each failure, each
  recovery, with exact copy. Copy is reviewed the way pixels are.
* **Native controls over free text** where a choice is bounded: buttons (≤3),
  lists (≤10). Cheaper, faster, and unambiguous to parse.
* **One message per turn.** ADR 0011 makes this an economic rule as well as a
  UX one: confirmation and result batch into a single message.
* **Emoji sparse, never as icons or status.**

### 4.1 Marketing site — the job is belief, not explanation

Hero states the promise (*"You run the business. Rekoda builds the records."*)
and shows the animated WhatsApp mock immediately — the product **is** a
conversation, so showing the conversation is showing the product. Below:
how-it-works in three steps, the reconciliation story, pricing transparency
(Paystack fees stated, never buried), FAQ, CTA to `wa.me` with UTM.

`/security` and `/ai-privacy` are conversion pages, not compliance pages. They
carry the one claim competitors cannot honestly copy — tokenisation, vault,
audio never leaving Rekoda — and they must be written to ADR 0005's honesty
constraint, never beyond it.

### 4.2 Onboarding — the 90-second rule

`/start` → `/verify` → `/setup/business` → `/setup/complete` → WhatsApp.
**Chat path completable in under 90 seconds on a phone**, measured, not
estimated. No email, no password, no CAC/TIN gate. A stepper showing real
progress; every step recoverable; the WhatsApp hand-off is a deep link, not an
instruction to go and find the number.

### 4.2b Storefront `/s/<handle>` — the merchant's shop, not ours

The only surface a merchant's **customer** sees (ADR 0012 rung A1), and the
hardest brief in the product: a stranger on a budget phone, on mobile data,
arriving from a WhatsApp link, who has never heard of Rekoda.

* **Merchant branding leads.** Their name, logo, colours. Rekoda appears as a
  discreet credit — the same restraint as the PDF footer, never a banner.
* **Fastest page we ship.** The < 120 KB JS budget is a ceiling here, not a
  target. Server-rendered, images sized and lazy, zero layout shift.
* **No account, no login, no install** to place an order. Any friction here is
  paid for by the merchant, in lost sales.
* **Checkout asks the minimum** — name, phone, delivery note — and every field
  is Zone 1 vault data the instant it is submitted.
* **Say who is being paid.** The confirmation names the *merchant*, the amount,
  and what happens next. A customer who cannot tell who they just paid will not
  pay again.

### 4.3 Merchant dashboard — visibility, not work

The dashboard is where a merchant *looks*, and the design must not imply
otherwise. Overview leads with the financial pulse: sales, received, expenses,
outstanding, unreconciled.

**The Reconciliation queue is the screen that sells Complete**, and it has one
failure mode that would destroy it: **filling it with normal states**. Cash and
unverified transfers are not problems. If "Needs Attention" contains every
cash sale, merchants learn to ignore the badge within a week and the moat's
flagship screen becomes noise.

So: **Needs Attention contains only genuine mismatches** — amount differences,
unmatched inflows, currency mismatches, overpayments. `RECORDED`-but-unverified
is shown in the normal transaction flow with a neutral mark and no badge count.

### 4.4 Admin — operator truth

Platform overview, businesses, Integrate onboarding pipeline, provider health,
failed webhooks, reconciliation exceptions, **per-business cost & margin**
(ADR 0011's telemetry made visible), admin audit. Density high; this is an
operator tool and deserves an information-dense treatment the merchant
dashboard should not have.

---

## 5. Review gate — every UI PR

- [ ] Built from `design-system/rekoda/MASTER.md` tokens; **zero raw hex**
- [ ] Renders correctly at **360px**, 768px, 1440px — no horizontal scroll
- [ ] **Light and dark** both checked, both meeting 4.5:1
- [ ] Touch targets ≥44×44 with ≥8px separation
- [ ] Keyboard path complete; focus visible; icon-only controls labelled
- [ ] `prefers-reduced-motion` honoured
- [ ] Skeletons for every async region; no layout shift on hydration
- [ ] Every money figure via `formatKobo`
- [ ] Empty states teach the next action
- [ ] **Screenshots posted to the owner: light + dark × mobile + desktop**
