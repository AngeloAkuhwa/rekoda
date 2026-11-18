# PR #432 final review C: concurrency, retries, runtime, migrations, deploy, test quality, launch truth

Read-only review. Reviewer C, in a fresh context that did not write the code.

- **Reviewed head:** `6534555331de357af3e22c7871e070011b5cf32b`. The brief's first `git rev-parse HEAD` gave
  `1376d7e`. Four commits landed while the review ran (`5d901dc`, `95d4479`, `1af146b`, `6534555`): test splits,
  comment fixes and audit manifests. Their code-relevant diff was also reviewed, and finding B1 is in one of them.
- **Merge base:** `58e6834`. The adversarial focus was `095ff62..HEAD`.
- **Docs read from the working tree, which another agent was editing:**
  - `docs/rls-exemption-register.md`: mtime 23:49:58Z, sha256 prefix `a6df080e`, uncommitted edits.
  - `docs/adr/0035-operational-aggregate-monitoring.md`: mtime 23:49:39Z, prefix `9e4f3e95`, uncommitted edits.
  - `docs/REKODA_LAUNCH_READINESS.md`:
    - First read: as committed at HEAD.
    - Re-read at mtime 23:52:37Z: by then it held uncommitted OD-54 and OD-55 rows.
  - All other docs: as committed at HEAD.
  - PR body: fetched with `gh api` at PR `updated_at` 2026-11-17T23:52:33Z.
- **Migration files:** 238 (`0000` to `0237`).

## Findings

### B1: BLOCKING. The second-review smoke suite does not compile or load

- **Location:** `packages/db/src/ops/deploy-smoke-sql-second-review.integration.test.ts:23`.
- **Defect:** the file calls `readFileSync(...)` but imports only `describe, expect, it` from vitest and
  `migrationText, smokeAfter, useSmokeHarness` from the fixtures. `readFileSync` is not a global.
- **Scenario:**
  - `pnpm turbo typecheck` fails with TS2304. `packages/db/tsconfig.json` includes `src`, so test files are
    type-checked.
  - Vitest throws a ReferenceError while it builds the `it.each` table at module load. The whole file fails.
  - As a result, none of the tamper cases for 0231 to 0237 run: R01 settlement `job_payload`, R07 state limit, R06
    unique index and 5-arg function, R02, R05, R08 cursor grant, G4b-2, G1-1, and the ledger tags.
  - The pre-start smoke's new clauses are therefore untested at this head, and exact-head CI cannot be green.
- **Introduced by:** `95d4479` ("split the second-review cases out of three suites").
- **Fix:** add `import { readFileSync } from 'node:fs';`, or use
  `migrationText('0228_worker_reads_no_payload_across_tenants.sql')` as the other cases do. Then re-run typecheck and
  the db integration suite.
- **Confidence:** high.

### I1: IMPORTANT. A recovery run that dies while its record cannot be reopened stays `recovering` for ever (G2-1 regression)

- **Location:** `packages/db/src/repos/jobs.ts`, `reclaimStalled`, the `try { savepoint } catch { unrecorded += 1 }`
  block around lines 637 to 647. It interacts with:
  - `enrolDeath` (`jobs.ts` ~752), which uses `NOT dead_job_has_record`, `enrolOnly: true` and insert-only
    `ON CONFLICT DO NOTHING`;
  - `dead_job_unrecorded_candidates` (0236), whose filter is `NOT EXISTS dead_job_exceptions d WHERE d.job_id = j.id`
    for a record in any status;
  - `beginRecovery` and the resolve function (`dead-jobs.ts` ~380 and ~440), which both require `status = 'open'`.
- **Scenario:**
  1. An operator recovers a dead `payment.process` job. Its record becomes `recovering` and the job is requeued for one
     attempt.
  2. The worker crashes during that run. The lease expires, and `reclaimStalled` sends the job to `dead`
     (`dead_job_is_recovering`).
  3. `recordDeath` should reopen the record (`ON CONFLICT ... DO UPDATE SET status='open' ... WHERE status='recovering'`)
     and raise a fresh merchant exception. Here it fails in its savepoint, for example on a lock conflict or a broken
     row.
  4. Since G2-1, that failure is swallowed. The job commits as `dead` while its record stays `recovering`.
  5. The enrolment pass never sees it, because a record exists. `enrolDeath` would not reopen it anyway, because it is
     insert-only.
  6. The operator queue shows it as "recovering" indefinitely. Recover and resolve both refuse a non-open record.
  7. No merchant exception is raised for the second death.
