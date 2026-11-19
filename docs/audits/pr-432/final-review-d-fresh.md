# PR #432 final review D (fresh, independent, read-only)

- **Reviewed head (local):** `e37c9aadc56cabdc57fe0055f34b67d1ca50de7b` (branch `angelo/magical-bell-s81mqc`, merge base `58e6834`).
- **PR head on GitHub at review time:** `6cf9d45016e61ce0ef2ecf3fba6536c6a5094db7`. The nine commits from `4d2df58` to `e37c9aa` (0238, I1, 0239, 0240, A-3, the smoke, the docs) are **not pushed**. No CI has run on 0238 to 0240.
- **Scope:** the whole diff `58e6834..HEAD` (425 files), with adversarial focus on `095ff62..HEAD`.
- **Method:** I read the code, migrations, tests and docs and ran git/grep only. I did not connect to a database or run tests. Each claim that a test fails comes from reading the code path, not from running it.

## Findings

### D-1 BLOCKING: 0239 refuses the staging fault-consumption write, so an armed staging fault can never be consumed and the OWN-77 tests fail

- **Where:**
  - `packages/db/migrations/0239_operator_actor_columns.sql:37` constrains `staging_tool_actions.operator` with `operator_only` (`^operator:[!-~]{1,255}$`).
  - `packages/db/src/repos/staging-tools.ts:186-190` (`consumeFault`) inserts `staging_tool_actions (operator = 'system:send', action = 'consume_fault')`.
- **Failure scenario:**
  1. On staging, an operator arms `send_timeout` or `sender_refused` (walkthrough 19, G-119/OWN-77).
  2. The next grace or trial-notice send calls `applyStagingFault`, then `consumeFault`. The UPDATE consumes the fault, and the INSERT then raises 23514 (check violation).
  3. The whole tenant transaction rolls back, so the fault stays armed.
  4. `apply­StagingFault` catches the error and throws `SendFailed(..., transient, not sent)` (`apps/api/src/billing/staging-faults.ts:23-31`). The sweep retries on the next pass and fails the same way.
  5. Every reminder send to that business is suppressed for good, the armed fault is never "consumed by exactly one send", and the acceptance walkthrough cannot pass.
- **Tests that should fail at HEAD:**
  - `packages/db/src/ops/staging-tools.integration.test.ts:380-394` (`consume` should throw instead of returning `send_timeout`) and the racing test after it.
  - `apps/api/src/health/staging-tools.integration.test.ts:~274-330` (consume_fault expected in the log).
- **Why it violates:** the 0239 header says "the release's writers produce only these forms". That is false for `consumeFault`. It is a regression introduced after `095ff62`, CI would go red, and it breaks a staging acceptance capability.
- **Fix:**
  - Use `operator_or_system` for `staging_tool_actions.operator`, because `system:send` matches `system:[a-z][a-z_-]{0,63}`. Correct the 0239 header list ("operator only" applies to `designated_by` and `armed_by`).
  - Add a RED test: arm, then consume, then expect `send_timeout` and a `consume_fault` row whose actor is `system:send`.
  - The smoke's constraint check (see D-5) should also pin the pattern.
- **Confidence:** high.

### D-2 IMPORTANT: 0238 breaks two existing ops-health integration tests that stage dead jobs on the worker credential

- **Where:**
  - `packages/db/src/ops/ops-health.integration.test.ts:180` and `:198` both run `workerDb.execute(UPDATE jobs SET state = 'dead' ...)` on jobs just enqueued as `pending`.
  - `packages/db/migrations/0238_worker_job_transitions.sql:31-38` refuses the worker `pending -> dead`.
- **Failure scenario:** the tests run as `rekoda_worker` (`testing.ts`; `urls.worker`). The UPDATE raises 42501, so "tells a merchant-scoped credential nothing about other tenants (OWN-36)" and "counts only jobs that died in the last 24 hours" fail. The db integration suite goes red on the first CI run that includes 0238. (No such run has happened yet: the PR head on GitHub predates 0238.)
- **Why it matters:** production paths are not affected. I checked every worker-credential job transition in the code; see "0238 vs legitimate worker paths" below. But exact-head CI cannot be green, and invariant 11 forbids skipping a test.
- **Fix:** stage these deaths as the owner, as the neighbouring tests do ("Staged as the owner ..."). Leave the guard as it is.
- **Confidence:** high. I did a full grep of test state updates on the worker credential: only these two, plus the intended B-1 and settlement-isolation cases, which still hold under the guard.

### D-3 IMPORTANT: PR #432's description is still stale, and the reviewed head is not the PR head (R14; final-review C I5, manifest G6-3 still open)

