# PR #432: owner pre-merge host evidence and decisions (18 Nov 2026)

Status: **PR OPEN, NOT MERGED, NOT DEPLOYED. STAGING ACCEPTANCE PENDING. P12 NOT APPROVED. Deployment approval
NOT GIVEN.**

This file records what the owner reported on 18 Nov 2026 about the staging host checks in
`docs/runbooks/staging-first-deploy-pr-b.md` §7 (P1 to P12), and the owner's decisions (OWN-96). The engineering
session cannot reach the host. Every value below is **as reported by the owner**, and none of it was observed by
engineering. Evidence the owner did not report is listed as **OUTSTANDING**, not inferred.

## 1. Owner decisions (OWN-96, `docs/REKODA_OWNER_DECISIONS.md`)

- **P1:** the Hetzner snapshot is skipped for isolated staging acceptance testing. The longer infrastructure recovery
  time is accepted. A database rollback past 0196 still restores the P7 R2 backup with the previous release
  (runbook §8, "Rollback").
- **P2:** the existing server is retained: 2 vCPU, 4 GB RAM, 2 GB swap, 40 GB disk. Every deployment memory safeguard
  is preserved. The deploy's 1 GiB `MemAvailable` floor is unchanged, and it can only be raised. See §4 for what
  that means for later deploys.
- **No** live customer data, live payment keys or real-money transactions.
- **The GitHub `staging` deployment approval gate stays on** (P11, OWN-95 (7)).
- `MONO_BASE_URL=https://api.withmono.com` and both existing Mono keys are retained (§5).
- The eight follow-up workstreams in §6 are recorded as **separate workstreams** (G-126 to G-133). They are not PR #432
  scope.

## 2. Pre-merge checklist status

| Row | Status (18 Nov 2026)                                               | Owner-reported evidence                                                                                                                                                 | Outstanding                                                                                                                                          |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **SKIPPED by owner decision** (OWN-96)                             | n/a                                                                                                                                                                     | none                                                                                                                                                 |
| P2  | **NOT RESCALED by owner decision** (OWN-96)                        | 2 vCPU, 4 GB RAM, 2 GB swap, 40 GB disk; available memory 1.6 GiB                                                                                                       | none for the merge; see §4 for later deploys                                                                                                         |
| P3  | DONE                                                               | available disk 20 GB, against the ≥ 8 GiB requirement                                                                                                                   | none                                                                                                                                                 |
| P3a | DONE (connection budget)                                           | `max_connections` 100, reserved 3: 97 for the runtime roles, against the estate's worst case of 93                                                                      | the lane-setting line (`REKODA_WORKER_CONCURRENCY` / `REKODA_SETTLEMENT_CONCURRENCY` absent or at the defaults 4 and 2, OWN-95 (6)) was not reported |
| P4  | DONE                                                               | dedicated private bucket `rekoda-staging-backups`; dedicated backup API credentials; 30-day bucket lock; 90-day lifecycle retention; 1-day incomplete-multipart cleanup | **off-server custody of the backup passphrase** (`backup.pass` copy outside the host) not evidenced                                                  |
| P5  | DONE                                                               | Paystack **TEST** key verified; `REKODA_PAYSTACK_PLATFORM_CONFIRMED` absent                                                                                             | none                                                                                                                                                 |
| P6  | DONE                                                               | one pending first purchase: `RKD-SUB-20261114-ZVQQTA`                                                                                                                   | none for the merge (see §3)                                                                                                                          |
| P7  | **PASS** (backup and off-box restore drill of the running release) | see §3                                                                                                                                                                  | **the restored copy's migration count and last tag** (`193`, `0192_reminder_reply_notices` expected) were not recorded                               |
| P8  | DONE                                                               | all four database connection strings validated, with correct principals and distinct passwords; `VAULT_KEY` format and distinct OIDC audiences validated                | none                                                                                                                                                 |
| P9  | DONE, as confirmed by the owner                                    | external provider credentials present; Meta, Resend and Paystack TEST webhook configurations confirmed                                                                  | the approved document and trial WhatsApp templates (P9a)                                                                                             |
| P9a | **OUTSTANDING**                                                    | n/a                                                                                                                                                                     | configure the approved `META_DOCUMENT_TEMPLATE` and `META_TRIAL_TEMPLATE` with their `_LOCALE` lines, then run the P9a check                         |
| P10 | DONE, as confirmed by the owner (verified earlier)                 | Auth0 permissions                                                                                                                                                       | none                                                                                                                                                 |
| P11 | DONE                                                               | GitHub `staging` deployment approval gate configured                                                                                                                    | none                                                                                                                                                 |
| P12 | **PENDING: not given**                                             | n/a                                                                                                                                                                     | the owner's written approval of one exact head SHA                                                                                                   |

## 3. Backup and restore evidence (P7)

| Item                    | Value                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Date                    | 18 Nov 2026                                                                                  |
| Release                 | `staging-58e6834`                                                                            |
| Backup object           | `rekoda-20261118T223639Z-1783012.dump.enc`                                                   |
| Size                    | 746800 bytes                                                                                 |
| Backup execution        | about 12 seconds                                                                             |
| `restore_seconds`       | 14                                                                                           |
| Counts                  | businesses 1, ledger entries 77, invoices 15                                                 |
| `unbalanced_businesses` | 0                                                                                            |
| Result                  | **PASS**; the temporary restore container was removed                                        |
| Bucket lock             | refused deletion of the `.pending` object, as designed (runbook §1.2; tested as §1.3 case 3) |
| Nightly timer           | enabled, 01:00 UTC                                                                           |

**Recorded separately as OUTSTANDING evidence. None of it is inferred from the PASS:**

