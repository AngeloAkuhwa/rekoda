# The integrated system plan

_Last revised: 23 August 2026. This document is the standing contract for how
Rekoda changes from here: every piece of work gets its place in this plan and
its own written mini-plan BEFORE any code moves, and the plan is updated when
a phase closes. The goal is that nothing is fixed twice and nothing fixed is
ever silently unfixed._

## 1. The process contract

Every change, from a one-line fix to a feature, follows the same loop:

1. **Plan first.** A written mini-plan naming: what changes, which files it
   touches, what could break (the impact map), and which test will prove it.
   No code before the plan.
2. **A test that fails before and passes after.** A fix without a failing
   test is a fix that can quietly unfix itself. Where practical, the test is
   shown to fail under a targeted mutation of the fix.
3. **The whole estate green before every push.** `pnpm turbo typecheck lint
test build`, then the db and api integration suites run SERIALLY (they
   share one Postgres). Nothing is pushed on a partial run.
4. **CI green and API-verified before every merge.** Squash-merge, then the
   working branch resets onto main. One PR in flight at a time.
5. **The record updated.** HANDOFF.md carries what was learned; this file
   carries what changed in the plan.

Why this stops the circles: the 1,000+ integration tests ARE the memory of
every past fix. A change that would re-break a fixed thing fails the suite
before it reaches a PR. The failures seen during development are this net
doing its job; what matters is that nothing red has ever merged.

## 2. Where the system stands (verified, not assumed)

Milestones M0 through M5's buildable half are done and merged: identity and
tenancy under forced RLS, the WhatsApp chat loop with conversation gates,
invoices, receipts, credit notes, orders, expenses, purchases, suppliers,
stock and stocktakes, fixed assets with depreciation, the four statements
(screen, PDF, Excel), bank reconciliation, payments end to end behind §47,
metering and billing with proration/grace/packs, retention, voice notes,
receipt OCR, the hosted shop with SEO-correct paging, and the operator
margin view.

The five audit remediation PRs (#124 to #128) closed every finding from the
full-system audit: the role matrix everywhere, the two-layer name
tokenisation, the bank page at scale, webhook availability, the lost-work
crash windows, idempotency keys on every double-clickable write, draining
sweeps with leader election, and the tier-3 hardening list.

Verified clean and load-bearing: tenant isolation (RLS pins, no
caller-supplied businessId anywhere), webhook signatures over raw bytes,
integer-kobo money with a balanced-posting gate the AI cannot reach,
append-only ledger enforced by grants, secrets hygiene across every log
site.

## 3. Known items that are OPEN, and where they live in the plan

**Waiting on the owner (phase D, launch):**

- Production env variables (the full list is in the session notes and
  `.env` docs): keys, three DB roles, Meta channel + template names,
  Paystack keys, storage, URLs.
- §47 written confirmation before `REKODA_PAYSTACK_PLATFORM_CONFIRMED=1`.
- Company facts for the legal pages (task #40): entity name, RC number,
  address, NDPR auditor, support/privacy emails.
- Meta template and catalogue approvals (M5 Door 3 webhook work resumes
  when Meta answers).

**Deliberately recorded, scheduled in phase C:**

- The job runner is serial per process; a small concurrency pool inside
  `poll()` (SKIP LOCKED already makes it safe) lifts delivery throughput.
- Exports stop at 10,000 rows while the link says "ALL": either a caption
  with the count or a streamed export.
- The per-IP rate limiter is in-memory per replica; production with more
  than one replica wants a shared store, and `REKODA_TRUSTED_PROXIES` must
  be set in every deployment behind a proxy.
- The platform-wide AI daily cap is first-come-first-served; fairness
  (per-tenant reservation) matters once active merchants approach the cap.
- The sitemap needs an index file past 5,000 shops (the response already
  says when it is truncated).

## 4. The phases from here

**Phase A — close the audit (done when PR #128 merges).** No new work
starts while an audit PR is open.

**Phase B — the UI/UX polish pass.** The product must read like an
accounting tool a bank would recognise (the QuickBooks bar). One
screen-group at a time, each group planned, then built, then
BROWSER-VERIFIED at 360px and 1280px with screenshots before its PR:

B1. Foundations: role-aware chrome. The session already carries the role;
view-only members must not SEE buttons they cannot press (the API
refusals stay as the backstop, but an accountant's dashboard reads as
the read-only instrument it is). Loading and error boundaries per
route group (the /app pair landed in #127; the marketing and shop
trees get theirs).
B2. The money screens: overview, invoices, receipts, expenses.
Consistent money alignment (tabular numerals everywhere), consistent
empty states that say what to DO, consistent confirmation and error
sentences, print-clean statements.
B3. The working screens: bank, stock, catalogue, reports, export, audit,
team, billing, payments. Same checklist.
B4. The public surfaces: landing, pricing, shop, legal pages, /enter and
/verify flows. First-impression polish: spacing rhythm, typography
scale, focus states, reduced-motion, dark-ground safety.

The checklist each screen passes: real data at volume (the load fixtures
from task #57), empty state, error state, loading state, keyboard focus,
360px layout, money formatting, sentence-level copy (no jargon, no em
dashes), and role-appropriate rendering.

**Phase C — scale leftovers.** Each with its own mini-plan and test.
Delivered: the job runner's concurrency lanes (REKODA_WORKER_CONCURRENCY,
proven by an overlap test) and honest export captions past the 10,000-row
ceiling; REKODA_TRUSTED_PROXIES and the per-replica limiter caveat are in
.env.example. Deliberately DEFERRED behind their existing tripwires, with
the reasoning here so nobody relitigates it: per-tenant fair-share on the
platform AI cap waits for telemetry showing merchants actually approaching
it (the mechanism depends on real usage shapes), and the sitemap index
waits for growth toward 5,000 published shops (the response already
reports `truncated`, so the moment is observable). Both remain in
HANDOFF §7.

**Phase D — launch.** Env vars into the deployment, migrations run with the
privileged role, §47 confirmation recorded, legal facts on the pages,
smoke-test the live webhooks with Meta test numbers, switch on.

## 5. What "polished" means here, concretely

- Every number a merchant reads is whole-business truth or says what it
  left out; every list says how many it holds.
- Every action answers in a sentence a shop owner would say aloud.
- Every failure path lands somewhere designed: a form message, a boundary
  page with navigation intact, never a stack trace or a dead spinner.
- Every screen holds at 360px without horizontal scroll.
- Nothing a role cannot do is dangled in front of them.
- The wire never carries a name the vault should hold, and the UI never
  shows a token where a person expects a name.
