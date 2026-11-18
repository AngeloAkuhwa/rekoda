# PR #432 final closeout review (E), 18 Nov 2026

Status: **CODE COMPLETE, PR OPEN, NOT MERGED, NOT DEPLOYED. STAGING ACCEPTANCE PENDING. P12 NOT
APPROVED. ADR 0035 Amendment 6 PROPOSED, NOT ACCEPTED.** Nothing here authorises a merge, a deploy
or an owner decision. Where this file recommends, the recommendation is engineering advice.

## 1. Baseline

| Item                            | Value                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge base (= `origin/main`)    | `58e6834e4e92efa702756594135f9aa125298cec` (PR A, #431)                                                                                                                     |
| Head reviewed                   | `0b4956ab985009291f3e3aaa4136516e0839d6e5` (docs-only on top of `acf7f34`; CI run 44217506923 green on it)                                                                  |
| Head after this review          | `692fbb5` (fix, 0241), `2be51d1` (docs), `5fee6b2` (G-62 reviewed list) and the docs commit recording §6; on `angelo/magical-bell-2ht8ys`, a fast-forward of PR #432's head |
| Commits / files at `0b4956a`    | 218 commits; 428 files (+52,472 / −3,628 at `acf7f34`)                                                                                                                      |
| Migrations at `0b4956a` / after | 241 (0000–0240) / **242 (0000–0241)**; journal entries equal files, contiguous, tags equal filenames                                                                        |

## 2. How the review was run

Five fresh read-only reviews, none of which built the code they reviewed, each given the PR, the
exact head, the canonical docs and the repository, by distinct risk domain:

1. **Audit coverage and findings reconciliation**: every manifest row against the diff, every commit
   against the registers, every earlier finding re-verified at HEAD, a full scan for test weakening.
2. **Database security**: migrations 0193–0240 with focus on 0231–0240, probed as each runtime role on
   a scratch database migrated 0000–0240 (settlement isolation, the 0238 guard, the actor contract,
   SECURITY DEFINER hygiene, the enrolment cursor).
3. **Financial**: refunds (0235, 0240) and pack eligibility probed with concurrent sessions on a
   scratch database; annual pricing and OD-56; open-ended plans against OWN-33/OWN-34/OD-50; the
   ₦0 upgrade; billing/books separation.
4. **Release engineering**: the migration chain and journal, the deploy script's breaking set and
   smoke pins derived from code, draft-migration detection, compose/Caddy/credentials/audiences,
   Paystack test-mode guards, vault-key checks, backup and restore, and P1–P12.
5. **Owner decisions**: the decision paper for OD-53 (1)–(5), OD-54, OD-55 and OD-56
   (`owner-decisions-od53-56.md`), with the four principals' grants audited from the migrations.

Earlier in the day a fresh review of `738d8cb..acf7f34` (the CI follow-ups) found 0 BLOCKING and
0 IMPORTANT (PR comment of 18 Nov 2026, 01:40 UTC). A Codex review of the current head was requested
once; see §8.

## 3. Audit coverage

- **Base range, `58e6834..095ff62`:** the g1–g6 manifests hold 394 rows for 394 files: 0 missing, 0
  duplicate, 0 phantom. The commit register holds 180 rows for 180 commits.
- **Remediation, `095ff62..0b4956a`:** 100 files. 42 had no delta row: 36 are docs covered by README §6
  or are the audit files; **6 code or test files had none** and are backfilled in the delta
  manifest's fourth round, which also corrects one phantom row and labels the superseded 0238 row.
  The remediation register lacked `acf7f34` and `0b4956a`; both are added (#217, #218), with this
  review's commits (#219, #220).
- **No evil merge:** `cb07772` resolves to `6bd4d64`'s tree exactly.
- **Authorship:** every remediation commit is authored and committed by the owner's identity, with
  no attribution trailers.
- **Test weakening:** no `.skip`, `.only`, `.todo`, `skipIf`, `test.fails` or `xit` was added; no test
  file was deleted. Of 34 test titles on `main` absent at HEAD, 25 are renamed or moved and 9 belong to
  rewrites for owner-ruled behaviour changes (OWN-93, OD-50). Every removed assertion in the
  remediation asserted a defect or was retargeted to a stronger layer. One weaker proof remains and is
  stated: the 0217 policy is now checked by its `WITH CHECK` text, because 0238 refuses first.
- **Stale evidence corrected:** README §7 named older local runs (db at `083b8e1`, api at `738d8cb`,
  "later commits change no api code"), which was false after `39ad27d`, `df1319d` and `91de525`. It now
  points here. README §5 named an R03 test title that does not exist; corrected. D-1, D-2 and D-4 had
  no recorded RED; README §5 now says so.

## 4. Findings of this review and their disposition

| ID                      | Severity                                    | Finding                                                                                                                                                                                                                                                                                                                                     | Disposition                                                                                                                                                                                                  | Evidence                                                                              |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| E-1                     | **IMPORTANT**                               | 0238's worker transition guard tested `current_user <> 'rekoda_worker'`. A role that only inherits `rekoda_worker` holds every worker grant and policy but skipped the guard, so it could move a done job back to running and read its payload (the B-1 attack). 0222 (residual 11) had already fixed this pattern elsewhere.               | **FIXED** in `692fbb5`, 0241 (the 0222 `pg_has_role` pattern with the owner exemption); smoke text updated                                                                                                   | RED at 0240: `revived and read: {"secret":"inherited-history-secret"}`; GREEN at 0241 |
| E-2 (F-1)               | MINOR (financial truth)                     | `usage_entitlement` reads a trial's `plan_expires_at`; 0240 recorded only `plan` / `plan_version_id`, so an expiry moved past and back (staging date tool; theoretically a re-posted trial over a short legacy expiry) left no history row and a pack that paid for consumption while the trial read expired was refunded in full as unused | **FIXED** in 0241: a trial's expiry change is recorded                                                                                                                                                       | RED at 0240: refund resolved `refunded`; GREEN at 0241                                |
| F-4                     | MINOR                                       | The history upsert could move `changed_at` backwards under overlapping holding writes                                                                                                                                                                                                                                                       | **FIXED** in 0241 (`greatest`)                                                                                                                                                                               | smoke tamper "history time able to move backwards again" prints `f`                   |
| D-5                     | MINOR (from review D)                       | The smoke counted the seven actor constraints by name with a tautological `convalidated IS NOT NULL`                                                                                                                                                                                                                                        | **FIXED**: checked by `pg_get_constraintdef`                                                                                                                                                                 | smoke tamper "an operator-actor check loosened but keeping its name" prints `f`       |
| B-6 / F3                | MINOR                                       | The retention coverage guard compared the list with itself                                                                                                                                                                                                                                                                                  | **FIXED**: candidates derived from `CREATE TABLE` in migrations 0193 onwards                                                                                                                                 | a mutant list missing one table fails                                                 |
| F-2                     | MINOR                                       | The billing page's `done=processing` strip persists after a later withdrawal or a dead job (extends G3-4)                                                                                                                                                                                                                                   | RECORDED (OD-41 (xxxi)); no charge is made and the copy says so; a fix needs an API field, not done here                                                                                                     | —                                                                                     |
| F-3                     | MINOR                                       | The refund takes no `businesses` lock; a plan change committing between two statements of one function is a theoretical race                                                                                                                                                                                                                | RECORDED; not reproducible deterministically; the counter-row wait order favours the refund; a `FOR SHARE` lock would add a lock-order question with plan writers, so it is not added without its own review | —                                                                                     |
| E-F4                    | MINOR now; **IMPORTANT before paid launch** | A reclaimed job whose death cannot be recorded stays `running` with a count-only warning and no alert                                                                                                                                                                                                                                       | RECORDED as a paid-launch item                                                                                                                                                                               | `jobs.ts:606-655`, `runner.ts:269-275`                                                |
| E-F1                    | MINOR                                       | CR-1's draft list missed 0238 and 0239; only the 0238 draft is caught by the smoke                                                                                                                                                                                                                                                          | DOCUMENTED (README §4)                                                                                                                                                                                       | —                                                                                     |
| E-F5                    | MINOR (pre-existing)                        | A restore into a new database drops 0109's `REVOKE TEMPORARY`                                                                                                                                                                                                                                                                               | DOCUMENTED (backup-restore "Real restore")                                                                                                                                                                   | —                                                                                     |
| E-F6, E-F7, E-F8, E-F10 | MINOR                                       | Drill BYPASSRLS check meaningful only with `DRILL_DATABASE_URL`; non-superuser owner untested; no migration-classification guard; settlement lacks `depends_on: api` on a fresh install                                                                                                                                                     | RECORDED (OD-41 (xxxi))                                                                                                                                                                                      | —                                                                                     |
| E-F9                    | MINOR (docs)                                | Key rotation did not mention settlement's keys                                                                                                                                                                                                                                                                                              | DOCUMENTED (key-rotation)                                                                                                                                                                                    | —                                                                                     |
| S-1                     | MINOR                                       | Settlement can move its own billing jobs in any direction (no transition guard applies to it)                                                                                                                                                                                                                                               | RECORDED under OD-54 and ADR 0035 Am. 6                                                                                                                                                                      | probe: `done -> pending`, `dead -> pending` both `UPDATE 1`                           |
| S-2                     | MINOR                                       | `email_address_erasures.operator` (0191, on `main`) keeps a looser actor rule                                                                                                                                                                                                                                                               | RECORDED (OD-41 (xxxi))                                                                                                                                                                                      | —                                                                                     |
| S-3                     | MINOR (docs)                                | 0234's header word "dying" understates that a closed dead payment or billing job stays readable                                                                                                                                                                                                                                             | RECORDED; ADR 0035 Am. 6 states it exactly                                                                                                                                                                   | —                                                                                     |
| N6                      | not a defect                                | "(xxx)" in HANDOFF and OD-41                                                                                                                                                                                                                                                                                                                | the Roman numeral after (xxix)                                                                                                                                                                               | —                                                                                     |
| N5                      | process                                     | CodeRabbit last reviewed `97501a8` and skipped the final head ("manual review required"); the PR body said "file limit"                                                                                                                                                                                                                     | Stated; a skip is not a review. The owner decides whether to accept the gap                                                                                                                                  | check run on the head                                                                 |

**Earlier findings (R01–R18, Codex ×3, Qodo, CodeRabbit, G-manifests, reviews A–D, CI runs):** every
one was re-verified at `0b4956a`: the fixing commit exists in the range, the claimed code is present
at HEAD and the regression test exists by file and title. The dispositions stand as recorded in
README §2 and §5; the open ones are owner decisions (OD-53 to OD-56), not engineering defects. R12
and R13 (OD-53 (4) and (5)) are **NOT BUILT** and are paid-launch blockers.

## 5. The four latest-migration areas, verified

- **Settlement isolation (0217, 0231, 0237): clean.** Direct, pinned and per-row re-pinned reads
  return only the two billing kinds; `job_payload` is refused; no runtime role is a member of
  another; the only definers settlement may execute are two boolean lookups.
- **Worker guard (0238 → 0241):** with E-1 fixed, every legitimate transition (claim, completion,
  deferral, retry, death, reclaim) succeeds; `done -> running/pending/dead` and `dead -> anything` are
  refused for the worker and for any role holding its privileges. Trusted-worker capabilities that
  remain, as Amendment 6 states: claim any tenant's pending job and read it; read running or dying
  payloads across tenants by re-pinning per row; kill a running job; write coordination columns.
- **Actor contract (0233, 0235, 0239): clean.** Five functions and nine constraints agree with the
  code's `/^[!-~]{1,255}$/`; every system actor the code writes is accepted. The rule checks format,
  not authenticity (OD-54).
- **Refunds (0235, 0240 → 0241):** replay (sequential and concurrent), conflicting reuse, partials up
  to the charge, wrong tenant, multiple packs, plan and holding changes, trial conversion and
  rollback on refusal are all correct; a concurrent probe of one refund id on two packs recorded once
  and rolled back the loser's revocation. E-2 and F-4 are fixed; F-3 is recorded.
- **Annual billing / OD-56:** the fallback, explicit annual price, grandfathered pin and missing-price
  refusal agree between `review_plan_price` and the resolver. Under the only catalogue writers
  (which enforce annual = 10 × monthly) the application and the database cannot disagree; they can
  only after a direct SQL edit, and the consequence is a truthful refusal or a scheduled change, never
  an immediate wrong charge.
- **Open-ended legacy plans:** answer `support_review` with no review row, as OWN-34 rules; no web copy
  claims a recorded review.
- **Rekoda's subscription money never enters a merchant's books:** no billing, refund, settlement or
  operator path in the diff writes a journal, ledger or merchant record.

## 6. Exact-head verification

Local runs on 18 Nov 2026: Node 24.22.3 (`.nvmrc` 24), pnpm 9.15.9, PostgreSQL 16.15. Each
integration suite ran on a fresh database. No test was skipped (vitest and `node --test` report 0
skipped or todo).

| Check                                                                                                                                                                                                                                                                       | SHA       | Result                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                                                                                                                                                                            | `5fee6b2` | ok                                                                                                                                                                                                                               |
| `pnpm turbo typecheck lint test build --force`                                                                                                                                                                                                                              | `5fee6b2` | 24/24 tasks; unit tests: core 4042, api 1146, web 272, db 85, contracts 44 (5,589 passed, 0 failed)                                                                                                                              |
| Same, before the G-62 allowlist entry                                                                                                                                                                                                                                       | `2be51d1` | **1 failure**: `plan-expiry-files.test.ts` flagged 0241 (it reads `plan_expires_at`); fixed in `5fee6b2` (a reviewed-list entry, no product code)                                                                                |
| Guards: boundaries, env-example, deploy, vendored skills, node version, ui-copy, retired claims, openapi, staging deploy, test layout, test years                                                                                                                           | `5fee6b2` | all OK                                                                                                                                                                                                                           |
| `node --test scripts/*.test.mjs`                                                                                                                                                                                                                                            | `5fee6b2` | 454/454, 0 skipped                                                                                                                                                                                                               |
| Fresh install, 0000–0241                                                                                                                                                                                                                                                    | `692fbb5` | 242 applied                                                                                                                                                                                                                      |
| Foreign-owner install (a separate cluster with no `rekoda` role)                                                                                                                                                                                                            | `0b4956a` | 241 applied; no role named `rekoda` created (0241 adds two function replacements and a trigger, none naming an owner)                                                                                                            |
| Upgrade from `main` with data: a database at 0192 seeded with 5 businesses (trial, paid with a pending downgrade, an open-ended operator plan, grace, annual), 8 charges in every status, 7 jobs in every state, usage rows and an expired add-on, then the PR's migrations | `0b4956a` | 0193–0240 applied; every row kept. The repository's own `upgrade-from-main` and `upgrade-od51` suites cover 0193–0241                                                                                                            |
| db integration, full, serial (unsharded)                                                                                                                                                                                                                                    | `692fbb5` | **2249/2249** (165 files)                                                                                                                                                                                                        |
| api integration, full, serial (unsharded)                                                                                                                                                                                                                                   | `692fbb5` | **2808/2808** (188 files)                                                                                                                                                                                                        |
| db integration files changed after `692fbb5` (retention, formatting only; second-review smoke)                                                                                                                                                                              | `5fee6b2` | 33/33                                                                                                                                                                                                                            |
| Playwright: main / purchase journey / reminder screens                                                                                                                                                                                                                      | `5fee6b2` | 92/92, 30/30, 10/10                                                                                                                                                                                                              |
| gitleaks 8.24.3, full history                                                                                                                                                                                                                                               | `5fee6b2` | 268 commits, no leaks                                                                                                                                                                                                            |
| Docker deployment smoke (`scripts/deploy-smoke.sh`)                                                                                                                                                                                                                         | —         | **NOT RUN locally**: inside the build container corepack could not fetch pnpm through this environment's TLS-intercepting proxy ("self-signed certificate in certificate chain"). CI's "Deployment (Docker)" job is the evidence |
| CI-sharded configuration                                                                                                                                                                                                                                                    | —         | The full unsharded runs above cover every file; the sharded jobs run in CI                                                                                                                                                       |
| CI on the final head                                                                                                                                                                                                                                                        | —         | **PENDING**: CI runs only for pull requests; the commits are on `angelo/magical-bell-2ht8ys` and reach PR #432 only when its branch is fast-forwarded (owner's permission)                                                       |
| Backup and restore drill                                                                                                                                                                                                                                                    | —         | The scripts' tests pass (in the 454); the R2 drill (P7) is an owner action on staging and was not run                                                                                                                            |

The full unsharded db and api suites were not re-run on `2be51d1` or `5fee6b2`, because those commits
change no product code: docs, formatting of one test, and one entry in a test's reviewed list.

## 7. Owner decisions

`owner-decisions-od53-56.md` is the full paper: the problem as the register states it, current
behaviour with file:line evidence, options, implications, risks, recommendation, release impact
and the exact question, for OD-53 (1)–(5), OD-54, OD-55 and OD-56, ending in 22 consolidated
questions with preferred answers. **None is approved.** Two facts it adds that the register did
not state: the api and worker processes hold `PAYSTACK_SECRET_KEY` (so "no automatic refund" rests on
code policy, not credential custody), and both processes hold both the `rekoda_app` and
`rekoda_worker` credentials (the app/worker split is a database-rights split, not a process
boundary).

## 8. External reviewers

- **Codex:** the last receipt covers `095ff62`. A review of `acf7f34` was requested once (18 Nov,
  01:38 UTC) and acknowledged; its result, and any request for the final head, is in the PR thread.
  A receipt for an earlier SHA is not a review of this one.
- **CodeRabbit:** skipped (see N5). Not a review.

## 9. P1–P12

The runbook `docs/runbooks/staging-first-deploy-pr-b.md` §7 is the checklist. Every infrastructure
item is **UNVERIFIED** from the repository; P12 is **PENDING** and is the owner's alone, on the exact
final SHA. The consolidated report to the owner lists each item with the runbook's safe command.