1. The restored copy's `SELECT count(*), max(tag) FROM rekoda_migrations` (expected `193`, `0192_reminder_reply_notices`).
2. Off-server custody of the backup passphrase (and of `VAULT_KEY`, `backup-restore.md`, "losing VAULT_KEY loses the
   vault").
3. The first **unattended** nightly run: `systemctl status rekoda-backup.service` showing success at about 01:00 UTC,
   and a new object in R2 (runbook §1.6). The timer being enabled is not evidence that it ran.

The pending charge `RKD-SUB-20261114-ZVQQTA` stays as it is. OD-53 (4), pending-charge reconciliation, is a
paid-launch blocker and is **not built** (C1, `docs/plans/paid-launch-plan.md`). Do not settle or cancel it by hand.
After the deploy, run the P6 query again and compare it with this list.

## 4. P2 consequence for later deploys (memory safeguards preserved)

Runbook §3 still holds. The first deploy of #432 builds before `settlement` and `operator` exist. Every later deploy
builds while they run (about 330 MB together), which leaves roughly 0.75 GiB at the 1 GiB floor check. **The deploy
script will then refuse to build** ("only … KiB of memory available"), and swap does not count. The floor is not
lowered.

Until the server is resized (G-133): before approving each later Deploy staging run at the approval gate, stop
`operator` and `settlement` by hand (`dc stop operator settlement`). The deploy restarts every service itself. Run
the restore drill only when no build is running.

## 5. Before deployment approval (the first Deploy staging run after the merge)

Do **not** approve the Deploy staging run until every item below is verified:

1. **WhatsApp templates (P9a):** configure the approved document and trial templates, with their locales, under the
   exact names WhatsApp Manager shows. Then run the P9a check. The deploy repeats it in the new image and refuses
   by name.
2. **Remove the obsolete settings** `REKODA_OPERATOR_SECRET` and `REKODA_LOCAL_STORAGE` from `/opt/rekoda/.env`.
   - Compatibility was checked in code at `58e6834` and at `45b4366`. In production both refuse to boot when set to
     any non-empty value: `apps/api/src/config.ts` (`operatorSecret`, `localStorageRoot`) and
     `apps/api/src/operator-plane/config.ts`.
   - So the running release can only hold them blank or absent, and a blank line behaves exactly like an absent
     one.
   - Compose passes neither name to `settlement` or `operator`. Settlement would refuse a non-empty `REKODA_OPERATOR_SECRET` (`FOREIGN_SECRETS`).
   - Removing the lines therefore changes no behaviour of either release. Documents use R2 (`R2_*`), never the
     container's disk.
3. **Mono stays as it is:** `MONO_BASE_URL=https://api.withmono.com` and both Mono keys.
   - In production `MONO_BASE_URL` boots when blank or **exactly** `https://api.withmono.com`, and is refused for any
     other value (`providerBaseUrl`; pinned by `apps/api/src/config/production.test.ts` and `scripts/deploy-smoke.sh`).
   - Retaining the canonical value is compatible.
   - Mono stays production-disabled by readiness axes (OWN-9).
4. **Backups:** the first unattended nightly run (§3, item 3) and the remaining recovery evidence (§3, items 1 and 2).
5. **API/worker image inconsistency (owner-reported; its details are not recorded in this repository):** investigate
   and reconcile it before approving.
   - Compose runs `api`, `worker`, `operator`, `settlement`, `migrate` and `edge-check` from one tag,
     `rekoda-app:${REKODA_RELEASE}`.
   - A difference therefore means at least one container was not recreated from the current release, or a tag was
     rebuilt.
   - Read-only checks: `docker inspect -f '{{.Name}} {{.Config.Image}} {{.Image}}' $(dc ps -q api worker)` (tag
     and image id), against `sed -n 's/^REKODA_RELEASE=//p' .env`.
   - `scripts/staging-readonly-check.sh` reports it as `api and worker image` `SAME` / `DIFFERENT`. It compares tags,
     not image ids.
   - Record the cause and the fix here before approval. The durable remedy is G-129.
6. Re-confirm P3a's lane-setting line (§2).

After the deploy: D8 (post-deploy backup and drill of the new schema, 0000 to 0245) and D13 stay required. D9 becomes
"verify the timer is still enabled".

## 6. Separate follow-up workstreams (not PR #432 scope)

Recorded in `docs/REKODA_LAUNCH_READINESS.md` §8:

| Gap   | Workstream                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-126 | Mono Connect integration completion: provider contract verification, consent lifecycle, webhooks, real-time refresh, multiple bank accounts, synchronisation, reconciliation, security and actual provider acceptance |
| G-127 | Mono DirectPay integration completion                                                                                                                                                                                 |
| G-128 | R2 backup temporary objects: stage `.pending` under a separate unlocked prefix with short retention, so the lock does not retain a second copy for 30 days                                                            |
| G-129 | Immutable Docker images built in GitHub Actions (and deployed by digest)                                                                                                                                              |
| G-130 | Automated backup failure and freshness alerts                                                                                                                                                                         |
| G-131 | PostgreSQL point-in-time recovery with WAL archiving (ADR 0010; OD-7)                                                                                                                                                 |
| G-132 | Full infrastructure disaster-recovery test (host loss, rebuild from nothing, restore, re-point DNS)                                                                                                                   |
| G-133 | Server capacity optimisation and production infrastructure planning                                                                                                                                                   |

Every paid-launch blocker (OD-53 (4) and (5), C1 to C6), every deferred owner decision (OD-53 (1) to (3), OD-54 to
OD-56, ADR 0035 Amendment 6 for paid production) and every acceptance requirement (runbook §6, §9) is unchanged.
