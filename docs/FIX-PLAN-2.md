# Fix plan 2 — the second full-system sweep (23 Aug 2026)

_A three-lane adversarial audit of the post-remediation codebase (HEAD 3cd6437,
all of PRs #124-#131 merged). This plan is the standing contract for closing
its findings: one batch per PR, each planned here, each shipped with a test
that fails before it, the whole estate green serially before any push, one PR
in flight at a time. Ordered by attacker impact first, and arranged so batches
do not touch the same files._

## Findings, verified against the code

**Availability (an attacker can bring the API down):**

1. HIGH — webhook flood. `/webhooks/{paystack,meta}` are exempt from the rate
   limiter (signature-gated) but the JSON body is parsed BEFORE the signature
   check and no `bodyLimit` is set: anonymous ~1 MB junk bodies + a fake
   signature, at unlimited rate, force parse+buffer on the single event loop.
   Opened by the allowlist in PR #126.
2. HIGH — per-IP limiter defeat. `trustProxy` trusts any `X-Forwarded-For`
   when `REKODA_TRUSTED_PROXIES` is unset, and `loadConfig` never requires it
   in production, so a spoofed header per request resets every bucket
   including the paid-OTP bound.
3. MED — Meta media buffers the whole response before the 16 MB check when
   `content-length` is absent (`meta.sender.ts:213`).

**Regressions from the recent fixes (lost money / messages):** 3. HIGH — `RecordPaymentForm` mints one `clientRef` per mount; after a
success the page revalidates without remounting, so a second GENUINE
payment carries the same key and is falsely reported "already recorded"
(PR #127). 4. HIGH — worker concurrency lanes (default 4) let two `inbound.message`
jobs for one business run at once; the pending-draft read-then-write
assumed one runner, so a burst of messages can double or drop a draft
(PR #131).

**Correctness / reconciliation / privacy:** 5. HIGH — Paystack `listSettlements`/`listSettlementTransactions` read only
the first page; a merchant past 200 transactions under-reconciles forever. 6. MED-HIGH — `nameFacetsFor` orders by `created_at` with no supporting
index (full scan per message), and the 2,000-name cap silently leaves a
big merchant's OLDEST customer names untokenised to the model (PR #125).

**Medium/low:** owner-only ledger writes (journal, credit note, asset record,
paySupplier, recurring create) not idempotency-keyed; team page bare `catch`
shows an outage as a role refusal; day-1 grace reminder skipped after a

> 2-day outage; `schedulesFor` unbounded (small set); `hasJobForSingleton`
> missing the state predicate; `overviewFor`/`cashflowFor` index mismatch;
> v1 vault blobs movable with prior DB write access.

**Verified clean:** tenant isolation (no caller-supplied businessId; RLS +
id double-pinning), auth/session/magic-link/setup/operator handling, webhook
signature correctness, no SQL injection, no ReDoS (names regex-escaped),
upload bounds, storage-key unguessability, role matrix at the edge, integer
kobo with balanced postings.

**Pending features are all owner/third-party-blocked**, none a code gap:
Meta template approvals (retention template gates deletions), §47 Paystack
confirmation, legal-page facts (#40), STT/OCR sidecars, M5 Door 3 webhook
(CAC + Meta). Doc note: MASTER-PLAN:1286 stale — records/who-owes-me/resend
ARE built.

## The batches (one PR each)

- **B1 Availability**: verify webhook signature against rawBody before JSON
  parse + small `bodyLimit` on webhook routes; require `REKODA_TRUSTED_PROXIES`
  in production in `loadConfig`; stream Meta media with an aborting byte cap.
- **B2 Regressions**: regenerate the payment form `clientRef` after each
  committed payment; serialize `inbound.message` per business with a
  per-business advisory lock (keeps the throughput win across businesses).
- **B3 Reconciliation + privacy**: follow Paystack pagination in both
  settlement reads; add `(business_id, facet, created_at)` index and close the
  oldest-names privacy cliff.
- **B4 Idempotency + small correctness**: client keys on journal / credit /
  asset / paySupplier / recurring (migration 0043: nullable `client_ref` +
  partial unique per table, same contract as the payment form's key); team
  page rethrows anything that is not ApiForbidden, so an outage reaches the
  error boundary instead of telling the owner they are not the owner; core
  `billingState` answers `reminderDue` (the latest reminder day REACHED)
  instead of exact-day `remindToday`, so a sweep outage across day one delays
  that warning to the next pass instead of cancelling it; `schedulesFor`
  bounded at 200 with a window count and a "showing N of M" caption;
  `ledger_entries (business_id, created_at)` added for the overview cards and
  cashflow chart, whose month-window reads no account-pinned index served.
  FINDING REJECTED after verification: `hasJobForSingleton`'s missing state
  predicate is deliberate — its one caller, the pump's stranded-event lane,
  documents ANY-state as the contract, because filtering to live states would
  resurrect a five-times-failed job and turn one poison payload into a
  permanent retry loop. The helper's doc now says so, so the next audit does
  not reflag it.
- **B5 (optional, defense-in-depth)**: re-seal legacy v1 vault blobs, reject
  v1 on read.
