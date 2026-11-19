# Manifest F (PR #432 independent review, batch F; merge base 58e6834, head 198d37a)

| path                                                            | reviewed | findings |
| --------------------------------------------------------------- | -------- | -------- |
| .env.example                                                    | reviewed | none     |
| .github/workflows/ci.yml                                        | reviewed | F-1      |
| .gitleaksignore                                                 | reviewed | none     |
| CLAUDE.md                                                       | reviewed | F-3      |
| README.md                                                       | reviewed | none     |
| apps/web/e2e/billing-journey-no-charge-upgrade.spec.ts          | reviewed | F-7      |
| apps/web/e2e/billing-journey.spec.ts                            | reviewed | none     |
| apps/web/e2e/reminders.spec.ts                                  | reviewed | none     |
| apps/web/playwright.config.ts                                   | reviewed | F-9      |
| apps/web/playwright.journey.config.ts                           | reviewed | F-9      |
| apps/web/playwright.reminders.config.ts                         | reviewed | F-9      |
| apps/web/src/app/app/billing/actions.ts                         | reviewed | none     |
| apps/web/src/app/app/billing/page.tsx                           | reviewed | none     |
| apps/web/src/app/app/billing/payments/[reference]/page.tsx      | reviewed | none     |
| apps/web/src/app/app/export/[kind]/route.ts                     | reviewed | none     |
| apps/web/src/app/app/invoices/actions.ts                        | reviewed | none     |
| apps/web/src/app/app/page.tsx                                   | reviewed | none     |
| apps/web/src/app/app/payments/page.tsx                          | reviewed | none     |
| apps/web/src/app/app/settings/ReminderSettingsForms.tsx         | reviewed | none     |
| apps/web/src/lib/allowance-copy.test.ts                         | reviewed | none     |
| apps/web/src/lib/allowance-copy.ts                              | reviewed | none     |
| apps/web/src/lib/billing-pay-copy.test.ts                       | reviewed | none     |
| apps/web/src/lib/billing-pay-copy.ts                            | reviewed | none     |
| apps/web/src/lib/charge-status.ts                               | reviewed | none     |
| apps/web/src/lib/payment-record-copy.test.ts                    | reviewed | none     |
| apps/web/src/lib/payment-record-copy.ts                         | reviewed | none     |
| deploy/Caddyfile                                                | reviewed | none     |
| deploy/migrate.sh                                               | reviewed | none     |
| docker-compose.prod.yml                                         | reviewed | none     |
| docs/HANDOFF.md                                                 | reviewed | none     |
| docs/REKODA_CURRENT_STATE.md                                    | reviewed | none     |
| docs/REKODA_LAUNCH_READINESS.md                                 | reviewed | F-2      |
| docs/REKODA_MVP_AUTOPILOT_PLAYBOOK.md                           | reviewed | none     |
| docs/REKODA_MVP_DELIVERY_LEDGER.md                              | reviewed | none     |
| docs/REKODA_OWNER_DECISIONS.md                                  | reviewed | none     |
| docs/REKODA_REFERENCE_MANIFEST.md                               | reviewed | none     |
| docs/TEST_MAP.md                                                | reviewed | none     |
| docs/adr/0034-the-operator-plane-has-identities-not-a-secret.md | reviewed | none     |
| docs/adr/0035-operational-aggregate-monitoring.md               | reviewed | none     |
| docs/audits/pr-432/README.md                                    | reviewed | F-2      |
| docs/audits/pr-432/commit-register-remediation.md               | reviewed | none     |
| docs/audits/pr-432/commit-register.md                           | reviewed | none     |
| docs/audits/pr-432/documentation-audit.md                       | reviewed | none     |
| docs/audits/pr-432/final-closeout-f.md                          | reviewed | none     |
| docs/audits/pr-432/final-closeout-g.md                          | reviewed | none     |
| docs/audits/pr-432/final-review-a-financial.md                  | reviewed | none     |
| docs/audits/pr-432/final-review-b-security.md                   | reviewed | none     |
| docs/audits/pr-432/final-review-c-runtime-tests-docs.md         | reviewed | none     |
| docs/audits/pr-432/final-review-d-fresh.md                      | reviewed | none     |
| docs/audits/pr-432/final-review-e-closeout.md                   | reviewed | none     |
| docs/audits/pr-432/manifest-g1-migrations.md                    | reviewed | none     |
| docs/audits/pr-432/manifest-g2-db.md                            | reviewed | none     |
| docs/audits/pr-432/manifest-g3-api-billing.md                   | reviewed | none     |
| docs/audits/pr-432/manifest-g4a-api-health.md                   | reviewed | none     |
| docs/audits/pr-432/manifest-g4b-api-other.md                    | reviewed | none     |
| docs/audits/pr-432/manifest-g5-web-core-scripts.md              | reviewed | none     |
| docs/audits/pr-432/manifest-g6-docs.md                          | reviewed | none     |
| docs/audits/pr-432/manifest-remediation-delta.md                | reviewed | none     |
| docs/audits/pr-432/owner-decisions-od53-56.md                   | reviewed | none     |
| docs/audits/pr-432/pre-merge-host-evidence.md                   | reviewed | F-6      |
| docs/plans/PR-B-plan.md                                         | reviewed | none     |
| docs/plans/paid-launch-plan.md                                  | reviewed | none     |
| docs/rls-exemption-register.md                                  | reviewed | none     |
| docs/runbooks/README.md                                         | reviewed | F-5      |
| docs/runbooks/backup-restore.md                                 | reviewed | none     |
| docs/runbooks/billing-duplicate-payments.md                     | reviewed | none     |
| docs/runbooks/deploy.md                                         | reviewed | F-5      |
| docs/runbooks/incident.md                                       | reviewed | none     |
| docs/runbooks/key-rotation.md                                   | reviewed | none     |
| docs/runbooks/meta-whatsapp-templates.md                        | reviewed | none     |
| docs/runbooks/staging-acceptance-handoff.md                     | reviewed | none     |
| docs/runbooks/staging-first-deploy-pr-b.md                      | reviewed | F-4, F-6 |
| docs/runbooks/staging-test-business-tools.md                    | reviewed | none     |
| scripts/backup-scripts.test.mjs                                 | reviewed | none     |
| scripts/check-boundaries.mjs                                    | reviewed | none     |
| scripts/check-deploy-privileged.test.mjs                        | reviewed | none     |
| scripts/check-deploy.mjs                                        | reviewed | none     |
| scripts/check-deploy.test.mjs                                   | reviewed | none     |
| scripts/check-staging-deploy.mjs                                | reviewed | none     |
| scripts/check-staging-deploy.test.mjs                           | reviewed | none     |
| scripts/check-staging-deploy.tools.test.mjs                     | reviewed | none     |
| scripts/deploy-smoke.sh                                         | reviewed | none     |
| scripts/deploy-staging-classes.test.mjs                         | reviewed | none     |
| scripts/deploy-staging-compat.test.mjs                          | reviewed | none     |
| scripts/deploy-staging-envfile.test.mjs                         | reviewed | none     |
| scripts/deploy-staging-interrupt.test.mjs                       | reviewed | none     |
| scripts/deploy-staging.fixtures.mjs                             | reviewed | none     |
| scripts/deploy-staging.sh                                       | reviewed | F-8      |
| scripts/job-payload-reads.test.mjs                              | reviewed | F-1      |
| scripts/lib/backup-common.sh                                    | reviewed | none     |
| scripts/lib/job-payload-reads.mjs                               | reviewed | none     |
| scripts/restore-drill.sh                                        | reviewed | none     |
| scripts/staging-readonly-check.fixtures.mjs                     | reviewed | none     |
| scripts/staging-readonly-check.services.test.mjs                | reviewed | none     |
| scripts/staging-readonly-check.sh                               | reviewed | none     |
| scripts/staging-readonly-check.templates.test.mjs               | reviewed | none     |
| scripts/staging-readonly-check.test.mjs                         | reviewed | none     |
| scripts/test-layout-baseline.json                               | reviewed | none     |

