# PR #432 final closeout round (F), 18 Nov 2026

Status: **CODE COMPLETE, PR OPEN, NOT MERGED, NOT DEPLOYED. STAGING ACCEPTANCE PENDING. P12 NOT
GIVEN. ADR 0035 Amendment 6 PROPOSED, NOT ACCEPTED.** This round carries out the owner's two
instructions of 18 Nov 2026 ("Final Action Instructions and Merge Readiness Closeout" and "Reconcile
PR #432 Closeout Routine with Latest Engineering Remediation"). Nothing here merges, deploys, accepts
an ADR or makes an owner decision.

## 1. Branch reconciliation

| Step                                          | Result                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `angelo/magical-bell-s81mqc` (PR head) before | `0b4956ab985009291f3e3aaa4136516e0839d6e5`, unchanged on the remote when re-fetched                           |
| `angelo/magical-bell-2ht8ys` (engineering)    | `d976b21a06aaef4d5e3939bdd32a717cce4b21ef`                                                                    |
| Relationship                                  | `git merge-base --is-ancestor` true; `rev-list --left-right --count` 0 behind, 5 ahead                        |
| The five commits                              | `692fbb5` (0241), `2be51d1`, `5fee6b2`, `84399be`, `d976b21`; author and committer the owner                  |
| Push                                          | ordinary fast-forward `0b4956a..d976b21` (owner authorisation of 18 Nov 2026); no force, no rewrite           |
| This round's commits                          | fast-forwards on top of `d976b21`; `commit-register-remediation.md` #224 onwards (#220 to #223 are round E's) |

Preserved and not reopened: E-1 (inherited worker privilege, 0241), F-1 (trial-expiry history,
0241), F-4 (monotonic history time, 0241), D-5 (constraint verification; extended below) and B-6/F3
(independent retention inventory). Their regression tests are unchanged.

## 2. Findings and their disposition

