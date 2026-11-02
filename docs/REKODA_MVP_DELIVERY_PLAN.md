# Rekoda MVP delivery plan (owner directive, 2 November 2026)

> **Status:** CURRENT WORKFLOW GUIDANCE from the owner (Angelo, 2 Nov 2026). It sets the MVP
> delivery order, the per-feature completion criteria and how the work is executed. It does not
> override the canonical spec, the owner decisions register or `CLAUDE.md` invariants; where a
> requirement below needs a product or financial rule that no ruling covers, the work stops and an
> owner decision is requested. Progress is recorded in `REKODA_MVP_DELIVERY_LEDGER.md`.
>
> Recorded verbatim in substance from the owner's three documents: Part A (delivery sequence),
> Part B (feature specifications), Part C (technical lead mandate).
>
> Amendment (owner, 2 Nov 2026): OWN-58 (billing-email confirmation limit per address) is approved
> into MVP scope as SUB-02a. The figures and the uncertain-send rule were ruled by the owner on
> 2 Nov 2026 (OWN-66, see SUB-02a); implementation resumed from `main` `f31e89d`.
>
> **Agreed delivery order (owner, 2 Nov 2026):** (1) SUB-01 (#396); (2) SUB-02 monthly and annual
> checkout; (3) SUB-02a OWN-58; (4) SUB-03 residual grace-reminder fix (SUB-03r; the merged SUB-03
> lifecycle work is separate); (5) remaining subscription and billing work (SUB-04, SUB-05 gaps if
> any); (6) subscription staging acceptance; (7) customer reminders (REM-01 to REM-06), then
> integrated acceptance (ACCEPT-01).
>
> Note on timing: the Anthropic SDK upgrade (#379), listed below as outside the MVP, was already
> merged as #397 (`283ae06`) under the owner's earlier direction, before this directive arrived. No
> further work on it is planned.

## Part A: MVP delivery sequence

**Primary objective:** a usable MVP where merchants can subscribe, manage their billing, and
communicate invoice and trial reminders to customers reliably. Do not introduce post-launch features
into the current delivery scope.

### A1. Rules for this delivery

1. Work on one feature at a time.
2. Finish and verify the current feature before moving to the next.
3. Reuse the existing codebase, services, workers, queues and UI patterns.
4. Check existing PRs and implementations before creating new work.
5. Do not assume a feature is complete because a PR is merged.
6. Keep a delivery record showing implementation, tests, review, merge, deployment and acceptance.
7. Do not invent product or financial rules. Ask the owner when a decision is required.
8. Do not perform live payments, real customer messaging or production deployment without explicit
   authorization.
9. **PR freshness (owner, 2 Nov 2026; permanent).** Keep every open PR current with `origin/main`:
   - Fetch `origin/main` and compare before starting work on a PR, before requesting review, and
     again immediately before merging. If `main` has moved, synchronise and rerun the required
     checks on the exact final head; checks from an earlier head never count.
   - While a PR is open, check for new `main` commits periodically, and after any other PR merges
     assess at once whether the remaining open PRs need updating.
   - Synchronise with a normal merge from `origin/main`. Rebase or force-push only a private branch
     where rewriting is safe, never a shared one. Resolve conflicts by reading both changes and
     keeping the intent of each; never overwrite another contributor's work.
   - A PR that is already up to date is left alone: no empty or synchronisation-only commits and no
     synchronisation-only PRs.
   - Every handoff report states, per open PR: base SHA, PR head SHA, synchronisation status and the
     latest CI result on that head.

### A2. Priority 0: establish the current state

A short, focused check of: current `main` and SHA; open, merged and closed PRs related to billing and
reminders; the subscription and checkout implementation; the reminder and notification
implementation; staging deployment and health; pending migrations; CI and review status; Paystack and
Meta staging configuration. Historical references to inspect (not assumptions about status): #396
(G-62), #344 (checkout), #349 (lost checkout-link recovery), #335 (renewal and grace copy), #281
(subscription lifecycle), #283 (stale paid charge), #334 (top-up exactly-once grant), #355 (trial
metering), #362 (trial reminder sweep, G-109), #368 (N1 Slice A review findings). Then record the
first incomplete feature and begin work. Do not repeat a broad audit.

### A3. Priority 1: subscription and billing (complete before reminders)

1. **Subscription write-path safety** (G-62 / #396). Plan, expiry, cycle and status fields cannot be
   modified through unintended application write paths; legitimate payment and lifecycle updates are
   preserved. Exit: all relevant write paths covered, regression tests pass, required review clear,
   merged.
2. **Checkout and plan purchase**, monthly and annual: plan selection, correct server-side pricing,
   required billing email, Paystack initialization, server-side verification, webhook or
   authoritative confirmation, pending, failed, abandoned and successful states, exactly-once
   activation, lost or interrupted checkout recovery. Annual pricing: 12 months of service for the
   price of 10. Exit: monthly and annual test-mode purchases work end to end; unverified, duplicated
   or incorrect payments cannot activate a subscription.
   - **2a. Billing-email confirmation limit per address (SUB-02a, OWN-58)**, approved into MVP scope
     by the owner on 2 Nov 2026. Delivered after SUB-02 and before the SUB-03 residual fix; part of
     SUB-02's completion. Figures ruled by the owner (OWN-66, 2 Nov 2026). Exit: the per-address limit holds across businesses under concurrency, is merged
     with green CI and review, and is verified on staging.
3. **Subscription lifecycle**: trial creation and expiry, trial usage and metering, paid conversion
   after verified payment, active, renewal through a new payment, grace, grace expiry, expired,
   cancellation and reactivation where supported, plan changes, top-up purchase and exactly-once
   grant where included in the MVP. The launch inventory specifies a 14-day trial; verify the
   approved configuration and implementation. Automatic card-on-file renewal is not in this MVP.
   Exit: all supported transitions work and are tested, including duplicate events, delayed
   webhooks, repeated background jobs and payment after expiry.
4. **Billing UI**: current plan and period, price and next due date, trial and expiry, grace, payment
   history and status, checkout recovery, supported plan changes, cancellation and top-ups, clear
   loading, error, pending and failed states. Exit: the customer understands their billing state and
   completes supported actions; the UI never shows a payment as successful before server
   verification.
5. **Subscription staging acceptance**: monthly and annual checkout, trial, verification,
   activation, lifecycle transitions and billing UI journeys in staging, with evidence and the
   deployed SHA. Phase 1 is complete only when these pass staging acceptance.

### A4. Priority 2: customer reminders (only after the Phase 1 gate)

1. **Trial reminders**: Day 0 communication where the approved journey requires it, upcoming expiry,
   expiry, correct recipient and tenant, suppression after paid conversion, duplicate prevention,
   delivery and failure tracking. The four Meta templates are approved and configured in staging;
   verify the configured names, IDs and usage; do not recreate them.
2. **Invoice reminder reliability** (N1 Slice A, #368 findings): balance checked before dispatch,
   payment changes respected, duplicates prevented, provider calls never hold database transactions
   open, provider timeouts handled safely, partial payments, credits, reversals and void invoices
   handled, tenant and customer relationships validated, attempts and outcomes recorded.
3. **Cross-channel opt-out** (OWN-62): WhatsApp STOP, email unsubscribe, shared suppression across
   applicable automated reminder channels, safe identity resolution, suppression of queued
   undispatched reminders, dispatch-time checks, audit history.
4. **Merchant payment instructions** (OWN-64 / OD-35): merchant-configured bank details or approved
   payment link, authorization and validation, correct merchant and invoice association, accurate
   rendering, safe handling when missing or invalid.
5. **Scheduled and bulk reminders**: select recipients, preview recipients and exclusions, confirm,
   schedule or cancel, recheck eligibility before dispatch, independent per-recipient processing,
   duplicate prevention, rate and batch limits, per-recipient outcomes; reuse the existing queue,
   worker and outbox.
6. **Merchant reminder screens**: individual, scheduled and bulk reminders, preview and
   confirmation, payment instruction configuration, history, per-recipient status, cancellation,
   validation and error states.

### A5. Priority 3: integrated MVP acceptance (staging)

Required journeys: (1) a new customer starts a trial; (2) trial state and expiry are correct; (3) the
customer receives the appropriate trial communication; (4) monthly purchase; (5) annual purchase; (6)
billing email captured; (7) Paystack test payment verified server-side; (8) entitlement activated
exactly once; (9) trial reminders stop after paid conversion; (10) renewal, grace and expiry; (11) an
eligible invoice receives a reminder; (12) payment before dispatch suppresses an unnecessary reminder;
(13) WhatsApp STOP and email unsubscribe work; (14) queued reminders respect opt-out; (15) merchant
payment instructions render correctly; (16) scheduled and bulk reminders work; (17) duplicate jobs and
provider retries are handled safely. Record environment, deployed SHA, migration status, test case,
expected result, actual result and pass or fail. MVP exit: all pass in staging with no unresolved
critical payment, security, tenant-isolation, data-integrity or notification-suppression defect.

### A6. Explicitly outside this MVP delivery

Admin console; supplier screens; customer-credit application; VAT engine; API dashboard; SMS sign-in;
key rotation; Pidgin mirroring; automatic card-on-file renewal; Developer API and extra-seat add-on
sales; Anthropic SDK upgrade (#379) unless a direct dependency blocks an MVP feature. These are
reviewed after the MVP scope is complete and accepted.

### A7. Completion rule

A feature is not complete merely because it is coded, tested locally or merged. It must be
implemented, tested, reviewed, merged, deployed to staging and accepted, with evidence in the ledger.

## Part B: MVP feature specifications

A feature is complete only when its applicable requirements below are satisfied. "MVP" never permits
skipping security, payment correctness, tenant isolation, error handling or tests.

### SUB-01 Subscription write-path safety (G-62 / #396)

Behaviour: identify every application path that can modify plan, expiry, cycle dates, status and
entitlement-related fields; restrict unintended modifications; preserve legitimate updates from
payment verification and lifecycle operations; unrelated customer or file updates cannot overwrite
subscription information; consistent rules for API requests and background operations.
Tests: unauthorized plan change rejected; unauthorized expiry change rejected; unrelated updates
preserve subscription state; legitimate payment updates work; background lifecycle updates work;
concurrent changes do not produce inconsistent state.
Complete when: all relevant write paths are protected, legitimate operations work, regression tests
pass, review findings resolved, CI passes, merged.

### SUB-02 Monthly and annual checkout (#344, #349)

Behaviour: select monthly or annual; server calculates the amount; billing email required and stored;
Paystack initialized with a server-generated reference; server-side verification; activation only
after successful verification; pending, failed, abandoned and successful states; interrupted checkout
recoverable; duplicate webhook or verification cannot activate twice; amount, currency, reference,
customer and tenant validated. Business rule: annual = 12 months of service for the price of 10.
Tests: monthly purchase; annual purchase; incorrect amount or currency; invalid reference; forged
browser success; failed payment; abandoned checkout; duplicate webhook; delayed webhook; concurrent
verification; payment associated with another customer or tenant; lost checkout-link recovery.
Complete when: both journeys work in Paystack test mode, verification is authoritative, billing email
captured, duplicates safe, customer sees the correct final state.

### SUB-02a Billing-email confirmation limit per address (OWN-58)

Approved into MVP scope by the owner on 2 Nov 2026; part of SUB-02 and delivered before SUB-03.
Requirement: limit billing-email confirmation-link requests per email address across all businesses,
in addition to the per-business limits already in place (five an hour and sixty seconds apart, OWN-58).
**Owner rulings (OWN-66, 2 Nov 2026), resolving the two questions this section held open:**
(1) **Figures:** at most 5 requests an hour per normalised email address across all businesses, with
at least 60 seconds between requests. (2) **Unknown send outcome:** a request whose hand-over to the
provider ended with an unknown outcome, including a timeout where delivery cannot be confirmed,
counts against the per-address limit; only a definite provider refusal reverses the count. The address is
compared as the mailbox compares it (trimmed, case-insensitive).
Behaviour: enforced server side by the database clock; decided under a lock so concurrent requests
from one or many businesses or browser sessions cannot exceed it; a refused request records no link
and sends no mail; a link the provider definitely refused does not count (an unknown outcome
does, OWN-66); the refusal has the same generic
shape as a business's own limit and reveals no other business, address or count beyond retry
guidance; the shared counter stores only hashes (no address in clear text, no business id), the
application role cannot rewrite or delete it, the worker role has no access; erasure is possible by
hashing the address; the migration is additive and its rollback or forward-recovery is documented.
Tests: a second business within the cooldown is refused; five an hour per address however many
businesses ask; case and whitespace do not make a new address; ten businesses at once issue exactly
one link; ten concurrent requests from one business issue exactly one link; a failed send does not
count; an unknown outcome counts; the refusal reveals nothing about another tenant; database privileges as stated; the existing
per-business limits still hold.
Complete when: implemented, tested, reviewed, merged with exact-head green CI, migration verified on
staging, and the limit observed on staging.

### SUB-03 Subscription lifecycle (#281, #283, #355)

Behaviour: eligible trial; approved 14-day duration after verifying configuration; trial usage and
expiry; paid conversion only after verified payment; active state; renewal through a new payment;
approved grace rules; grace expiry and expiry; cancellation and reactivation where in scope; plan
changes; delayed or stale payment events; repeated background jobs safe.
Tests: trial creation and expiry; paid conversion; conversion without verified payment rejected;
successful and failed renewal; grace entry and expiry; cancellation and reactivation; plan change;
delayed and duplicate payment events; payment after expiry; repeated sweeps; month-end and leap-year
dates; annual cycle boundaries; UTC storage and local display; concurrent lifecycle operations.
Complete when: all supported transitions are correct, tested and safe under retries and concurrency;
customer-facing status matches the authoritative state.

### SUB-04 Entitlements, usage, annual billing and top-ups (#334, #355)

Behaviour: correct trial, monthly and annual entitlements; usage tracked against the right
entitlement; concurrent requests cannot exceed available units; exhaustion handled; top-up purchase
where in the MVP; top-up units granted exactly once after verified payment; entitlement and usage
history preserved; plan entitlements distinct from purchased top-ups.
Tests: trial, monthly and annual allowance; usage decrement; exhaustion; concurrent usage; duplicate
top-up webhook; failed top-up; successful top-up; cross-tenant attempt; plan change with existing
balance.
Complete when: calculations are server-authoritative, concurrent usage is safe, top-ups granted
exactly once, displayed balances match the backend.

### SUB-05 Billing UI

Behaviour: current plan; monthly or annual period; price; next due date; trial status and expiry;
paid, pending, failed, grace and expired states; payment history; checkout recovery; supported plan
change, cancellation and top-up actions; never shows success before server verification.
Tests: trial, monthly and annual customer; pending, failed, expired, grace and successful states;
checkout recovery; unauthorized action; responsive desktop and mobile.
Complete when: the customer understands their state and performs supported actions; browser tests
pass.

### REM-01 Trial reminders (G-109 / #362)

Behaviour: Day 0 message where the approved journey requires it; upcoming expiry; expiry; correct
recipient and tenant; correct approved Meta template; suppression after paid conversion and for
ineligible customers; duplicate prevention; delivery and failure tracking. Verify the configured
names, IDs and mappings of the four approved templates; do not recreate them or assume config keys.
Tests: eligible trial gets the right message; paid customer suppressed; expired or ineligible handled;
wrong tenant rejected; duplicate worker execution sends once; provider failure and timeout safe; Day 0
matches the approved journey.

### REM-02 Invoice reminder reliability (N1 Slice A / #368)

Behaviour: validate invoice, customer and tenant; authoritative balance; payment status checked and
eligibility rechecked immediately before sending; partial and full payment, credit, reversal, void
and cancellation handled; duplicate dispatch prevented even with different idempotency keys; no
database transaction held open during provider calls; uncertain provider outcomes handled; attempts
and outcomes recorded; correct email reply-to; externally reachable opt-out endpoints protected and
throttled.
Tests: concurrent requests; different idempotency keys for one reminder; payment before dispatch;
partial and full payment; credit and reversal; void or cancelled invoice; provider timeout; callback
after timeout; worker restart; cross-tenant access; opt-out throttling.

### REM-03 Channel-specific opt-out (OWN-62, OWN-69)

Owner ruling OWN-69 (2 Nov 2026, resolves OD-34): opt-outs are channel-specific. An email
unsubscribe suppresses automated reminder email for that merchant and address only; WhatsApp
reminders stay eligible unless the customer separately sends WhatsApp STOP; STOP suppresses
WhatsApp only and never unsubscribes email. The two preferences stay independent and per merchant.

Behaviour: each channel checks only its own opt-out; the check is re-read at dispatch, immediately
before the provider call, not only when the attempt opens; every reminder path (individual now,
scheduled and bulk in REM-05) dispatches through `ReminderService.sendOne`, so it inherits the check;
tenant isolation and the existing identity keys are kept (email: business and address hash; STOP:
business, WhatsApp number and participant blind index). No cooldown (OWN-67).
Tests: email unsubscribe blocks email but not WhatsApp; STOP blocks WhatsApp but not email; both
channels in one event; per-merchant isolation; an opt-out committed after the attempt opened and
before dispatch is honoured on its own channel and not on the other.

### REM-04 Merchant payment instructions (OWN-64 / OD-35)

Behaviour: authorized merchant configures approved bank details or a payment link; validated;
associated with the correct merchant; correct invoice and amount context; missing or invalid handled
safely; correct rendering per channel. Never invent bank details or payment links.
Tests: valid bank details; valid link; missing or invalid; unauthorized configuration; update and
removal; cross-tenant attempt; correct invoice and amount rendering.

### REM-05 Scheduled and bulk reminders

Behaviour: select recipients; preview recipients and exclusions with an eligible count; explicit
confirmation; schedule; cancel before dispatch; per-recipient eligibility recheck; per-recipient
idempotency; batch, rate and concurrency limits; per-recipient outcomes; provider failures and
uncertain delivery handled; reuse queue, worker and outbox.
Tests: mixed eligibility; duplicate recipients; payment after scheduling; opt-out after scheduling;
cancellation; worker restart; provider rate limit; timeout; partial batch failure; concurrent
processing; cross-tenant access.

### REM-06 Merchant reminder screens

Behaviour: individual, scheduled and bulk reminders; recipient preview; confirmation; payment
instruction configuration; history; per-recipient status; cancellation; loading, empty, validation
and error states; every action authorized server-side.
Tests: each journey above, unauthorized action, validation failure, desktop and mobile browser
journeys.

### ACCEPT-01 End-to-end staging acceptance

The journeys in A5, each recorded with environment, deployed SHA, migration status, test case,
expected and actual result, pass or fail, a safe payment or provider reference where applicable and
known limitations. Complete when all pass and no critical payment-integrity, security,
tenant-isolation, data-integrity or unauthorized-messaging defect remains.

### Global quality requirements

1. Server-side business rules are authoritative. 2. Tenant isolation on reads and writes. 3. Payment
   verification is authoritative. 4. Financial and entitlement changes are idempotent. 5. Background
   jobs are safe to retry. 6. Provider calls do not hold database transactions open. 7. Provider
   timeouts are treated as uncertain outcomes. 8. Migrations are safe and documented. 9. No sensitive
   information or secrets exposed. 10. Success, failure, boundary and concurrency cases tested where
   relevant. 11. Existing architecture reused. 12. Review findings and CI failures resolved. 13.
   Deployment and staging acceptance recorded.

## Part C: technical lead mandate (how the work is executed)

- **Mission and order:** subscription and billing, then reminders, then integrated staging
  acceptance. Do not move to reminders while billing is incomplete; do not call the MVP ready until
  the integrated journeys pass.
- **Start from the actual state:** read these documents, inspect the repository, PRs, CI, staging
  health, deployed commit and migrations, find the first incomplete feature, and move into
  implementation without repeating a broad audit.
- **Sequential work:** one feature at a time; no parallel half-finished branches; one blocking defect
  at a time; no speculative refactors; reuse existing services, workers, queues, outbox and UI
  patterns. If blocked, record the precise blocker and request the owner decision.
- **Statuses:** Not started, Investigating, In progress, Blocked, In review, Ready to merge, Merged,
  Deployed, Acceptance pending, Complete. Merged is not complete; deployed without acceptance is
  acceptance pending.
- **Definition of complete:** requirements implemented; backend and frontend done; migrations done;
  authorization and tenant isolation enforced; success, failure, boundary and concurrency tested;
  idempotency and retry correct; review findings resolved; exact-head CI green; merged; staging
  deployment and migration state verified; browser or end-to-end acceptance passed; docs updated;
  evidence in the ledger.
- **PR execution:** confirm remaining scope, reuse existing PRs, focused tests while developing and
  the broader suite before merge, review the whole diff (security, tenancy, payment integrity,
  migrations, unrelated changes), clear PR description with evidence, required review, exact-head CI,
  merge when authorized, verify merge and staging, update the ledger. Avoid repeated full-suite runs,
  unrelated formatting, re-auditing and progress-by-PR-count.
- **Technical standards:** backend authoritative for price, amount, currency, payment state and
  entitlements; Paystack verified server-side; never activate from a browser success; stable
  references and idempotency; duplicate and delayed webhooks; no transaction open across provider
  calls; preserve payment history; tenant ownership on every query and mutation, never trust a
  browser tenant id, negative cross-tenant tests; retry-safe jobs, no duplicate grants or
  uncontrolled duplicate reminders, eligibility rechecked before dispatch, timeouts treated as
  uncertain, no blind resend; focused safe migrations with backfill and recovery notes; never weaken
  or skip tests to get green.
- **May do independently:** inspect, branch, implement the approved scope, test, open and update PRs,
  request reviews, resolve feedback, merge when authorization and review requirements are met, deploy
  to staging per the runbook, verify staging and migrations, update docs and the ledger.
- **Needs explicit owner authorization:** live Paystack operations; real payments, charges or
  refunds; real customer-facing messages outside approved test workflows; `LIVE_MODE_ALLOWED=YES`;
  production deployment; destructive database operations; irreversible migrations or deletion;
  production secrets; force-pushing shared branches; bypassing branch protection or required checks;
  new paid provider commitments. Staging authorization never implies production authorization.
- **Operational safety:** never print or commit secrets; no customer PII in PRs or reports; never
  bypass tenant authorization or payment verification; never remove audit history; no
  `git reset --hard` as routine cleanup; no `docker system prune -a`, `docker volume prune`,
  `docker compose down -v` or aggressive Docker cleanup; never delete data or volumes to fix a
  deployment without approval; never weaken CI or branch protection; mind staging disk and memory.
- **Ledger:** one ledger (`REKODA_MVP_DELIVERY_LEDGER.md`) with feature ID, feature, status, PR,
  branch and SHA, implementation, tests, CI, review, merge, deployment, migrations, acceptance,
  blocker, next action and updated time, updated on every meaningful state change, with evidence and
  no vague wording.
- **End-of-session report:** current feature, status, completed work, PR and SHA, verification,
  remaining requirements, blockers, one next action; do not repeat unchanged information.

## Part D: PR structure and per-PR scope (owner delivery guide, 2 Nov 2026)

Working target: **12 PRs**, counted as the whole sequence in the table below from #396 (already merged) to the CI PR; the one-time governance documentation PR makes 13 in total, and acceptance runs are milestones, not PRs. Each feature ships as one substantial, focused PR
with its implementation, tests, migrations and supporting changes; a split is proposed only for a
genuine technical or safety reason, explained before another PR is opened. One implementation PR is
active at a time; the CI optimisation is the only supporting PR run alongside and never delays the
sequence. SUB-02 checkout and the original SUB-03 lifecycle work are merged and are not reopened.
Subscription staging acceptance and integrated MVP acceptance are verification milestones, not PRs. No
separate PRs for minor cleanup, single test files, small supporting changes or review comments that
belong to the current feature. Out-of-scope improvements are recorded as proposals, not implemented.

| PR  | Feature          | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Acceptance                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | SUB-01 (#396)    | G-62 subscription write-path safety: writes consistent, tenant isolation and subscription invariants preserved, retries cannot produce inconsistent state, regression tests                                                                                                                                                                                                                                                                              | Issue resolved; tests and database checks pass (migration checks only if the PR adds a migration; #396 added none); review resolved; required CI green on the exact final head (never on partial results); merge SHA recorded                                                                                                                                                                       |
| 2   | SUB-02a (OWN-58) | Per-address billing-email confirmation limit across businesses: trimmed, case-insensitive address; database clock and locking under concurrency; a refusal issues no link and sends no mail; a failed send does not count; generic refusal leaking nothing about another business; only hashes stored (no address, no business id); app cannot rewrite or delete counters, worker has no access; additive migration with documented rollback or recovery | Shared cooldown across businesses; hourly limit across businesses; normalisation; concurrency cannot bypass; failed sends do not count; no cross-tenant leak; permissions enforced; per-business limits still work. Figures and the unknown-outcome rule ruled by the owner (OWN-66, 2 Nov 2026): 5 an hour and 60 seconds per address; an unknown outcome counts, only a definite refusal reverses |
| 3   | SUB-03r          | Grace-reminder defect in the merged lifecycle: no claim release on an uncertain provider outcome such as a timeout; idempotency and OWN-47 duplicate prevention preserved; final eligibility check before dispatch; retries and delayed jobs cannot send duplicate or stale reminders                                                                                                                                                                    | Timeout uncertainty cannot duplicate; ineligible customers suppressed; retry and concurrency tests; existing lifecycle intact                                                                                                                                                                                                                                                                       |
| 4   | SUB-04           | Entitlements and usage per plan; annual billing and cycle dates; usage against the right entitlement and state; top-up handling completed with exactly-once grants under repeated events or jobs; delayed or stale payment events safe; server-side verification and tenant isolation preserved                                                                                                                                                          | Entitlements and usage match the subscription; annual periods correct; top-ups never granted twice; payment, retry and lifecycle tests pass                                                                                                                                                                                                                                                         |
| 5   | SUB-05           | Customer billing screens: current subscription and plan; trial, active, pending, grace, expired and other supported states; monthly and annual options with server-authoritative pricing; billing and payment status; supported actions; failed, abandoned and pending checkout never shown as paid; loading, empty, error and success states                                                                                                            | UI reflects backend state; no client-side price or payment state grants entitlements; browser tests cover the important journeys                                                                                                                                                                                                                                                                    |
| 6   | REM-01           | Trial reminders using the approved Meta templates configured in staging (verify names, IDs, mappings; no invented keys); agreed timing and eligibility; paid conversion stops them; Day 0 behaviour resolved where required; idempotent and retry-safe                                                                                                                                                                                                   | Correct templates; timing and eligibility correct; paid conversion suppresses; retries never duplicate                                                                                                                                                                                                                                                                                              |
| 7   | REM-02           | N1 Slice A (#368) reliability: eligibility and balance rechecked before dispatch; duplicates prevented across different idempotency keys; no transaction or lock held during provider I/O; timeouts and uncertain outcomes safe; partial payments, credits, reversals and voids; tenant ownership validated; correct reply-to; opt-out and throttling protections                                                                                        | Ineligible invoices never reminded; no duplicates under concurrency or retries; provider uncertainty safe; tenant boundaries held; regression and integration tests                                                                                                                                                                                                                                 |
| 8   | REM-03           | OWN-62 / OWN-69 channel-specific opt-out: WhatsApp STOP suppresses WhatsApp only and email unsubscribe suppresses email only; safe identity resolution; queued messages suppressed; dispatch-time recheck; audit and tenant boundaries preserved                                                                                                                                                                                                         | Either channel applies the agreed suppression; queued messages cannot bypass; tests for identity resolution, queued messages and dispatch checks. (OD-34 ruled 2 Nov 2026 as OWN-69: channel-specific)                                                                                                                                                                                              |
| 9   | REM-04           | OWN-64 / OD-35 merchant payment instructions: merchant provides and manages approved bank details and/or payment link; validated; tied to the right merchant and invoice; never invented or substituted; used in applicable reminders                                                                                                                                                                                                                    | Only merchant-approved information used; correct association; invalid or missing handled safely; validation and association tests                                                                                                                                                                                                                                                                   |
| 10  | REM-05           | Scheduled and bulk reminders on the existing queue, worker and outbox: preview, confirmation, scheduling, cancellation; eligibility rechecked per dispatch; per-recipient idempotency; batch and provider rate limits; outcomes recorded; partial failures safe                                                                                                                                                                                          | Preview and confirm before sending; cancellation; ineligible invoices suppressed; no duplicates; accurate outcomes                                                                                                                                                                                                                                                                                  |
| 11  | REM-06           | Merchant reminder screens for individual, scheduled and bulk reminders: preview and confirmation, history and delivery status, payment instructions, cancellation, loading, empty, error and success states; existing UI patterns and contracts                                                                                                                                                                                                          | Merchant manages the agreed journeys in the UI; screens reflect backend state; browser tests                                                                                                                                                                                                                                                                                                        |
| 12  | CI               | One supporting PR: the safest combination of separate jobs with their own PostgreSQL, cheaper data clearing without weaker isolation, and careful path filtering                                                                                                                                                                                                                                                                                         | One PR; no loss of meaningful coverage or isolation; no flaky tests; required checks cannot be skipped or falsely green; before-and-after runtime evidence; workflow stays understandable                                                                                                                                                                                                           |

Every PR: inspect the implementation and spec first; complete scope in one PR; targeted tests then
required CI; full-diff review for security, tenant isolation, data integrity, idempotency and
regressions; review feedback resolved; CI verified on the exact final commit; merge only when checks
and review conditions hold; staging deployment and behaviour verified when appropriate; ledger updated
with PR, SHA, tests, review, merge, deployment and acceptance evidence. Approval boundaries in Part C
stay in force.