- **Where:** the PR body (fetched via REST at review time).
  - It still says "Rounds (migrations 0193 to **0226**)", "pins 26 tags", "OWN-92 ... NOT fixed ... (next free migration, 0227)", "migrated 0000 → 0226 (227 migrations)", and "Compatibility breaks: 0216, 0217, 0218, 0220, 0221".
  - It omits 0227 to 0240, OD-54 to OD-56, and the 0228, 0230 and 0235 breaks.
  - The GitHub head is `6cf9d45`. Local HEAD is nine commits ahead.
- **Why it matters:** P12 asks for approval on the exact head SHA reviewed. The artefact the owner approves from describes a different migration set and a different set of compatibility breaks.
- **Fix:**
  - Push.
  - Rewrite the description for the final head: migrations 0193 to 0240, 241 files, a smoke of 40 tags, the breaks including 0228, 0230 and 0235, and OD-53 to OD-56.
  - Record the final-head CI run and the serial suite results (G6-7, OWN-94 (3)).
- **Confidence:** high.

### D-4 MINOR: 0238 lets the worker requeue a dead `payment.process` job, which no worker code path does

- **Where:** `0238_worker_job_transitions.sql:33-34`. The only `dead -> pending` writer in the code is `deadJobsRepo.beginRecovery` (`packages/db/src/repos/dead-jobs.ts:384-389`), and it runs on the application credential (`dead-job-recovery.service.ts:96`).
- **Scenario:** a holder of the worker credential can re-run a dead payment job without the operator's Paystack-verified recovery (OWN-73). This is not a payload leak (0234 already exposes dying payment payloads), and it is not a regression: before 0238 the worker could make any transition.
- **Fix:** drop the `dead -> pending` branch for the worker, or state the residual in ADR 0035 Amendment 6 and the guard's comment, which currently calls it "(recovery)".
- **Confidence:** high on the code path.

### D-5 MINOR: the smoke checks that the seven 0239 constraints exist, not what they enforce

- **Where:** `scripts/deploy-staging.sh:257` (`convalidated IS NOT NULL` is always true).
- **Scenario:** a constraint re-created with a permissive pattern passes the smoke. Only "constraint dropped" is a tamper case (`deploy-smoke-sql-second-review.integration.test.ts`).
- **Fix:** compare `pg_get_constraintdef` with the expected pattern.

### D-6 MINOR: 0240 retention relies on alphabetical table order

- **Where:** the `retention_delete_business` walk (`0161:107-131`, ordered by table name) and the 0240 trigger on `business_add_ons` DELETE.
- **Scenario:** deleting `business_add_ons` re-inserts the business's `business_allowance_changes` row. It is cleaned up only because `business_add_ons` sorts before `business_allowance_changes`, and nothing references `business_add_ons`, so it never lands in the retry list. If a future foreign key defers `business_add_ons` to a second round, the businesses delete fails with an FK violation (`0240:21` has no ON DELETE).
- **Also:** the R10 test populates no `business_add_ons` row, so this ordering is untested. (Retention excludes ever-paid businesses, so this is unlikely today.)
- **Fix:** give `business_allowance_changes.business_id` `ON DELETE CASCADE`, or skip the trigger write when the business is being deleted. Add an add-on row to the R10 fixture.

### D-7 MINOR: HANDOFF's "Current date" cell says 17 November while its own text records work of 18 November (`docs/HANDOFF.md:13`)

## Confirmation table (each prior finding at HEAD `e37c9aa`)

Legend:

- **RESOLVED:** fixed in code, docs or tests at HEAD.
- **OD:** correctly recorded as an open owner decision.
- **REC:** a MINOR recorded and deferred in the OD-41 row of `docs/REKODA_LAUNCH_READINESS.md`.
- **OPEN:** still a defect.

### Reviewer A (financial)

| ID         | Status                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1        | RESOLVED                                 | 0240 records `business_allowance_changes` by a definer trigger on plan, plan_version_id and add-on holdings. `subscription_record_refund` refuses when `changed_at >= units_credited_at` (`0240:145-149`). RED tests at `pack-refund.integration.test.ts:440,466`. Untracked changes made by date (trial or holding expiry; owner-only catalogue edits) are stated in the header and fail the equality check. |
| A-2        | OD                                       | OD-55 (iv), with options A, B and C and a recommendation (`REKODA_LAUNCH_READINESS.md:156`).                                                                                                                                                                                                                                                                                                                  |
| A-3        | RESOLVED (within the wait); residual REC | `awaitNoCharge` returns `withdrawn` → `upgrade_withdrawn` (`billing.service.ts:553-588`), with honest copy (`page.tsx:111`) and the contract updated. A withdrawal after the 4 s wait still shows the "switching on now" strip. This is G3-4, recorded.                                                                                                                                                       |
| A-4        | OD                                       | OD-56 (`:157`). It agrees with the code: the application compares at monthly prices, the database at the cycle's interval.                                                                                                                                                                                                                                                                                    |
| A-5 to A-9 | REC                                      | OD-41 row.                                                                                                                                                                                                                                                                                                                                                                                                    |

