# PR #432 final closeout round (F), 18 Nov 2026

Status: **CODE COMPLETE, PR OPEN, NOT MERGED, NOT DEPLOYED. STAGING ACCEPTANCE PENDING. P12 NOT
GIVEN. ADR 0035 Amendment 6 PROPOSED, NOT ACCEPTED.** This round carries out the owner's two
instructions of 18 Nov 2026 ("Final Action Instructions and Merge Readiness Closeout" and "Reconcile
PR #432 Closeout Routine with Latest Engineering Remediation"). Nothing here merges, deploys, accepts
an ADR or makes an owner decision.

## 1. Branch reconciliation

| Step                                              | Result                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `angelo/magical-bell-s81mqc` (PR head) before     | `0b4956ab985009291f3e3aaa4136516e0839d6e5`, unchanged on the remote when re-fetched                   |
| `angelo/magical-bell-2ht8ys` (engineering branch) | `d976b21a06aaef4d5e3939bdd32a717cce4b21ef`                                                            |
| Relationship                                      | `git merge-base --is-ancestor` true; `rev-list --left-right --count` 0 behind, 5 ahead                |
| The five commits                                  | `692fbb5` (0241), `2be51d1`, `5fee6b2`, `84399be`, `d976b21`; author and committer the owner          |
| Push                                              | ordinary fast-forward `0b4956a..d976b21` (owner authorisation of 18 Nov 2026); no force, no rewrite   |
| This round's commits                              | on top of `d976b21`, pushed as fast-forwards; listed in `commit-register-remediation.md` #221 onwards |

Preserved and not reopened: E-1 (inherited worker privilege, 0241), F-1 (trial-expiry history,
0241), F-4 (monotonic history time, 0241), D-5 (constraint verification; extended below, not
reverted) and B-6/F3 (independent retention inventory). Their regression tests are unchanged.

## 2. Findings of this round and their disposition

| ID          | Severity (owner)                   | Finding                                                                                                                                                                                                                      | Disposition                                                                                                                                                                                                                                                                                              | Commit    |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| S-1         | **IMPORTANT** (raised from MINOR)  | Settlement could move done or dead billing jobs back to pending (and reset a job's retry budget or park it), outside OWN-73/OWN-76 recovery                                                                                  | **FIXED** (0242): `jobs_settlement_transition_guard`, by privilege (`pg_has_role`), owner exempt; claim +1, renewal, retry/reclaim, deferral −1, completion, death; run time ≤ 10 min ahead. Operator recovery (application credential) unchanged and tested                                             | `e25702b` |
| E-F4        | **IMPORTANT**                      | A reclaimed job whose death cannot be recorded stays `running` with only a count                                                                                                                                             | **FIXED**: `queueHealth.stuckRunning` (payment / billing / other) and `oldestStuckSeconds`; the G-26 alert `jobs.stuck_running` (critical for money kinds) once per cooldown, resolved only when the job moves; reclaim logs id, kind, SQLSTATE; incident runbook procedure                              | `08c8b6e` |
| F-3         | owner: do not dismiss              | Refund vs concurrent plan change (and the other interleavings)                                                                                                                                                               | **NOT REPRODUCIBLE; evidence recorded** (§4): nine forced interleavings on separate connections; the result always equals a serial order; no code change. A mutation (no counter `FOR UPDATE`) fails two of them                                                                                         | `7090101` |
| F-2         | user-facing correctness            | The billing page kept saying "switching your plan on now" after a withdrawal or a stopped job                                                                                                                                | **FIXED**: overview `noChargeUpgrade` (`processing`, `applied`, `withdrawn`, `failed`, from the charge and its job; defaults to null); the page notice follows it                                                                                                                                        | `e141258` |
| D-5 residue | completion of review 6's MINOR     | The smoke matched actor constraints by name and a `LIKE` on the definition: a decoy on another table or schema, `CHECK (true OR ...)`, another column, `NOT VALID`, and a dropped refund or enrolment actor check all passed | **FIXED**: nine constraints matched by schema, table, name, `conkey` column, validation and exact definition; 0239's intentionally NOT VALID one may be validated later. 0242 pinned (42 tags)                                                                                                           | `f3e3fb0` |
| E-F1        | MINOR                              | The 0239 draft (`ebb8d79`) was not detected                                                                                                                                                                                  | **FIXED** by the exact smoke (tamper case "the 0239 draft"); 0238's draft was already caught                                                                                                                                                                                                             | `2d6f02c` |
| E-F5        | MINOR (pre-existing)               | A restore into a new database drops 0109's `REVOKE TEMPORARY`                                                                                                                                                                | **FIXED in the drill**: re-applied from `BACKUP_DATABASE_REVOKES_SQL` and checked (no runtime role keeps TEMP); the real restore's commands are tied to 0109 by a script test                                                                                                                            | `2d6f02c` |
| E-F6        | MINOR                              | The drill's BYPASSRLS check proves nothing in container mode                                                                                                                                                                 | **DOCUMENTED, bounded**: the container creates the roles itself; the check is meaningful with `DRILL_DATABASE_URL` and in a real restore (`deploy.md`, supported configuration)                                                                                                                          | `2d6f02c` |
| E-F7        | MINOR                              | A non-superuser migration owner is untested                                                                                                                                                                                  | **DOCUMENTED, unsupported configuration**: the owner is the image's superuser (`POSTGRES_USER: rekoda_owner`); CI's foreign-owner job proves no migration names the owner                                                                                                                                | `2d6f02c` |
| E-F8        | MINOR (material for deploy safety) | No guard forced a new migration to be classified                                                                                                                                                                             | **FIXED**: `ADDITIVE_MIGRATIONS` beside `COMPAT_BREAKING_MIGRATIONS`; `scripts/deploy-staging-classes.test.mjs` (in CI) fails a migration in neither or both; the reviewed breaking set is pinned                                                                                                        | `2d6f02c` |
| E-F9        | MINOR (docs)                       | Key rotation and settlement                                                                                                                                                                                                  | **ALREADY DOCUMENTED** in `key-rotation.md` (settlement holds `VAULT_KEY` and `PAYSTACK_SECRET_KEY`, never enrols; rotate API first, then settlement)                                                                                                                                                    | —         |
| E-F10       | MINOR                              | Settlement has no `depends_on: api` on a fresh install                                                                                                                                                                       | **DOCUMENTED, bounded**: settlement refuses to boot until the API or worker enrols the vault key and `restart: unless-stopped` retries it; it settles nothing meanwhile. Fresh-install order stated in `deploy.md`; compose unchanged (a `depends_on` would also start the API with any `up settlement`) | `2d6f02c` |
| Runbooks    | docs                               | The staging runbook named 0240 beside a count of 242; P7 and D8 did not name their schema                                                                                                                                    | **FIXED**: 0000–0242, 243 migrations, 42 smoke tags; P7 drills the schema staging runs now (193, `0192_…`), D8 the deployed one (243, `0242_…`)                                                                                                                                                          | `2d6f02c` |
| S-2         | MINOR (on `main`)                  | `email_address_erasures.operator` keeps `^operator:`                                                                                                                                                                         | Unchanged, recorded (OD-41 (xxxi)); outside PR B's actor set                                                                                                                                                                                                                                             | —         |
| S-3         | MINOR (docs)                       | 0234's header word "dying"                                                                                                                                                                                                   | Unchanged; ADR 0035 Am. 6 states it exactly                                                                                                                                                                                                                                                              | —         |

## 3. RED before GREEN

| Finding | Test (file › title)                                                                                                                                           | RED (at `d976b21` or with the fix removed)                                                                                                                        | GREEN      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| S-1     | `packages/db/src/ops/settlement-job-transitions.integration.test.ts` › three ATTACK tests                                                                     | 3 failed: `done -> pending` allowed for the real role; an inheriting role "revived 1 done job(s)"; a budget reset "allowed"; the two legitimate-path tests passed | 5/5        |
| E-F4    | `apps/api/src/health/stuck-job-alert.integration.test.ts` (2); `packages/core/src/ops-alerts.test.ts` (2 new)                                                 | api 2/2 failed (no per-job detail: `jobs is not iterable`; `stuckRunning` undefined); core 2 failed (no alert)                                                    | 2/2; 19/19 |
| F-2     | `apps/api/src/billing/no-charge-upgrade-status.integration.test.ts` (4)                                                                                       | 4/4 failed: `noChargeUpgrade` undefined                                                                                                                           | 4/4        |
| F-2     | `apps/web/src/lib/billing-pay-copy.test.ts` › `noChargeUpgradeCopy (F-2)` (3); `apps/web/e2e/billing-journey-no-charge-upgrade.spec.ts` (2 × mobile, desktop) | the function and the page notice did not exist                                                                                                                    | 44/44; 4/4 |
| Smoke   | `packages/db/src/ops/deploy-smoke-sql-closeout.integration.test.ts` (16)                                                                                      | against the `d976b21` smoke: 13 of the 15 tampers then present printed `t`                                                                                        | 16/16      |
| E-F8    | `scripts/deploy-staging-classes.test.mjs` (2)                                                                                                                 | no `ADDITIVE_MIGRATIONS`: the classification could not be checked                                                                                                 | 2/2        |
| E-F5    | `scripts/backup-scripts.test.mjs` › "the drill re-applies 0109's database-level revokes" ; a scratch database: 5 runtime roles with TEMP before, 0 after      | the drill applied no revoke                                                                                                                                       | 20/20      |
| F-3     | `packages/db/src/billing/pack-refund-concurrency.integration.test.ts` (9)                                                                                     | not reproducible on the product; with the counter `FOR UPDATE` removed: 2 failed                                                                                  | 9/9        |

Two existing assertions changed, both to include the new queue fields (`stuckRunning`,
`oldestStuckSeconds`) in an exact-shape expectation of an empty queue
(`packages/db/src/ops/ops-health.integration.test.ts`, `apps/api/src/health/ops.integration.test.ts`):
stronger, not weaker. No test was skipped, removed or weakened.

## 4. F-3: what PostgreSQL guarantees here, and the evidence

`subscription_record_refund` runs in READ COMMITTED; PL/pgSQL takes a new snapshot per statement.
Its order: S1 the charge row `FOR UPDATE`; S2 the recorded allowance, `usage_entitlement` and the
allowance history (no lock); S3 the period's counter row `FOR UPDATE`, reading `used` and `bonus`
of the latest committed version; S4 the revocation, the refund row, the charge, the audit row.

- A plan or holding change committed before S2 is in S2's snapshot: the refund is refused (OD-55).
  Forced: the refund held at S1 by a lock on the charge; the plan change commits; refused.
- One committed after S2 is not seen. The outcome equals the serial order "refund, then change":
  the plan writers read and write neither the pack charge nor the counter, the refund reads nothing
  they write after S2, and the change's history row is recorded for any later refund. Forced with the
  refund held at S3 (plan upgrade, add-on holding, same-plan renewal): the refund records once, the
  change applies after it, every fact equals the serial result.
- Consumption: `usage_reserve` checks its limit in `ON CONFLICT DO UPDATE ... WHERE c.used + p_n <=
ceiling + c.bonus`, evaluated on the locked latest row. A reservation committed while the refund
  waits at S3 is seen and the pack is refused as used; a reservation waiting behind a refund sees the
  revocation and is refused. Both forced.
- Concurrent refunds: one pack serialises on its charge row (the second refused, units revoked once);
  two packs on one counter serialise on the counter row, and the second reads the first's
  revocation. Forced.
- Lock order: refund and pack credit take charge then counter; consumption the counter alone; plan
  writers neither. No cycle exists, so no deadlock; the forced two-pack case completes.
- Rollback: a refund in a transaction that rolls back leaves no refund row, no revocation and no
  charge change. Forced.
- Why not add a `businesses` lock: none of the above needs it, and it would introduce a lock-order
  question with every plan writer (which lock `businesses` first) for no correctness gain.

## 5. Verification on the final candidate

Recorded in `README.md` §7 and in the PR description against the exact final SHA, with commands,
environment, counts and CI links.

## 6. Independent review and external reviewers

Recorded in `README.md` §7 after the review of the final head.