## Verification run by this reviewer (read-only)

- `node --test` on check-deploy(+privileged), check-staging-deploy(+tools), deploy-staging-{classes,envfile,compat,interrupt}, staging-readonly-check{,.services,.templates}, backup-scripts: 306/306 pass. `node scripts/check-deploy.mjs`, `node scripts/check-staging-deploy.mjs`: OK. `node --test scripts/job-payload-reads.test.mjs`: 7/7 pass locally (but not run in CI, F-1).
- apps/web vitest: allowance-copy, billing-pay-copy, payment-record-copy: 65/65.
- Not run: Docker deploy smoke, Playwright, restore drill (no Docker daemon/browser stack used here).
- Checked and found sound: deploy-staging.sh ordering (every .env, credential, Compose-project, Paystack TEST-key, template-in-new-image and memory refusal happens in phase checks/prepared, before `dc stop`; stop -> verified-stopped -> migrate -> 45-tag pre-start smoke -> up), the exit handler's fix-forward vs rollback branches, the 1 GiB floor (raise-only), compose credential isolation (operator/settlement get only the named lists, api/worker blank both URLs, check-deploy.mjs enforces names/fields/networks), Caddy operator routing vs API controllers, migrate.sh, restore drill ownership and 0109 revokes, read-only check additions, CI (only additions; no job weakened or skipped), .gitleaksignore (each entry's commit is an ancestor and its line holds only a `placeholder`/`placeholderkey` literal), web contract consistency (`processing`, `upgrade_withdrawn`, `support_review_unavailable`, `noChargeUpgrade`, `processingIssue`, `paid_twice`, provider times, quote `window` all exist in packages/contracts and the API), apps/web/e2e/billing.spec.ts helpers (unchanged by the PR; per-worker RUN plus desktop offset; collision only flakes, never false-passes). pre-merge-host-evidence.md is internally consistent (the 0.75 GiB figure derives from the 1.09 GiB post-api-build measurement minus about 330 MB, not from the 1.6 GiB idle figure; 193/246 migration counts consistent; status lines say not merged, not deployed, P12 not approved).