### Reviewer B (security)

| ID         | Status                       | Evidence                                                                                                                                                                                                    |
| ---------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1        | RESOLVED, with a side effect | The 0238 guard holds against revival, and the worker cannot change `kind` or `payload` (`0212` column grants), so it cannot relabel a job to pass the guard. The guard broke two tests (D-2). Residual D-4. |
| B-2        | RESOLVED in part, rest OD    | The 0239 constraints, with forgery of a well-formed actor recorded in OD-54. 0239 introduced D-1.                                                                                                           |
| B-3 to B-6 | REC                          | OD-54 (B-3) and the OD-41 row (B-4, B-5, B-6).                                                                                                                                                              |

### Reviewer C (runtime, tests, docs)

| ID           | Status   | Evidence                                                                                                                                      |
| ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 (compile) | RESOLVED | It uses `migrationText` from the fixtures.                                                                                                    |
| I1           | RESOLVED | A per-job savepoint holds the UPDATE and its record (`jobs.ts:617-652`). A job whose record cannot be written stays `running` and is retried. |
| I2           | OD       | OD-55 (iv), which also covers a mistyped amount.                                                                                              |
| I3           | RESOLVED | `billing-duplicate-payments.md:114-124`.                                                                                                      |
| I4           | RESOLVED | OD-54, OD-55 and OD-56 are committed.                                                                                                         |
| I5           | OPEN     | D-3.                                                                                                                                          |
| I6           | RESOLVED | Migration count 241 (`HANDOFF.md:16`). The date cell is still stale (D-7).                                                                    |
| I7           | RESOLVED | `scripts/deploy-staging-compat.test.mjs:566-592`.                                                                                             |
| M1 to M9     | REC      | OD-41 row. M4 is corrected in the runbook.                                                                                                    |

### Group manifests

| ID                                     | Status                    | Evidence                                                               |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| G1-1                                   | RESOLVED                  | The 0235 insert guard.                                                 |
| G1-2                                   | OD                        | OD-54.                                                                 |
| G1-3                                   | REC                       |                                                                        |
| G2-1                                   | RESOLVED                  | 0236 plus `8e263c5`.                                                   |
| G2-2 to G2-10                          | REC                       | G2-7 is fixed by `1af146b`.                                            |
| G3-1                                   | RESOLVED                  | `e5b2bd2` plus A-3.                                                    |
| G3-2, G3-3, G3-4                       | REC                       |                                                                        |
| G4a-1                                  | RESOLVED                  | `5b1b459`, `5d901dc`.                                                  |
| G4a-2 to G4a-4                         | REC                       |                                                                        |
| G4b-1                                  | RESOLVED                  |                                                                        |
| G4b-2                                  | RESOLVED                  | 0237 plus `assertKeyEnrolled`. The never-enrolled test gap is M5, REC. |
| G4b-3                                  | RESOLVED                  | `1af146b`.                                                             |
| G5-1                                   | RESOLVED                  | The gate plus its test.                                                |
| G5-2, G5-3, G5-6, G5-7                 | REC                       |                                                                        |
| G5-4                                   | RESOLVED                  |                                                                        |
| G5-5                                   | RESOLVED                  | R01, 0231.                                                             |
| G6-1                                   | RESOLVED                  | D3 is 241 and D8 is the 0240 schema.                                   |
| G6-2                                   | RESOLVED                  |                                                                        |
| G6-3                                   | OPEN                      | D-3.                                                                   |
| G6-4                                   | RESOLVED                  | The register row, ADR Amendment 6 (PROPOSED).                          |
| G6-5                                   | RESOLVED                  |                                                                        |
| G6-6                                   | OD                        | OD-55 (ii) and B, plus A-6.                                            |
| G6-7                                   | OPEN until the final head | D-3.                                                                   |
| G6-8, G6-9, G6-12, G6-13, G6-15, G6-16 | RESOLVED                  | Spot-checked.                                                          |
| G6-10                                  | RESOLVED except the date  | D-7.                                                                   |
| G6-11                                  | not re-verified           |                                                                        |

### Codex findings on PR #432

