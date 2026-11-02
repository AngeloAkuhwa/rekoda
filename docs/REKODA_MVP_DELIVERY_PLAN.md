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
> into MVP scope as SUB-02a, delivered after SUB-01 and before SUB-03.
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
     by the owner on 2 Nov 2026. Delivered after SUB-01 merges and before SUB-03; part of SUB-02's
     completion. Exit: the per-address limit holds across businesses under concurrency, is merged
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
The per-address limit applies the same figures to one address, compared as the mailbox compares it
(trimmed, case-insensitive).
Behaviour: enforced server side by the database clock; decided under a lock so concurrent requests
from one or many businesses or browser sessions cannot exceed it; a refused request records no link
and sends no mail; a link that could not be mailed does not count; the refusal has the same generic
shape as a business's own limit and reveals no other business, address or count beyond retry
guidance; the shared counter stores only hashes (no address in clear text, no business id), the
application role cannot rewrite or delete it, the worker role has no access; erasure is possible by
hashing the address; the migration is additive and its rollback or forward-recovery is documented.
Tests: a second business within the cooldown is refused; five an hour per address however many
businesses ask; case and whitespace do not make a new address; ten businesses at once issue exactly
one link; ten concurrent requests from one business issue exactly one link; a failed send does not
count; the refusal reveals nothing about another tenant; database privileges as stated; the existing
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

### REM-03 Cross-channel opt-out (OWN-62)

Behaviour: WhatsApp STOP; email unsubscribe; consistent suppression across applicable automated
reminder channels; safe identity resolution failing closed when ambiguous; queued undispatched
messages suppressed; suppression rechecked immediately before sending; audit history.
Tests: STOP; unsubscribe; one channel's opt-out suppresses the others where applicable; unknown or
ambiguous identity; cross-tenant attempt; opt-out after scheduling; opt-out just before dispatch;
duplicate opt-out; worker retry after opt-out.

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