## Findings

### F-1 MINOR: the job-payload boundary rule's regression test never runs in CI

- Where: .github/workflows/ci.yml:92,108,119,147 (no step names scripts/job-payload-reads.test.mjs; no glob runs scripts/*.test.mjs).
- Scenario: someone loosens a regex in scripts/lib/job-payload-reads.mjs so the original unpinned `enrolUnrecordedDeaths` read is no longer flagged. check-boundaries.mjs still passes (the repo is clean today) and the 7 tests that would catch it are never executed; the next unpinned cross-tenant payload read merges unflagged. closeout-g §5 row 17 ran `scripts/*.test.mjs` locally, which hides the gap.
- Fix: add `scripts/job-payload-reads.test.mjs` to the boundaries/guards `node --test` step.

### F-2 MINOR: stale "not fixed" statuses contradict code and the round-F record

- Where: docs/REKODA_LAUNCH_READINESS.md:142 ("RECORDED, MINOR, not fixed here: F-2 ... E-F4 ... no alert (IMPORTANT before paid launch) ... E-F5 ..."); docs/audits/pr-432/README.md:83-86 (G3-4 includes the persisting "switching your plan on now" strip; "E-F4: no alert"); README.md:8 says the final head is recorded in final-review-e-closeout.md while §7 says final-closeout-g.md §5 and that review E is history.
- Scenario: F-2 is fixed (noChargeUpgradeCopy, overview.noChargeUpgrade, e2e spec), E-F4 is fixed (`jobs.stuck_running` alert, packages/core/src/ops-alerts.ts, incident.md section) and E-F5 is fixed (BACKUP_DATABASE_REVOKES_SQL, restore drill), per final-closeout-f.md:29-32. The authority-#3 document tells the owner they are open, including an "IMPORTANT before paid launch" item; a reader of the audit README is pointed at the wrong verification record.
- Fix: mark F-2, E-F4, E-F5 FIXED (round F) in the OD-41 row and README §4; point README line 8 at final-closeout-g.md §5.

### F-3 MINOR: CLAUDE.md names the wrong migration range

- Where: CLAUDE.md:184 "SQL migrations `0000`–`0241`"; head carries 0000-0245 (README.md:68 says 0245).
- Scenario: a fresh session trusting CLAUDE.md §5 believes 0242-0245 do not exist and may re-implement or misnumber a migration.
- Fix: `0000`–`0245`.

### F-4 MINOR: the PR #432 staging rollback drops 0109's TEMPORARY revokes and cites a snapshot that was skipped

- Where: docs/runbooks/staging-first-deploy-pr-b.md:607-641 (§8 "Rollback").
- Scenario: step 2 creates a fresh `rekoda` (`CREATE DATABASE ... OWNER rekoda_owner`) and restores P7 "as backup-restore.md, Restore by hand, says"; that section does not re-apply 0109's database-level revokes (only "Real restore" does, E-F5). After a rollback, PUBLIC (and so rekoda_app/rekoda_worker, plus the still-LOGIN settlement/operator roles) can create temporary tables again, silently undoing 0109. The section also ends "The Hetzner snapshot (P1) is the last resort", but OWN-96 (1) skipped P1, so no snapshot exists.
- Fix: add the three REVOKE TEMPORARY statements (BACKUP_DATABASE_REVOKES_SQL) after step 2 and verify BACKUP_TEMP_GRANTED_SQL prints 0; replace the snapshot sentence with "no snapshot exists (OWN-96); escalate".

### F-5 MINOR: deploy.md and the runbook index still say no backup exists

- Where: docs/runbooks/deploy.md:417 and :444 ("there is no backup mechanism yet (G-02)"); docs/runbooks/README.md:11 (backup-restore "... not enabled").
- Scenario: during a failed 0196 deploy the operator reads in "Roll back" that no backup exists, while backup-restore.md, G-02 and OWN-96 record nightly R2 backups and a passing off-box drill on staging since 18 Nov, and OWN-96 relies on that backup for a rollback past 0196. Contradictory guidance at the moment it matters.
- Fix: "staging: nightly R2 backups since 18 Nov 2026 (OWN-96); production: none (G-02)" in both places.

### F-6 MINOR: hand-stopped operator/settlement are not restarted if a later deploy refuses

- Where: docs/audits/pr-432/pre-merge-host-evidence.md §4 ("stop operator and settlement by hand ... The deploy restarts every service itself"); docs/runbooks/staging-first-deploy-pr-b.md §3 last paragraph.
- Scenario: per OWN-96 the owner runs `dc stop operator settlement` before approving a later Deploy staging run. Only a run that reaches `dc up` restarts them. A refusal (the memory floor, a template, a .env check, `--newer-only` skip exit 75, or a failure in phase prepared, whose restore puts back only the checkout and .env) leaves both stopped: plan changes answer 502 at Caddy and every billing.process / billing.apply_no_charge job waits, with nothing in the doc saying to start them again.
- Fix: add "if the run refuses, skips or fails before `start the new release`, run `dc start operator settlement` and confirm healthy (staging-readonly-check.sh flags them otherwise)".

### F-7 MINOR: the no-charge e2e spec finds its business by a name that can collide across projects

- Where: apps/web/e2e/billing-journey-no-charge-upgrade.spec.ts:42, 96, 134.
- Scenario: RUN is drawn per worker (1 in 900 chance mobile and desktop draw the same); the phone has a desktop offset but the name `Ada Free Upgrade ${RUN}-${seq}` does not. On a collision `SELECT id FROM businesses WHERE name = ...` returns two rows and `[row]` may be the other project's business; the test arranges the wrong business and fails (flake, not a false pass).
- Fix: include `test.info().project.name` in the name, or look the business up by the onboarded phone.

### F-8 MINOR: the pre-stop audience check compares raw .env text, not what Compose resolves

- Where: scripts/deploy-staging.sh:1208.
- Scenario: `.env` holds `OPERATOR_BILLING_OIDC_AUDIENCE="rekoda-api"` and `OPERATOR_OIDC_AUDIENCE=rekoda-api`. The sed values differ (one keeps quotes), so the check passes; Compose strips the quotes, the operator receives equal audiences and refuses to boot (operator-plane/config.ts:154) after migrate, failing `up --wait` in phase live instead of refusing with nothing changed. P8 says the owner validated distinct audiences, so this is a latent gap.
- Fix: after the checkout, read both values from `dc config operator` (as is done for the settlement Paystack key) and compare those, still before `dc stop`.

### F-9 MINOR: Playwright principal URLs can point at a different database from the run

- Where: apps/web/playwright.config.ts:19, playwright.journey.config.ts:19, playwright.reminders.config.ts:33 (`principalUrl` prefers an exported SETTLEMENT_/OPERATOR_DATABASE_URL).
- Scenario: a developer who exported the README's integration URLs (database `rekoda`) runs `e2e:journey` with DATABASE_URL/APP_DATABASE_URL at `rekoda_journey`. The in-process settlement runner then claims and settles billing jobs in `rekoda` (another suite's data) while the journey waits for its own, and fails. closeout-g §5 records exactly this happening. CI is unaffected (the e2e job sets neither variable).
- Fix: always derive from APP_DATABASE_URL (swap the user only), or refuse when the given URL's database differs from APP_DATABASE_URL's.

Counts: BLOCKING=0 IMPORTANT=0 MINOR=9
