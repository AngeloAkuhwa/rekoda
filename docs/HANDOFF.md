# Rekoda — Session Handoff

> **Operational memory, not specification.** Read the top section (five
> minutes), then follow the reading order. Everything under
> "Historical session log" is the project's history, kept as written;
> where it names a document, that document may since have been archived
> (see `REKODA_REFERENCE_MANIFEST.md`).

## Current state at a glance

| Field                       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current date**            | 12 November 2026 (PR A merged as #431 on 8 Nov; PR B #432 open, OD-50 and OD-51 closed in it on 12 Nov, not merged; the older rows below are history and the notes under this table are dated)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Current `main` SHA**      | `58e6834` (8 Nov 2026, PR A #431; PR B #432 is open and not merged). Before it: `a43675c` (7 Nov 2026, #428, squash of head `68fb90a`; all 12 checks green on that head; Deploy staging run #183 succeeded: migration 0190 applied, api, worker, web and edge-check recreated and healthy, `/health` reports `staging-a43675c`; STAGING ACCEPTANCE PENDING). Before it: `b8baf24` (4 Nov 2026, #427, squash; `main` CI run 41888917354 green; Deploy staging run 41890201057 green, its "Staging answers with this commit" step passed; host health, images and applied migrations NOT verified by an operator). Before it: `5a3608c` (#426), `be68ec5` (#425), `2f7bd3a` (#424), `41eacf6` (#423), `fcbe1dd` (#422), `60c8358` (#421), `963332b` (#420), `75ad210` (#419), `d96d87e` (#418, OWN-70 key-kind gate), `c3e66aa` (#417), `317a2ac` (#416), `131282f` (#415, REM-06). Earlier: `d11ed34` (3 Nov 2026, #413 REM-05, squash; `main` CI run 41565201861 green; Deploy staging run 41565857377), after `7b37e26` (#412 REM-03) and `90c369e` (#409 REM-04), after `60cfee8` (2 Nov 2026, #406 REM-02, squash; `main` CI run 41502231198 green; Deploy staging run 41503379820 green), after `e4f58a0` (#403, docs) and `79f9968` (#405, REM-01), after `def64c3` (2 Nov 2026, #404 SUB-05), after `920f2ac` (2 Nov 2026, #402 SUB-02a; `main` CI run 41437735933 green), after `f31e89d` (2 Nov 2026, #401 docs; CI run 41416757779 and Deploy staging run 41417864421 green), after `cefb6ee` (#400, SUB-03r), `4bea81e` (#399), `cc369c5` (2 Nov 2026, #398 CI integration sharding; Deploy staging run 41378727482 green), after `7f1adec` (2 Nov 2026, #396 G-62 static guard), after `283ae06` (2 Nov 2026, #397 Anthropic SDK 1.3.0). Earlier: `baefd3e` (#395), `c868cce` (29 Oct 2026, #384)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Open branches**           | Docs closeout #319 MERGED (`22a572d`, 23 Oct 2026). #317 (design skills at project scope, with the Taste preview servers and the Impeccable launcher patched shut under OWN-38; independent security review 0 BLOCKING / 0 IMPORTANT at `b2d5609`) merges with this text; no implementation PR was open after it at the 23 October snapshot (since then #344 to #349 have been opened; see the 24 October note below). G-67 MERGED (#322, `b8dbd0b`, 23 Oct 2026): 24-hour window check and `META_DOCUMENT_TEMPLATE` fallback for owner documents; deployed to staging, template not yet submitted or approved, STAGING ACCEPTANCE PENDING; OPEN OWNER DECISION on the `resend` entitlement for Integrate-only and lapsed owners (G-67 row). Deployed to staging: everything up to `22a572d` (#319; Deploy staging succeeded for `b8dbd0b` (#322, G-67) and then `22a572d`, 23 Oct 2026), which includes G-10, G-12, G-18, G-20, G-26, G-63 and G-67; none is staging-accepted. Backlog row 6 (G-40, G-58) MERGED as #324 (`f831557`, 23 Oct 2026); its docs closeout is in #323 and #325. Next engineering step: the first NOT STARTED priority-A backlog row, row 8 (G-116); rows 5 and 7 are priority B. G-20 draft clearing MERGED (#320, `50fc6ba`, 23 Oct 2026, OWN-37; deployed to staging, STAGING ACCEPTANCE PENDING); G-10 MERGED (#314, `75521f4`, 22 Oct 2026): sweep first pass at boot, wall-clock reclaim, lease heartbeat, per-claim fencing; deployed to staging, STAGING ACCEPTANCE PENDING; OPEN RESIDUAL: outbound provider calls stay at-least-once (owner decision on per-job idempotency keys). G-12 and G-20 (part) MERGED (#310, `eded30e`, 22 Oct 2026): OTP send outcomes and Meta `status.failed` receipts are counted on `/v1/ops/health` (`otpSends`, per process, reset on restart; `meta.deliveryFailures`, database-backed, 24 h) and delivery receipts are attributed by `phoneNumberId`, never by recipient; the alert (G-26, #318) and clearing previewed drafts on a failed status (#320, OWN-37) have since merged; residual OWN-37 risks are listed in G-20; STAGING ACCEPTANCE PENDING. G-02 logical backup and restore-drill scripts MERGED (#308, `9761e5a`, 22 Oct 2026): CODE COMPLETE, NOT enabled, no off-box drill yet, STAGING ACCEPTANCE PENDING (batched staging acceptance follows the remaining hardening train; G-02 off-box acceptance additionally awaits the owner's destination); OD-7 open; G-115 merged (#307, `dc0541c`; OWN-33 as revised by OWN-34 Option B, migration 0167); G-87 merged (#306, `5c6ecd5`, OWN-31, migration 0166). Merged: G-92(5) (`a78d5ff`, #302, OWN-32), docs #300 (`5762ba7`, playbook v4, OWN-30 to OWN-33). Merged: G-44 (`e4b9b05`, #301), G-99 (`9cc0a96`, #299), G-78 (`9890e74`, #298), G-104/G-112 (`177d050`, #283: a payment for an old subscription decision never overwrites a newer one; migration 0162; OD-30 ruled as OWN-29, Option A), G-62 (`4e64d5b`, #281). Merged: G-62 (`4e64d5b`, #281, operator plan change through one subscription-state writer; no migration), G-69 (`ecc6ff8`, #279), the 14-day trial (`4074afe`, #278), G-103 fix-forward (`0485562`, #277), G-106 (`8fe9522`, #276), G-103 (`0eae7aa`, #275), G-59 (`5087f95`, #274), G-07 (`044eb40`, #273), G-60 (`c5b2c8a`, #271) and earlier; the old G-80 WIP stays local as `backup/g80-wip-c9f2059` (never pushed) |
| **Product version / state** | 0.1.0. Build plan complete (138 rows, PR-001…PR-132; PR-006–009 and PR-115 gated); 185 migration files on `main` as of 29 Oct 2026 (0000 to 0184; 0184 is N1 slice A, #368). The detail that follows is the 23 Oct snapshot: then 171 files (0000 to 0170; 0170 was the G-20 draft retired reason and 0169 the reply-to link, both merged as #320, `50fc6ba`; 0168 is G-18, merged as #312, `68c5169`; 0167 is G-115, 0166 is G-87, 0165 is G-22; 0160 is G-103, 0161 its retention-locking fix-forward); deployed to staging (automatic after CI on main since #249); never to production (the production stack boots on a clean CI runner since G-01); the Meta WhatsApp transport has been live-exercised on staging (real webhook ingress, outbound text and media); production Meta App Review and templates remain open; payment-provider live verification remains pending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Launch verdict**          | **NOT READY** (`REKODA_LAUNCH_READINESS.md` §1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Engineering model**       | Simple: Angelo assigns, Claude reads `CLAUDE.md` and the canonical docs, implements with tests, normal CI, Angelo reviews and merges. Exception (OWN-26, 20 Oct 2026): the MVP closeout autopilot may merge the closeout PRs it drives once exact-head CI is green, threads are 0, every known Codex finding is fixed and a final Claude fan-out finds 0 BLOCKING / 0 IMPORTANT; Codex is preferred, but its quota is never a merge dependency. The multi-agent control plane (PR #233) was removed by PR #237 (merged 11 Sep 2026) and PR #234 closed unmerged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**PR B, 12 Nov 2026, autopilot run on head `5654ee2`: still OPEN as #432, not merged, not deployed; the merge is the owner's. OD-52 is NOT closed.**

- **CI:** the secret scan failed on `5654ee2` (a key-shaped placeholder in `apps/api/src/settlement/config.test.ts`, never a credential). Fixed in `0e898c6`: the line builds the string at run time and the historical finding is pinned in `.gitleaksignore`.
- **Three independent read-only reviews of `4d5f1cd..5654ee2`** (0217 to 0219 and the two new processes, which had none): 0 BLOCKING, 2 IMPORTANT, minors.
  - **IMPORTANT 1, OPEN OWNER DECISION (OD-52 reopened):** the application credential can still keep a delivered unit refundable, because 0218 closes a reservation from the job row and `rekoda_app` can write and delete job rows. Vectors, options and a recommendation are in the OD-52 row of `REKODA_LAUNCH_READINESS.md`. Not fixed here. Where the notes below say OD-52 or limit 51.4 is closed, read "narrowed".
  - **IMPORTANT 2, fixed:** `scripts/staging-readonly-check.sh` did not look at `settlement` or `operator`, so a staging with settlement down read healthy. Both are now required running and healthy (RED first in `staging-readonly-check.services.test.mjs`).
  - **Minors, not fixed:** three are in the OD-52 row. Also: `deploy-staging.sh` failure text still names only the api and worker though four services are stopped; settlement's `/health` stays 200 after its database access is lost; no test runs `reclaimStalled` on the settlement credential; settlement's `enrolUnrecordedDeaths` cannot see events, so it re-selects legacy dead rows each pass (the worker's pass still enrols them); 0219 compares only `plan_decided_at > requested_at`, so a re-asked upgrade keeps its old request time.
- **Qodo's open items triaged against `3dbc77e` (read from source):** 0 BLOCKING, 1 IMPORTANT, minors.
  - **IMPORTANT, fixed:** the by-hand restore in `docs/runbooks/backup-restore.md` created seven roles and left out `rekoda_settlement` and `rekoda_billing_operator`, so a restore typed from the runbook would skip their grants and policies. The runbook now creates all nine, and `backup-scripts.test.mjs` keeps it equal to the migrations (RED first).
  - **Minors, not fixed:** two 15 ms sleeps order prices in `pack-purchase-identity.integration.test.ts`; `docs/runbooks/deploy.md` says an `expired` post clears a future trial start from the preflight, and 0212 still reports that row as active; `deploy-staging.sh` does not run `preflight-subscriptions` (OD-49 records it as a release-only step); `usage_credit_pack` trusts the unit and quantity settlement passes; `openPlanReview` in `repos/subscriptions.ts` is unused. The rest are fixed at head, already recorded in `docs/plans/PR-B-plan.md`, or need a stolen credential and end on the safe side.
- **Codex:** UNAVAILABLE (usage quota), not asked again in this run; not approval. CodeRabbit: skipped (file limit).

**PR B, 12 Nov 2026: OD-50 and OD-51 closed (owner instruction OWN-91): still OPEN as #432, not merged, not deployed; STAGING ACCEPTANCE PENDING; the owner reviews the readiness report and explicitly approves the merge.**

- Migrations 0213 to 0219 and two new processes:
  - **OD-50 (0213, 0219):** `POST /v1/businesses/plan/support-review` moves a support-reviewed upgrade and keeps the paid-through date; no caller date exists; a schedule the merchant made after asking is never overridden.
  - **OD-51.7 (0214):** one credited charge per pack purchase; a second payment is set aside.
  - **OD-51.6 (0215):** the pricing source is a database fact, checked at boot and kept on each charge.
  - **OD-51.4 (0216, 0218):** usage counters change only through database functions, and a reservation is closed when its event's job is done (this closes OD-52, which the autopilot note below records as open).
  - **OD-51.2 and 51.3 (0217):** settlement is its own process (`settlement`) on a role with exact grants; the worker cannot run settlement jobs.
  - **OD-51.1:** plan changes are served by their own process (`operator`) with its own token audience; the API and the worker refuse the credential in production.
  - **OD-51.5:** the database-administrator boundary is documented (runbook, ADR 0035 Amendment 5).
- **Two sessions worked on this branch on 12 Nov.** The engineering session holding the owner's instruction wrote 0213 to 0219; the scheduled autopilot run, working from `2b602b0`, fixed CI, a web copy defect and the runbook, and reviewed 0213 to 0216 (its note is kept below). Its two IMPORTANT findings are both closed here (the runbook section, and OD-52 by 0218), and its OD-50 minor about a later cancellation is fixed by 0219.
- **Before a deploy (owner):**
  - add `OPERATOR_BILLING_OIDC_AUDIENCE` to the staging `.env`, different from `OPERATOR_OIDC_AUDIENCE`, and have the identity provider issue plan-change tokens for it; the staging deploy refuses to start without it, with nothing changed;
  - follow `docs/runbooks/deploy.md`, "Deploy a release carrying 0213 to 0219" (two new services; every writing process is stopped);
  - run the OD-49 preflight as before.
- **Not done, on purpose:** no merge, no deploy, no staging change, no live Paystack or Meta call. `REKODA_USER_JOURNEYS.md` and the acceptance documents do not yet describe the support-review route or the `duplicate_purchase` record.
- **Honest limits:** the end of the OD-51 row in `REKODA_LAUNCH_READINESS.md`.

**PR B, 12 Nov 2026 (head `2b602b0` plus the autopilot follow-up): still OPEN as #432, not merged, not deployed; STAGING ACCEPTANCE PENDING; the merge is the owner's.**

- **Four commits after `edf747d` add migrations 0213 to 0216.** Their commit messages and the 0215 header cite an owner instruction of 12 Nov 2026. That instruction is now recorded as OWN-91 (it was not when this note was written).
  - **0213 (OD-50):** a support-review upgrade keeps the paid-through date (`POST /v1/businesses/plan/support-review`).
  - **0214 (OD-51 limit 7):** one pack purchase is credited once across replaced payment links; a second payment is set aside (`duplicate_purchase`).
  - **0215 (OD-51 limit 6):** one pricing source in the database, recorded on every charge; the api and worker refuse to start on a different setting.
  - **0216 (OD-51 limit 4):** the usage meter is written only through `usage_reserve`, `usage_refund` and `usage_credit_pack`. Compatibility break: deploy with the api and worker stopped.
- **Autopilot follow-up on that head (12 Nov 2026):**
  - CI on `2b602b0` failed one repository guard (the webhooks suite grew past the layout limit). Fixed by splitting it (`e8fe3a5`): `webhooks.fixtures.ts` and `webhook-delivery-meter.integration.test.ts`, the same 16 tests.
  - A reviewed payment record no longer also says it is being reviewed, and the "switching your plan on" notice is not shown beside a processing problem (`ce659eb`; RED first in `payment-record-copy.test.ts`).
  - Three independent read-only reviews of `edf747d..2b602b0` (financial; security and migrations; concurrency and tests): 0 BLOCKING, 2 IMPORTANT, minors.
    - IMPORTANT 1, fixed in docs: the boot error and 0215 pointed to a "Pricing source" runbook section that did not exist, and the runbook still advised changing `REKODA_PLAN_CATALOGUE_READS` alone, which now stops both processes. `docs/runbooks/deploy.md` has "Deploy a release carrying 0213 to 0216" and "Pricing source".
    - IMPORTANT 2, not fixed at the time and since CLOSED by migration 0218 (see the note above), recorded then as **OPEN OWNER DECISION OD-52**: a completed reservation stays refundable for 45 days, so a stolen application credential can still return used units. OD-51 limit (4) is narrowed, not closed.
    - Minors are recorded in the OD-50 and OD-51 rows of `REKODA_LAUNCH_READINESS.md`.
  - Codex: UNAVAILABLE (usage quota), last asked 11 Nov 19:37 UTC for `edf747d`; not approval. CodeRabbit: skipped (file limit).
- **Not done:** `REKODA_USER_JOURNEYS.md` and the acceptance documents do not yet mention the support-review route or the `duplicate_purchase` record.
- **Before a deploy, in addition to the list below:** `docs/runbooks/deploy.md`, "Deploy a release carrying 0213 to 0216".

**PR B, 11 Nov 2026 closeout round (owner instruction OWN-90): still OPEN as #432, not merged, not deployed; STAGING ACCEPTANCE PENDING; the owner reviews the readiness report before any merge.**

- Migrations 0207 to 0212:
  - **OD-44:** fresh payment initiation for a renewal blocked before initiation, once the gate opens (`billing.renewal_initiate`).
  - **OD-50 (0207):** standard operator periods; the trial start is fixed.
  - **OD-49 (0208):** read-only release preflight and audited correction. The staging and production counts are NOT checked yet.
  - **OD-51 (0209):** settlement re-prices every charge; the API holds no settlement credential; zero-priced upgrades are applied by the worker.
  - **0210:** worker least privilege (G-125), with its external-event writes limited, the retention policy enforced in its function, and the migration ledger and entitlement grants read-only.
  - **0211:** the operator principal is narrowed.
- **Web:** fixed the cause of the desktop reminders Playwright flake.
- **Before a deploy:**
  - remove nothing from `.env`, since compose blanks `SETTLEMENT_DATABASE_URL` for the api;
  - run `deploy/migrate.sh preflight-subscriptions` after migrate (`docs/runbooks/deploy.md`, "Deploy a release carrying 0207 to 0212").
- **Open for the owner at the time (both closed 12 Nov 2026, OWN-91):**
  - the OD-50 support-review consequence;
  - the OD-51 known limitations (the operator credential in the API; settlement in the worker; settlement still inheriting `rekoda_app`; the application credential's metering and identity writes; the owner boundary).

**PR B, 11 Nov 2026 autopilot follow-up (`a278bb8`): still OPEN as #432, not merged, not deployed (OWN-89 item 6 keeps it unmerged until the owner rules).** Qodo item 6 on `5772e92` was real: a close-pass heartbeat that threw (a database error, not a lost lease) released the lease with the batch's failed closes uncounted, so no stopped-pass `ALERT` fired and `last_pass_failed` left them out. Fixed in `apps/api/src/billing/renewal-sweep.ts`; RED then GREEN: `renewal-gate-lease.integration.test.ts`, "a heartbeat that errors mid-batch still reports the closes that batch already failed". Qodo items 12, 29 and 31 are already recorded as post-MVP rows in `docs/plans/PR-B-plan.md`. Item 25 is not a defect: the operator contract takes an explicit `expiresAt: null` for the rule's default date. Items 1 and 3 (PR description) are answered on the PR. Codex: UNAVAILABLE (usage quota).

**PR B, 11 Nov 2026 owner review round (OWN-89): still OPEN as #432, not merged, not deployed; the owner reviews the implementation report before any merge.** Migrations 0201 (close-pass lease heartbeat), 0202 and 0205 (settlement and billing-operator database principals: only `rekoda_settlement` opens a charge, changes its terms or status (apart from a refund), records a payment, credits pack units, holds an add-on or applies a paid plan; only `rekoda_billing_operator` runs the operator writer), 0203 (Rekoda's real plan durations in both writers; the operator route takes `billingInterval`), 0204 (the worker's event access is a read; the generic exception resolve is pinned and audited), 0206 (security re-review B3: a paid renewal or upgrade is bound to its charge's frozen period in the provider writer; the subscription's cycle and pricing inputs change only as settlement or the billing operator; trial end counted in hours). New REQUIRED deployment secrets: `SETTLEMENT_DATABASE_URL`, `OPERATOR_DATABASE_URL` (must be in the staging `.env` before deploying; `docs/runbooks/deploy.md`, "Deploy a release carrying 0202 to 0206"). Minors fixed (OIDC subject 400, SQL privilege test, exact-set smoke). Open for the owner: OD-49 (pre-existing nonconforming rows, not rewritten), OD-50 (shorter operator periods allowed), OD-51 (residual limits of the principal separation).

**PR B, 11 Nov 2026 update (owner direction OWN-88): still OPEN as #432, not merged, not deployed; the owner reviews the readiness report before any merge.** Migration 0199 gives the blocked-renewal close pass a durable keyset cursor (saved after every batch, database lease, wrap-around; the restart-starvation tests fail on the old in-memory offset), and migration 0200 replaces the general plan writer with `subscription_apply_paid_charge` (plan from a paid, unapplied charge) and `subscription_operator_set_plan` (validated plan, date window and `operator:` actor; it writes its own audit row), refuses clearing an applied charge period (one charge, one cycle), and guards the INSERT (future trial, at most 15 days); a pass that stops without recording its end is recorded on takeover and raises `billing.renewal_block_close_stalled`, and the close alert holds until a whole cycle runs clean; the deploy script lists 0200 as compatibility-breaking and its pre-start smoke checks the new boundary (signatures, owner, pinned search_path, EXECUTE grants, triggers) and the absence of the removed and test-only writers. Open for the owner (OD-37, an integrity boundary, not an authorisation boundary against a stolen application credential): a forged `paid` charge, or an operator-writer call, by a holder of the application credential (proposed fix: dedicated settlement and operator database roles; `docs/REKODA_LAUNCH_READINESS.md`, OD-37).

**PR B, 8 Nov 2026: OPEN as #432 on branch `angelo/magical-bell-s81mqc` (not merged, not deployed). PR A MERGED as #431 (`58e6834`, 8 Nov 2026; main CI green).** All six PR B items are code complete with RED/GREEN integration tests (`docs/plans/PR-B-plan.md`, "As built"): **Review round on #432 (8 Nov 2026, after head `9b13d97`):** seven CodeRabbit threads were verified against the code. Fixed with a RED test each: case-insensitive event-id compare in the cutover enrolment (`jobs.ts`); the public sale route's customer check now locks the row `FOR KEY SHARE` (`merchant-api.ts`); statement routes answer a malformed, unknown or foreign id with one identical 404 and check before spending an export unit (`reports.controller.ts`, `party-statements.ts`); stricter assertions in the records, members and staging-marker tests. The blocked-renewal close pass, bounded at 20 pages of 200 per sweep, was first left as a post-MVP deferral; on the owner's ruling OWN-87 (10 Nov 2026; an earlier "8 Nov direction" claim could not be verified) it is now fixed in this PR with a persisted cursor (migration 0198, `blocked_close_failed_at`; `renewal-gate-cursor.integration.test.ts`), and its thread stays open until the final head is verified. OWN-87 (10 Nov 2026) also keeps the IDOR hardening in PR B and confirms OWN-85 and OWN-86; the deploy script now enforces OWN-86's pre-start database smoke. The security finding on `subscription_write_plan` is documented as accident prevention, not authorisation (`PR-B-plan.md` §5), with options A, B and C awaiting the owner. The plan's stale note that the IDOR hardening awaited an A/B ruling is withdrawn. Nothing here is deployed, merged or staging accepted.

- OD-40: charge times, 0193.
- OWN-73 and OWN-76: dead-job record, merchant exception or billing notice, operator item, and verified one-attempt recovery, 0194.
- OWN-70: blocked renewals recorded, listed and alerted on, 0195.
- OD-37: plan-field trigger and the `rekoda_plan_writer` definer writers, 0196.
- G-119 / OWN-77: staging tools and runbook, 0197.

Next steps: CI on the final head, CodeRabbit, an independent review, then owner merge. After deploy, staging setup per `docs/runbooks/staging-test-business-tools.md` §2, then the owner's SUB-ACC 17/18/19/22 and ACCEPT-01 2/3/9/10 runs.

Still open:

- **OD-44** (owner); since implemented in the closeout round (OWN-90, `billing.renewal_initiate`).
- **Rollback:** none past 0196 (OWN-86): stop api and worker before migrating, never restart the previous release against a database that holds 0196, fix forward or escalate (`docs/runbooks/deploy.md`, "Deploy a release carrying 0196").
- **OD-47 and OD-48 RULED 8 Nov 2026 (OWN-85, OWN-86):** operator work lists are worker-only fixed-column definer functions (ADR 0035 Amendment 2); 0196 is an accepted compatibility break enforced by `deploy-staging.sh`.
- **Dependabot:** #429 and #430 await the owner.

**PR A, 7 Nov 2026 (HISTORY: since MERGED as #431, `58e6834`, 8 Nov 2026; deployed state not confirmed, staging acceptance PENDING): was OPEN on branch `angelo/magical-bell-1djjc3`.** Owner rulings OWN-78 to OWN-84 (`REKODA_OWNER_DECISIONS.md`; OWN-83 supersedes OWN-81). OD-41(b): the five WhatsApp template slots are mapped (`apps/api/src/channels/template-slots.ts`), the grace and trial templates carry the billing link from `REKODA_WEB_URL`, the read-only staging check validates the five slots in api and worker. OD-42(b) under OWN-83: a reminder email's Reply-To is the business's own verified email; without one the email is not sent (`business_email_unverified`) and WhatsApp may still go; the owner can give the email on WhatsApp ("my email is ...", which mails the existing single-use confirmation link and never verifies by itself); `REKODA_SUPPORT_EMAIL` is optional and unused for reminders; a customer's WhatsApp reply to a recent reminder is told to the business once per reminder (migration 0192), but Rekoda has no inbox to read or answer it (G-124). The notice is sent only while Rekoda's 24-hour window for the business is open; a message from any member counts, so with only a delegate's message Meta may refuse the owner's notice or report it failed. A withheld, refused or failed notice is tried again on the customer's next message, which may never come, only while that reminder is still the newest WhatsApp reminder to the customer within its seven days (a later message, or one after a newer reminder, matches a different reminder or none); a notice reported failed is not retried for an owner who belongs to more than one business, because the receipt cannot be tied to the business (G-124). Within that, it is at-least-once (OD-46, OWN-84): a crash after Meta accepted it and before it was recorded can send one duplicate. OD-44 (a renewal blocked before it was initiated) is deferred to PR B (OWN-76), not ruled. OD-39: `POST /v1/ops/privacy/email-erasure` (`ops:privacy`, migration 0191). OD-38: documentation only (no private-beta mechanism). OD-43 unchanged. Owner actions before staging can use it: set the staging `.env` values in `docs/runbooks/meta-whatsapp-templates.md` §3, confirm the test business's own email before testing email reminders, and check each template in WhatsApp Manager (§2). The PR #428 threads on `jobs.ts` (OWN-76) stay open for PR B.

**#428 FOUR OUTSTANDING GAPS, 7 Nov 2026: owner ruled (A) on each; fixes pushed to PR #428 (still OPEN, not merged, not deployed).** (1) The ingress fence's 120 s now runs from each message's OWN first failure (it ran from the business's first failure, so a message failing late got only the remainder of the window), and a stored message whose redelivery is refused, times out or fails its duplicate write is acknowledged instead of fencing the business. (2) A held purchase withdrawn by a lost message stays withdrawn: tests for late "separate" / "same" / "cash" / "yes", the redelivery, and the purchase sent again booking once, both death paths. (3) A message skipped behind an unattributed failure is now held in its own business's lane until Meta redelivers the body (a later webhook of that business was stored ahead of it), and the failed message's order is reserved so the redelivery stores it first (independent review of `0c5501e`). (4) Admission order is the stated guarantee; tests for sender resolution finishing out of order and simultaneous webhooks with one Meta timestamp. Exact guarantee and limits: `REKODA_LAUNCH_READINESS.md` G-122 item 9. OWN-76 (`billing.process`, PR B) and OD-41 (templates, PR A) are out of scope; the staging check stays `RESULT: ATTENTION` until the template slots exist.

**#428 CONSOLIDATED REVIEW, 7 Nov 2026: fixes pushed to PR #428 (still OPEN, not merged, not deployed).** On the owner's consolidated list: (1) ingress is admitted per business by an in-process lane in front of the database ingress lock (`apps/api/src/channels/ingress-sequencer.ts`): waiting webhooks hold no pool connection, and a message that fails to be stored is kept outstanding, so every later message of its business (already waiting, in the same body or in later webhooks) is refused until the earlier ones are stored, in the order they first came, whatever order Meta redelivers them in (at most 120 s from the first failure, not extended by repeat failures; other businesses in the same body are stored), which closes the "later yes overtakes a timed-out cancel" residual and the cross-business body-skip for attributed failures; (2) a bare "cash", "bank", "same" or "separate" waits behind an earlier retrying message even with no question open (a held purchase's "separate" could overtake a lost cancel); (3) the batch-ordering test releases the lock on the first message's observed failure, not on a timer; (4) the held-purchase scope of OWN-74 is recorded for the owner to confirm; (5) staging-check tests for an uninspectable Paystack key and a non-ok `/health`; deploy and handoff runbooks corrected (migration count at least the journal count; OWN-69 journey per opt-out and per merchant; journey 14 preview; journey 17(b) BLOCKED on an owner-confirmed retry procedure). Still open on #428: OWN-76 (PR B), the unset-template-slot verdict (OD-41), the body-skip for a failure before attribution (narrowed, not removed), the journey 17(b) procedure. G-122 item 9 has the detail.

**G-122 ITEM 7, 4 Nov 2026: DECIDED as OWN-73, NOT IMPLEMENTED.** The owner ruled that a dead `payment.process` job must leave both a merchant exception and an operations queue item. #428 records the ruling and the acceptance criteria (`REKODA_LAUNCH_READINESS.md` G-122 item 7); the implementation is an approved follow-up, not in #428.

**STAGING READINESS, 4 Nov 2026 (updated 6 Nov with the OWN-75 to OWN-77 rulings): in PR #428 (the single engineering closeout PR, with the Step 5 work below), OPEN, NOT MERGED, ON HOLD pending explicit owner approval.** A final development audit (migrations, deploy, billing, tenancy, notifications, worker, config, acceptance docs) found no BLOCKING defect; it fixed the job reclaim that could loop a crashing job for ever (one run past the last attempt, then dead), corrected the acceptance docs (the mock email provider cannot run on staging; an ACCEPT-01 plan and result table; steps needing date moves are BLOCKED until the OWN-77 procedure is merged and deployed to staging), and recorded G-119 to G-122. `main` `b8baf24` is deployed to staging (Deploy staging run 41890201057 green); the api and worker images, host health and the applied migration list are NEEDS OPERATOR EVIDENCE; nothing is STAGING ACCEPTED. `scripts/staging-readonly-check.sh` now checks the checkout and the served commit against `EXPECT_SHA`, api/worker image parity, migrations 0187 to 0189 and the full expected-against-applied ledger by tag, and the effective `REKODA_CUSTOMER_REMINDERS`, ending with an attention list. The operator's order and prerequisites are in `docs/runbooks/staging-acceptance-handoff.md`. Docs corrected: the walkthrough no longer tells the operator to set `REKODA_PAYSTACK_PLATFORM_CONFIRMED` (OWN-70); G-05's key gate is recorded as merged (#418 `d96d87e`); Meta template slots, approval and delivery are recorded as separate facts (ledger, 4 Nov block). Owner rulings on #428 (4 Nov 2026): OWN-74, an inbound message whose job died (by `markFailed` or `reclaimStalled`) now withdraws the drafts that were pending behind it before any later "yes" is read, and the merchant is told to record it again (G-122 item 9; migration 0190); OWN-75, a job that dies through `reclaimStalled` records fixed error text, never an earlier error, with a sanitised `failure_category` beside it. G-119 was ruled on 5 Nov 2026 as OWN-77 (route A: a staging-only, test-business-only, audited date-move and forced-failure procedure). It is NOT IMPLEMENTED (planned for PR B), so those steps and journeys stay BLOCKED until that procedure is merged and deployed to staging. OWN-73 (dead `payment.process`) and OWN-76 (dead `billing.process`) are approved and NOT IMPLEMENTED (PR B); the OWN-76 review thread on #428 stays open deliberately. The 5 Nov independent review of #428 fixed, RED first: a typed "yes", "no" or "cancel" that answered a newer request (or returned before reaching the withdrawn one) left a withdrawal behind a lost message untold, so the notice now follows such an answer (`apps/api/src/channels/meta-lost-message.integration.test.ts`); and six staging-check branches that a test could not fail, plus a quoted-empty `.env` value read as SET (`scripts/staging-readonly-check.services.test.mjs`).

**TEST YEARS AND TEST LAYOUT PHASE 4, 4 Nov 2026: #427 MERGED (`b8baf24`, squash of head `1bef603`); the Step 5 follow-up (config split, api-root rule, quote/PO/bill year boundary) is PR #428 (branch `angelo/magical-bell-yuy70g`), OPEN, NOT MERGED (the owner asked for it inside #427, which merged before it was pushed; the owner approved the follow-up PR on 4 Nov 2026).** Two integration tests asserted a document number with a literal year (`meta-plan-example`, `reports.integration.test.ts`). They now assert the number they issued, so they keep passing from 1 January 2027. A db test pins the Lagos year boundary (22:59:59.999Z and 23:00Z on 31 December) for every document writer: invoice, receipt, credit note, journal, and now quote, purchase order and supplier bill. For the last three this needed a small product change: `createQuote` and `createPurchaseOrder` take an optional `issuedAt`, and `recordPurchase` an optional `recordedAt` (the name `recordExpense` already uses, driving the posting date, the expense row, and the bill's number year, `billed_on` and `created_at`). Unset, which is every live caller, each keeps the clock exactly as before; no public request schema carries the field; no migration. `scripts/check-test-years.mjs` (a CI step) fails a new unannotated document-year literal in an integration test or fixture. Phase 4 moves the rate-limit module and its tests, and (on the owner's instruction that the approved plan included it) `client-address.ts` and its unit test, into `apps/api/src/http/`; imports only. `config.test.ts` (850 lines) is split by concern into eight files in `apps/api/src/config/` with `config.production.test.ts` moved beside them as `config/production.test.ts` (168 + 191 tests, names identical; `config.ts` stays at the root; its baseline entry removed, layout debt 40 to 39). `check-test-layout` now fails a test directly in `apps/api/src/` unless `API_ROOT_TESTS` names it with a reason; the list is the edge pair only (`edge-check.ts` and `edge-proxies.ts` stay at the root, owner decision D2, recorded as OWN-71). The web layout stays as it is (D5, recorded as OWN-72). Nothing from Step 5 is deferred. The original Phase 4 plan text is not in the repository, so the client-address scope rests on the owner's statement. Not deployed to staging; not staging accepted.

**SUBSCRIPTION CERTIFICATION, AUTOMATED HALF (P1-3), 4 Nov 2026: #426 MERGED (`5a3608c`, 4 Nov 2026; deployed by Deploy staging run 41841049324, since superseded by run 41890201057 on `b8baf24`; STAGING ACCEPTANCE PENDING).** A SUB-03 gap check, done requirement by requirement, found every lifecycle item covered at integration level. Three browser journeys were missing, and #426 adds them: a renewal paid in grace, a yearly renewal paid, and a cancellation that is kept or left to run. The acceptance matrix, the subscription audit, P1-3 and the staging walkthrough now name the specs. #426 also fixes `trial-notice-sweep.integration.test.ts`, which would have failed from 2026-11-14T09:30Z with no code change. Its pinned sweep clock was compared with the database `now()` claim stamp. A clock-drift audit of the 43 integration files that both read the clock and carry 2026 dates found no other time-bomb. This is CI evidence on a stand-in Paystack, not staging acceptance: SUB-ACC still needs the owner on staging (`docs/runbooks/billing-staging-walkthrough.md`). The year-literal and test-layout Phase 4 cleanup is authorised and comes next, as its own PR.

**REM-06 (merchant reminder screens) MERGED (#415, `131282f`, 3 Nov 2026, squash of final head `09854ab`; exact-head CI green 12 of 12; independent review 0 BLOCKING / 0 IMPORTANT; Codex at its usage limit). DEPLOYED TO STAGING (Deploy staging run 41676936858 on `131282f`, green); staging acceptance pending. Next: SUB-ACC and ACCEPT-01, which need a person on staging. #414 closed as superseded (its content is already on main).**

**REM-05 (scheduled and bulk reminders) MERGED (#413, `d11ed34`, 3 Nov 2026, squash of final head `14138bc`; exact-head CI green 12 of 12; CodeRabbit APPROVED `14138bc`, 14 of 14 pre-merge checks; 0 unresolved threads; independent reviews 0 BLOCKING / 0 IMPORTANT after two IMPORTANT findings were fixed; Codex at its usage limit). DEPLOYED TO STAGING (`main` CI run 41565201861, Deploy staging run 41565857377); STAGING ACCEPTANCE PENDING.** Migration 0189. Limits are engineering defaults recorded as OPEN OWNER DECISION OD-43. **(Historical: before #415 merged, REM-06 was in review; see the MERGED entry above.)**

**REM-03 MERGED, 3 Nov 2026, as #412 (`7b37e26`, squash of final head `bf5a86a`).** Exact-head CI green on all 11 workflow checks; 0 unresolved threads; independent read-only reviews 0 BLOCKING / 0 IMPORTANT on every head; the two CodeRabbit code findings (a WhatsApp STOP landing after the unit reservation; the refund on a failed STOP re-read, spec §4.3 rule 4) were fixed RED first. CodeRabbit's last formal state on `bf5a86a` was CHANGES_REQUESTED from a PR-description pre-merge check (the metering invariant was not named in the description); the description was corrected before the merge, which happened before CodeRabbit re-reviewed it. Codex at its usage limit (OWN-35). The superseded #410 was closed unmerged. Post-merge `main` CI run 41554267854 and Deploy staging run 41555019810 green: DEPLOYED TO STAGING; STAGING ACCEPTANCE PENDING. The whole-MVP remaining-work view is the last section of `REKODA_MVP_DELIVERY_LEDGER.md`.

**OD-34 RULED (OWN-69, 2 Nov 2026): customer opt-outs are channel-specific.** An email unsubscribe stops reminder email for that merchant and address only; WhatsApp STOP stops WhatsApp only; neither unsubscribes the other; both are per merchant. **REM-03 IN REVIEW** on `angelo/magical-bell-k057yd`: the email opt-out is now re-read immediately before the provider call (WhatsApp STOP is now re-read inside `sendCustomerText` after the unit reservation commits and before Meta is called, refunding the unit when the customer has opted out: a CodeRabbit finding on `746299b`, reproduced RED by `a WhatsApp STOP that commits after the gateway reserved the unit…`), so an unsubscribe that lands after the attempt opened still stops that email; `reminder-channel-optout.integration.test.ts` proves each channel honours only its own opt-out, per merchant, through the real WhatsApp gateway (RED first on the dispatch-time email case). Scheduled and bulk reminders (REM-05) dispatch each recipient through `ReminderService.send`, which calls `sendOne`, so they inherit the check. REM-03 has since merged (#412); see its entry above for the current status.

**REM-04 (merchant payment instructions) MERGED, 2 Nov 2026, as #409 (`90c369e`, squash; final head `c51593b`: exact-head CI run 41523473937 green, CodeRabbit check success and 0 unresolved threads, independent read-only review 0 BLOCKING / 0 IMPORTANT with its three important items fixed, Codex at its usage limit and never reviewed it, OWN-35). Migrations 0187 and 0188. DEPLOYED TO STAGING (`main` CI run 41525376326 and Deploy staging run 41526342374 green on `90c369e`; the deploy's "Staging answers with this commit" step passed); STAGING ACCEPTANCE PENDING.** REM-04 (OWN-64 Slice D, backend): owner-approved payment instructions (bank name, account name, ten-digit NUBAN; only the owner can save or clear them, the owner and delegate can read them), migrations 0187 and 0188 (all-or-nothing CHECK added NOT VALID, then validated), `GET/PUT/DELETE /v1/reminders/payment-instruction`; email and in-window WhatsApp reminders carry the approved account, the current balance and the invoice reference, and fall back to the public phone when none is approved (never invented). Out-of-window WhatsApp reminders are blocked (`window_closed_no_template`; no reminder template is configured or sent), so only email and in-window WhatsApp carry the account; the unused template parameters are unchanged. OWN-43 and OWN-64 stay OPEN until a reminder template exists; the merchant screen is in REM-06 (#415, `131282f`), merged; deployed to staging; staging acceptance pending. Merged (#409, `90c369e`); deployed to staging, not staging accepted, STAGING ACCEPTANCE PENDING. Next after this merge (historical): REM-05 and REM-03, both since merged; the current next step is SUB-ACC and ACCEPT-01 (each needs a person on staging).

**REM-02 (invoice reminder reliability) MERGED, 2 Nov 2026, as #406 (`60cfee8`, squash; final head `9bf96c4`: exact-head CI run 41499699429 green, CodeRabbit APPROVED on that head, independent review 0 BLOCKING / 0 IMPORTANT, 0 unresolved threads; the overlapping PR #407 was closed in favour of it). No migration; DEPLOYED TO STAGING (`main` CI run 41502231198 and Deploy staging run 41503379820 green); STAGING ACCEPTANCE PENDING. Next in sequence: REM-03, in review under OWN-69 (OD-34 ruled 2 Nov 2026: opt-outs are channel-specific).** RED-first tests: the dispatch balance re-read locks the invoice `FOR SHARE`; one reminder IN FLIGHT per invoice and channel whatever the idempotency key (advisory lock plus the `reminder_in_flight` refusal while another attempt is `sending`); **no cooldown or minimum interval exists** (the owner rejected the proposed 60-minute figure and has not approved 24 hours; when to remind again is the reminder cadence, REM-05, not REM-02); standalone `sendCustomerText` (no caller transaction: invoice reminders and the payment-link job) holds no transaction during the Meta call, refunds only a definite non-send (`SendFailed` with `notSent`) and keeps the unit after a timeout or any other error that does not prove the message was not sent; when Meta accepted the message but returned no message id, or writing its provider id fails, that standalone outcome stays `sent` with `providerIdUnrecorded` (never a failure, never resent, the unit stays spent; a 2xx with no id is flagged the same way on the `outerTx` path) and the reminder history records reason `provider_id_unrecorded`, with the outbound row id in the log. Callers that pass their own transaction (`outerTx`: the customer-message and inbound-message jobs) keep the single-transaction shape. For a `SendFailed` there, only `notSent` refunds the unit and an unknown `SendFailed` keeps it spent; a non-`SendFailed` error or a failed provider-id write after Meta accepted is rethrown into the caller's transaction, which can roll the reservation and outbound row back (an existing residual, not changed here; follow-up: a SAVEPOINT around the settle writes). Email `replyTo` is the merchant's billing email only when it is verified and can be decrypted; otherwise no reply-to is set (no fallback is approved; OD-42(b) open); the public opt-out route is limited to 10 requests per minute per visitor; void, credit, reversal and real-payment tests use the supported posting paths. Remaining: callback after timeout, the Slice B worker, REM-03 (OWN-69).

**REM-01 (trial reminders) MERGED, 2 Nov 2026, #405 as `79f9968` (migration 0186; NOT STAGING ACCEPTED). Post-merge CI on `main` was first blocked by a GitHub Actions billing failure (jobs not started); after billing recovered, CI run 41461494325 attempt 2 passed and staging was deployed by hand (Deploy staging run 41468489977, `e4f58a0`, which includes #405). DEPLOYED TO STAGING; staging acceptance pending.** SUB-05 MERGED as #404 (`def64c3`, 2 Nov 2026; staging acceptance pending). REM-01 gap check on `def64c3`: 7/2/1 reminders met with tests; a Meta delivery failure after acceptance was never applied, now fixed (#405): the `delivery.status` job marks the reminder `undelivered` (matched on business id and the recorded wamid; idempotent; never resent; the next stage still sends). Day 0 and trial-ended messages, and which approved template is the trial template, are OPEN OWNER DECISION OD-41. `scripts/staging-readonly-check.sh` now reports SET/UNSET for all five `META_*_TEMPLATE` slots (no values). Next: verify the trial template slot on staging, then the owner rules OD-41. OD-41 stays open and is not a merge gate: Day 0 and trial-ended messages need an approved template first, so if ruled in they follow in their own PR; the template mapping must be verified on staging.

**SUB-02a (OWN-58) MERGED, 2 Nov 2026 (#402, `920f2ac`; migration 0185; STAGING ACCEPTANCE PENDING).** Per-address billing-email confirmation limit across businesses (OWN-66): 5 an hour, 60 s apart; an unknown send outcome counts, only a definite refusal reverses. Final head `97f105c`: CI run 41435072069 green, final independent review 0 BLOCKING / 0 IMPORTANT, CodeRabbit review complete with 0 pre-merge errors (its stale change request from `509e68c` is superseded by the disposition comment on the PR; this autopilot cannot dismiss reviews). New OPEN owner decisions: OD-39 (allowance exhaustion) and OD-40 (month a top-up pack counts toward). ADR 0036 added. **SUB-04** gap check done on `920f2ac`: all requirements met in code; its only gap (dashboard meter ceiling computed in the browser) ships in the SUB-05 PR. **SUB-05** gap PR in progress on `angelo/magical-bell-n5xlq6`. **Blocked on a person with staging access:** SUB-03r and SUB-02a staging acceptance (`docs/runbooks/billing-staging-walkthrough.md` steps 17 to 21); this autopilot has no staging access.

**SUB-03r MERGED, 2 Nov 2026 (#400, `cefb6ee`; no migration; STAGING ACCEPTANCE PENDING).** The grace-reminder sweep no longer resends after an unknown send outcome (the claim is kept, OWN-47), claims and re-reads eligibility (including STOP/START) in one transaction, treats a missing billing template or sender as definite non-delivery (retried), and a failed claim release no longer aborts the pass. Known residual (accepted under OWN-47): a reminder day is not retried after an unknown outcome, so the day-5 reminder can be lost before the day-7 expiry; softening it is an owner product decision. Codex was unavailable (usage limit) and never reviewed this PR; it merged on OWN-35. Next in the owner's order: SUB-02a, still blocked until the owner confirms the per-address figures and whether an unknown-outcome send counts against the limit. Details: `REKODA_MVP_DELIVERY_LEDGER.md`.

**COMPLETION AUDIT AND TWO MERGES, 2 Nov 2026.** (1) #397 MERGED (`283ae06`): `@anthropic-ai/sdk` 0.135 to 1.3.0 with one credential per request (`X-Api-Key`, the SDK's Bearer header removed), `anthropic-version` pinned to `2026-10-21`, no sampling parameters, `ANTHROPIC_CUSTOM_HEADERS` refused, SDK logger off; it supersedes Dependabot #379 (closed; CodeRabbit cannot review bot-authored PRs). Not verified against the live API: the owner-run G-07 evaluation should confirm it. (2) #396 MERGED (`7f1adec`): a static file-and-assignment guard for who writes `businesses.plan` and `plan_expires_at` (G-62); the stronger database trigger is OPEN OWNER DECISION OD-37. (3) Codex was at its usage limit on every head of both PRs (recorded, not approval); independent read-only reviews and CodeRabbit gated them. (4) The completion audit is in `REKODA_PRODUCT_FEATURE_INVENTORY.md`, `REKODA_E2E_ACCEPTANCE_MATRIX.md`, `REKODA_SUBSCRIPTION_COMPLETION_AUDIT.md` and `REKODA_PRODUCTION_ROADMAP.md`; verdict unchanged (NOT READY); subscriptions NOT 100%; nothing staging-accepted since mid-October. **Next actions:** `cc369c5` is already deployed to staging (run 41378727482; deployed, not accepted); run the batched staging acceptance campaign (roadmap P0-6), the owner-run live AI evaluation (P0-7), owner calls on OD-37 and OD-38, and the external long poles (Meta templates and App Review, Paystack §47 answers, tax advice, production host and off-box backup destination). No production deployment was made.

**LIVE STATE, 29 Oct 2026 (verified on GitHub, not inferred).** (1) **GitHub Actions is blocked by billing:** jobs on `main` `25c4aaa` (CI run 40839824216) and the staging deploy of `3ac0a4f` (run 40839321249) failed in about 3 seconds with "The job was not started because recent account payments have failed or your spending limit needs to be increased". The same error stopped PR #379 on 28 Oct. Account action needed: fix the payment method or raise the Actions spending limit (Settings, Billing and plans). No required check was bypassed. (2) **Staging runs `262b883` at best:** the last successful Deploy staging run is 40835266714 on `262b883` (29 Oct 07:24 UTC). `311990d`, `3ac0a4f` and `25c4aaa` are merged but NOT confirmed deployed. Staging was not reachable from the engineering sandbox (proxy 403), so no health, migration or browser evidence was gathered and NOTHING is STAGING ACCEPTED. (3) **Subscription staging acceptance:** the walkthrough result table in `docs/runbooks/billing-staging-walkthrough.md` is empty; all 18 steps are MERGED with automated tests and STAGING ACCEPTANCE PENDING. (4) **Open PRs:** #387 (G-62 guard), #390 (walkthrough evidence docs), #388 (G-28 row metadata), #384 (G-118, two owner-decision threads open), #379 (Anthropic SDK 1.3.0, held). (5) **Open owner decisions:** G-118 net versus gross wording; N2 product ranking (A, B or C); G-116 fully refunded payment fee; G-110 yearly/monthly switch while overdue; OD-34 email opt-out scope; OD-2 (VAT) narrowed. OD-32 is RULED (OWN-58), not open. (6) **Scheduled routine:** its stored prompt could not be read or edited from the engineering sandbox (no routine tool, no scheduled jobs in session); a replacement prompt is attached to the 29 Oct report and must be pasted by the owner.

**N1 customer debt reminders, slice A MERGED (29 Oct 2026, #368, `311990d`; migration 0184; STAGING ACCEPTANCE PENDING; NOT LIVE).** `POST /v1/reminders/send` sends an immediate payment reminder for one unpaid invoice on WhatsApp and email (`channels: 'auto'` tries WhatsApp first and email as well when the customer has an address; each channel is its own attempt, key `<key>:<channel>` and history row). Balance, contact, opt-out and merchant attestation are re-read in the transaction that writes the `sending` row; the provider is called after it commits; an unknown outcome is `uncertain` and never resent; a `sending` row older than 10 minutes reads as uncertain. Migration 0184; reusable channel policy `packages/core/src/notification-policy.ts`; public opt-out page `/reminders/opt-out`. Refused on every channel (`reminders_not_released`) until the owner sets `REKODA_CUSTOMER_REMINDERS=1` (default off, after legal sign-off); email also needs `REKODA_EMAIL_PROVIDER`, a verified sender and `REKODA_WEB_URL`; WhatsApp only inside the 24-hour window (no reminder template is configured; nothing is substituted). No real Resend, Meta or customer message has been sent; legal sign-off on customer email is not given (OWN-62). Known minor follow-ups from the independent review of #368: prepare decrypts both contact facets whatever the channel (a corrupt unused facet turns a request into a 500); a failure before the provider call is recorded as uncertain; a send over 10 minutes stays uncertain after the stale sweep. Not built: slices B (scheduled), C (bulk), D (web and WhatsApp controls, public-phone and customer-email entry screens), business-email onboarding collection and routing other notification flows through the policy.

**G-28 stock journey MERGED (29 Oct 2026, #394, `2e3425b`; no migration; test only; STAGING ACCEPTANCE PENDING): `apps/web/e2e/stock.spec.ts` shows an empty shelf, that sending a purchase order does not count stock, and that marking it received puts 10 on the shelf at ₦5,000 each (default desktop-size browser, not phone width), shows the product in the stock CSV export (only the product name is asserted, not quantity or cost), with one +10 inventory movement and a balanced Dr 1200 / Cr 2000 ledger. CI was green on the PR head `015b5c5` (run 40859117608), Codex and CodeRabbit clean there. The push CI on main `2e3425b` (run 40888023014) FAILED in about 4 seconds with no job body run (Actions failed instantly on and off between 28 Oct 22:44 and 29 Oct 00:28 UTC and again from 29 Oct 14:05 until 1 Nov 2026; runs are green again from 1 Nov), so main `2e3425b` has no green CI of its own and its staging deploy was skipped; main `c868cce` (#384) was likewise unrun until its re-run on 1 Nov (attempt 2; confirm its result before relying on it). Still NOT started under G-28: the other export journeys, desktop width, a part-paid receipt, stock after a sale, the stocktake form and the paid-checkout path.**

**G-28 team roles journey MERGED (29 Oct 2026, #391, `561a9c7`; no migration; test only; STAGING ACCEPTANCE PENDING): `apps/web/e2e/team.spec.ts` invites an accountant, shows the trial seat-limit refusal, signs the accountant and a helper in on separate phone-width contexts and asserts the screens each role gets, and shows removal ends the accountant's already-open session. Exact-head CI green, Codex and CodeRabbit clean. Still NOT started under G-28: the other export journeys, desktop width, the paid-checkout path (the stock journey is merged in #394).**

**G-28 catalogue-to-storefront journey MERGED (29 Oct 2026, #376, `3ac0a4f`; no migration; STAGING ACCEPTANCE PENDING): `apps/web/e2e/storefront.spec.ts` drives catalogue to shop as the owner and reads the shop as an anonymous customer at phone width (only a priced, listed product appears; a closed or never-made shop is not-found; no sideways scroll; the business id is not in the HTML), and a customer order becomes one confirmed order and one unpaid invoice with a balanced ledger (order, invoice and ledger links asserted). It also fixes a dashboard dead end: an empty catalogue now offers the Add a product form to roles that can record trade. Exact-head CI green (run 40830803825), Codex and CodeRabbit clean on the final head. Still NOT started under G-28 at that point: stock, team and export journeys, desktop width, and the paid-checkout path on the shop (team is merged in #391, stock in #394). GitHub Actions failed instantly on every job for about a day (26 to 29 Oct 2026) and then recovered; cause not shown to the engineering session.**

**N2 slice 1 MERGED (26 Oct 2026, #372, `6e10e5b`; no migration; STAGING ACCEPTANCE PENDING): period comparison engine in `@rekoda/core` (`period-compare.ts`, `resolveCustomRange`) and `GET /v1/reports/compare?from&to` (Lagos days; neither given means the month so far; an unfinished range is stopped at today and says so; percentages only where the earlier base is positive; no profit field; cash movement read from the ledger's cash accounts, recorded spending kept separate). It also fixed `summaryFor`, which feeds the chat sales and spending answers: withdrawn expenses were counted as spending, reversed, failed or pending payments as money in, and credit notes and refunds were invisible (RED tests in `packages/db/src/reports.integration.test.ts`). Independent review 0 BLOCKING / 0 IMPORTANT; Codex and CodeRabbit clean on the final head. OPEN GAP G-118: `summaryFor` still computes sales, credit notes, collected cash, refunds and spending from the operational tables, while the spec says reports read the ledger (only cash in and out are ledger-based); `summaryFor` is therefore NOT complete against the spec. Not started: trends, PDF and Excel, web charts, natural-language custom ranges. Product rankings (slice 2) wait on an OPEN OWNER DECISION recorded in the backlog N2 row: chat sale lines are free text with no product link. #367 and #368 remain with their own sessions; G-28 slices are being merged by another session (#371).**

**N3 MERGED (26 Oct 2026, #369, `f456a5e`; no migration; STAGING ACCEPTANCE PENDING once deployed): the deterministic `resend` command works on every plan, lapsed and Integrate-only included (OWN-45, OWN-60), with the view-only role guard kept. Residuals (readiness G-67): purged stored objects are not filtered before the resend job (OWN-60), a delegate's resend carries the owner STOP override, and retrieving a specific older document has no path. Independent review 0 BLOCKING / 0 IMPORTANT; Codex and CodeRabbit clean on the final head. Open interactive PRs at the time: #367 (G-109 milestone strip) and #368 (N1 slice A), owned by other sessions. Next: G-28 populated browser journeys, then N2; N1 slices B to D only after #368 merges.**

**Billing Slice A MERGED (25 Oct 2026, #364, `485b915`; migration 0182; main CI green on the PR head; STAGING ACCEPTANCE PENDING).** A merchant opens any payment from the billing history as a neutral payment record (states, applied period, print or PDF; never a tax document). **Slices B and C are MERGED (#365, `f85501a`, 25 Oct 2026; migration 0183; main CI green on the PR head e17f891; STAGING ACCEPTANCE PENDING):** four browser journeys (declined card then retry, late payment on a replaced checkout, refund, lapsed plan restarted by paying; mobile and desktop, against a Paystack stand-in) and uncertain-email-delivery handling (one retry under the same Resend idempotency key, link kept and counted, the page says the mail may or may not arrive). **Staging infrastructure recovered (25 Oct 2026, owner-reported):** the Hetzner host had lost its GitHub read credential (Deploy staging runs 118 and 119 failed at `git fetch`: no username). The owner configured a dedicated read-only SSH deploy key, switched the checkout's origin to SSH, and verified `git ls-remote` and `git fetch --prune`. Deploy staging run 120 (workflow_dispatch) then deployed `485b915` through the unmodified deploy script: health `{status ok, database up, migrations 183, release staging-485b915}`, api, web, worker and postgres healthy. The owner also cleared Docker build cache (19.79 GB to 4.13 GB; 15.66 GB recovered; free disk about 13 GB to 28 GB; utilisation 65% to 24%), keeping the current and rollback images; no further cleanup is needed. Those figures are owner-reported, not read from the host by Claude. Known minor imprecision in `scripts/staging-readonly-check.sh`: its recent-error count reads a failed `dc logs` with no matching text as `0`; read the count as unreliable if the services section shows a service down. The disk and memory preflight, release retention and sequential api-then-web builds are unchanged. #365 (`f85501a`) is merged but NOT yet deployed at the time of writing. Next: real Paystack test-mode acceptance on staging (`docs/runbooks/billing-staging-walkthrough.md`, `scripts/staging-readonly-check.sh`), which needs the owner to run the read-only check and to supply the Paystack, Resend and Meta dashboard settings.

**G-109 trial reminders (25 Oct 2026): MERGED as #362 (`e2c3675`, squash, 25 Oct 2026 21:13Z; migrations 0180 and 0181). Main CI green; Deploy staging run 117 succeeded and its "Staging answers with this commit" step passed. CODE MERGED, DEPLOYED TO STAGING, NOT PROVIDER-VERIFIED, NOT STAGING ACCEPTED: the Meta template is not approved (`docs/runbooks/meta-trial-template.md`), so nothing has been sent to a real owner. The merge was made through GitHub's web merge under the owner's account; the audit trail available to the engineering session cannot say whether a person or an automation pressed it. The pre-merge final read-only review of the delta after `cbc5ce7` did not happen before the merge; a retrospective read-only review of the merged code found 0 BLOCKING and 0 IMPORTANT (one stale comment and an undocumented dependency on the migrating role bypassing RLS, now documented). Billing Slice A (payment record page) follows.** (Note: `docs/runbooks/meta-trial-template.md`, named above, was superseded by `docs/runbooks/meta-whatsapp-templates.md` in PR A and no longer exists.)

Design of the sweep: an hourly worker sweep sends a Meta utility template at 7, 2 and 1 days of trial left (`META_TRIAL_TEMPLATE`, inert while unset; the template is not approved and nothing has been sent to a real owner). Owner ruling 25 Oct 2026: no lock across the Meta call, a final eligibility check (plan, trial end, consent) immediately before dispatch (`suppressed` when it fails), no automatic resend of an unknown outcome, the in-flight race stated honestly, transactional reminders only. Migrations 0180 and 0181 (0181 is the OD-33 discovery function `sweep_trial_candidates`, OWN-57). Next billing slices: the merchant payment record page (PR #364, neutral wording; not a VAT or tax invoice), browser journeys for expiry, reactivation, failed payment and refund, uncertain-send handling for billing-email verification, then real Paystack test-mode staging acceptance.

**G-116 MERGED (24 Oct 2026, #347, `cdee03e`; no migration): an order's processing fee resolves from ESTIMATED to ACTUAL when its invoice balance is zero, every included verified provider payment is settled and each included provider fee is non-null and greater than zero; fully refunded and merchant-recorded payments are excluded from that set (`markSettlements`, `recordMerchantPayment`). An order with no invoice link resolves instead when its linked verified provider payments together cover the order total. STAGING ACCEPTANCE PENDING. Open residuals are in the G-116 readiness row.**

**G-102 (24 Oct 2026): slice 1 (API) MERGED as #344; owner rulings OWN-50 to OWN-53 recorded in #346 (`13d4124`);
slice 2a, lost-checkout-link recovery, is MERGED as #349 (`f62e6d5`, migration 0173; test-mode only; staging acceptance pending).** Slice 2b (billing-email mailbox
verification, OWN-51; migration 0174; mock/none email sender until Cloudflare email is configured; a LIVE Paystack key refuses to start a
checkout until the mailbox is proven, a test key does not; `REKODA_EMAIL_PROVIDER`) is MERGED as #351 (`2f84410`, migration 0174; backend only; staging acceptance pending; its request limits are open owner decision OD-32). Remaining G-102
order: 2c the billing
page (and the page the emailed link opens, `/app/billing/confirm-email`), 2d billing-email erasure in the account-deletion work (OWN-52, backlog rows 19/20/N4). The slice-2a design
(per-attempt provider references, verify-before-replace, a late duplicate payment flagged for an operator refund) is
Claude's proposal and awaits the owner's confirmation. Provenance note: #347 (G-116) was opened and merged under the
owner's GitHub account during this run without this run's involvement, and commit `811baa5` has no identified author;
ask the owner whether another session is driving this repository.

**G-102 slice 2c (24 Oct 2026): the merchant billing page is CODE COMPLETE and its PR is OPEN (web, plus one additive field on the billing overview: `superseded` per charge in `packages/contracts` and `apps/api/src/billing/billing.service.ts`; no migration; staging acceptance pending).** `/app/billing` shows trial days left, the billing email card, a Pay with Paystack action and the lost-link recovery for the newest waiting charge; `/app/billing/confirm-email` spends the fragment token. Next: 2d (billing-email erasure, OWN-52). Local verification used a Paystack test double on a throwaway Postgres; the pay journey is not in CI e2e. UI verified: light theme at 1280 and 390 pixel widths, the pay, lost-link, confirm-page and email states by screenshot, first keyboard focus ("Skip to content"), and `billing.spec.ts` 9 of 9 on the first commit. NOT verified: 360, 375, 768 and 1440 widths, dark theme, screen readers, full keyboard order through the pay and recovery forms, and the recovery journey after a rejected address (no component-test setup, and no Paystack double in CI e2e). The overview now carries `superseded` per charge (additive contract field), so the page never offers a replaced charge for payment and history reads it as "Replaced by a newer choice".

**Autopilot playbook v4 installed (22 Oct 2026, #300); OWN-30 to OWN-33 recorded.**
`docs/REKODA_MVP_AUTOPILOT_PLAYBOOK.md` is now the routine's operating playbook (summary in
`CLAUDE.md` §7a). Priority order: finish the in-flight PR; operational safety before the Admin UI
(G-02 off-box encrypted backups and isolated restore proof, G-12/G-20 OTP and WhatsApp failure
alerts, G-18 outbox backoff, G-10 sweeps, CI and deploy stability); then Chat, hosted-storefront
Integrate and Complete acceptance; then the minimal Central Admin; then external gates and
production readiness. OWN-30 (VAT is a SaaS-scope decision, not a legal exemption; Rekoda's own
subscription VAT needs professional review) is in `REKODA_OWNER_DECISIONS.md`; the G-11 code
audit has NOT started. Main merges are serialized so each push run the staging deploy needs finishes
and deploys before the next merge (CI no longer cancels a `main` run once #331 is merged). Compact state at merge: `main` `e4b9b05` (#301, G-44; before it #299,
G-99 and #298, G-78). OWN-31 (G-87), OWN-32 (G-92(5), revises OD-23 D3) and OWN-33 (G-115) were
ruled on 22 Oct 2026 and are recorded in `REKODA_OWNER_DECISIONS.md`. Owner-held: off-box backup
destination, G-09 branch protection, G-05 live Paystack, G-03 Meta, tax and legal review. Next safe
step: G-87 with G-92(5) and G-115 are merged; G-02 is merged as #308 (code complete, not enabled, no off-box drill yet). G-12/G-20 are partly merged as #310 (counters on ops health; the alert G-26 merged as #318 and draft clearing as #320). G-18 (outbox backoff, migration 0168) is MERGED as #312 (`68c5169`, 22 Oct 2026): deployed to staging, staging acceptance pending. G-10 (sweep first pass at boot, wall-clock reclaim, lease heartbeat, per-claim fencing) is MERGED as #314 (`75521f4`, 22 Oct 2026): deployed to staging, staging acceptance pending. G-67 is merged (#322, `b8dbd0b`); next engineering step: `REKODA_LAUNCH_BACKLOG.md` row 6 (G-40, G-58). The alert path (G-26, #318) and G-20 draft clearing (#320) are merged and on staging. The alert path polls a process that holds `WORKER_DATABASE_URL` (`meta` is `null` without it) and alerts on dead, overdue or backlogged jobs, flagged or unprocessed Paystack and Meta webhooks, and WhatsApp delivery failures (`packages/core/src/ops-alerts.ts`); there is no OTP-failure or backup alert yet (G-12, G-02), and nothing pages anyone until the owner sets `REKODA_ALERT_WEBHOOK_URL` (G-26).

**Review policy (OWN-35, 22 Oct 2026): CodeRabbit is the primary AI PR reviewer; Codex is optional.** A Codex quota limit is `UNAVAILABLE — QUOTA`, not approval or failure, and never blocks CodeRabbit or eligible work. Playbook section "Reviewer hierarchy" has the procedure. **G-115 Option B (OWN-34):** operator-defined subscription arrangements of ANY length are never auto-prorated; origin is stored in `businesses.subscription_origin` (migration 0167).

**G-81 (owner-prioritised interstitial, OD-23 / OWN-21): MERGED 7 Oct 2026 (#262,
`88b577c`, migration 0158); staging acceptance pending.** A purchase that may be one
already waiting or booked in the last 24 hours is held and asked "same or separate";
the purchase work refuses a booked duplicate under a lock before any posting. G-81
closes Chat purchase collision handling and protects Chat against booked purchase
facts, including bookings from a PO that committed before the chat yes (a receive
still in flight was not seen until G-89). G-89 (dashboard PO receive compared with
Chat bookings, SAME links the PO to the Chat purchase, SEPARATE receives it) is
merged (#263 as `3d462c1`, migration 0159) and deployed to staging (`staging-3d462c1`), staging acceptance pending, NOT closed
and required pre-public-launch, so the system-wide invariant is not certified until G-89 closes. G-88 (purchases carry no `posting_purpose`)
recorded, not fixed. G-90 (purchase-identity copy issues) and G-92 (reference parser and held-question
residuals) recorded, not fixed. G-92(5) books one real purchase twice with no
model error under OD-23 D3 as ruled (two different same-kind documents for one
purchase), for the owner to revisit.

**Build 1 (G-48) accepted (26 Sep 2026):**

- G-48: STAGING ACCEPTED (#252, merged as `b9c9562`, deployed to staging).
- J2 real-handset acceptance: PASS.

**Build 3 (G-77) accepted (27 Sep 2026, reported by the owner):**

- G-77: STAGING ACCEPTED (#254, merged as `ce4755a`).
- Physical staging evidence (reported by the owner, recorded 8 Oct 2026, staging at
  `88b577c`): the public API was exercised on the Safe Deal test business through one
  application ("G77 Staging Test"). Two keyed paid sales of ₦10,000 each (`INV-2026-000014`,
  `INV-2026-000015`) each added exactly one invoice, payment, allocation, merchant
  verification, claim, receipt and ledger transaction, with distinct `sale-k-…` /
  `api:sale-k-…` identities (never the application id, never the raw key). A replay
  returned the original response and the same key with another body answered 400; both
  left the seven financial tables unchanged (zero new financial records). They still
  write operational state (the rate limit, an `API_REQUEST_UNITS` unit for the live
  key), so this proves financial idempotency, not the absence of every write. Details in the G-77 row of
  `REKODA_LAUNCH_READINESS.md`.
- To run it, the `developer_api_starter` add-on had to be granted directly in staging
  data: nothing in the product grants it (G-17), and API applications and keys have no
  dashboard UI (G-94).

**Build 2 (G-49) accepted (reported by the owner):**

- G-49: STAGING ACCEPTED (#253 merged as `ea7c7db`; the dashboard
  confirmation form fixed by #256, merged as `2abb8a1`, after staging found
  it resetting the amount to the balance on 28 Sep 2026).
- Physical staging evidence (reported by the owner, recorded 8 Oct 2026): a ₦120,000
  transfer against a ₦100,000 invoice, in WhatsApp (previewed ₦100,000 applied and ₦20,000
  customer credit) and on the dashboard (a confirmation step first); after the yes, one ₦120,000 payment, a
  ₦100,000 allocation, ₦20,000 customer credit, a ₦120,000 receipt and ₦0 owing. On the
  dashboard the first submit created no financial records (row counts checked), the invoice ended `paid`,
  and the posting was DR 1020 Bank ₦120,000, CR 1100 Accounts Receivable ₦100,000, CR 2300
  Customer credits ₦20,000. A WhatsApp confirmation made stale by a balance change was
  refused and created no new financial records. Details in the G-49 row of
  `REKODA_LAUNCH_READINESS.md`.

**Status board (8 Oct 2026). Acceptance and engineering are separate lanes; each build
keeps its own status, and none is accepted because a related one passed.**

| Build                               | PR (merge)       | Status                                                      |
| ----------------------------------- | ---------------- | ----------------------------------------------------------- |
| G-48 receipt for a paid sale        | #252 (`b9c9562`) | STAGING ACCEPTED                                            |
| G-49 merchant overpayment           | #253, #256       | STAGING ACCEPTED                                            |
| G-77 public API sale identity       | #254 (`ce4755a`) | STAGING ACCEPTED                                            |
| G-61 purchase funding account       | #255 (`6df1b91`) | MERGED, staging acceptance pending                          |
| G-23 draft expiry                   | #258 (`f5fb1ce`) | MERGED, staging acceptance pending                          |
| Build 6 conversational continuation | #260 (`3612fcf`) | MERGED, staging acceptance pending                          |
| G-68 / G-24 routing, STOP/START     | #259 (`f5ef123`) | MERGED, staging acceptance pending                          |
| G-65 Chat entitlement on commands   | #261 (`29dc934`) | MERGED, staging acceptance pending                          |
| G-81 Chat purchase identity         | #262 (`88b577c`) | MERGED, staging acceptance pending                          |
| G-89 dashboard PO receive vs Chat   | #263 (`3d462c1`) | MERGED, DEPLOYED TO STAGING, acceptance pending             |
| G-80 natural Nigerian opt-outs      | #265 (`f2a155a`) | MERGED, DEPLOYED TO STAGING, acceptance pending             |
| G-85 marks on short answers         | #266 (`e539439`) | MERGED, staging acceptance pending                          |
| Build 9 command-bus enforcement     | #267 (`8b59d26`) | MERGED, staging acceptance pending                          |
| G-95 reverse released bank lines    | #268 (`c499d15`) | MERGED, DEPLOYED TO STAGING, acceptance pending             |
| G-97 forgotten statement day        | #269 (`072db70`) | MERGED, DEPLOYED TO STAGING, acceptance pending             |
| G-57 view-only AI authorisation     | #270 (`9752971`) | MERGED, staging acceptance pending                          |
| G-60 privacy-gateway identity       | #271 (`c5b2c8a`) | MERGED, DEPLOYED TO STAGING, acceptance pending             |
| G-07 AI launch evaluation harness   | #273 (`044eb40`) | MERGED; live real-model eval and staging acceptance pending |
| G-59 model-family pricing           | #274 (`5087f95`) | MERGED, staging acceptance pending                          |

**Staging acceptance queue (the owner, in this order; none accepted, and CI is not acceptance):** G-61, G-23, Build 6, G-68 / G-24,
G-65, G-81, G-89, G-80, G-85, Build 9, G-95, G-97, G-57, G-60, G-07 with G-30 (merged 20 Oct 2026 as `044eb40`; G-07's acceptance is the
owner-run live AI evaluation, now unblocked by G-59), G-59 (merged as `5087f95`). G-89, G-80 and G-85 may be tested first while they are fresh; that waives
nothing earlier.

**Acceptance is BATCHED (owner, 19 Oct 2026).** Physical staging acceptance is no longer run after each
hardening PR. Every PR still needs review and CI, and staging deployment continues normally, but
acceptance stays PENDING until the remaining hardening train is merged and deployed; then one coordinated
staging and end-to-end campaign covers the whole queue above, including the paid live AI evaluation
(G-07). CI or a deployment is never "STAGING ACCEPTED". Items already STAGING ACCEPTED keep that status
and are not retested.

**Launch-closeout engineering order (owner, 19 Oct 2026; supersedes the 8 Oct order below for
everything after G-60; changed only by a verified new financial, privacy or authorization blocker):**

1. **G-07**, AI launch evaluation harness (MERGED 20 Oct 2026, #273 as `044eb40`; HARNESS CODE COMPLETE; LIVE REAL-MODEL EVALUATION PENDING; STAGING ACCEPTANCE PENDING). Builds and
   proves the harness; the paid live evaluation is NOT run in the PR (owner-run, in the batched
   acceptance campaign, after G-59).
2. **G-59**, model-family pricing correctness (`modelFamily()` matches by substring). MERGED 20 Oct 2026 (#274, `5087f95`); staging acceptance pending.
   2a. **Subscription / trial / billing lifecycle hardening** (audit 20 Oct 2026 recorded as G-102 to G-110 and OD-25 to OD-27 in `REKODA_LAUNCH_READINESS.md`; G-103, a paying merchant's books deletable by retention, first) (owner, 20 Oct 2026, via the MVP autopilot routine): a full audit and certification of trial, plans, upgrades, downgrades, renewal, grace, packs and billing UI (G-62, G-69 and the renewal "payment did not go through" copy among the known items). The owner ruled the MVP free trial is **14 days**, superseding 30 (OWN-27; contradiction 14 in `REKODA_LAUNCH_READINESS.md` §15); the constant, copy and a retired-claim guard merged in PR #278 (`4074afe`, 21 Oct 2026). Trials begun before it keep their stored date, so the lapse reply names no length.
3. **G-96**, storefront concurrent-submit metering / in-flight order race.
4. **G-98**, a bank line from a closed accounting period must refuse cleanly (answers 500 today).
5. **G-92(5)**, one real purchase can still be booked twice in the documented reference edge.
6. **G-87**, a purchase re-read as an expense can bypass purchase identity protection (PR #306 open, not merged).
7. **G-99**, command-bus member-role context / enforcement architecture.
8. **G-53**, MERGED (#291, `187e7ca`; `out_of_stock`). The two-customer last-unit race now has an integration test (PR `test/g53-last-unit-race`: one `placed`, one `out_of_stock`, stock 0, one order, one order unit and one document unit; it fails with a 500 when the catch is removed). Staging acceptance is still pending.
9. The documented Paystack order-fee pricing mismatch.

**Immediate engineering order (owner, 8 Oct 2026; supersedes the earlier assumption that
Build 9 follows G-65 directly; the long-term roadmap is otherwise unchanged):**

1. **G-80, natural Nigerian opt-outs (MERGED, #265 as `f2a155a`; staging acceptance pending).** G-24 made STOP/START exact and
   deterministic, but natural opt-outs (`abeg stop`, `stop abeg`, `abeg stop am`,
   `no send me again`, `stop o`) went to the model, so protecting a merchant's consent
   depended on a model call. PR #265 made them a typed STOP from a closed list.
2. **G-85 (MERGED, #266 as `e539439`; staging acceptance pending)**, combining or overlay marks on short deterministic answers: the same safety
   boundary as G-80.
3. **Build 9 (MERGED, #267 as `8b59d26`; staging deployment to be confirmed by `/health`; staging acceptance pending)**, command-bus production enforcement: all fourteen flags default on,
   `0` the per-command rollback (PlaceOrder's `0` refuses orders instead), any other value
   invalid (OD-4, approved as OWN-22). Angelo ran the pre-merge staging check on 8 Oct 2026: no
   `REKODA_COMMAND_*` value in `.env`, in what Compose resolves, or in the running api or
   worker (SAFE). Its reviews recorded two pre-existing gaps: G-95 (releasing a classified bank line leaves
   its journal posted, so classifying it again posts a second journal; owner decision
   OD-24) and G-96 (two simultaneous submits of one storefront form meter two units for
   one order; a mid-flight price change answers 500).
4. **G-95 (MERGED, #268 as `c499d15`; DEPLOYED TO STAGING as `staging-c499d15`, `/health` ok;
   STAGING ACCEPTANCE PENDING)**, releasing a classified bank line reverses the journal Rekoda
   wrote for it (OD-24 approved as OWN-23, Option A; no migration). Found while fixing it:
   G-97 (below) and G-98 (classifying a line from a closed month answers 500; OPEN).
5. **G-97 (MERGED, #269 as `072db70`; DEPLOYED TO STAGING as `staging-072db70`, `/health` ok;
   STAGING ACCEPTANCE PENDING)**, forgetting a statement day reverses the classifications
   made on its lines in the same transaction, ordinary matched postings untouched (OWN-24,
   10 Oct 2026; no migration). Moved ahead of G-57 by the owner: it books one bank movement
   twice. G-96 and G-98 stay OPEN and separate.
6. **G-57 (MERGED, #270 as `9752971`; STAGING ACCEPTANCE PENDING)**, a view-only member's clear record or ambiguous text is
   refused or asked for a question before `AI_ACTIONS` and the model, and a view-only photo before
   any download or vision (OWN-25; no migration). Found while fixing it: G-99 (the command bus
   carries no member role; chat role enforcement lives in the handler; OPEN).
7. **G-60 (MERGED, #271 as `c5b2c8a`, 15 Oct 2026; deployed to staging; STAGING ACCEPTANCE PENDING)**, privacy-gateway identity correctness: one token per customer with a deterministic
   reply display composed from every facet typed (name first), tokens opaque to the known-name pass, a typed
   `IdentityConflict` from `addIdentityFacet`, and the storefront handling only that conflict (no migration).
8. **G-07** (the AI launch harness, then the owner's live eval) **and G-59** (model-family
   pricing matched by substring). The Nigerian evaluation corpus belongs with G-07; it has no
   gap ID of its own. Superseded for ordering by the 19 Oct launch-closeout order above.

**Build 4 (G-61): CODE COMPLETE and MERGED (#255 as `6df1b91`, 28 Sep
2026); deployed to staging (every staging release since #255 contains it); staging
acceptance pending (run by the owner), not yet accepted.** Was branch
`fix/g61-purchase-payment-method` off `main` at `ce4755a`. The paid part
of a stock purchase now leaves the account the merchant named (cash or transfer), the preview says which, and money paid
from an account nobody named is asked about, never defaulted; the ledger
builder and the repository refuse a paid amount with no method.
Purchase-order receive requires the method when anything is paid. No
migration. After merge: a transfer, a cash, a credit and a part-paid
purchase in chat, and a paid PO receive, on staging.

**Build 5 (G-23): MERGED as `f5fb1ce` (#258); staging acceptance pending. As
recorded while in review (1 Oct 2026):** branch `fix/g23-draft-expiry` off `main` at `2abb8a1`. A
preview is confirmable only inside its confirmation window:
`command_drafts.expires_at` (migration 0153) from `CONFIRMATION_TTL_SECONDS`
(300 seconds, the HIGH_RISK window), a claim that carries `expires_at > now`
itself, and a new `expired` state (separate from G-61's `abandoned`). A
"yes" to an expired preview records and meters nothing and says it expired.
After merge, on staging: a sale confirmed inside five minutes records
normally; a fresh sale answered "yes" after more than five minutes gets the
expiry sentence and zero financial rows. (G-23 has since MERGED as
`f5fb1ce`, #258.)

**Build 7 (G-68 Phases 1 and 2 and G-24): MERGED 2 Oct 2026 as `f5ef123` (#259);
staging acceptance pending. As recorded while in review (1 Oct 2026):** PR #259, branch
`fix/g68-g24-nigerian-chat-routing`, rebased onto `main` at `3612fcf`. Owner decision OWN-18: standard English, Nigerian
English, Nigerian Pidgin and code-switching are first-class merchant
registers. `na so` confirms like `yes` (a leading `na` is no longer stripped
as a filler), high-confidence Pidgin whole-message commands are free and
deterministic, a bare "no" with nothing waiting gets an honest reply instead
of silence, and STOP/START are read by one exact matcher on the raw message
for the merchant router, the customer thread and tapped replies, so a
padded keyword changes nobody's consent. REBASED onto Build 6 (`3612fcf`)
and Phase 2 added through its typed continuation state: Pidgin period
answers resume "Which period?", an uncountable window keeps it open, a
numbered list is consumed by a correct "2" (no production question shows a
numbered list yet, so this path is reachable only from tests), and the G-61 funding question
takes a short "bank" or "cash" (migration 0155, `expects = funding_source`;
0156 marks an undone rebuild and allows one continuation per message per
member; 0157 records which member drafted a preview and what a rebuild was built from)
with a FRESH preview, never executing the retired draft. After merge, on
staging: `na so` to a fresh preview records it; `no` with nothing waiting is
answered; J17 including the padded `start`; a POS purchase answered "bank"
shows a new preview and records only after yes.

Review rounds since added: a questioned yes ("na so?") confirms nothing;
the funding rebuild is one-shot (a resend closes the question too) and is
taken only within 1800 seconds of the first ask (OD-19); the two-ask
erasure breaks on ANY message between the asks (stricter than base for free
English commands); the STOP decoration cap is OD-20; more positive emoji do not confirm
(OD-21, owner ruling OWN-19); a question-shaped STOP opts out (OD-22, owner
ruling OWN-20).

**MERGED (1 Oct 2026, Build 6, conversational continuation state; #260 as
`3612fcf`; staging acceptance pending):** was branch
`feat/conversation-continuation-state` off `main` at `f5fb1ce` (G-23, #258).
"How much did I sell?" with no period is answered "Which period?", and a
short "last month" resumes it from SQL with no model call; "what about this
week" continues the read just answered. State is `conversation_continuations`
(migration 0154): typed, scoped to the business AND the member who was asked,
newest wins, one-shot clarifications claimed atomically, expiring after
`CONTINUATION_TTL_SECONDS` (600, an implementation value for the owner to
confirm, OD-14). It only ever resumes a read and never claims or revives a
command draft (G-23, G-61 unchanged). Numbered-option state is representable; number
routing, Pidgin answers and "send it as PDF" belong to later builds.
Answering the G-61 funding-source question ("bank", "cash") was NOT
representable in Build 6; Build 7 (#259) makes it so with migration 0155.
Build 6's note was: Build 7 must widen the `expects` CHECK in a new migration
and answer it through a separate write path that shows a FRESH purchase
preview, never by executing the retired draft. Resumed reads are free (no
`AI_ACTIONS` unit); as built in Build 6 they were not plan- or
entitlement-gated, which Build 8 (G-65) changed: they now follow `records`,
refused to a live plan without Chat and kept on a lapsed one. Each re-opens
the 600-second window. Retired rows persist (opaque
tokens and enums only) until the business is deleted. A Query's draft is no
longer what a "yes", "no" or correction is about (erasure, expiry and
supersession still count it), but a "yes" never reaches past a read: after a
question asked since the newest live preview, each "yes" retires the newest
such question's draft and points back at the preview ("There is still a
preview waiting from before the last question..."), and the yes after the
last question confirms it: exactly as many yeses as base took (one per
question, then one). The pointer fires only for a delivered financial
preview, and any other waiting draft gets base's answer.
A resumed read records a read-only Query draft, the footprint base left, so
it shields a preview and breaks an erasure pair like any question. A
single-yes confirmation past a read is an option the owner MAY choose later,
not implemented; whose reads interpose, and whose preview a member may
confirm, is OD-15. For Build 7: a correct answer to a numbered-choice list
currently retires the list as `superseded`, not `consumed`, because
`resumedRead` returns null for a choice; Build 7 must consume it when it
wires numbered choices. Also for Build 7: a reply to "Which period?" that
names a window core cannot count ("last week", "yesterday", "in March")
retires the question and goes to the model today; consider keeping the
question open with `periodNotCountable` instead. After
merge, on staging: ask "how much did I sell?", answer "last month", check the
figure; a delegate's "last month" must not answer the owner's question.

**Build 8 (G-65): MERGED 2 Oct 2026 as `29dc934` (#261); staging acceptance
pending. As recorded while in review (1 Oct 2026):** branch `fix/g65-deterministic-chat-entitlement`
on `main` at `f5ef123` (Build 7, #259; first cut off `3612fcf`). Router-served commands no longer skip
the plan: `packages/core/src/chat-access.ts` classifies every deterministic
intent, and the handler checks it after routing and before the command
runs, in the model path's order (lapsed plan, then `REKODA_CHAT`). STOP,
START, erasure, the dashboard link, help and upgrade work on every plan;
`who owes me`, `records`, `stock`, `payment details` and `remind` need Chat
on a live plan and stay open on a lapsed one; `resend` is refused on both;
a "yes" to a Chat draft is refused without Chat (the draft stays pending),
"no" and "cancel" never are, and a yes between two erasure asks still keeps
the data. This supersedes Build 6's "resumed reads are not plan- or
entitlement-gated": a resumed read now follows `records`. The matrix is in
`REKODA_CURRENT_STATE.md` §5.7. A refused "yes" opens "I did not save
that."; a lapsed paid plan is told its plan ended, never a free trial, on every
Chat surface (`usageRepo.lapseOf`); on a plan without Chat, help,
greetings, START, a stray number, an empty yes and a failed dashboard link
name only what works. OD-17 (open): whether a live Integrate
plan may use the three free reads by message, and with them a resumed read;
implemented as refused.
OD-18 (open): the lapse exception, where a lapsed plan keeps five fixed reads
its free-form equivalent is refused and `capabilities.ts` disagrees;
implemented as kept. G-82 to G-84 record the voice, timing and model-path
copy edges found in review (G-81 is the duplicate-purchase lane's). Rebased
onto Build 7 (#259, `f5ef123`) on 2 Oct 2026: its questioned yes (`unsure`) is
conversation control, and its funding answer, re-asked question and
closed-question replies meet the same draft boundary as a yes. After merge,
on staging: on an Integrate
plan `who owes me` and `resend` get the Chat-plan reply and nothing is sent;
on a lapsed trial `resend` gets the trial-ended reply while `who owes me`
still answers; STOP and erasure work on both.

**G-77 (#254), for the record:** every public API sale is its own financial
event (its `sourceId` is an opaque per-request id, never the application
id), and the retry fingerprint is unchanged across releases.

**G-49 (#253), for the record:** off `b9c9562`
(G-48, #252, CLOSED as above). Owner ruling OWN-16: a
merchant may deliberately confirm a genuine overpayment; the full amount is
real money, the invoice settles up to its balance, the excess is a
customer-credit liability, and a confirmation made stale by a balance change
is never turned into credit. Migration 0152 adds
`command_drafts.confirmation_context`.

**Last completed work (10–11 Sep 2026):** the repository reset. Removed
`AGENTS.md`, `GEMINI.md`, `docs/AUTONOMOUS-ENGINEERING.md`, `docs/agents/`,
`scripts/agents/`, the seven `agent-*.yml` workflows and the agent-task
issue form; archived `architecture.md`, `MASTER-PLAN.md`,
`engineering-plan.md`, `SYSTEM-PLAN.md`, `FIX-PLAN-2.md` under
`docs/archive/`; rewrote `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`,
`CODEOWNERS` and the PR template; rebuilt `REKODA_REFERENCE_MANIFEST.md`;
created `REKODA_CURRENT_STATE.md` (evidence-based inventory plus the build
plan reconciliation) and `REKODA_LAUNCH_READINESS.md` (verdict, gates,
70 gaps, 20 journeys, staging plan). Verified locally: install, typecheck,
lint, unit tests (1,274), build, guard scripts, migrations on an empty
database, db integration 1,258/1,260 and api integration 1,036/1,040 (the
six failures are Windows/timezone/`pg_dump`-on-PATH environment
differences; the two db ones pass with `pg_dump` on PATH and UTC; CI on
`main` is green).

**Last completed work (11 Sep 2026, G-06, merged as `8f07a6d`; CODE COMPLETE, NOT LIVE PROVIDER VERIFIED until G-05):** provider refunds, reversals
and chargebacks now reach the books. Events are dispatched by kind in the
payment-event handler; `verifyRefund` and `verifyDispute` join the provider
port (Paystack `GET /refund/:id`, `GET /dispute/:id`; the other adapters
answer `found: false`); `payment-adjustment-commands.ts` reuses
`recordRefund`, `recordPaymentReversal` and `recordChargeback`, unwinds
allocations through §14.2 full-reversal rows and re-derives the invoice
projection; migration 0150 lets a pre-settlement refund credit the
connection's clearing account; migration 0151 gives `payment_allocations`
an `insertion_seq` identity so "newest allocation first" is decided by the
database, not by a tied `created_at` and a random uuid (the first CI run
of #238 failed the two-invoice case on exactly that); the independent
review of 11 Sep then found, and this branch fixed, a dispute-opened
exception swallowed when the obligation already carried any exception
(`hasOpenException`: once per reason while open), a `refund.processed`
whose provider read lagged retired unflagged (now the attempt fails and
retries; a failed read is an exception) and a chargeback row written
before its posting account was resolved (account first); the reversal
trigger and the post-settlement refund credit side are recorded as
OD-10 for the G-05 drill; the third review found that a refund
fitting inside an overpaid payment's allocations reopened the invoice
while the customer credit stood (now every adjustment of an overpaid
payment is refused whole, `*_overpaid_payment`, under OD-8) and that a
refund read still pending on the last attempt died as a job (now an
exception, `refund_read_never_processed`); a Sonnet reviewer in the
model fan-out found `recordPaymentReversal` writing its row before
resolving the clearing account (now account first, as refunds and
chargebacks do), and an Opus reviewer found that a partial dispute
and the refund Paystack raises for it could post twice against one
payment (now a refund on a payment carrying a chargeback, and the
reverse, are refused to a human under OD-11); billing-domain refund
events are flagged and never booked. 58 api integration cases, 5 db
cases, plus contract and adapter unit tests. Open decisions OD-8
(overpayment-credit refunds), OD-9 (dispute lifecycle mapping and the
newest-first unwind order), OD-10 (reversal trigger, post-settlement
refund credit side, payout netting), OD-11 (one movement of money, two
provider facts) and OD-12 (gross processed volume) recorded in
`REKODA_LAUNCH_READINESS.md` §6. G-06 is CODE COMPLETE and NOT LIVE
PROVIDER VERIFIED until the G-05 drill.

**Last completed work (13 Sep 2026, G-75, on `fix/edge-private-ranges`):**
the owner ruled OD-13: `REKODA_EDGE_PROXIES=private_ranges` must not be
accepted for a real deployment (`REKODA_OWNER_DECISIONS.md` OWN-15). The
edge check now refuses it by name, and any range holding the edge
network's gateway (172.30.10.1, the address Docker hands Caddy every IPv6
visitor and hairpin connection from), which the compose file pins with the
network IPv4 only. The smoke's G-71 visitors are named by a container at a
fixed address on the edge network that plays Cloudflare, and the host's
own `CF-Connecting-IP` is shown to name nobody. Carried in from the final
G-74 review: the job runs `dist/edge-check.js`, an entry with no
entry-point test, so it cannot skip itself and exit 0; the guard refuses
any field on the job no rule reads (`scale: 0`, `deploy.replicas: 0`,
`provider`) and any YAML tag compose acts on (`!reset`, `!override`),
pins the edge network and keeps Caddy on it alone; a real
IPv6 aggregate test; `caddy adapt` failures print Caddy's own error.

**Previous work (13 Sep 2026, G-74, merged as `3cab9dd`; CODE COMPLETE):**
`REKODA_EDGE_PROXIES` is the one client-address trust list no Rekoda
process reads: Caddy takes it from the environment, so the G-72 boot
rules never saw it, and a universal value there would let Caddy believe
any browser's forwarding headers. A one-shot `edge-check` job in the app
image now reads the same value compose gives Caddy and refuses a
universal list by the same rule (`apps/api/src/edge-proxies.ts`, sharing
`client-address.ts`'s parser); Caddy waits for it
(`service_completed_successfully`), so a bad value fails the deployment
instead of serving. Cloudflare's ranges, `private_ranges` and the empty
no-edge-proxy mode still pass. `check-deploy.mjs` pins the wiring and the
smoke drives it in the production image.
Found in review: G-75 (`private_ranges` unsafe on this topology),
ruled by the owner and closed by the work above.

**Previous work (13 Sep 2026, G-72, merged as `1bbe1f1`; CODE COMPLETE):**
a production process now refuses to start on configuration that would
point it at non-production infrastructure or make client-address trust
meaningless, naming the variable; development and test keep their fakes.
Refused in production: a `PAYSTACK_BASE_URL` or `MONO_BASE_URL` other
than blank or the provider's own host; `REKODA_LOCAL_STORAGE`; an
`AI_BASE_URL` or operator OIDC URL that is not a public https host
(`apps/api/src/endpoints.ts`, judged after the URL parser normalises
alternate spellings of an address, and including the reserved `.invalid`,
`.test` and `.example` names); a `REKODA_TRUSTED_WEB` or
`REKODA_TRUSTED_PROXIES` entry that trusts effectively the whole
internet, an IPv6 range holding the IPv4-mapped block included. Refused everywhere: a malformed `R2_ACCOUNT_ID` (it becomes the
storage host) and a separator-only proxy list (the G-43 case). The proxy
list is now parsed in `config.ts` (`trustedProxies`) and strictly.
Proved by `config.production.test.ts` and a Docker smoke step where the
production images refuse seven such values while the compose values boot.
Found in review and recorded: G-74, closed by the work above.

**Previous work (13 Sep 2026, G-71, merged as `48ba9d5`; CODE COMPLETE):**
every visitor now has their own per-IP bucket on both roads to the API.
Caddy, still the only trust boundary, writes the address it decided to web
as `X-Rekoda-Client-IP` (replacing any browser copy) and removes that header
on the API host; web hands the one value on, in the same header, from all
five places it calls the API (`apps/web/src/server/client-address.ts`;
`visitor-forwarding.test.ts` runs all five against a stubbed `fetch` and
fails if one stops carrying the visitor, and a source scan catches a new
caller that never calls the helper); the API believes it only when the
TCP peer is web's fixed address `172.30.10.11` (`REKODA_TRUSTED_WEB`,
required in production) and otherwise keys on Fastify's proxy-derived address
as before (`apps/api/src/client-address.ts`). Keys are per IPv4 address and
per IPv6 /64. Proved by an API integration suite (seven cases, six of which
fail with the old key), and by `deploy-smoke.sh` driving two visitors and an
IPv6 /64 through the real Caddy, web's export route and the API (Caddy
trusting the runner as it would Cloudflare). Found in review and recorded,
not solved: G-73 (a page of many product photos spends its visitor's
minute) and a separator-only `REKODA_TRUSTED_PROXIES` booting (fixed by G-72). G-43's OTP half is met on both
roads; its replica half remains.

**Previous work (12 Sep 2026, G-01, merged as `c508709`; CODE COMPLETE, NOT YET ON A HOST):**
the production runtime. `Dockerfile` builds one app image (api, worker
and the migrate job) and one web image (public values baked in, refuses to
build without the legal facts), both non-root on the Node in `.nvmrc`;
`docker-compose.prod.yml` runs postgres (internal network, no port), a
one-off migrate job (the only holder of the owner password besides
postgres), api, worker (same image, `REKODA_WORKER=1`), web and Caddy;
`deploy/Caddyfile` serves the site and API over HTTPS and replaces
`X-Forwarded-For` with the address it resolved; `/health` now reports
`release` and `commit`; `packages/db/src/provision.ts` sets the runtime
roles' passwords as SCRAM verifiers from `.env`; the entrypoint guard
now compares real paths (`migrate.js` started through a pnpm symlink had
exited 0 applying nothing; the migrate job now calls the real path too). CI's new "Deployment
(Docker)" job boots and attacks the stack with `scripts/deploy-smoke.sh`;
`scripts/check-deploy.mjs` and rules 3 to 6 of `check-env-example.mjs`
(with fixtures) hold the files' shape and their agreement with the code.
`docs/runbooks/deploy.md` is rewritten to the shipped files. New gaps:
G-71 (web's server-side calls share one per-IP bucket, P1) and G-72
(production does not refuse `PAYSTACK_BASE_URL`, `MONO_BASE_URL`,
`REKODA_LOCAL_STORAGE`, P2).

**Next actions:**

1. Done: the staging host is live and deploys automatically after CI on
   `main` (since #249; `/health` reported `staging-3d462c1` on 8 Oct 2026).
   OD-4 is ruled (OWN-22, 8 Oct 2026; Build 9 implements it). Still with Angelo: delete the leftover GitHub
   environments `agents*` and the `builder:*`, `risk:*`, `status:*`,
   `agent-task` labels (gap G-45); turn on branch protection (G-09; `main`
   was still unprotected on 8 Oct 2026).
2. Rule on OD-1 to OD-7 in `REKODA_LAUNCH_READINESS.md` §6 (R0A-i on an
   empty database, VAT, which unwired modules ship, command-bus flags,
   renewal copy, erasure scope, backup design).
3. Also open, outside the immediate order in item 4 (owner to place): G-02
   (backups per OD-7; the nightly scripts are in PR #308, code complete and NOT enabled, WAL/PITR still open), G-73
   (owner decision on the photo budget). G-06 is code complete and NOT live-verified until the G-05 drill
   confirms the real Paystack envelopes.
4. Strict serial mode, one issue at a time from fresh `main`, in the
   "Immediate engineering order" above: G-80 next, then G-85, then Build 9,
   G-57, G-60, and G-07 with G-59. #263 (G-89) merged as `3d462c1` on
   8 Oct 2026 and recorded G-93; #262 (G-81) merged as `88b577c` on
   7 Oct 2026; it records G-88, G-90 and G-92 as open and closed G-91. G-86
   (replies that say "send it again") goes into the smallest appropriate PR;
   G-87 (a purchase re-read as an expense) STAYS OPEN as #262's follow-up,
   as that PR has decided.

**Known P0 blockers:** G-01 production host (code complete; staging is live, production is not) · G-02 backups · G-03
Meta number, app review, templates · G-04 legal facts · G-05 Paystack §47
and live drill · G-07 AI eval never run · G-08 production environment
(`REKODA_LAUNCH_READINESS.md` §4). G-06 code complete on 11 Sep 2026, not live-verified until G-05.

**Document reading order:** `CLAUDE.md` → this section →
`REKODA_LAUNCH_READINESS.md` §1–§3 → `REKODA_CURRENT_STATE.md` §3 →
`REKODA_CANONICAL_SPEC.md` §2–§3, §5–§6 → `REKODA_USER_JOURNEYS.md`
Part 4 → the ADRs and current-state rows for the area in hand.
`REKODA_REFERENCE_MANIFEST.md` classifies every document.

## Operational facts that still hold

- Three database roles, three connection strings: owner runs migrations
  (`DATABASE_URL` at migrate time), `rekoda_app` serves requests, and
  `rekoda_worker` is the only credential that reads across tenants, to
  claim a job. Never run the db and api integration suites at the same
  time; they share one PostgreSQL and each truncates the other's fixtures.
- The api integration suite runs against the packages' built `dist`;
  `pnpm turbo build` first.
- postgres-js cannot bind a JS `Date` or an array into raw SQL; cast
  explicitly. `tx.execute` returns `timestamptz` as a string. A backslash
  inside a `sql` template never reaches Postgres; use POSIX classes.
- Secrets are not interchangeable: `REKODA_API_SECRET` signs setup grants,
  `VAULT_KEY` seals, `MATCH_KEY` derives match keys, `CONNECTION_KEY`
  wraps provider credentials, `OTP_PEPPER` peppers codes; production
  operator access is OIDC, never a shared secret.
- A page or a reply may only state numbers about the business, never about
  its own page: counts come from SQL over the whole table.
- gitleaks scans the full history and reads a high-entropy literal in a
  test as a credential; compose test secrets from one another.
- On this Windows checkout the four guard scripts need a literal root
  (gap G-27) and Playwright's `webServer` commands use POSIX env syntax;
  run both in CI or WSL.
- Pushing from this machine: plain `git push` can hang on a dead
  credential; use the `gh` credential helper.

## Working agreements with Angelo (standing)

- Security and scalability are default requirements. Money rules are
  absolute: integer kobo, deterministic computation, AI proposes and code
  disposes, no figure in a reply that the deterministic layer did not
  compute.
- No Azure; hosting is Hetzner + Cloudflare + R2 (ADR 0006). No hardware
  purchases. Voice transcription is hosted OpenAI and vision is hosted
  Anthropic (ADR 0032).
- Plans before substantial builds; honest pushback with reasoning is
  welcome, then do what he decides. Show UI as screenshots (light and
  dark, mobile included). No zip deliveries; everything lands as
  reviewable conventional commits.
- Do not expand launch scope. Multicurrency stays dark (ADR 0033). NestJS
  12 (#225–#227) waits as one post-launch migration.

## Standing review triggers

Kept from earlier sessions, still live: the 1 Oct 2026 Meta service-message
repricing (re-run the COGS tables and the `messaging.ts` card); the first
50 paying merchants (replace pricing assumptions with `usage_events`);
the first abandoned trial reaching 90 days (needs `META_RETENTION_TEMPLATE`);
5,000 published shops (sitemap index); the first merchant past 10,000
invoices, receipts or expense entries (`EXPORT_ROWS` caps at ten thousand
with no truncation notice); `reconciliationsFor` must never be capped
without an open COUNT beside it; a persistently high `assetsDue` means the
depreciation sweep runs too rarely.

---

# Historical session log

Everything below is the project's history as it was written at the time,
through PR #231 (6 September 2026). Status claims here are superseded by
`REKODA_CURRENT_STATE.md`; open-item lists are superseded by
`REKODA_LAUNCH_READINESS.md`.

## 1. What this project is (30 seconds)

Rekoda is a WhatsApp-first financial operating assistant for Nigerian small
businesses. Merchants talk to it (text/voice) or connect their WhatsApp
catalogue + Paystack; Rekoda turns activity into invoices, receipts, a
double-entry ledger, and **reconciliation** — matching what should have
happened against what actually happened when money moved. Full story:
[archive/architecture.md](archive/architecture.md) (the original spec) and
[archive/engineering-plan.md](archive/engineering-plan.md) (review, stack, milestones); both superseded, see `REKODA_REFERENCE_MANIFEST.md`.

Rekoda supersedes **VoiceReceipt AI**, a working single-vendor WhatsApp
receipt bot built first (118-test Node/SQLite codebase). Rekoda is a
re-architecture, not a rewrite: the money engine, PDF engine, channel
layer, webhook handling, conversation gates, compliance layer and legal
pages port from it. The VoiceReceipt code was delivered to Angelo as
`voicereceipt-ai-v5.1.zip` — keep that file; it is the porting reference
for M2/M3 (PDF templates, Meta/Twilio channel code, conversation gates).

## 2. Where everything lives

| Thing                 | Location                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions and why     | [adr/](adr/) — 33 ADRs at the reset (0001–0034, 0030 unused); see `REKODA_REFERENCE_MANIFEST.md` §4 for status. This row is historical                                                                                    |
| Product & system spec | [archive/architecture.md](archive/architecture.md) (superseded by `REKODA_CANONICAL_SPEC.md` on 25 Aug 2026)                                                                                                              |
| Commercial model      | [pricing-model.md](pricing-model.md) — incl. standing review triggers                                                                                                                                                     |
| Milestones M0–M5      | [archive/engineering-plan.md](archive/engineering-plan.md) §11 (superseded by the build plan)                                                                                                                             |
| SEO/content plan      | [content-plan.md](content-plan.md)                                                                                                                                                                                        |
| Ops procedures        | [runbooks/](runbooks/)                                                                                                                                                                                                    |
| Code                  | `packages/core` (money/ledger/costing/statements — most-tested), `packages/contracts` (AI border schemas), `packages/db` (schema + RLS, migrations through 0154 on main, 0157 on #259), `packages/shared` (branded types) |

## 3. Status at handoff

**M0 complete, 45 tests green — independently re-verified 19 Aug 2026** from
the delivered bundle: `pnpm test` 45 passed (39 core + 6 contracts),
`pnpm typecheck` and `pnpm lint` clean, `pnpm demo:m0` balances
(₦160,000 = ₦160,000, MATCHED, exit ✔). The bundle has been merged with the
repository's README commit; history is now on `main` plus this branch.

**Plan revised to v3 (19 Aug 2026).** Four new ADRs and one supersession:

| ADR                           | Effect                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0011** (supersedes 0002)    | Meta charges service messages from 1 Oct 2026. ₦9,900 Chat margin is **39–60%**, not 75%+. Allowance redefined as messages **processed** (inbound + outbound).                                                                                                                                                                                      |
| **0008**                      | STT baseline becomes `intronhealth/afrispeech-whisper-medium-all` — stock `large-v3` is 30–45% WER on African-accented English. Gate metric is entity accuracy, not WER. No training flywheel without NDPA consent.                                                                                                                                 |
| **0009** (superseded by 0012) | Paystack DVAs make bank transfers verifiable per _customer_. Mechanism kept; position wrong — CAC-only, so it serves a minority.                                                                                                                                                                                                                    |
| **0012**                      | **Integrate no longer requires CAC.** Meta verification needed CAC _too_, so both halves excluded most vendors. Two ladders: capture via Rekoda storefront `/s/<handle>` or order-forwarding (no Meta); verification via open banking on the merchant's existing account (BVN + consent, no CAC). Registered-only rungs become upgrades, not gates. |
| **0010**                      | Continuous WAL archiving (PITR), RPO minutes not 24 hours, with a scripted restore drill that sweeps the ledger-balance invariant.                                                                                                                                                                                                                  |

**VoiceReceipt source supplied and verified** — `voicereceipt-ai-v5.1.zip`
delivered; **118 tests pass, 0 failed**; ~10,500 LOC / 15 service modules. The
Part 4.3 port map is now against verified-working code.

**M0 follow-ups (MASTER-PLAN Part 4.4) are all closed.** The boundary ban and
the pooled-connection leakage test are enforced in CI, jobs run pinned inside
`withBusiness` under their own row-level-security policy (ADR 0022 replaced
pg-boss with a queue in our own schema), the composite indexes landed with the
reporting layer, and the overpayment clamp is fixed: an overpayment is now a
CG1 question the merchant answers, never a figure the books round away.

**`docs/safety-review.md` is the one-page risk view** — GREEN (safe to build
now), AMBER (needs written confirmation from Paystack / counsel / Mono /
Flutterwave first), RED (never build, never claim). Its §4 lists the five that
matter most; its §5 carries the diarised review triggers.

**Design/UX method now lives in `docs/design-plan.md`** — the `ui-ux-pro-max`
and 21st.dev pipelines, ten non-negotiable UI rules, per-surface UX intent, and
the review gate. Note the verified caveat: in remote sessions only the skill's
`SKILL.md` is synced, so the design-system generation must run in a local
session with the full skill payload and be committed.

**M1 identity is complete.** The design system, marketing surface and the
four-step onboarding flow shipped in PR #9; the follow-on replaced the dev-only
in-memory store with real persistence.

- **`apps/api`** — NestJS on Fastify. Auth module (OTP request/verify, business
  creation, sessions, role guard), health endpoint reporting the applied
  migration count rather than just a live socket.
- **`packages/db/src/repos/identity.ts`** — the only place identity SQL lives.
  Rules stay in `@rekoda/core` (no database, no clock); this holds locking and
  transaction boundaries and no rules of its own.
- **ADR 0020** records the three decisions worth not rediscovering: the setup
  grant (a session is bound to a business, so onboarding needs its own
  artefact), `app.user_id` as a second narrow pin for the bootstrap read, and
  the fact that the OTP attempt limit did not survive concurrency until the
  decision moved inside an advisory lock.
- **`apps/web` can no longer assert identity** — no pool, no signing secret, no
  tenant pin.

**M2 is feature complete.** What a merchant can now do, end to end, against a
real database in CI:

- **Chat.** Inbound WhatsApp message → privacy gateway (PII tokenised before
  the model) → routed model call → conversation gates CG1-CG5 → transaction
  engine. Sales, expenses, purchases and merchant-reported payments each become
  a confirmed, balanced, numbered, audited record with a PDF that is rendered
  and delivered. Free deterministic commands answer from rows and cost nothing:
  `who owes me`, `payment details`, `records`, `resend`, `help`, `upgrade`,
  STOP/START, and a two-ask erasure.
- **Payments.** Paystack connection onboarding, intent minting, webhook
  verification server-side, attribution across tenants on the worker
  credential, booking, receipt, settlement tracking, and an exception queue a
  human can resolve. VERIFIED and RECORDED stay distinguishable everywhere they
  surface (ADR 0014) — chat, register, receipt PDF and activity feed.
- **Dashboard.** Overview, the four statements, and registers for invoices,
  receipts, spending and payments, with the sign-out and empty states each
  page needs. `/app/expenses` is the money-out half of the books: operating
  expenses, stock purchases and the accounts payable balance are three
  separate figures on purpose, because one combined "spent" number overstates
  the cost of trading by the value of the inventory still on the shelf.
  All four statements download as one dated A4 PDF from the reports page
  (`GET /v1/reports/statements.pdf?period=YYYY-MM`), which is the artefact a
  bank, a landlord or a grant officer asks for and a screen is not, and as an
  Excel workbook (`statements.xlsx`) with one sheet per statement and every
  figure a real number. The xlsx writer is ours, in `@rekoda/core`: a few
  hundred lines against a large dependency that would also be a parser, and a
  parser is attack surface for something that only ever writes. Zip entries
  are stored rather than deflated, so it pulls in no node built-in and stays
  importable anywhere core is.
- **Commercial.** Exhaustible monthly allowances consumed atomically, a
  free trial (14 days since OWN-27; 30 before) that actually expires, an operator plan endpoint, and cost
  telemetry per provider call including the ones that time out.
- **Operations.** A stranger messaging the number gets answered once,
  `GET /v1/ops/health` reports queue depth and webhook intake as numbers with
  no tenant named, and the job runner, attribution pump, settlement sweep and
  stranger sweep all ride the worker credential on their own clocks.
- **Stock.** On-hand is `SUM(delta)` over an append-only movement ledger and
  is never stored. A merchant counts stock in chat ("add 20 bags of rice",
  previewed and confirmed like every write), asks "stock" for what is left
  free of any model call, and a confirmed sale takes its lines off the shelf
  in the same transaction as the invoice. The dashboard has the same register.
  A recorded PURCHASE restocks the shelf too, in the same transaction as the
  money, but only when the merchant named a countable thing and a number for
  it: `RecordPurchase` carries a nullable `productMention` and `quantity`, and
  a purchase described only in prose ("restocked the shop") or a purchase of
  a service moves nothing. The prompt is explicit that a quantity must never
  be inferred from an amount, because 50k of ankara is not 50 crates and a
  guess there becomes a stock count the merchant never took.
- **M3, complete.** Voice notes transcribe through the same gates as text,
  the books answer questions from SQL with the model computing nothing, an
  owner can invite an accountant who is kept out of settings by the guard
  rather than by row-level security, and the four statements download as a
  dated A4 PDF or an Excel workbook. A profit and loss carries the prior
  month beside it, as every accounting package does.
- **The model.** There is no OpenAI default any more, so GPT-4.1 leaving the
  API on 14 Oct 2026 costs this deployment nothing: `AI_MODEL_DEFAULT` is
  `claude-haiku-4-5` (ADR 0023). At ₦1,450/$ that is ≈₦4 a call, about 10% of
  the ₦9,900 Chat subscription for a heavy merchant, where the previous
  Sonnet default was ≈₦12 and 30%. See `docs/ai-model-strategy.md`.
- **Margin.** `GET /v1/ops/margin?period=YYYY-MM` reads what `usage_events`
  has been collecting since metering shipped: plan revenue against provider
  cost, per business and per provider, for one Lagos billing month. Same
  operator secret, same worker credential, business ids and never names.
  Revenue is the plan price only, because add-on packs are priced in
  `docs/pricing-model.md` and recorded in no table yet.

**M4 is built (PRs #68 to #71).** ADR 0024 records the commercial terms
Angelo decided; `@rekoda/core/billing` implements the arithmetic, migration
0020 stores the cycle and every charge Rekoda makes, `/v1/billing` and
`/app/billing` are the merchant's surface, and the grace sweep runs the seven
days after a card fails: reminders on days 1 and 5, then read-only with the
books intact. The plan never moves on a merchant's say-so alone, only when a
provider confirms, and §47 refuses a paid change BEFORE opening a charge so
lifting the gate leaves nothing to reconcile.

**The retention schedule is published AND enforced (PRs #72, #73).**
`/privacy#retention` states maximums; `apps/api/src/privacy/retention-sweep.ts`
keeps them. Anyone who ever completed a subscription charge is excluded from
both stages. The deletion is a `SECURITY DEFINER` function the worker may
execute and nothing else: the capability is "delete a business the schedule
says is due", not "delete a business". `/refunds` publishes the matrix.

**Receipt OCR is built behind a port (PR #74).** Photo, self-hosted OCR, PII
tokenisation, then the model, with NO raw-image fallback: a failed extraction
answers the merchant and reaches no model at all, and a test asserts that
rather than a comment claiming it.

**The billing loop closes (PRs #75, #76).** `sweepRenewals` raises the charge
when a cycle ends and starts the grace clock AT the renewal date, so a sweep
that runs late neither shortens the month nor lengthens the grace. It
deliberately takes no money: card-on-file needs an authorization from a
previous payment and §47 means there has been none, so the merchant is billed
and the grace period they already have takes over. A subscription payment now
has a path at all - `billing.process`, split from `payment.process` IN THE
PUMP so our revenue can never meet their ledger. A partial payment does not
unlock a plan; an overpayment does, and the excess is a human's decision.

**Two customer records for one person, and the rule Angelo chose (PR #77).**
The gateway resolves each identity independently, so a message naming
somebody by phone AND email minted two customers. Merging automatically was
refused as a design: "Ada 0803..., send it to accounts@bigco.com" is the same
shape to a regular expression, and a wrong merge puts one customer's address
on another's invoice. The merchant is ASKED, inside the sale preview they are
already reading, and one `yes` covers both. It only fires on a real split -
exactly two customers, at least one created by that message, on a sale - and
the proposal is stored only when the question actually reached them, so a CG1
arithmetic question cannot lead to a link nobody was asked about.

**The operator can refund and can see who asked to pay (PR #78).**
`GET /v1/ops/business/:id` and `POST /v1/ops/refund`. The refund RECORDS and
does not move money, `reason` is one of ADR 0024's five published rows rather
than free text, and the plan is deliberately untouched: the matrix refunds
money in several situations that all leave the merchant with the period they
paid for.

**An invoice can be withdrawn (PR #79).** Not deleted: the invoice stays
marked `voided`, the books get the mirror of its posting, and the reason and
actor go in the audit trail. Every account nets to zero and BOTH transactions
remain, because a sale and its reversal is a different story from a sale that
never happened. Refuses any invoice money has arrived against - that wants a
refund and a credit, which is a different instrument.

**A spend entry can be withdrawn too (PR #83).** Same instrument as the
invoice void: the entry stays, gets marked, and the books carry the mirror of
its posting. The reversal is built from the ENTRIES that were written rather
than rebuilt from the row, because a purchase's posting depends on how much
was paid at the time and the row has never stored that - rebuilding would have
left whatever went to ACCOUNTS_PAYABLE standing. Stock is deliberately not
reversed and the outcome says so, because what is on the shelf is a physical
fact and only the merchant knows it.

**Both void paths had the same race, and neither was tested for it (PR #83).**
The reversal was written BEFORE the row was claimed, so two operators voiding
at once wrote two reversals and one got told `already_void` - an unexplained
entry in an append-only ledger, which is the exact thing a void exists to
prevent. The status read settles nothing: both transactions read `issued`
before either writes. Only the UPDATE decides, so the posting now comes after
it. Two concurrency tests, each verified by restoring the old order.

**The audit trail is finally readable (PR #85).** `audit_events` had been
written since M1 by five repos and read by NOTHING - the compliance record
Rekoda keeps for a merchant had never been shown to one. `/app/audit` is the
QuickBooks Audit Log equivalent and the surface an accountant asks for by
name. It is not the overview's activity strip: that answers "what happened to
my money" and this answers "who changed something, and why".

Sentences are built by `describeAuditEvent` in @rekoda/core, one case per
stored shape, with the unknown case falling back to naming the entity rather
than printing what it held. That fallback is the rule to keep: whatever a
future writer puts in `new_value` is what a merchant reads here, so a shape
this file has not seen must be DULL on the page, never loud. Every current
writer was inventoried before it was built and none stores a customer name or
a CUSTOMER\_ token.

**Chat finally links somewhere (PR #86).** Until this shipped, nothing Rekoda
ever said linked anywhere at all - `REKODA_WEB_URL` appeared twice in the
whole codebase and neither was a reply. A merchant who wanted their statements
had to leave the thread, recall an address, type their number and wait for a
code that arrived back in the thread they had just left. Now "dashboard",
"my books" or "sign in" gets a one-tap link, and `/enter` exchanges it for a
session.

This is what the magic-link code was always for: the schema comment has said
"the raw token exists only in the WhatsApp message" since M1. It is NOT a
second sign-in method, and the distinction matters if anyone extends it. The
thread is already the credential - it is where the OTP is delivered and what a
CG2 confirmation moves money on - so a link into it is no weaker than the code
it saves. What keeps it narrow is that it is issued for one MEMBER, resolved
from the sending phone, so it can never carry more access than the sender
already had. A stranger gets nothing.

Delegate invites were never the use for it: those have worked by phone and OTP
since `POST /v1/auth/members` shipped, with `/app/team` in front.

**An invoice can be credited (PR #87).** The void refused any invoice with a
payment on it and told the merchant a credit note was the right instrument;
there was no such instrument, so that refusal was a dead end. Now the two
cover every invoice between them and overlap on none: the void takes unpaid
ones and mirrors the whole posting, the credit note takes the rest and reduces
without touching the cash that already moved.

The receivable is allowed to go NEGATIVE, and that is the design rather than a
bug to guard. A customer credited past what they still owe is in credit, and a
negative receivable is how a ledger says so - inventing a refunds-payable
account would have put customer credits in with what the shop owes suppliers.
VAT comes back proportionally, and the final credit on an invoice takes the
whole remaining VAT so repeated partial credits cannot strand a kobo.

`credited_k + amount <= total_k` lives inside the UPDATE. Two credits racing
would otherwise both read the same `credited_k`, both conclude there was room,
and between them take back more than the invoice was ever worth.

**Two things the browser found that the tests did not.** The register showed
nothing when an invoice had been partly credited, so a credit note existed and
the row a merchant looks at was unchanged; there is a Credited column now, in
the page and in the CSV. And all three corrections were writing
`source_type: 'system'` on their audit rows, which rendered as "Automatic"
beside a change a person had deliberately made from the dashboard. Both void
paths carried that from the start. All three now say `dashboard`.

**What is owed to suppliers is aged now (PR #88).** The receivable side has
been bucketed since the debtors page shipped and this side was one number,
which left a merchant deciding who to pay this week with no help from the half
that costs them money.

It ages differently on purpose, and the difference is not cosmetic. An invoice
carries a due date the merchant agreed, so the receivable ages by how LATE a
debt is. A purchase carries no terms - Rekoda never asks, because it stores
nothing about suppliers at all - so this ages by how long the debt has STOOD.
Calling both "overdue" would invent a deadline nobody set, and the page says
which it is.

The amount owed comes from the LEDGER, not the row: `expenses` stores what a
purchase cost and never what was paid on it, so the remainder exists only as
the ACCOUNTS_PAYABLE credit its posting wrote. That link is `ledger_transaction_id`,
added by migration 0024 for the withdraw path and reused here. Withdrawn
entries drop out by their status, which is why their reversals need no special
handling.

**A note on how the last six were found.** By grepping for exported functions
with no production caller. Every hit was a missing surface rather than dead
code: `dueForRenewal`, `applySettledCharge`, `businessForCharge`,
`refundCharge`, `upgradeRequestsFor` and `recordVoidedDocument`. The script is
worth re-running after any large slice; a function written and never called is
usually a feature somebody designed and then could not reach.

**What that sweep still shows, triaged and NOT yet built.** None of these is
a bug today; each is a surface that does not exist. Listed so the next session
inherits the triage instead of repeating it:

- **No chat-history surface** (`threadFor`, `messagesFor`, `draftsFor`), and
  Angelo decided against building one. Neither QuickBooks nor HelloBooks has a
  transcript, because neither has a chat input; what they have is an Audit Log,
  and that is what PR #85 built instead (`/app/audit`). A transcript would
  also need the vault opened on a second path besides `ReplySender`, since
  `conversation_messages.body` is stored tokenised. If it is ever revisited,
  that is the cost to weigh.
- **Ops visibility gaps**: `jobsForBusiness`, `callsToday`, `usageTotals`.
  The exception queue is now workable (PR #84) - `GET /v1/ops/exceptions` and
  `POST /v1/ops/exceptions/:id/resolve` - and it is the ONE place on that
  surface that returns rows. Angelo took that decision deliberately. Read the
  method comment before adding a second: everything else there is numbers so
  that a cross-tenant console never quietly becomes a feature, and this earns
  its exception only because an unattributed event belongs to no tenant, so if
  no operator can see it then nobody can. There is no UI: the ops surface is
  gated on a verified operator identity rather than a session (ADR 0034,
  scopes `ops:read` and `ops:payment`), so it has no place under `/app`, and
  `/v1/ops/margin` has been curl-only since it shipped. A small operator
  console is the natural follow-on and a deliberate one.
- **These read-backs are not dead code.** Every function in the two entries
  above is called by the integration suites as a read-back, which is a real
  and intended role - `expensesFor` was one until `spendFor` gave the
  dashboard its own query and left it where it was. The no-caller sweep means
  "no PRODUCTION caller"; check the tests before deleting anything it names.
- **`addIdentityFacet` remains uncalled**, and deliberately. PR #77 joins two
  customer records by UPDATE-ing the facet's `customer_id` rather than
  inserting a new facet, so the vault is never opened by a merge. The
  function is the right tool for a future "add this customer's email"
  flow and the wrong one for linking.
- **`settlementCipherFor`** reads back the encrypted settlement account and
  nothing needs to yet. It stays write-only until something does.

### Since PR #87: the doors, and the books becoming books

**Money out got its remaining halves (PRs #88, #89).** Accounts payable is
aged in the same buckets receivables are, because "what do I owe" with no age
on it is a number a supplier's phone call cannot be answered from. And a cost
that arrives every month whether or not anybody mentions it is a schedule now:
`recurring_entries` plus a daily sweep that CLAIMS a row before raising it, so
two sweeps racing cannot raise a month's rent twice. Entries are dated the day
they fell due, not the day the sweep caught up: a quarter of rent stamped on
one day would put three months of cost into one month's profit.

**A price list a merchant can manage (PR #90).** Prices, descriptions, photos
and a listed/hidden flag, all edited from `/app/catalogue`. Absent and null are
different throughout: a form that submits only what it changed must not wipe
what it did not, which is what `CatalogueEdit` exists to express.

**Door 2, orders somebody else wrote (PRs #91, #92).** A merchant forwards the
message a customer sent them; Rekoda parses it into names and quantities with
NO money in it, because the person who wrote it does not set the prices, and
prices it from the merchant's own catalogue. `RecordOrder` carrying no amount
is the whole design. The catalogue is re-read at the yes rather than carried on
the draft, so a price changed in between cannot issue at yesterday's figure.
The order then becomes an invoice and a payment link a customer can open.

**Door 1, the first page with no session behind it (PR #93).** `rekoda.app/s/<handle>`
is a merchant's own shop, open to anybody. The design turns on one problem: a
public page has to resolve a slug to a tenant, and `businesses` is under
row-level security keyed on the pinned tenant. A policy letting anyone read a
published business would expose the WHOLE row — plan, TIN, RC number, owner id,
the date a card last failed. So the public face of a business is its own table
holding only what the merchant published, readable by anyone and writable only
under a pin. No cart and no checkout: every item is a wa.me link with the order
already typed, which hands Door 1 to Door 2.

**What a shared link looks like (PR #94).** Icons and Open Graph cards. Two
bugs came out of asking for the images rather than trusting the build: the shop
card 500'd for every shop that had a product (Satori refuses a div with two
children, and `{count} items · order on WhatsApp` is two), and every shop page
declared the HOMEPAGE as its canonical while asking to be indexed. `apps/web`
got its first unit test and it renders to bytes, because nothing else catches a
layout the type system accepts and the renderer refuses.

**Both halves of the profit and loss now show their working (PRs #95, #97).**
`expenses.category` was free text nothing read and `invoices.sale_source` was
written and never read. Both are fixed sets now, folded deterministically —
the model's word is a hint, never the decision, because a category is what a
whole P&L groups by and a prompt revision would otherwise regroup a year of
history. Both schedules are built from LEDGER movement rather than from the
registers, which is the part to keep: a provider fee has no expense row, a
credit note is its own posting, and a void is a mirror that must come off the
month it is written in. Reading the ledger and joining outward for a label
makes each schedule tie to its statement line by construction.

That needed a column `invoices` never had. `expenses` and `credit_notes` have
carried `ledger_transaction_id` since they existed; invoices did not, so
`reverses_id` sat in the schema unwritten and nothing could get from a credit
on SALES_REVENUE back to the invoice behind it. Migration 0031 closes both.

**Open shops are in the sitemap, and the form says so (PR #96).** Slugs and
dates only: every merchant's name and number is public on their own page, and
gathering all of them into one downloadable file would be a directory rather
than a sitemap. The publish control now says an open shop is findable by search
engines and listed on rekoda.app, because "open to customers" should not
quietly mean more than a merchant read.

**The books can be opened (PR #98).** `OWNERS_EQUITY` had been in the chart
since ADR 0004 with nothing ever posted to it, so every business came into
existence holding nothing and a merchant who spent from money they already had
read a NEGATIVE cash balance. One posting, once, enforced by a partial unique
index rather than by a check the caller is trusted to make. Deliberately no box
for what customers owe: an opening receivable has no invoice behind it, so the
debtors page and the ledger would answer the same question differently.

**A sale costs something (PRs #99, #100).** `COGS` sat at code 5000 with
nothing ever posted to it, so inventory only grew and gross profit equalled
revenue. Weighted average per product, moved by deliveries, with the null
load-bearing: a product nobody has priced posts no cost and the statements say
how much revenue that was. Two postings per sale, because a sale is exact and
a cost is an estimate — which also means a void has to mirror both, a bug
caught by re-reading the diff rather than by a test. The statement gained the
shape an accountant reads: revenue, cost of sales, gross profit, running costs,
net. A merchant can state a cost by hand for stock they counted or already had.

**The chart of accounts started being touched by reporting.** At PR #100 ADR
0004's ten accounts were still unchanged, but four of them carried something
they never had: `OWNERS_EQUITY`, `COGS`, and the two schedules that break
`EXPENSES` and `SALES_REVENUE` out by category and channel WITHOUT adding
accounts. That remains the pattern to reach for first: a supporting schedule
tied to a ledger line, not a wider chart. It has since been widened twice, and
both times the reason was written down before the diff (ADR 0025, ADR 0026).

### Since PR #100: the books become auditable, and reconcile against a bank

**A shelf can be counted, and a month can be closed (PRs #101, #102).**
Inventory drifted from the ledger the moment reality did, so a stock take
posts the difference rather than overwriting a number. Then `closed_through`
plus a trigger on BOTH `ledger_transactions` and `ledger_entries`: a filed
month cannot silently change, and the refusal comes from the database rather
than from a check a caller is trusted to make. It is invoker-rights on
purpose, and the file says why. Reopening is the owner's to do, with an audit
event, because pretending otherwise just teaches merchants never to close.

**A correction a merchant can write by hand (PR #103).** Every other posting
is derived; this is the one an accountant asks for and did not find. Two
accounts and one amount, never a free line list, so there is no arrangement of
inputs that fails to balance. What it cannot express is a genuine multi-line
journal, which is a real limit and a deliberate one — and it is exactly the
limit that later made equipment disposal impossible to fake (see #114).

**The merchant's own bank, apart from settlements (PR #104, ADR 0025).**
`cashOrBank()` sent every transfer to `BANK_PAYSTACK`, so a customer paying
into a merchant's GTB account landed in an account labelled "Bank (Paystack)"
— wrong for every merchant who could currently exist, since Paystack is gated
on §47. Worse, one account holding both produced a balance matching no
statement anybody holds, so reconciliation would have been incoherent before
it was built.

That PR also found something worth remembering: **FORCE RLS applies to the
table owner**, so a data migration relabelling tenant rows updates ZERO rows
in production while passing in dev and CI, both of which run as superuser.
`applyMigrations` now refuses to run as a role without superuser or BYPASSRLS,
which is why a production migration role is on Angelo's list.

**Every statement was dropping the last days of the month (PR #105).** March
lost three days, May and July one each, and it reached all four statements
including the cumulative balance sheet. The period window added a month to a
Lagos-shifted timestamp instead of adding it to the DATE and shifting after.
Found by driving July, not by a test.

**Bank reconciliation, in five slices (PRs #106 to #109, #112).** A statement
is read from CSV or Excel with the date order inferred across the WHOLE file
and `mixed_date_order` refused outright; lines are stored append-only, keyed
by a fingerprint so re-uploading the same file changes nothing. The matching
rule is deliberately timid: exact amounts, four days either side, and a
pairing only when the line has one candidate AND that posting has one line
wanting it. A wrong match reports agreement between books and bank that does
not exist, which is the single failure the whole surface exists to catch.

What the rule refuses, a merchant decides: they may lift the date window and
the ambiguity, never the amount, because two figures a bank charge apart are
two facts. Releasing is a DELETE, so an automatic match is safe to offer at
all. `bank_line_matches` holds two unique indexes, one each way, so a
reconciliation cannot explain the same money twice.

#112 is the test that proves the SEAM: import a statement, record the payment
from the dashboard, watch it become a pairable bank movement, pair it, read a
difference of zero. Its mirror matters as much — a CASH payment must never
reach the bank reconciliation.

**Both directions of payment, from the dashboard (PRs #110, #111).** Paying a
supplier did not exist at all, and the payable ageing joined only the
purchase's OWN ledger transaction: settling a debt by journal dropped the
register to zero while the ageing reported it standing, ageing past ninety
days, forever. Two figures in one accounting product disagreeing. The ageing
now nets attributed payments and returns whatever no purchase accounts for as
`unlinkedK`, derived by subtraction, so buckets plus unlinked equal the balance
by construction rather than by diligence.

Recording money RECEIVED had existed since M1 and was reachable only from
WhatsApp: a merchant on the Bank page looking at an unexplained transfer had
to leave the dashboard to record it. It is RECORDED, never VERIFIED (ADR
0014), and the receipt register shows it as "Payment recorded".

**Equipment is not a month's expense (PRs #113, #114, ADR 0026).** A ₦450,000
generator reached `EXPENSES`, so the month of purchase reported a loss the
business did not make and every month after reported a profit it did not.
Three accounts: `EQUIPMENT`, `ACCUMULATED_DEPRECIATION` (a contra-asset
needing no special handling, because `naturalBalance` already nets debits
against credits for assets) and `DEPRECIATION`. Straight line, monthly, no
salvage; the last month absorbs the rounding so an asset depreciates to
EXACTLY its cost.

The monthly sweep shipped in the same PR deliberately: without it the feature
would be a NEW misstatement in place of the old one, holding a generator at
full price forever under a page promising a monthly charge that nothing made.

#114 exists because #113's copy told merchants to record a sale as a journal
entry, and that is impossible: `postJournal` is two accounts, a disposal needs
four lines, and there was no gain-or-loss account. ADR 0026 is amended with
the original claim STRUCK rather than rewritten. The result is measured against
BOOK VALUE, not the price paid, so depreciation already charged is never
counted twice.

**The chart is fifteen accounts now**, and the guard test in
`apps/api/src/reports/accounts.test.ts` pins the number on purpose: it is what
makes the next addition a decision somebody writes down rather than a diff.

**What is still missing before merchants.** Almost none of it is code:

1. **Three Meta-approved templates.** Authentication for sign-in codes
   (`META_OTP_TEMPLATE`), and two Utility templates: the grace reminder
   (`META_BILLING_TEMPLATE`) and the retention warning
   (`META_RETENTION_TEMPLATE`). Each has two body parameters and each fails
   in the safe direction while unset. The retention one has teeth: no
   template means no warnings means no deletions, so the published schedule
   is not actually being kept until it is approved.
2. **Two sidecars to deploy.** `STT_URL` for AfriSpeech transcription (ADR 0008) and `OCR_URL` for receipt text (ADR 0024). Both are promises the
   privacy pages make out loud, both refuse honestly while unset, and NEITHER
   may be pointed at a hosted provider without changing the page first.
3. **Credentials.** Meta WABA, Paystack test keys, the three secrets
   (`REKODA_API_SECRET`, `VAULT_KEY`, `MATCH_KEY`), and an operator identity
   provider (`OPERATOR_OIDC_ISSUER`, `_AUDIENCE`, `_JWKS_URL`) — production
   refuses to boot without one, and refuses `REKODA_OPERATOR_SECRET` with it.
   Paystack stays in test mode until written confirmation (spec §47).
   `CONNECTION_KEY` is deliberately NOT `VAULT_KEY`: account numbers are
   stored as cipher plus last4 and never echoed anywhere.
4. **A production migration role with superuser or BYPASSRLS.** New at PR
   #104 and easy to miss because nothing fails loudly: FORCE RLS applies to
   the table owner, so a data migration touching tenant rows silently updates
   ZERO of them under an ordinary role. Dev and CI both run as superuser, so
   neither can demonstrate it. `applyMigrations` now refuses to start without
   one, which turns a silent no-op into a startup error.
5. **Company facts for the legal pages.** Registered entity, address and
   support address. `/terms`, `/refunds` and `/privacy` render a visible "not
   set yet" badge wherever one is missing, so nothing can go live naming the
   wrong body, but they mean little until the facts are real.
6. **The voice benchmark** (ADR 0024, C11). 30 to 50 real Nigerian voice
   notes spanning male and female voices, Lagos and non-Lagos accents, noisy
   shops, code-switching and spoken amounts. The metric is whether the
   financial instruction came out right, not word accuracy.
7. **M5 Integrate** — the WhatsApp catalogue webhook (Door 3) is what remains,
   and it waits on Meta approval rather than on us. The note that used to sit
   here said the priority was ingesting external orders rather than building a
   native catalogue; PRs #90 to #93 built the catalogue and the shop anyway,
   and that was right: Doors 1 and 2 need no approval from anybody and they
   feed the bookkeeping rather than replacing it. Every price on the shop is
   the merchant's own, every order still becomes an invoice through the same
   engine, and Rekoda still holds no money.

### Since PR #114: one bug, found eight times

PRs #115 to #122 are almost entirely one defect wearing different clothes: a
page or a reply that describes ITS OWN PAGE and presents that as the business.
Worth reading as a group, because the shape recurs and the next one will look
new.

**Where it was only a wrong number.** The stock reply handed a merchant twenty
products as though that were the shop, and counted the empty shelves it could
see rather than the ones they have (#116). The dashboard's stock footer told a
205-product merchant they had 200. The bank page said "412 lines" above a table
of 100 (#120). The asset register, the catalogue footer, the orders list, the
billing history and the payments list all did some version of it (#119, #121,
#122).

**Where it stopped somebody working.** Order pricing scanned a 300-row page and
answered "I cannot find it in what you sell" about a product the shop stocks
and has priced (#117). Bank entries and asset disposals could not be reached at
all from the only screens that offer them (#118, #119). The catalogue's pickers
stopped at product 300, and the twelve unpriced products a merchant needed to
fix were the twelve they could not reach (#121).

**The worst one was a zero.** `unpriced` on the catalogue is what the contract
calls the number that stops a shop selling. Counted off the page it came back
as ZERO for a shop with twelve listed products nobody could buy, so the page
rendered no warning at all. Not a count that was low: a warning that was
absent.

Three shapes of fix, and which one applies is a real decision each time:

1. **Ask for what you need.** Order pricing looks products up by the names in
   the order (`catalogueByNames`); the bank page asks for movements matching
   the amounts on its own lines; `matchByHand` asks for the one id it was
   handed. The cap stops mattering rather than getting bigger.
2. **Sort so the cap drops history, not work.** The asset register puts what
   is still owned ahead of what was sold; the statement page puts lines still
   needing a decision ahead of settled ones. Only works where order is free —
   the catalogue is name-ordered ON PURPOSE, because a list that reorders
   itself when a sale lands is a list where the row you were about to change
   moves.
3. **Carry enough, and say what is missing.** Counts come from SQL over the
   whole table, never from `rows.length`, and the page says what it left out.
   All nine registers now do this; six already did.

Both limits first recorded here as open tasks are now fixed. The public shop
pages at sixty products per page (#55): sellable is filtered AND paged in SQL,
each page is self-canonical, a page past the end is a 404 and a mangled page
parameter opens page one. And `reconcile` reads the whole statement (#56):
`allBankLinesFor` walks the table in bounded chunks by id keyset, the matching
rule still runs once over the complete list (batching the RULE would let a
pairing depend on chunk placement), and the chunk size is a documented test
seam so a test can prove the walk crosses a boundary.

**A fixture that drifted by 13% of dates (#120).** Two depreciation tests went
red with no code change. `buyMonthsAgo` built its date as `monthsAgo * 30.5
days`, so on 23 August "one month ago" landed on 24 July, and an asset bought
on the 24th has not completed a month by the 23rd. `monthsElapsed` was right
and the fixture was lying. Swept across two years at three times of day it
disagreed on 1,764 of 13,140 combinations. Anything that means "a month ago"
in a test steps calendar months now.

**And one test that read as coverage and was not.** The sweep named "every
reply" ran over twelve of the sixty-two builders in `replies.ts`. It covers all
sixty-two now, with a guard that fails when somebody adds one and forgets. The
same trap caught the catalogue's api-level count test, which cannot detect the
bug it was written for (twelve products under a thousand-row cap cannot
diverge); rather than inflate the fixture it is named for what it proves and
points at the repo test that does the real work.

### The full-system audit and its five remediation PRs (23 Aug 2026)

After the cap-class campaign closed, a three-lane adversarial audit
(scalability, safety, correctness) produced roughly thirty verified findings.
Five PRs closed all of them, in severity order:

- **#124 role matrix** — RolesGuard existed on six routes; it now guards
  every write on every controller AND the chat surface. Owners do
  everything; delegates record trade; accountants read and export, plus bank
  reconciliation (annotates, moves nothing). The web turns 403s into
  sentences via ApiForbidden.
- **#125 name tokenisation** — the gateway's known-name pass replaces every
  stored customer name before a model sees it; a first mention becomes an
  encrypted facet with a token in the same transaction, and no raw name is
  persisted anywhere along the way (drafts, previews, the inbound row).
- **#126 scale and lost work** — hash-indexed matcher; (business_id, id) on
  bank lines; webhooks allow-listed past the per-IP limiter (Meta delivers
  everyone's traffic from a handful of IPs); the Meta webhook answers non-200
  on storage failure; record+enqueue in one transaction; the pump's stranded
  lane; paySupplier FOR UPDATE.
- **#127 idempotency** — clientRef on merchant payments; one pending charge
  per upgrade/pack target; folded-name unique index behind
  findOrCreateProduct; delivery lock on weighted average; stocktake advisory
  lock; closeBooks compare-and-set; Lagos years in the last three UTC
  numbering sites; the renewal backdate floor; released grace claims.
- **#128 sweeps and hardening** — every sweep drains until a short page with
  a progress guard; runExclusively elects one replica per sweep; documentById
  for deliveries; SQL-bounded exception queue; v2 AAD-bound vault blobs;
  hash-compared operator secret; strict UUID guards; a 16 MB media ceiling.

Lessons that cost time, so they are written down:

- **A batched IN over an RLS table returns nothing.** The sign-in
  membership loop is one pinned read per membership BY DESIGN; "optimising"
  it broke every invited-member test within minutes. RLS makes the pin per
  business the price of the policy.
- **The api integration suite runs against packages' BUILT dist.** After
  editing packages/db or core, rebuild before running the api suite, or the
  failures point at code that no longer exists.
- **drizzle's sql template does not bind JS arrays as postgres arrays** in
  raw execute: `= ANY(${ids})` sends a scalar. Use `IN (${sql.join(...)})`
  like openMovements does.
- **REKODA_TRUSTED_PROXIES must be set in any deployment behind a proxy**,
  or the per-IP limiter trusts any X-Forwarded-For. Unset means trust-all,
  which is only acceptable in development.

The standing process from here was docs/archive/SYSTEM-PLAN.md: plan first, a failing
test per fix, the whole estate green serially before any push, one PR in
flight at a time.

### From #124 to #231: the plan finished, the schema proven, the closeout (24 Aug - 5 Sep 2026)

The longest era compresses well because its record lives elsewhere: the
build plan's amendment log carries every PR (entries 1.13 through 1.139),
and `docs/audits/` holds the 1 September audits verbatim. What a new
session must know:

- **The 132-PR build plan completed.** Every planned slice from PR-021
  (command bus) through PR-132 landed and is marked MERGED in the plan's
  own tables, including the accounting kernel and both golden-fixture
  gates, the payment hub, WABA connection and W3 commerce, reconciliation
  tiers, billing, the developer API, and production hardening. The only
  never-built rows are PR-006 to PR-009 and PR-115, blocked by design on
  the owner-approved R0A-i production provenance report.
- **The R1/R2 audits were executed, not just filed** (GitHub #196 through
  #222, migrations 0130-0145): `external_events` got its three-policy
  tenant model; every status column got its CHECK from evidence, never
  from comments; indexes were added on EXPLAIN plans, not by count; and
  ruling 1 closed at **34 audited tenant-composite foreign keys plus 14
  more the audit missed** (group F, found by re-measuring), each proven by
  cross-tenant refusal tests and a standing closure query that fails the
  suite if a weak edge ever returns. The RLS predicate suite
  (`rls-invariants.integration.test.ts`) now asserts the canonical tenant
  predicate character-for-character from `pg_policy`. Raw bank narration
  is dropped (0127) and never persisted in any derivative.
- **The ordering family** (0146, 0148, 0149): `now()` is transaction-start
  time, so rows written by one job shared an instant and read back in
  arbitrary order. Conversation transcripts, checkout breakdowns and -
  the one that mattered - the draft a merchant's "yes" executes now order
  by `clock_timestamp()` defaults, deterministic tiebreakers, and for
  `command_drafts` a `GENERATED ALWAYS` identity `insertion_seq` that no
  caller can choose (#230). Ruling 5's two redundant single-column FKs
  are dropped (0147).
- **Launch closeout** (#230, #231): after an independent launch review,
  two code gaps closed - the confirmation ordinal above, and numeric
  config that fails closed at boot: all thirteen `Number(env[...])` reads
  now refuse garbage, blanks, hex/exponent forms and wrong signs with a
  one-line error naming the variable, while zero stays a VALUE for the
  brakes (a kill switch, never unlimited). Each PR carried an adversarial
  review round whose findings were fixed in-branch before merge - among
  them a deploy-time reordering hazard in the ordinal backfill and a shop
  flood-brake whose kill switch the first commit would have broken.
- **Owner decisions of 4-5 September:** annual billing STAYS on the
  public pricing page by explicit ruling (the backend bills monthly; the
  annual lifecycle is post-launch work, and the review's truthfulness
  flag is recorded, not relitigated). The fix-plan 7 H7c-H7g enumeration
  was proven unrecoverable from the repository and the owner ruled to
  skip reconstructing it. Dependabot #224 (six minor/patch bumps) merged
  after re-verifying the combined main; NestJS 12 (#225-#227) waits as
  one coordinated post-launch migration.

**Where the next session starts:** the owner holds a fill-in
`.env` template and a per-variable checklist (delivered 5 September);
the next milestone is booting the stack with test-mode values and walking
every feature end to end, then the release-candidate sequence - AI live
eval, live Paystack drill, production backup and restore evidence, branch
protection, legal facts - per `docs/REKODA_OWNER_DECISIONS.md` §2.

## 4. Operational facts a new session must know

1. **Pushing:** the Claude GitHub App is installed on the `AngeloAkuhwa`
   account with `rekoda` granted. A session can push **only if the repo was
   attached to it at start** (the sandbox git proxy enforces a per-session
   allowlist; pasted tokens are ignored by design). Start every working
   session with the repo attached.
2. **Two GitHub accounts exist:** `AngeloAkuhwa` (owns this repo — use
   this one) and `AngeloKindred` (collaborator). Don't mix them.
3. **Tokens:** two fine-grained PATs were pasted into chat during setup and
   are burned — Angelo must revoke them (github.com → Settings → Developer
   settings → Fine-grained tokens). The installed app replaces them; never
   request a PAT again.
4. **drizzle-kit** reads the compiled schema (`dist/schema/index.js`) —
   build `@rekoda/db` before `generate`. Migration 0001 is hand-written
   RLS; keep custom SQL migrations for policy work.
5. **CI** activates fully once `pnpm-lock.yaml` exists at root (it does);
   gitleaks scans full history on every push, and it reads a high-entropy
   string literal in a test as a credential. Compose test secrets from one
   another rather than writing new ones down.
6. **Three database URLs** are needed for the integration suites, and they are
   three different roles on purpose: `DATABASE_URL` (owner, runs migrations),
   `APP_DATABASE_URL` (`rekoda_app`, what the API holds), `WORKER_DATABASE_URL`
   (`rekoda_worker`, the only credential that reads across tenants). Running a
   suite as the owner makes every tenancy assertion pass for the wrong reason.
7. **postgres-js cannot bind a JS `Date` or an array into raw SQL.** Cast
   explicitly (`${d.toISOString()}::timestamptz`) or use the drizzle query
   builder. Coming back the other way, `tx.execute` returns `timestamptz` as a
   **string**, so wrap it in `new Date(...)` before it reaches a caller that
   expects one.
8. **Secrets are not interchangeable.** `REKODA_API_SECRET` signs setup grants;
   `REKODA_OPERATOR_SECRET` is the plaintext operator header OUTSIDE
   production only, and must differ (config refuses to boot otherwise);
   `VAULT_KEY` seals payloads and `MATCH_KEY` derives match keys, and they are
   deliberately not the same as `CONNECTION_KEY`. In production the operator
   plane holds no shared secret at all: it verifies a signed token against
   `OPERATOR_OIDC_JWKS_URL`, so the audit trail names a person rather than
   whoever held a string.
9. **Never run the db and api integration suites at the same time.** They
   share one PostgreSQL and each truncates the other's fixtures, so the
   failures land in files nowhere near your change — a run once came back with
   24 failures in `auth.integration.test.ts` for a bank-page edit. Run them
   serially, and treat a surprising failure list as a scheduling question
   before a code question.
10. **A backslash inside a `sql` tagged template never reaches Postgres.**
    `regexp_replace(x, '\s+', ' ', 'g')` arrives as `'s+'` and quietly
    replaces runs of the letter s, mangling every value it touches. Use POSIX
    classes — `'[[:space:]]+'` — which need no escape. The two name-folding
    queries in `stock.ts` and `catalogue.ts` are the only regexes in any SQL
    template; keep it that way.
11. **A CI "all green" derived from an empty pending-list can be a lie.**
    GitHub registers this repo's five checks over several seconds, so a poll
    that asks "is anything pending" too early sees two registered checks, none
    pending, and reports success while three jobs are still running. Require
    the count as well as the state before merging on a poller's word, and
    confirm against the API.
12. **A page and a reply may only state numbers about the BUSINESS, never
    about their own page.** Counts come from SQL over the whole table; a
    caller that shows a page says what it left out. This is not a style
    preference — it is eight merged bug fixes (#115 to #122), and §3 has the
    three shapes of fix and when each applies.

## 5. Working agreements with Angelo (standing preferences)

- **Security and scalability are default requirements**, not features to
  ask about. Two-layer tenant isolation, hashed tokens, encrypted vaults,
  audit trails — always.
- **No Azure** (cost). Hosting is Hetzner + Cloudflare + R2 (ADR 0006).
- **AI:** strongest affordable model — Sonnet is the runtime default
  (ADR 0007); top-tier models for build/evals; escalation is a config flag.
  No hardware purchases ever. (Voice transcription is hosted OpenAI per ADR 0032; the earlier self-hosted STT preference is superseded.)
- **No zip-file deliveries** — everything through the repo as reviewable
  conventional commits. (Bundles were a one-time workaround for the proxy.)
- **UI work uses the UI/UX Pro Max skill + 21st.dev inspiration**, and
  Angelo wants to **see screenshots of UIs in chat** (light + dark, mobile
  included) when pages are built.
- Angelo welcomes **honest pushback with reasoning** — he has accepted
  several reversals of his own suggestions when argued properly (e.g. no
  WhatsApp caption branding, STOP semantics, tiered honesty copy). State
  disagreement plainly, then do what he decides.
- Plans before builds: for substantial new work, write the plan, let him
  review, then execute on "go".
- Money rules are absolute: integer kobo, deterministic computation, AI
  proposes / code disposes, no figure in any reply that didn't come from
  the deterministic layer.

## 6. Open items owned by Angelo

The canonical register is `docs/REKODA_OWNER_DECISIONS.md` §2, which
carries each item as the question to answer. The working list as of 6
September:

- **Fill the production environment.** A fill-in template
  (`rekoda-production.env.template`) and a per-variable checklist were
  delivered on 5 September; every value boots fail-closed, so a typo is a
  one-line startup error naming the variable. Test-mode keys first, on the
  host, never in git.
- **Branch protection on `main`** - still off, zero rulesets. PR + CI +
  integration + migration replay + e2e + secret scan required; no force
  pushes; minutes of work protecting months of it.
- **Production backup evidence** - the runbook's design is written but
  nothing is enabled or evidenced yet: off-box backups, WAL/PITR, an
  encrypted logical dump, alerting, and one restore drill into a clean
  database before the first paying merchant.
- **The AI live eval** - `docs/ai-launch-readiness.md` has every gate
  wired and every live metric still reading "not yet run". An owner-run
  eval against the configured models is a launch gate.
- **Three WhatsApp templates approved on the WABA** - `META_OTP_TEMPLATE`
  (nobody signs in without it), `META_BILLING_TEMPLATE`,
  `META_RETENTION_TEMPLATE` (the retention sweep deletes nothing while it
  is missing, by design).
- **Written confirmation before Paystack goes live** (spec §47), then one
  controlled real-money drill end to end: payment, verification, booking,
  allocation, receipt, reconciliation, refund, webhook replay, no
  duplicate booking.
- **The company facts** for `/terms`, `/refunds`, `/privacy` and the
  `NEXT_PUBLIC_LEGAL_*` values - production web refuses to boot without
  them (all but the NDPR auditor line, which stays blank unless a genuine
  filing supports it). Legal/DPCO review of the drafts.
- **The R0A-i production provenance report** - run, reviewed, approved
  per `docs/runbooks/r0a-provenance.md`; unblocks PR-006 to PR-009 and
  PR-115 and nothing else.
- **Tax, fiscalisation and accounting sign-off** - on the register so the
  quiet items do not vanish behind the loud ones.
- Secure `rekoda.app` (and ideally `rekoda.ng`); CAC name alignment for
  Meta business verification; the accent-benchmark voice notes (ADR 0024
  C11); VoiceReceipt's fate for current testers.

Superseded from earlier versions of this list: the two self-hosted
sidecars (`STT_URL`, `OCR_URL`) are not deployed and never will be -
ADR 0032 replaced them with hosted OpenAI transcription and Anthropic
vision, and the privacy pages already describe that architecture.

## 7. Standing review triggers (do not lose these)

- **1 Sep 2026** — Meta publishes post-October service-message rates →
  re-run every COGS table in pricing-model.md (ADR 0002 assumption).
- **First 50 paying merchants** — replace pricing assumptions with
  `usage_events` telemetry.
- **M3 accent benchmark** — self-hosted STT vs provider baseline gates the
  "audio never leaves Rekoda" marketing claim (ADR 0005).
- **The first abandoned trial reaching 90 days** — the retention sweep must
  have a working `META_RETENTION_TEMPLATE` by then, or the schedule
  `/privacy` publishes stops being kept (ADR 0024).
- **5,000 published shops** — `/v1/shops` caps the sitemap there and reports
  `truncated`. At that point the answer is a sitemap index with one file per
  slice, not a bigger number in `SITEMAP_SHOPS`.
- **The first merchant to query their gross margin** — weighted average is
  the method (PR #99) and it is only as good as the deliveries recorded. If
  merchants routinely buy without naming a product, the honest response is to
  make the stock page's "no cost recorded" line louder, not to start
  inferring costs from amounts.
- **The first merchant whose bank statement will not parse** — the parser
  names six distinct reasons and the page translates each into something a
  person can act on. If one reason dominates real files, fix the parser for
  that bank rather than widening the rules: `mixed_date_order` in particular
  is refused on purpose, because guessing a date order across a file is how a
  reconciliation quietly matches the wrong month.
- **The first depreciation charge a merchant disputes** — straight line with
  no salvage is ADR 0026's choice, and it is defensible rather than
  universal. If merchants' accountants routinely expect reducing balance, that
  is an ADR amendment with a rate somebody has an opinion about, not a
  setting to expose.
- **Before anyone caps `reconciliationsFor`** — it is the one query on the
  payments page with no limit, and that is load-bearing rather than an
  oversight. The page says "Nothing. Every verified payment matched what was
  expected" whenever the OPEN exceptions filtered out of it come to zero, and
  that sentence is only true because the filter runs over the complete set.
  Cap it the way `paymentsFor` was capped and the sentence becomes a lie the
  first time fifty resolved rows crowd an unresolved one off the page: a
  merchant told their money is fine while it is not. If it ever needs a cap
  for load, it needs an open COUNT alongside it, and the page must read that
  rather than the array. Checked and true as of PR #122; nothing enforces it.
- **The first merchant past 10,000 invoices, receipts or expense entries** —
  every export link says "Download ALL ... as a spreadsheet" and `EXPORT_ROWS`
  stops at ten thousand with nothing reporting truncation. The number was
  chosen deliberately as roughly a decade of a busy shop, and the reasoning is
  in the controller; the word "all" is what makes it a promise rather than a
  page. Whoever gets there needs either a report of what was left out or a
  streamed export, not a bigger constant.
- **Any run where `assetsDue` returns more than a handful** — the
  depreciation sweep bounds catch-up at twelve months per asset per pass, and
  logs what it charged. A count that stays high across passes means the sweep
  is not running often enough, not that the bound is wrong.

---

_Update discipline: at the end of each session, amend §3 (status), §4
(new operational facts), and §6 (open items) in the same PR as the work._
