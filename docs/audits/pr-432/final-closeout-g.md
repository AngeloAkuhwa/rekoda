# PR #432 closeout round G, 18 Nov 2026

Status: **CODE COMPLETE, PR OPEN, NOT MERGED, NOT DEPLOYED. STAGING ACCEPTANCE PENDING. P12 NOT
GIVEN. ADR 0035 Amendment 6 PROPOSED, NOT ACCEPTED.** This round carries out the owner's instruction
of 18 Nov 2026, "Consolidated Final Engineering Remediation, Verification and Merge Approval
Closeout". Nothing here merges, deploys, accepts an ADR or makes an owner decision.

## 1. Release identity at the start of the round

| Item                       | Value                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR head when fetched       | `bfa00cf9592f6924d5eabe3f5ca97ea82248436c` (unchanged from the owner's snapshot); merge base and `main` `58e6834e4e92efa702756594135f9aa125298cec`                                                                                                                                                                                                                                            |
| Size then                  | 242 commits, 446 files, migrations 0000 to 0243 (244)                                                                                                                                                                                                                                                                                                                                         |
| CI then                    | run 44283542613 on `bfa00cf`: every check green (the owner's snapshot saw it in progress)                                                                                                                                                                                                                                                                                                     |
| Reviews then               | Codex "no major issues" on `bfa00cf` (10:39 UTC; the owner's snapshot saw `dbdbd98`); 47 threads (42 CodeRabbit, 5 Codex), 0 unresolved; CodeRabbit skipped itself (file limit); Qodo's summary comment last updated 10:21 UTC with 66 findings (§3)                                                                                                                                          |
| Other engineering branches | `angelo/magical-bell-2ht8ys` (`d976b21`) is an ancestor of the head. Branches with commits not in the PR (`v7abci`, `ysvrjy`, `hvwoy6`, `cw9vh5`, `hznqgc`, 11 to 14 Nov) are superseded drafts: a different migration lineage (their own `0212`), or work landed in the PR under other commits (the compose `.env` pin, the R2 runbook revision). None is outstanding authorised remediation |
| This round's commits       | fast-forwards on `bfa00cf`; `commit-register-remediation.md` #243 onward                                                                                                                                                                                                                                                                                                                      |

Preserved and not reopened: every round F correction (0241 to 0243, the stuck-job alert, the ₦0
upgrade status, the exact smoke pins, migration classification, the drill's revokes) and their
tests. The 11 forced interleavings of `pack-refund-concurrency` are unchanged and pass.

## 2. Findings and their disposition

| ID                                                       | Severity                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                       | Fixing commit            | Regression result                                                                                                                                                                                                                                               | Disposition                                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-1 natural expiry during a refund (owner §5)            | **IMPORTANT** (financial truth)                       | Reproduced at 0243: a refund that began before a holding's `ends_at` (or a trial's `plan_expires_at`) and waited for the charge row recorded a full refund and revoked the units of a pack that consumption, metered after the boundary, had spent; and an allowance that dipped and came back by time alone (a holding ends, the next starts later) passed the equality check | `2f723a74` (0244)        | `pack-refund-natural-expiry` 6/6 GREEN (3 RED at 0243: holding, trial, dip); `pack-refund-concurrency` 11/11 unchanged                                                                                                                                          | **CONFIRMED AND FIXED**                                                                                                                                                                  |
| G-1 catalogue boundary                                   | IMPORTANT (same class)                                | A version of the plan taking effect or ending changes the allowance of a business whose pin does not choose one (a trial has no pin), with no business write                                                                                                                                                                                                                   | `2f723a74`               | the boundary function, in a rolled-back transaction: no boundary, unpinned boundary, pinned no boundary                                                                                                                                                         | **CONFIRMED (by inspection) AND FIXED**                                                                                                                                                  |
| G-2 pool sizing, runtime (owner §4.3)                    | verification                                          | `9a543ad` and `04dd32f` were proved by formula and wiring only                                                                                                                                                                                                                                                                                                                 | `acd6d76f`               | `renewal-initiate-pool` 2/2: ten real lanes, real handler and checkout; a pool of 10 observed in the circular wait (10 idle lane transactions, 10 nested requests, none served) and no job completes; 12 serves 2, queues 8, completes 10 with one session each | **VERIFIED SAFE** for this path                                                                                                                                                          |
| G-3 unbounded lane setting (owner §4.4; Qodo 26)         | IMPORTANT (launch path)                               | `REKODA_WORKER_CONCURRENCY` had no upper bound; a worker pool is `max(10, lanes + 2)`                                                                                                                                                                                                                                                                                          | `acd6d76f`               | `numeric.test.ts`: 17 refused (RED before), 16 accepted                                                                                                                                                                                                         | **CONFIRMED AND FIXED**; budget in `deploy.md`, "Connection budget"                                                                                                                      |
| G-4 three connections per lane: catalogue refusal        | **IMPORTANT** (independent audit)                     | `customer-message` `settle()` gave both units back with `Promise.allSettled`, two transactions beside the runner's                                                                                                                                                                                                                                                             | `844502cb`               | `meta-catalogue-order-pool`: demand 3 RED, 2 GREEN; both units still given back                                                                                                                                                                                 | **CONFIRMED AND FIXED**                                                                                                                                                                  |
| G-4 three connections per lane: standalone customer text | **IMPORTANT** (independent audit)                     | `sendCustomerText` without the caller's transaction tokenised inside its reservation transaction, and the gateway's lookups each took another connection (`payment.link` catalogue checkout under the runner; the reminder sweep; API requests)                                                                                                                                | `844502cb`               | `waba-templates-pool`: demand 2 RED, 1 GREEN; the stored text still tokenised                                                                                                                                                                                   | **CONFIRMED AND FIXED**                                                                                                                                                                  |
| Qodo 12                                                  | **IMPORTANT** (metering; the 0227 comment was untrue) | `usage_bind_event` matched a stripped text the closure trigger cannot cast (`{{uuid}}`, a misplaced hyphen): the job's finish closed nothing, the unit stayed refundable for 45 days                                                                                                                                                                                           | `09226f58` (0245)        | `usage-bind-event-job` 4/4 (3 RED at 0244)                                                                                                                                                                                                                      | **CONFIRMED AND FIXED**                                                                                                                                                                  |
| Qodo 13                                                  | **IMPORTANT** (metering)                              | a running job of any kind, or a second live metering job beside the real one, qualified for a binding                                                                                                                                                                                                                                                                          | `09226f58` (0245)        | same file                                                                                                                                                                                                                                                       | **CONFIRMED AND FIXED**; residual (fabricated event) in OD-54                                                                                                                            |
| Qodo 45                                                  | IMPORTANT (Qodo)                                      | a pack spent after a trial ends                                                                                                                                                                                                                                                                                                                                                | `2f723a74`               | as G-1                                                                                                                                                                                                                                                          | **CONFIRMED AND FIXED**                                                                                                                                                                  |
| Ordinary refund race (round F, F-3)                      | IMPORTANT                                             | downgrade plus consumption while the refund waited                                                                                                                                                                                                                                                                                                                             | `0243` (round F)         | 11/11                                                                                                                                                                                                                                                           | **CONFIRMED AND FIXED** (round F; not conflated with G-1)                                                                                                                                |
| Pool correction `04dd32f` (Codex thread r4611348834)     | IMPORTANT                                             | API pool grew with the worker setting                                                                                                                                                                                                                                                                                                                                          | `04dd32f` (round F)      | `app-pool-size` 3/3                                                                                                                                                                                                                                             | **CONFIRMED AND FIXED** (round F); runtime proof G-2                                                                                                                                     |
| Docs: `deploy.md` `trial_starts_in_future` repair        | doc defect (Qodo 42)                                  | the runbook said posting `expired` makes the row pass; 0212 reports such a row active whatever its plan                                                                                                                                                                                                                                                                        | this round's docs commit | —                                                                                                                                                                                                                                                               | **CONFIRMED AND FIXED** (doc); the condition itself is a recorded residual                                                                                                               |
| Docs: D3 `/health` count, handoff migration count        | doc defect                                            | `244`/`0243` and `241`/`0240`                                                                                                                                                                                                                                                                                                                                                  | docs commit              | —                                                                                                                                                                                                                                                               | **FIXED**: 246, `0000` to `0245`                                                                                                                                                         |
| `pnpm docs:check`                                        | process                                               | 18 files failed at `bfa00cf` (not a CI check)                                                                                                                                                                                                                                                                                                                                  | docs commit              | `docs:check` passes                                                                                                                                                                                                                                             | **FIXED**: formatting only; three path globs prettier turned into emphasis (`operator-plane/*`, `plan-*`/`pack-*`, `health/*`/`api/*`) restored as code (the last two found by review B) |

### Qodo's other findings

Qodo marks 1 to 25 partly resolved; the round's two independent read-only triages checked every
unresolved item against the tree. Beyond the rows above:

- **Fixed at head:** 3, 16, 17, 34, 40, 63, 65.
- **Not applicable:** 14 (the shipped image sets `NODE_ENV=production`, and the operator then
  refuses the development secret), 50 (synchronous stdout on Linux), 55 (no settlement credential
  in a production API or worker).
- **Recorded residuals:** 15 (settlement can close or insert its own dead-job records: OD-54, B-3),
  35 (no event-only payment lookup: OD-53 (5)), 41, 42 (the condition), 51, 53, 56, 66.
- **PR wording only:** 4, 5, 46, 52. The PR description now names its invariants.
- **MINOR, open, recorded here and not fixed:** 1, 2, 27, 28, 29, 30, 31, 32, 33, 36, 37, 38, 39,
  43, 44, 47, 48, 49, 54, 57, 58, 59, 60, 61, 62, 64. None affects financial truth, privacy,
  authorisation, identity, billing or subscription state, metering or a launch-gate claim:
  - display copy: 1, 2, 31, 33, 37, 62;
  - comments and doc comments: 57, 59, 60, 61;
  - test hardening: 29, 36, 38, 39, 64;
  - staging tooling: 30, 32, 49, 58;
  - an inert re-pin pattern the tripwire does not catch: 28;
  - a runbook ordering that fails closed: 27;
  - an export race that spends one unit on an empty file: 43;
  - alert wording: 44;
  - a stall-only payload default: 48;
  - performance of a stopped window: 54;
  - settlement keeping a lease alive: 47. This is no more than settlement declining to run the
    job, which `running -> done` already allows; the withheld-payment reconciliation is OD-53 (4).

## 3. Natural expiry: what was shown, and why 0244 is sufficient

`usage_entitlement` (0222) reads a trial's `plan_expires_at`, the catalogue version in force (when
the pin does not choose one) and the active holdings, all against `now()`, the transaction's
start. Each changes value only at a boundary instant (`plan_expires_at`, `effective_from`,
`effective_to`, `started_at`, `ends_at`), and none is a write the history (0240, 0241) sees.

- **Shown, not assumed.** In each case the refund is observed in `pg_stat_activity` blocked on the
  charge row, with a transaction start before the boundary. The database's own clock is then waited
  past the boundary, and the consumption is committed on the application credential. Boundaries are
  read from the database clock, so the test depends on neither the runner's clock nor scheduling.
- **The fix.** The refund refuses (OD-55, same message) when any boundary of this unit lies in
  `(least(now(), recorded entitlement time, credit), clock_timestamp()]`, with the clock read after
  the counter lock:
  - every consumption counted in `used` committed before that lock, so it started, and judged its
    own allowance, inside the window;
  - none can commit after the lock until the refund ends;
  - with no boundary in the window the allowance was constant across it, so the existing equality
    check becomes a check of the whole interval.
- **Rejected.**
  - Evaluating `usage_entitlement` at the clock still misses a dip.
  - Changing `usage_entitlement` itself would change every consumer's metering.
  - A global `now()` to `clock_timestamp()` would let two statements of one consumption disagree.
- **Unchanged.** Lock order (charge, then counter), owner, grants, signature, result, messages,
  every earlier refusal, and integer kobo.
- **The new function.** Owned by the migration owner, not `SECURITY DEFINER`, executable by no
  runtime role, and it requires the tenant pin.
- **Pins.** The smoke pins the refund by md5 and the boundary function by body, owner, attributes
  and no grant, with seven tampers.
- **Supported states only.** A trial pack credits to `TRIAL00` (0224). An expired trial meters
  nothing of its own, but the database still lets bonus units be spent (the application refuses
  writes after expiry; the test drives the database boundary). A holding's future `ends_at` is the
  supported cancellation (`addOnsRepo.endHolding`). No runtime role writes a holding today (0226),
  so the holding cases model settlement's write as the owner, as the round F suite does.

## 4. Connection budget

Ceilings per process, from the code. Pools open lazily, so these are maximums, not steady use.

| Process                          | Pools                                      | Default | Worst case                                               |
| -------------------------------- | ------------------------------------------ | ------- | -------------------------------------------------------- |
| `api`                            | app 10, worker 8, lock 4                   | 22      | 22                                                       |
| `worker`                         | app `max(10, lanes + 2)`, worker 8, lock 4 | 22      | 30                                                       |
| `settlement`                     | `2 × lanes + 2`                            | 6       | 34                                                       |
| `operator`                       | 4                                          | 4       | 4                                                        |
| `migrate`, backups, admin `psql` | while running                              | 2       | 3                                                        |
| **Estate**                       |                                            | **56**  | **93**, against PostgreSQL's default 100 less 3 reserved |

The host's real `max_connections` is not repository evidence; P3a reads it.

`lanes + 2` is enough only while each lane holds at most its runner transaction plus one more, and
the pump and sweeps never hold an application connection while waiting for another. An independent
read-only audit traced every handler and sweep:

- the two violations it found are fixed (G-4);
- every other handler is at most two;
- the worker and lock pools carry claims, heartbeats, failure records and advisory locks, so no
  lane waits on them while holding an application connection in a way that can close a cycle.

Its stated limits: the 5,800-line `inbound-message.handler.ts` was covered by searching every pool
use rather than reading every helper, and the row-lock self-wait form was spot-checked.

Other correctness the fixes keep:

- the runner fence and completion are unchanged;
- checkout idempotency, one live attempt per charge and provider-session reuse are unchanged (the
  runtime test asserts one session per charge);
- the give-backs still attempt both units and throw if either fails;
- tokenisation writes now commit with the reservation that needed them.

## 5. Verification on the final candidate

**Environment:** Node 24.22.3, pnpm 9.15.9, PostgreSQL 16.15. The cloud session uses fresh databases
and runs serially. CI uses ubuntu-latest with `postgres:16-alpine`.

**Code under test:** `0b0bea68`. Its successors change no executable code:

- `a10b7798`: docs, plus the text of one error message in `scripts/deploy-staging.sh`;
- the record commit: docs.

The db shards, the script tests, the guards, `docs:check` and the browser suites ran on the
`a10b7798` tree.

| #        | Check                                                                    | Command                                                                                                                                                                                                                           | Result                                                                                         |
| -------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1        | Frozen install                                                           | `pnpm install --frozen-lockfile`                                                                                                                                                                                                  | ok                                                                                             |
| 2 to 5   | Typecheck, lint, unit, build                                             | `pnpm turbo typecheck lint test build --force`                                                                                                                                                                                    | 24/24 tasks, 0 cached                                                                          |
| 6        | db integration, unsharded, fresh database migrated 0000 to 0245          | `vitest run --config vitest.integration.config.ts` (packages/db)                                                                                                                                                                  | **2313/2313**, 170 files, 0 skipped                                                            |
| 7        | api integration, unsharded                                               | same (apps/api)                                                                                                                                                                                                                   | **2818/2818**, 193 files, 0 skipped                                                            |
| 8        | db shards                                                                | `--shard=1/2`, `--shard=2/2`, a fresh database each                                                                                                                                                                               | 1161 + 1152 = 2313                                                                             |
| 9        | api shards                                                               | same                                                                                                                                                                                                                              | 1495 + 1323 = 2818                                                                             |
| 10, 11   | Fresh install; upgrade from `main` (0192) and from 0212 with seeded data | inside the db run: `upgrade-from-main`, `upgrade-od51`, through 0245                                                                                                                                                              | pass                                                                                           |
| 12       | Foreign-owner migrations                                                 | CI job "Migrations (foreign owner)"                                                                                                                                                                                               | green on `0b0bea68` and `a10b7798`                                                             |
| 13       | Deploy smoke and tampers                                                 | `deploy-smoke-sql*` in the db run                                                                                                                                                                                                 | pass (187 in the ops folder, 9 new tampers)                                                    |
| 14 to 16 | Guards                                                                   | `check-boundaries`, `check-env-example`, `check-deploy`, `check-vendored-skills`, `check-staging-deploy`, `check-node-version`, `check-ui-copy`, `check-retired-claims`, `check-openapi`, `check-test-layout`, `check-test-years` | all OK                                                                                         |
| 17       | Script tests                                                             | `node --test scripts/*.test.mjs`                                                                                                                                                                                                  | 457/457, 0 skipped, 0 todo                                                                     |
| 18       | Documentation                                                            | `pnpm docs:check`                                                                                                                                                                                                                 | passes (it failed on 18 files at `bfa00cf`)                                                    |
| 19       | Playwright, main                                                         | `playwright test`                                                                                                                                                                                                                 | **92/92**                                                                                      |
| 20       | Purchase journey                                                         | `pnpm --filter @rekoda/web e2e:journey`                                                                                                                                                                                           | **34/34**                                                                                      |
| 21       | Reminder screens                                                         | `pnpm --filter @rekoda/web e2e:reminders`                                                                                                                                                                                         | **10/10**                                                                                      |
| 22       | Secret scan, full history, all refs                                      | gitleaks 8.24.3 `detect --source . --redact --log-opts=--all`                                                                                                                                                                     | 1314 commits, no leaks                                                                         |
| 23       | Docker deployment smoke                                                  | CI job "Deployment (Docker)"                                                                                                                                                                                                      | green on `0b0bea68` and `a10b7798`; **not run locally** (no Docker daemon in this environment) |
| 24       | Pool runtime                                                             | `renewal-initiate-pool`                                                                                                                                                                                                           | 2/2, stable over 3 runs, in the api run                                                        |
| 25       | Natural-expiry refund                                                    | `pack-refund-natural-expiry`                                                                                                                                                                                                      | 6/6 in the db run                                                                              |

**CI.**

- Run 44305263631 on `0b0bea68`: every check green.
- Run 44306897881 on `a10b7798`: every check green.
- The run on the record commit is named in the PR description.

**Disclosed local failures, both environmental, none weakened or skipped:**

- The first db run failed every file in setup because my script dropped the database without
  migrating it. CI migrates first; the re-run passed.
- The first browser runs could not find Playwright's own Chromium build. They were re-run with
  `REKODA_CHROME` pointing at the installed Chromium, which the config supports.
- The first journey run inherited this session's `SETTLEMENT_DATABASE_URL` and
  `OPERATOR_DATABASE_URL`, pointing at another database. CI sets neither. The re-run with CI's
  exact environment passed.

## 6. Independent review

The reviews were read-only fresh contexts. None of them built the fixes.

**Connection-pool audit (before the fixes).** It found G-4, the two three-connection paths, and
the reminder sweep's hold-and-wait. All are fixed.

**Qodo triage, two contexts (items 1 to 33 and 34 to 66).** They found Qodo 12 and 13 IMPORTANT
(fixed in 0245). The rest are as in §2.

**Review A: database, financial and security, `bfa00cf..0b0bea68`. BLOCKING 0, IMPORTANT 0.**

1. 0244's comment overstates one point. A consumer whose transaction started before the credit
   and waited on the credit's counter lock started before the window. That is harmless: it
   refuses conservatively in one direction and is entitled in the other. The comment is part of
   the md5-pinned body, so it stays, and the record is here.
2. `usage_bind_event` is pinned by text fragments, not an md5. That is consistent with earlier
   rounds, and the 0227 body is refused.
3. The application credential can make a genuine bind fail by enqueueing a twin job. That is
   self-denial, within OD-54.

**Review B: API runtime, budget, tests and docs, same delta. BLOCKING 0, IMPORTANT 0.**

1. Stale 0243 counts in HANDOFF and CURRENT_STATE: fixed in `a10b7798`.
2. A deploy error message named the old runbook heading: fixed.
3. Two more `*`→`_` rewrites by prettier: restored as code.
4. A row-lock wait on a customer row another job created but has not committed is bounded by the
   statement and idle-in-transaction timeouts, not by the pool argument: now stated in
   `deploy.md`.
5. The catalogue pool test does not probe the gateway's own pool calls, which are sequential
   today. Recorded as a test limitation.

It also verified:

- drizzle opens a SAVEPOINT for the caller's transaction;
- the pin is unchanged;
- the conflict-retry loop still works;
- every budget figure, and all 246 migrations and 45 tags.

**External reviewers.**

- **Codex:** "no major issues" on `bfa00cf` (history). A review of the final head is requested
  on the PR, and its receipt or absence is recorded there.
- **CodeRabbit:** skipped itself on every head (the file limit). That is not a review.
- **Qodo:** last updated 10:21 UTC on `bfa00cf`. §2 dispositions every finding.
- **Threads:** 47, 0 unresolved, on `bfa00cf`. Re-read on the final head before any merge.

## 7. Owner decisions after this round (OWN-95, 18 Nov 2026)

Recorded after round G, on top of `92b5790b5cfb35b28ea1f838b8eeb4c59933487a`, in a docs-only
commit. The implementation and its evidence above are unchanged.

- ADR 0035 Amendment 6 is **accepted for isolated test-mode staging only**. Paid-production
  acceptance is PENDING. The residuals of §2 and of the ADR are accepted within that scope only.
- The ADR no longer says it "takes effect with the owner's acceptance of the PR (P12)". P12
  authorises merging one exact candidate and is not architectural acceptance. The privileges apply
  wherever the migrations are applied.
- P11 (the deployment approval gate) is to be enabled for the first deploy. Initial staging keeps
  4 worker lanes and 2 settlement lanes.
- OD-53 to OD-56 and C1 to C6 are unchanged; OD-53 (4) and (5) remain paid-launch blockers.
- **P12 NOT given.** The final candidate is the head named in the PR description.