| ID          | Severity                       | Finding                                                                                                                                                                                 | Disposition                                                                                                                                                                                                               |
| ----------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1         | **IMPORTANT** (owner)          | Settlement could move done or dead billing jobs back to pending, reset a job's retry budget, or park it, outside the OWN-73/OWN-76 recovery                                             | **FIXED** (0242): `jobs_settlement_transition_guard`, by privilege, owner exempt; claim +1, renewal, retry/reclaim, deferral −1, completion, death; run time at most 10 min ahead. Operator recovery unchanged and tested |
| E-F4        | **IMPORTANT** (owner)          | A reclaimed job whose death cannot be recorded stays `running` with only a count                                                                                                        | **FIXED**: `queueHealth.stuckRunning` by kind, `oldestStuckSeconds`; alert `jobs.stuck_running` once per cooldown, resolved only when the job moves; the reclaim logs id, kind, SQLSTATE; `incident.md` procedure         |
| F-3         | **IMPORTANT** (review A)       | A downgrade (or a holding ending, or a trial expiring) committing while the refund waited for the counter, then consumption spending pack units, let a spent pack be refunded as unused | **FIXED** (0243): the allowance is judged after the counter lock. RED reproduced deterministically; the other forced interleavings recorded (§4). My first conclusion (not reproducible, no change) was wrong             |
| F-2         | user-facing (owner)            | The billing page kept saying "switching your plan on now" after a withdrawal or a stopped job                                                                                           | **FIXED**: overview `noChargeUpgrade` (`processing`, `applied`, `withdrawn`, `failed`); the notice follows it, says nothing for none or a replaced request, and names the plan once on                                    |
| F-2 (E-1)   | **IMPORTANT** (review E)       | A pending ₦0 upgrade appeared as "Pay for your plan ₦0" with Paystack buttons and "Awaiting payment", beside "Nothing was charged"                                                      | **FIXED**: a ₦0 charge is never a charge waiting for money; the history says "Switching plan" / "No charge"                                                                                                               |
| D-5 residue | completion of review 6's MINOR | The smoke matched actor constraints by name and a `LIKE`                                                                                                                                | **FIXED**: nine constraints matched by schema, table, name, column, validation and exact definition                                                                                                                       |
| B-1 (round) | **IMPORTANT** (review B)       | The exact smoke mapped `$` to `@` on the live side, so a literal-`@` regex passed; the guard pins ignored `SECURITY DEFINER`, `search_path` and comment-padded bodies                   | **FIXED**: the anchor is mapped on the expected side only; both transition guards and the refund function are pinned by md5 of their exact body, language and attributes                                                  |
| D-I2        | **IMPORTANT** (review D)       | The 10-minute run-time bound of 0242 had no test                                                                                                                                        | **FIXED**: an ATTACK test (11 min, 1 day, infinity; a pending job) and the capped 5-minute backoff passing; a mutation without the clause fails it                                                                        |
| D-I1        | **IMPORTANT** (review D)       | The verification pointers were circular and the PR description named an older head                                                                                                      | **FIXED**: §5 below records the exact-head evidence; the PR description is rewritten on the final head                                                                                                                    |
| E-F1        | MINOR                          | The 0239 draft (`ebb8d79`) was not detected                                                                                                                                             | **FIXED** by the exact smoke (tamper case)                                                                                                                                                                                |
| E-F5        | MINOR (pre-existing)           | A restore into a new database drops 0109's `REVOKE TEMPORARY`                                                                                                                           | **FIXED in the drill**: re-applied from `BACKUP_DATABASE_REVOKES_SQL` and checked; tied to 0109 by a script test                                                                                                          |
| E-F6        | MINOR                          | The drill's BYPASSRLS check proves nothing in container mode                                                                                                                            | **DOCUMENTED, bounded** (`deploy.md`, supported configuration)                                                                                                                                                            |
| E-F7        | MINOR                          | A non-superuser migration owner is untested                                                                                                                                             | **DOCUMENTED, unsupported configuration** (the image's superuser `rekoda_owner`)                                                                                                                                          |
| E-F8        | MINOR (deploy safety)          | No guard forced a new migration to be classified                                                                                                                                        | **FIXED**: `ADDITIVE_MIGRATIONS`; `scripts/deploy-staging-classes.test.mjs` in CI                                                                                                                                         |
| E-F9        | MINOR (docs)                   | Key rotation and settlement                                                                                                                                                             | **ALREADY DOCUMENTED** in `key-rotation.md`                                                                                                                                                                               |
| E-F10       | MINOR                          | Settlement has no `depends_on: api` on a fresh install                                                                                                                                  | **DOCUMENTED, bounded**: it refuses to boot until the key is enrolled and is restarted; compose unchanged                                                                                                                 |
| Runbooks    | docs                           | The staging runbook named 0240 beside 242 migrations; P7 and D8 did not name their schema                                                                                               | **FIXED**: 0000 to 0243, 244 migrations, 43 smoke tags; P7 drills 193/`0192_…`, D8 244/`0243_…`                                                                                                                           |

**Recorded, not fixed (MINOR; none affects financial truth, privacy, authorisation, identity,
billing, subscription state, metering or a launch-gate claim):** a claim followed by a deferral
leaves settlement's attempts unchanged (review B; no worse than not running the job; ADR 0035 Am. 6
states it); the pre-start smoke runs only for a release carrying a breaking migration and `migrate`
sets no `lock_timeout` (review C; stated in `deploy.md`); `role="status"` on content present at load
(review E; matches the page's other strips); the F-2 notice is not shown beside the OWN-76 billing
notice (review E; the two concern different things and do not contradict); S-2
(`email_address_erasures.operator`, on `main`) and S-3 (0234's header word) as recorded in round E;
18 audit and canonical files fail `pnpm docs:check` formatting, as before this round (not a CI
check). Each intermediate commit of this round was not re-run on its own; register rows record the
evidence, and the head is what CI and §5 verify.

## 3. RED before GREEN

| Finding    | Test (file › title)                                                                                                                     | RED (before the fix)                                                                                            | GREEN |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----- |
| S-1        | `packages/db/src/ops/settlement-job-transitions.integration.test.ts` › three ATTACK tests                                               | 3 failed at 0241: `done -> pending` allowed; an inheriting role "revived 1 done job(s)"; budget reset "allowed" | 6/6   |
| S-1 (D-I2) | same file › "cannot park a job far ahead"                                                                                               | with the run-time clause removed from the guard: failed                                                         | 6/6   |
| E-F4       | `apps/api/src/health/stuck-job-alert.integration.test.ts` (2); `packages/core/src/ops-alerts.test.ts` (2 new)                           | api 2/2 and core 2 failed at `d976b21`                                                                          | pass  |
| F-3        | `packages/db/src/billing/pack-refund-concurrency.integration.test.ts` › "a downgrade and consumption that spends the pack ..."          | at 0242: the refund answered `refunded` with 51 pack units spent                                                | 11/11 |
| F-2        | `apps/api/src/billing/no-charge-upgrade-status.integration.test.ts` (4)                                                                 | 4/4 failed at `d976b21`                                                                                         | 4/4   |
| F-2 (E-1)  | `apps/web/src/lib/billing-pay-copy.test.ts` › "a zero-priced upgrade is never offered as a payment" (2)                                 | 2 failed: a ₦0 pending charge was the pay card's charge, labelled "Awaiting payment"                            | pass  |
| F-2        | `apps/web/e2e/billing-journey-no-charge-upgrade.spec.ts` (2 × mobile, desktop): notices, no pay card, history labels                    | the notice and labels did not exist                                                                             | 4/4   |
| Smoke      | `packages/db/src/ops/deploy-smoke-sql-closeout.integration.test.ts`                                                                     | 13 of 15 tampers printed `t` with the `d976b21` smoke; review B's 6 printed `t` at `2a6fa1c`                    | 24/24 |
| E-F8       | `scripts/deploy-staging-classes.test.mjs` (2)                                                                                           | no `ADDITIVE_MIGRATIONS` existed                                                                                | 2/2   |
| E-F5       | `scripts/backup-scripts.test.mjs` › "the drill re-applies 0109's database-level revokes"; a scratch database: 5 roles with TEMP, then 0 | the drill applied no revoke                                                                                     | 20/20 |

Changed existing assertions, none weakened: the empty-queue exact shapes
(`ops-health.integration.test.ts`, `ops.integration.test.ts`) gained the new zero fields; the reclaim
statement test (`dead-job-enrolment-pin.test.ts`) matches the new `SELECT id, kind` with every
assertion kept; the upgrade suites extend to 0243; two F-3 tests written earlier in this round
asserted that a change committing while the refund waited was ordered after it, which review A
showed unsafe, and now assert it is seen and refused (a new test covers a change after the refund's
checks, which is ordered after it and recorded in the history).

## 4. F-3: what PostgreSQL guarantees, and the evidence

`subscription_record_refund` runs in READ COMMITTED; PL/pgSQL takes a fresh snapshot per statement.
Since 0243 its order is: lock the charge row (`FOR UPDATE`); lock the period's counter row
(`FOR UPDATE`) and read `used` and `bonus`; read the recorded allowance, `usage_entitlement` and the
allowance history; judge; revoke, record, mark, audit.

- **Before 0243** the allowance was read before the counter lock. While the refund waited for the
  counter, a downgrade could commit and consumption, metered by `usage_reserve` against the lower
  allowance plus the pack's bonus, could spend pack units and commit; the refund then judged `used`
  against the allowance recorded at the credit and refunded a spent pack. Reproduced (Complete, a
  100-unit pack, 350 used; downgrade to Chat; 101 more reserved; refunded).
- **Now** any consumption committed before the counter lock is granted is in `used`, and any
  allowance change it relied on committed before it, so the later statement sees it and the refund
  goes to the owner (OD-55). After the lock no consumption can commit until the refund ends, and a
  plan change committing then is ordered after the refund and recorded in the history (tested,
  `changed_at` advances).
- **Consumption:** `usage_reserve` checks its limit in `ON CONFLICT DO UPDATE ... WHERE`, evaluated on
  the locked latest row: a reservation waiting behind a refund sees the revocation; a reservation
  committed first is seen by the refund. Both forced.
- **Concurrent refunds:** one pack serialises on its charge row; two packs on one counter serialise on
  the counter row and the second reads the first's revocation. Forced.
- **Lock order:** refund and pack credit take the charge, then the counter; consumption the counter
  alone; plan writers neither. 0243 adds no lock, so there is no cycle and no deadlock.
- **Rollback:** a refund that rolls back leaves no refund row, no revocation and no charge change.
- **Why not a `businesses` lock:** the counter lock already orders consumption against the refund;
  a `businesses` lock would add a lock-order question with every plan writer for no gain.

## 5. Verification on the final candidate

See the PR description, which names the exact final SHA, the commands, the environment, the counts
and the CI run; it is the record the owner reviews. A run on an earlier SHA is history.

## 6. Independent review

Five fresh read-only reviews of `d976b21..2a6fa1c`, one per risk domain (financial, security,
runtime and deploy, tests and docs, product and copy). BLOCKING 0. IMPORTANT 6, all fixed above
(review A: F-3; review B: two smoke gaps; review D: the run-time test and the verification record;
review E: the ₦0 pay card). Review C found none. A fresh read-only review of the fix delta `2a6fa1c..b1896d6` found 0 BLOCKING and 1 IMPORTANT:
the smoke pinned the guard functions but not their trigger bindings (`AFTER INSERT`, `UPDATE OF
payload` or `WHEN (false)` still printed `t`). Fixed: both triggers must be `BEFORE UPDATE` row
triggers on every column, with no `WHEN`, bound to their own functions (four tampers, RED with the
previous smoke, GREEN 178/178 smoke tests). Its MINORs: 0243's comments overstated what it closes
for an allowance that ends by time with no write (corrected; the millisecond residual is stated in
the migration, as it was for 0240); the runbook's hand-run smoke step said to source the deploy
script, which runs the deploy (replaced with an exact extraction); the refund function pin does not
cover `STRICT` (no effect: every argument is already checked). That review also, by following a
command in its brief, sourced `scripts/deploy-staging.sh` locally: the only effect was a
`git fetch --prune` of remote-tracking refs; no branch, checkout, file, database or service was
changed (remote branches verified).
