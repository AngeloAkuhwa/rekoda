# PR B plan (revision 2): dead-job recovery, plan-field protection, staging test tools, top-up month

Base: `main` after PR A is merged (today `a43675c`). **Status: PLAN ONLY. PR B must not start until PR A is completed and merged.** No PR open, nothing implemented. Revision 2 corrects revision 1 against the repository's decision records and your instructions of 7 Nov 2026.

Starting state of staging and the three deferred #428 threads are in `PR-A-plan.md` section 0. PR B owns threads 1 and 2 (`packages/db/src/repos/jobs.ts`, OWN-76); they stay open until the fix is implemented and verified.

## 1. Work items: meaning, scope, decision status

| Item | Repository-recorded meaning | Proposed scope | Decision status |
|---|---|---|---|
| OWN-73 | A dead `payment.process` job leaves a merchant exception and an operations queue item (G-122 item 7), idempotent, no secrets, nothing booked | Build as ruled | **RULED; approved follow-up.** Open design point D4 (which merchant exception home). |
| OWN-76 | A dead `billing.process` job leaves a merchant-visible exception and an ops item; recovery is operator-triggered, verified with Paystack, audited, retry-safe, keyed on the Paystack reference; no automatic settlement replay | Build as ruled | **RULED (option A).** Open design point D4. |
| OD-37 | Should `plan` / `plan_expires_at` be protected by a DB trigger refused unless the single writer set a transaction-local flag (recommendation: yes, P1 before public launch) | The trigger as described in the record, plus fixture helper and owner/repair bypass | **OPEN in the register** (status "owner ruling pending"). OWN-77 presupposes it but no ruling is recorded. **Needs your confirmation (D1).** |
| G-119 / OWN-77 | Staging-only, designated-test-business-only procedure to move dates and force notification failures; audited; works through the OD-37 sanctioned path; rollback; no raw SQL | Build as ruled | **RULED (route A, 5 Nov).** Open design point D3 (staging marker). Depends on OD-37 if D1 = yes. |
| OD-40 | Month a top-up pack counts toward when payment settles after month end: (A) keep, credit the settlement month; (B) credit the month the purchase was opened | Whatever you rule; if A: wording only, no code (the record's own recommendation) | **OPEN (D2).** |
| OWN-70 | `REKODA_PAYSTACK_PLATFORM_CONFIRMED` gates **live-key** charges only; a test key needs no confirmation | Nothing to implement: already implemented in #418 (`apps/api/src/billing/paystack-key.ts`). One question on record is still open: should the renewal sweep also hold renewals while a live key is unconfirmed | **Recorded scope implemented.** Sweep question OPEN (D5). |
| Renewal safeguards (broad audit) | Not a repository item | **Proposal only**, section 8. Not approved scope. | **Not approved.** |
| Payment timestamp work | Not what OD-40 records | **Excluded** unless you explicitly approve it. | **Not approved.** |

## 2. Decisions I need from you (PR B)

- **D1 OD-37.** Do you rule yes on the DB trigger (recommended, with the cost listed in the record: one migration, an owner-role and operator-repair bypass, a fixture helper for tests that set `plan` directly)? If no, G-119 uses the existing writer (`writeSubscriptionState`) and the G-62 file-level guard only, and the date-move procedure must be redesigned accordingly.
- **D2 OD-40.** (A) keep: credit the month the money arrives. Benefit: units are paid for at settlement; never credits a possibly closed month. Risk: a pack bought on the 31st that settles on the 1st expires a month sooner than the merchant may expect. (B) credit the month the purchase was opened. Benefit: matches the merchant's intuition. Risk: can credit a month that has already closed (usage already counted, units expire at once or never usable). Recommendation on record: A, wording only. Please pick.
- **D3 Staging marker.** Confirm the design in section 4 (explicit marker plus test-key requirement plus designated business), and confirm that the marker lives only in the staging host's `.env`, never in `docker-compose.prod.yml`.
- **D4 Merchant exception home (OWN-73 and OWN-76).** Today's merchant exceptions are customer-payment reconciliation rows (see section 3). A billing failure is money the merchant paid Rekoda, which must not enter the merchant's books or reconciliation (invariant on `process-billing-charge.handler.ts`, G-06 invariant 10, spec billing separation).
  - **Option 1 (recommended):** `payment.process` deaths reuse the existing reconciliation exception (a new reason string, shown on `/app/payments` and counted in the dashboard `exceptionsOpen`); `billing.process` deaths get a billing-domain notice (new small table or a column on `subscription_charges`) shown on the existing billing page and as a dashboard line, reusing the same visual primitives (attention badge, list, merchant wording) but not the reconciliation table.
  - **Option 2:** both go into the reconciliation exception table. Simpler, one screen. Risk: puts Rekoda subscription events into the merchant's payment-exception surface, blurring the two payment domains.
- **D5 OWN-70 sweep.** Should the renewal sweep (`apps/api/src/billing/renewal-sweep.ts`) hold renewals while a live key is unconfirmed? Only reachable with an operator-granted paid plan before spec §47; never on staging (test key). Tracked against G-05. Default if you do not rule: no change.
- **D6 Timestamps and renewal audit.** Approve or decline sections 8 and the timestamp inventory. Default: declined.

## 3. Existing implementation (relevant paths) and the precise gaps

**Queue and dead jobs.** `packages/db/src/repos/jobs.ts`: `markFailed` (~443; exhausted means `dead`, category `handler_error`), `reclaimStalled` (~486; one extra run past `max_attempts`, then `dead`, fixed `last_error`, category from migration 0190), `hasJobForSingleton` (~310; counts any state), `queueHealth` (dead counts only). Kinds in `apps/api/src/jobs/queue.service.ts` (`payment.process`, `billing.process`). Gap: nothing outside aggregate counts and logs records which business or event a dead job belonged to, and nothing moves a job out of `dead`.

**Event and pump.** `packages/db/src/repos/events.ts`: `exceptionQueue` (~636) returns `stuck` (unattributed unprocessed events) and `flagged` (`error IS NOT NULL AND resolved_at IS NULL`). A dead `billing.process` job leaves its event attributed, unprocessed and with `error` NULL, so it appears in neither list. `apps/api/src/payments/paystack-pump.ts` re-enqueues unprocessed events but skips any with a job in any state; G-122 item 8 also records that its scan takes the 50 oldest unprocessed events before skipping those that already have a job.

**Handlers.** `apps/api/src/jobs/process-billing-charge.handler.ts` (verifies with the provider first, then `applySettledCharge` in `apps/api/src/billing/billing.service.ts`; partial payment does not settle a plan; refund/dispute events are flagged for an operator and never booked). `apps/api/src/jobs/process-payment-event.handler.ts` (verify first, one-transaction booking, files `exception(...)` rows for odd money including unread refunds/disputes on the last attempt).

**Ops queue (reuse).** `apps/api/src/health/ops.controller.ts`: `GET /v1/ops/exceptions` (stuck, flagged, `unappliedCharges`), `POST /v1/ops/exceptions/charges/:reference/resolve`, `POST /v1/ops/exceptions/:id/resolve` (scopes `ops:read`, `ops:payment`; resolution records the operator and applies nothing); contract `packages/contracts/src/billing-api.ts` (`opsUnappliedChargeView`, ops exceptions response); repos `subscriptionsRepo.unappliedCharges`, `resolveUnapplied`, `events.resolveEvent`.

**Merchant exception screens (reuse).** API `GET /v1/payments/exceptions` and owner-only `POST .../exceptions/:id/resolve` in `apps/api/src/payments/payments.controller.ts` (~126-175) read `settleRepo.reconciliationsFor(status EXCEPTION)` (`packages/db/src/repos/settle.ts`: `recordException` ~627, `resolveException` ~925). Web: `apps/web/src/app/app/payments/page.tsx` (exception queue with attention badge, `describeException(reason)` wording, "mark reviewed" action) and the dashboard line from `overview.exceptionsOpen` (`packages/db/src/repos/reports.ts`, `apps/web/src/app/app/page.tsx` ~106). These rows describe money a customer paid the merchant. I found no merchant-visible surface for a failed Rekoda subscription charge other than the ops-only `unappliedCharges`.

**Plan fields (OD-37).** `businesses.plan`, `plan_expires_at` (`packages/db/src/schema/tenancy.ts` ~58-63). G-62 guard: `packages/db/src/billing/plan-expiry-files.test.ts` (file-level allow-list and assignment pins; its own header lists its limits: a name tripwire, not a proof). Sanctioned writers named there: `subscriptions.writeSubscriptionState`, the lapse to `expired` in `packages/db/src/repos/subscriptions.ts`, and the trial insert in `identity.createBusinessWithOwner`. Many `UPDATE businesses` statements exist in `subscriptions.ts`, `retention.ts`, `reminders.ts`, `plan-catalogue.ts`; each must be classified (touches plan or expiry, or not) before a trigger is written. Gap: nothing at the database refuses a stray write; tests that set the plan directly would need the helper.

**Environment (G-119 / OWN-77).** `isProductionEnv` in `apps/api/src/config.ts` (~1201) is NODE_ENV based and treats unknown values as production. Staging and production both use `docker-compose.prod.yml` with `NODE_ENV: production` (lines 81, 116, 166, 216), so **NODE_ENV cannot tell them apart**. The workflow's staging containers are named `rekoda-prod-*`. Other facts: `REKODA_RELEASE` is a label (`staging-<sha>` from the deploy script, shown on `/health`); the Paystack key kind is classified by `paystackKeyKind` (`paystack-key.ts`: test, live, missing, unrecognised) and staging runs a test key; `scripts/deploy-staging.sh` refuses a mis-set `STAGING_HOST`. Gap: no ops route moves dates or forces a send failure (`ops.controller.ts` has none); `docs/runbooks/billing-staging-walkthrough.md` steps 17-22 and `staging-acceptance-handoff.md` §4, §4a are BLOCKED on it.

**Top-up month (OD-40).** `apps/api/src/billing/billing.service.ts` (~650-665): on a settled add-on charge, `usageRepo.creditBonus(tx, businessId, usagePeriod(input.when), pack.unit, quantity)`; the pack's price/size is read at `charge.createdAt`. Tests: `apps/api/src/billing/pack-grant.integration.test.ts`.

## 4. Staging-only design (concrete, for D3)
Enabled only when ALL hold; any failure refuses the call and writes nothing:
1. A new explicit marker env, proposed name `REKODA_STAGING_TOOLS=1` (name not yet in the code; parsed like the existing `zeroOrOneFlag`: unset means off, `0` off, `1` on, anything else makes the process refuse to boot).
2. The Paystack key kind is `test`. A live, missing or unrecognised key refuses. At boot, marker `1` together with a live key refuses to start.
3. The target business has an explicit test designation (new column or table, set only through an audited ops action; production data is never designated).
4. Operator authentication with a new narrow scope (not `ops:payment`).
5. The marker comes only from the staging host's `.env`. It must not appear in `docker-compose.prod.yml` (shared with production). `scripts/check-staging-deploy.mjs` (CI keeps the workflow in step with the runbook) gets a check that the compose file never sets it.
Production therefore fails closed three ways: marker missing (off), marker invalid (boot refusal), live key (refusal). Residual risk I cannot remove in code: someone sets the marker and a test key on a production host; the designation and scope still stop real businesses.
Actions (each audited with operator, business, old and new values, reason, outcome, time): move trial end, paid-to date, renewal date; force one notification send failure for one sweep; rollback restores the recorded old values. Plan/date moves go through the OD-37 sanctioned writer, never raw SQL.

## 5. Implementation steps and tests (confirmed items; D-items gate the rest)

Order and checks are in section 7. Each step is RED first, then green, then focused suite.

**Step 1 OWN-73 + OWN-76 shared dead-job hook** (confirmed; D4 decides where the merchant row lives).
1. One function called from both `markFailed` (exhausted) and `reclaimStalled` (goes dead). `reclaimStalled` is a bulk update across tenants, so it returns the affected ids in the same statement and the rows are written in the same transaction (or by a worker-only SECURITY DEFINER function following the ADR 0035 pattern; to be decided with tests, not assumed). A dead job never exists without its rows.
2. Ops item: reuse the existing queue. For a dead job, set the attributed event's `error` to a fixed category text and leave `processed_at` NULL, so it shows in `flagged` and can be resolved with the existing endpoint, and the event stays recoverable. Add job id, kind, failure category and Paystack reference to the ops view only as sanitised fields. (A new table only if this cannot be made idempotent.)
3. Idempotency: unique by job id, so repeats, retries and crash recovery write nothing twice.
4. Merchant item per D4. Wording says the payment needs attention; never "payment failed", never that funds were or were not received.
5. Nothing is booked: no payment, intent, invoice, ledger row or subscription period changes in this step. No raw job error, payload or provider text is stored.
6. Also close G-122 item 8 only if you want it (it is in the register as a separate follow-up; not assumed).

**Step 2 operator recovery** (OWN-76 required; OWN-73 same shape).
`POST /v1/ops/exceptions/jobs/:id/recover` (proposed path), scope `ops:payment`, reason required. It re-verifies the reference with the provider server-side (`PaymentProviderPort.verify`); applies only if verified and the charge state allows it, through the existing `applySettledCharge` or payment-confirm path; keyed on the Paystack reference (existing unique references are the backstop); conditional on the exception still being open so two operators produce one outcome; audit row (operator, reason, verified status, outcome); never automatic; keeps the poison-payload bound by giving the job one fresh bounded attempt budget and reopening the same exception if it dies again.
Tests (each RED before): dead through `markFailed`; dead through `reclaimStalled`; repeated death processing; exception and ops item idempotent; business isolation; operator scope; invalid or missing reference; provider says not paid; provider unavailable; successful recovery; second recovery with the same reference; no second invoice settlement; no second subscription extension; no automatic replay after dead; partial payment applies nothing to a plan; poison bound holds.

**Step 3 OD-37 trigger** (only if D1 = yes). Inventory and classify every writer; `BEFORE UPDATE OF plan, plan_expires_at ON businesses` refusing unless a transaction-local setting set by the sanctioned writer is present; owner-role and operator-repair bypass; fixture helper for tests that set the plan directly; G-62 guard kept. Tests: valid plan change, trial expiry, renewal, upgrade, scheduled downgrade, operator change and retention exemption all pass; a direct UPDATE and a background job touching the columns are refused; migration applies and rolls back.

**Step 4 G-119 / OWN-77** (after Step 3 if D1 = yes; D3 confirms the marker). Section 4. Tests: tools absent without the marker; boot refusal on invalid marker; refusal with a live key; refusal for a non-designated business; unauthorised operator; each action audited; rollback restores values; tenant isolation; forced failure affects only the designated business and one sweep. Then the staging steps run on staging and observations are recorded (automated tests are supporting evidence only).

**Step 5 OD-40** (after D2). A: wording in billing copy and docs only. B: use the purchase-open month, with tests for a pack opened on the last day and settled next month, and for a closed month.

**Step 6 OWN-70.** No code. If D5 = hold, one sweep change plus tests; otherwise record the answer.

## 6. Dependencies, migrations, rollback
- Dependencies: PR A merged; D1 gates Step 3 and the plan-move part of Step 4; D4 gates the merchant row; D3 gates Step 4.
- Migrations (expand-only; next number after 0190): possibly a dead-job exception table or column (Step 1), the plan trigger (Step 3), the test-business designation and an audit table (Step 4). Rollback: revert the PR; triggers are droppable; new tables and columns are additive; recovery and staging routes disappear with the code; no data rewrite.
- Safety: no live Paystack call in tests (fixtures and test mode), no real charges, no production data changes, no secrets or raw provider bodies in logs.

## 7. Recommended order (one at a time)
1. Step 1 (shared dead-job hook, ops side first, then merchant side per D4).
2. Step 2 (verified recovery).
3. Step 3 OD-37 trigger (if D1 yes).
4. Step 4 G-119 tools.
5. Step 5 OD-40 (per D2).
6. Step 6 OWN-70 (per D5).
Full verification at the end: `pnpm turbo typecheck lint test build`, guard scripts, db then api integration suites serially, exact-head CI, independent review, docs and handoff updated, threads 1 and 2 answered with the fixing commit and resolved only then.

## 8. Explicit exclusions
No timestamp redesign. No renewal-sweep behaviour change except D5. No new payment provider paths, no live charges or refunds, no automatic settlement replay, no change to `applySettledCharge` semantics beyond calling it from verified recovery. No billing events in the merchant's books or reconciliation (unless D4 = option 2 is chosen). No private-beta, template, reminder or reply-to work (PR A). No general-purpose admin bypass in the staging tools. No Day 0 / trial-ended messages.

## 9. Proposal only (not approved): renewal-safeguard audit
If you want it, a separate audit would list, with tests and no code change first: duplicate and out-of-order Paystack renewal events, the renewal sweep with cancelled or expired subscriptions, and the invoice/period consistency of a recovered renewal. Not part of PR B unless you approve it (D6).