- **Before G2-1:** the re-throw rolled the reclaim back. The job stayed `running` and was retried on the next pass.
  That was stuck, but consistent and visible.
- **Why it matters:**
  - The commit and ADR 0035 Amendment 6 point 7 claim "the death is not lost: the enrolment pass records it". That is
    false for this path.
  - OWN-73 and OWN-76 require every dead payment or billing job to leave an open work item. Here the item is stranded
    with no operator action that can clear it (R08: failure-tracking failures not swallowed).
- **Fix, either of:**
  - (a) In the catch, re-throw (or keep the old per-row behaviour) when `dead_job_is_recovering(row.id)` was true.
  - (b) Better: extend the enrolment to "a dead job whose record is `recovering` and whose job `updated_at` is later
    than `recovery_requested_at`", and let `enrolDeath` reopen exactly that state.
- **Tests:** add a RED test that recovers, crashes, poisons the reopen, reclaims, and asserts the record is reopened
  by the next pass. Also surface the SQLSTATE that `catch {}` currently discards.
- **Confidence:** high on the code path, medium on frequency (it needs a double fault).

### I2: IMPORTANT. Refund recovery does not hold for credited packs, and a wrong recorded amount cannot be corrected (R06)

- **Location:** `packages/db/migrations/0235_refund_records_and_pack_eligibility.sql`, `subscription_record_refund`
  (the replay branch, then the pack checks for 7 days, allowance and `used`).
  Also `docs/runbooks/billing-duplicate-payments.md` §5, which says to refund in Paystack first and then record.
- **Defect 1: the provider refund happens first, and recording can then be refused.**
  - Replay is checked before eligibility, but only for an id that was already recorded. Take a first call that
    failed or timed out without committing.
  - For a credited pack, every retry re-runs eligibility. Facts that change after the Paystack refund turn the retry
    into a permanent refusal:
    - the merchant consumes units in the meantime, so the check says "has been used";
    - the seven-day window lapses between the refund and the retry;
    - the plan allowance changes (OD-55).
  - The result: money returned, the charge still `paid` with its units, and no sanctioned recording path.
  - This is the "provider refund succeeded but recording failed" case R06 names. There is no read-only eligibility
    check the operator can run before moving money, and no way to hold or revoke the units first.
- **Defect 2: a wrong amount is permanent.**
  - The recorded amount is operator-typed and never checked against Paystack's refund.
  - Recording `rf-X` with a mistyped amount succeeds. A corrected call is then refused as "already recorded with
    another charge or amount", and there is no compensating entry. That conflicts with invariant 6 (corrections are
    compensating events).
- **Fix:**
  - Add a check-only mode (or a "reserve": revoke the units and lock eligibility before the Paystack refund, then
    attach the provider id).
  - Reorder the runbook to check eligibility, then refund in Paystack, then record.
  - Make OD-55 name this race explicitly, and record the amount-correction path as an owner decision.
  - Optionally verify the refund amount with Paystack's refund API.
- **Confidence:** medium-high.

### I3: IMPORTANT. The operator refund runbook omits the now-required `providerRefundId`

- **Location:** `docs/runbooks/billing-duplicate-payments.md:104-112` (§5 step 3).
- **Defect:** the step lists `businessId`, `reference`, `amountK` and `reason` only. Since 0235 the route requires
  `providerRefundId` (`refund-operations.ts` refuses with 400 without it). The runbook also does not explain replay:
  the same id with the same amount is safe to resend, while another amount is refused.
- **Scenario:** an operator following the runbook gets a 400 for every refund recording.
- **Fix:** add the field, its source (the Paystack refund id), the replay rule, and what to do on refusal (the I2 and
  OD-55 path).
- **Confidence:** high.

### I4: IMPORTANT. OD-54 and OD-55 were cited but not committed (R09, R11, R14)

- **Where they are cited:**
  - the 0235 header and the runtime error message: "needs an owner decision (OD-55)";
  - `pack-refund.integration.test.ts`;
  - ADR 0035 Amendment 6 point 6 (OD-54);
  - rls-exemption-register row 237 (OD-54).
- **Where they were missing:** at the committed HEAD (both `1376d7e` and `6534555`), `docs/REKODA_LAUNCH_READINESS.md`
  had no OD-54 or OD-55 row. They appeared only as an uncommitted working-tree edit, seen at 23:52Z.