| Finding                              | Status   | Evidence                                                                                                                                                            |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0228 settlement job-kind restriction | RESOLVED | 0231 revokes EXECUTE from settlement and asserts it, and 0234 re-revokes it. Settlement reads through RLS-filtered `SELECT` (`jobs.ts:535-551`). The smoke pins it. |
| 0213 annual-price fallback           | RESOLVED | `review_plan_price` uses an explicit annual price, else monthly × 10, using the pinned version (`0232:35-72`). The interval question is OD-56.                      |
| 0230 operator actor length           | RESOLVED | `^operator:[!-~]{1,255}$` in 0233 and 0235/0240, with 255 and 256 tests (`pack-refund.integration.test.ts:402`).                                                    |

## Specific questions

### 0238 against legitimate worker paths

All of them are safe. These are every `UPDATE jobs` in non-test code (`grep`), checked against the guard:

| Path                                                                       | Credential and transition                | Under 0238           |
| -------------------------------------------------------------------------- | ---------------------------------------- | -------------------- |
| `claimNext` (`jobs.ts:391`)                                                | pending→running                          | allowed              |
| `markDone` (`runner.ts:203`)                                               | on the **application** credential        | guard not applicable |
| `markFailed` (`jobs.ts:505`, fenced by `locked_by`, so the job is running) | running→pending or dead                  | allowed              |
| `retireUnknownKind`                                                        | running→dead                             | allowed              |
| `deferClaimed`                                                             | running→pending                          | allowed              |
| `touch`                                                                    | no state change                          | allowed              |
| `reclaimStalled`                                                           | running→pending or dead                  | allowed              |
| enrolment (`enrolDeath`)                                                   | `SELECT ... FOR UPDATE`, no state change | allowed              |
| dead-job recovery requeue (`beginRecovery`)                                | on the application credential            | guard not applicable |
| settlement runner                                                          | its own role                             | guard not applicable |

No SQL function updates `jobs`. Only test staging breaks (D-2).

### Per-job reclaim: exactly-once and kind isolation

Both hold.

- `SELECT ... FOR UPDATE SKIP LOCKED` locks every stalled row for the whole pass.
- The per-job UPDATE re-checks `state = 'running' AND stale` on the locked row, so a concurrent pass skips it, and a heartbeat or `markDone` queued behind the lock re-evaluates after commit, finds `locked_by` NULL, and loses the lease (`JobLeaseLost`). The death and its record commit or roll back together in the savepoint.
- The worker's `FOR UPDATE` is filtered by the restrictive UPDATE policy `worker_leaves_settlement_jobs`, which hides running settlement jobs. Settlement's is filtered by `settlement_claim` and `settlement_only_its_kinds`. Settlement's payload read is the RLS-filtered column read (0231).
- A pin left in place by a released savepoint is harmless: jobs policies for the worker and settlement do not depend on it, and each record pins again.
- The residual is M1, REC: a permanently unrecordable job stays `running` and only logs a warning.

### 0240 against guards and RLS

There is no interference.

- The trigger is AFTER ROW and writes only `business_allowance_changes`. The BEFORE guards (plan fields 0196, cycle 0206, trial start, retention notice) run first and are unchanged. AFTER ROW triggers fire at the end of the statement, so the pin change cannot affect a multi-row scan.
- The definer pins the row's business, satisfying the FORCE RLS policy even for a non-superuser owner, and restores the caller's value. A function `SET search_path` clause does not save or restore `app.business_id`, so the explicit restore is needed and correct. An unset pin becomes `''`, which `nullif` treats the same as NULL.
- It fires before `businesses_release_trial_month_rows` (alphabetical), with the pin already restored.
- The refund function reads the table under the verified pin.
- Retention ordering is safe today (D-6).

## Checked and found sound (selected)

- R01: `0231:21-35`, `0234:44-47`, `jobs.ts:535-551`.
- R03: `billing.service.ts:423-430`.
- R06: replay under the charge lock, cross-business `unique_violation` aborting the whole call, and no money movement (`0240:113-182`).
- R08: the keyset cursor and its wrap (`0236:20-50`; `jobs.ts:700-737`). Untracked failures are reported by SQLSTATE.
- R07: the 0234 guarantee is stated exactly.
- 0237: settlement gets SELECT only, and `assertKeyEnrolled` refuses both an unenrolled and a mismatched key (`boot-checks.ts:348-366`).
- The smoke's ledger count of 40 matches the 40 tags listed.
- The gate now runs for any breaking migration, and 0235 has been added to `COMPAT_BREAKING_MIGRATIONS`.
- 0239's other columns: every writer uses `operatorActor()` (`operator:<subject>`) or a `system:<lower_snake>` actor (`system:recovery`, `system:gate_open`). The test actors that do not match (`op:a`) hit no row.
- R12/R13: explicitly NOT BUILT paid-launch blockers (OD-53 (4), GATE 8 and 9).
- The OD-53 to OD-56 rows match the code.

BLOCKING=1 IMPORTANT=2 MINOR=4