- **Content of that edit:**
  - OD-54 states the R11 boundary accurately: the app credential can forge `operator:` audit rows and close dead-job
    items, "not a new weakness". Recommendation B before paid launch.
  - OD-55 states the pack-refund gap.
- **Failure:** if the PR merges without that edit, the database refers merchants and operators to decisions that do not
  exist, and R09 ("unresolved commercial definitions go to the owner") and R11 are not met.
- **Fix:** commit the OD-54 and OD-55 rows with the PR. Add the I2 race to OD-55. Add OD-54 and OD-55 to the PR's
  "Open for the owner" list.
- **Confidence:** high about the committed state.

### I5: IMPORTANT. The PR description is stale throughout (R14)

The `gh api ... pulls/432 .body` text must change in at least these places:

- **"Rounds (migrations 0193 to 0226)":** now 0193 to 0237. Add the 15 Nov round (0227 to 0230) and the second review
  round (0231 to 0237: R01, R02, R03, R04/R05, R06, R07, R08/G2-1, R09, R10, G1-1, G3-1, G4a-1, G4b-2, G5-1).
- **Item 4 "Not database-enforced: worker_claim still lets the worker credential read any job row":** superseded.
  Since 0228 the worker has no SELECT on `jobs.payload`. 0231 revoked settlement's EXECUTE, and 0234 limits the
  function to running and dying jobs. Restate the exact residual (re-pin per row) as in Amendment 6.
- **OWN-92 "NOT fixed ... (next free migration, 0227)":** now CODE COMPLETE as `0227_paid_launch_gate`, not merged, not
  staging-verified. The gate holds.
- **The "Open owner questions" list:** the refund-window item ("the refund route enforces neither ADR 0024's 7-day
  window nor its unused condition") is superseded by 0230 and 0235. Replace it with OD-54, OD-55 and OD-53.
- **"Recorded MINORs ... (xx) permanently failing enrolment candidates could hold the page":** closed by 0229 and 0236.
- **"Accepted boundaries: the worker's queue read across tenants (the pinned payload read is application-level)":**
  rewrite to the 0228, 0231 and 0234 statement.
- **The "Pre-start smoke pins 26 tags":** it now pins 37 tags, plus the 0231 to 0237 checks, and it runs for any
  compatibility-breaking release (G5-1).
- **Compatibility breaks "0216, 0217, 0218, 0220, 0221":** the script lists 0196, 0200, 0202 to 0207, 0209 to 0212,
  0216 to 0218, 0220, 0221, 0228, 0230 and 0235. The text "0224, 0225 and 0226 are not breaks" needs 0227, 0229, 0231
  to 0234, 0236 and 0237 added.
- **"How verified" (head `a6e3a3b`, 0000 to 0226 (227 migrations), db 2133/2133, api 2798/2798, scripts 447/447):**
  all stale. Re-run at the final head after B1 is fixed. There are 238 migrations.
- **The commit and finding tables:** add the 095ff62..HEAD commits.
- **"Independent read-only reviews":** add this round.
- **Financial and security implications table:** add per-provider-refund idempotency (0235), the pack allowance
  snapshot (0235), the job_payload state limit (0234), settlement's vault-key check (0237), and the enrolment
  cursor (0236).
- **"Ruled and implemented: ... OWN-85 to OWN-93":** add OWN-94.

**Confidence:** high.

### I6: IMPORTANT. HANDOFF states a stale migration count and date (R17)

- **Location:** `docs/HANDOFF.md:13`, `:16`.
- **Defect:** it says "PR B #432 adds 0193 to 0226 (227 once it merges)" and "Current date 14 November 2026". HEAD has
  238 files, `0000` to `0237`.
- **Already correct elsewhere:**
  - `docs/runbooks/staging-first-deploy-pr-b.md` D3 (`"migrations":238`) and its rollback step 5 (`193`);
  - `staging-acceptance-handoff.md:38` (238, working tree).
- **Fix:** update the HANDOFF top section to 0193 to 0237 (238 once merged) with the 17 Nov state.
- **Confidence:** high.

### I7: IMPORTANT. G5-1 (smoke gating) has no regression test (invariant 11)

- **Location:** `scripts/deploy-staging.sh:95-97`, `carries_plan_boundary()`, which is now `[[ -n "${BREAKING// /}" ]]`.
- **Defect:** commit `1376d7e` fixes a real gap: a release carrying only 0228, 0230 or 0235 skipped the pre-start
  smoke. But `scripts/deploy-staging-compat.test.mjs` has no case where the release carries a breaking migration other
  than 0196 and the smoke is asserted to run between migrate and up. Every existing OWN-86 test uses a 0196-carrying
  journal.
- **Failure:** reverting the function to the hand list still passes CI.
- **Fix:** add a harness test with a running journal at 0234 and a target journal at 0235. Assert that the stop, the
  smoke and up appear in that order, and that a non-breaking-only release (for example 0236 alone) does not stop
  services.
- **Confidence:** high.

### MINOR findings

- **M1.** `jobs.ts` reclaim `catch {}` discards the SQLSTATE, and `onUnrecorded` is only a `log.warn` with no
  `ALERT` line.
  - A candidate whose failure cannot be tracked has no retry budget: it is retried on every wrap for ever, with only
    a warn line (R08 "retry budget").
  - Suggest an `ALERT dead_job_enrolment_untracked` line or metric, and SQLSTATE on the reclaim path.
- **M2.** `packages/db/src/privacy/retention-pr432-tables.integration.test.ts`, "the list above is every new table with
  a business id", is tautological. It filters `information_schema` to its own list, so it can never detect a missing
  table.
  - Compare against tables that do not exist at 0192, or against all `business_id` tables minus a 0192 snapshot.
  - Independently checked: the 13 tables created in 0193 to 0237 match the list plus the non-tenant singletons.
    Coverage is right today.
- **M3.** `dead-job-enrolment-dead-letter.integration.test.ts`, "overlapping passes", accepts 1 to 3 attempts. It
  passes whether or not the passes overlap, because three `Promise.all` passes on one small pool may serialise. It is
  a weak concurrency proof.
- **M4.** `docs/runbooks/deploy.md:188` lists 0222 and 0223 as requiring `dc stop api worker operator settlement`.
  Neither is in `COMPAT_BREAKING_MIGRATIONS`, and their headers say "not a compatibility break". The over-stop is
  harmless, but it is inconsistent.
- **M5.** Settlement's new `assertKeyEnrolled` (`boot-checks.ts:348`) has no test for the never-enrolled case.
  - In `docker-compose.prod.yml`, settlement `depends_on` only postgres. On a fresh database (a first install or an
    empty restore target), `dc up -d --wait` can see settlement exit before the API enrols the key.
  - Staging is unaffected, because its key has been enrolled since 0120.
- **M6.** The 0235 replay ignores a differing `reason` or `actor` and answers `replayed=true` silently.
  - There is no test for two concurrent different partial refunds whose sum exceeds the charge.
  - There is no test for one provider id on two charges concurrently. Code review says the charge lock and the unique
    index plus `unique_violation` handle both.
- **M7.** Re-running one earlier migration by hand after 0231 to 0236 silently undoes later guarantees, even though
  each header says "Re-running is safe":
  - 0228 re-grants settlement `job_payload` and drops 0234's state filter;
  - 0229 restores the 200-character actor rule;
  - 0230 recreates the 5-argument refund function.

  The smoke catches all three. Say so once in deploy.md.
- **M8.** `docs/rls-exemption-register.md:234` names `jobsRepo.enrolUnrecordedDeaths` as the caller. The runner calls
  `enrolUnrecordedDeathsPage` (0236).
- **M9.** `runner.ts` carrying the cursor (`this.enrolmentCursor = pass.next`) and the outer catch have no runner-level
  test. Only the repository-level loop is tested.

## Checked and found sound

- **0236 keyset cursor** (`0236_dead_job_enrolment_cursor.sql:20-56`):
  - Ordering matches the cursor.
  - A vanished or moved cursor yields no rows (row-compare with NULL), so the next pass starts over.
  - The worker holds the only grant, the result is id-only, and the 1-to-200 bound holds.
  - `enrolUnrecordedDeathsPage` sets `next` only on a full page (`jobs.ts` ~725).
  - Untracked failures are reported by SQLSTATE without message text.
  - The starvation test would fail before the fix.
- **0229 retry policy and dead letter:**
  - The `FOR UPDATE` on the failure row serialises concurrent `dead_job_enrolment_failed` calls.
  - The candidate filter honours backoff and dead letters.
  - `enrolDeath`'s `FOR UPDATE SKIP LOCKED` plus insert-only recording means overlapping passes enrol once.
- **0233 actor contract:** `^operator:[!-~]{1,255}$` is applied in the function and in the column CHECK, and
  boundary tests exist.
- **R11 status:** app-credential forgery is real and long-standing (`audit_events` INSERT since 0001). The working-tree
  OD-54 states it accurately. See I4 for committing it.
- **`markFailed`** (`jobs.ts` ~505-528): it still writes the record in the same transaction as the transition, with
  no swallow. A failure leaves the job `running` for the reclaim.
- **`pinnedPayload`** (`jobs.ts` ~535-549):
  - It chooses the function or the column read by `has_function_privilege`.
  - The worker without EXECUTE falls back to a column read that it is refused (fail-closed).
  - Settlement's column read is bounded to the pin, and 0217 RLS limits it to its own two kinds.
- **0231:** EXECUTE revoked from settlement, with an in-migration assertion. The smoke has a negative case, but see B1:
  that case is not running.
- **0234 state limit:**
  - Every worker payload read is of a `running` job (the claim, after its autocommit UPDATE) or a dead
    payment or billing job (markFailed, reclaim and enrolment, read after the state change in the same transaction).
  - No worker path reads a pending or done payload.
- **0235 concurrency:**
  - Two calls for one charge are serialised by the charge `FOR UPDATE`. The refund lookup is a fresh READ COMMITTED
    statement after the lock, so a concurrent replay sees the committed row.
  - One id on two charges is serialised by the unique index, and `unique_violation` is re-raised as a conflict.
  - `usage_counters` is locked before the `used` check, and reservations count in `used` immediately, so
    consumption cannot slip between the check and the revocation.
  - `pack_credit_entitlements` is inserted once per charge, behind the `units_credited_at` guard under the row lock.
- **R09 reasoning:**
  - A pack does not roll over (`usage.ts:216`).
  - Trial conversion, an upgrade, or a downgrade-and-back each either change the allowance (refused) or leave `used`
    measured against the credited allowance.
  - Multiple packs: revoking one leaves the ceiling at or above `used`.
- **G3-1** (`apply-no-charge-upgrade.handler.ts`):
  - The savepoint is rolled back. The business is re-locked, then the pending charge is withdrawn and audited.
  - Settlement holds the column grants it needs (`0217:137-140`).
  - No paid fact is written.
- **0237 and `assertKeyEnrolled`:** read-only grant. The mismatch case is tested
  (`settlement-process.integration.test.ts`), and the smoke checks SELECT without INSERT.
- **Migration re-run safety:** for 0231 to 0237 each statement is idempotent (`IF [NOT] EXISTS`,
  `CREATE OR REPLACE`, `DROP ... IF EXISTS`, and a drop-then-add for the constraint).
  `upgrade-od51.integration.test.ts` re-runs 0228 to 0237 in order.
- **Upgrade from main:** `upgrade-from-main.integration.test.ts` migrates from 0192 to 0237, checks the pending list
  ends at 0237, checks history is not rewritten, checks in-flight jobs, and runs the smoke.
- **`deploy-staging.sh` ordering:**
  - It computes BREAKING from the running and target journals (`:1063`).
  - It stops api, worker, operator and settlement and verifies they are down (`:1175-1187`).
  - Then migrate, then the pre-start smoke (`:1201-1207`, with a fail-closed exit and output), then `up`.
  - 0235 is in `COMPAT_BREAKING_MIGRATIONS`, because its signature changes.
- **Restore drill** (`scripts/restore-drill.sh`):
  - It bootstraps every runtime and writer role, keeps ownership, and checks BYPASSRLS for the provenance owner and
    the migrating role.
  - It compares the full function-owner map. The new tables need nothing role-specific.
- **R10 coverage:** `retention-pr432-tables` deletes rows in all nine new tenant tables for the target only. Its
  fixture shapes are documented, and M2 notes its tautological first test.
- **`test_fixture_*`:** created by the harness only (`testing.ts:180-250`). The smoke refuses them on a deployed
  database (`deploy-staging.sh:349-351`). The R09 upgrade test uses `test_fixture_set_plan` to change the plan, which
  is legitimate because the refund reads `usage_entitlement` whatever path changed the plan.
- **OWN-92 status:** consistent. CODE COMPLETE as 0227 in OWNER_DECISIONS row 28 and LAUNCH_READINESS row 456, with
  the gate held until merged and staging-verified.
- **OD-53:** consistent as open owner decisions. The duplicate-payment runbook says there is no record-only entry yet
  (R12 and R13 are explicitly open, not silently built).
- **ADR 0035 Amendment 6 (working tree):** the grant table, point 5's exact enforced and not-enforced statement, and
  the residual all match 0228, 0231 and 0234. Point 7 overstates G2-1 (see I1).

BLOCKING=1 IMPORTANT=7 MINOR=9
