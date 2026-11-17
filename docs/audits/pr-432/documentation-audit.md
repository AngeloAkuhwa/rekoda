# PR #432 documentation audit

- **Head audited:** `095ff625cf35c5bb15883a27b30796bfe5e33f09`, branch `angelo/magical-bell-s81mqc`, merge base `58e6834`.
- **Scope:** every document the brief names, changed in the PR or not. Each one is checked against HEAD code, migrations and tests.
- **Method:** read-only. No database was touched and no test was run.
  - Claims were traced to migrations `0193` to `0230` (0227, 0228, 0229 and 0230 read in full).
  - Code was checked in `scripts/deploy-staging.sh`, `deploy/Caddyfile`, `apps/api/src/{health,operator-plane,auth}` and `packages/db/src/repos/jobs.ts`.
  - Test files were checked for existence and test names at `095ff62` (`git cat-file`, `git show`).
  - The PR description was fetched with `gh api repos/AngeloAkuhwa/rekoda/pulls/432 --jq .body`, and the CI check-runs on `095ff62` were read.
- **Working tree:** it holds uncommitted work by another process: an untracked `0231_settlement_reads_only_its_kinds_payload.sql`, the journal at 232 tags, and edits to `jobs.ts` and `job-payload-isolation.integration.test.ts`. None of it is in `095ff62`, and nothing below credits it. Where it would change a number, that is said.
- **Facts at HEAD used throughout:**
  - 231 migration files and 231 journal tags, `0000` to `0230`.
  - CI on `095ff62` has all 12 checks green: Integration db 1/2 and 2/2, api 1/2 and 2/2, PostgreSQL, Playwright, foreign-owner migrations, gitleaks, GitGuardian, Docker, typecheck/lint/test/build. CodeRabbit skipped.
  - `COMPAT_BREAKING_MIGRATIONS` (`deploy-staging.sh:131`) includes 0228 and 0230.
  - The pre-start smoke counts 30 tags, 0201 to 0230 (`deploy-staging.sh:200-222`).
  - `/health` reports `migrations: applied.size` (`apps/api/src/health/health.controller.ts:37-41`).

---

## A. The five checks the caller named

### A1. PR #432 description against HEAD

| Description says | HEAD shows | Verdict |
| --- | --- | --- |
| "Head: **`a6e3a3b`**"; the commit table ends at `a6e3a3b` | HEAD is `095ff62`. Nine later commits: `2e54f35` (Paystack fail-fast), `a748f3d` (0227), `3d3cd3a` (0228, 0229), `0cc39e0` (0229 operator routes), `7a58696` (0230 refunds), `8ebb95d` (OWN-94 docs), `1a32a4c` (Caddy routes `/v1/ops/refund` to the operator), `0ffadac` (docs), `095ff62` (CI fix: the reclaim pin test asserts `job_payload()`; smoke key) | STALE |
| "Rounds (migrations 0193 to **0226**)"; "Fresh PostgreSQL 16.15, migrated 0000 → 0226 (227 migrations)" | 0193 to 0230; 231 migrations | STALE |
| "**OWN-92 paid-launch gate (next free migration, 0227), NOT fixed, NOT accepted for production**" | `0227_paid_launch_gate.sql` exists. The job guard refuses application changes to `run_at`, `max_attempts` and `attempts` except the dead-to-pending requeue, and refuses inserts of anything but new pending work. `usage_bind_event` binds only to a same-business event whose job is running. Test: `packages/db/src/ops/paid-launch-gate.integration.test.ts`. OWN-94 and LAUNCH_READINESS l.454: CODE COMPLETE, the gate holds until merged and staging-verified | FALSE at HEAD (code exists); "not accepted for production" is still true |
| "The pre-start smoke now pins 26 tags" | 30 tags (`deploy-staging.sh:200-222`) | STALE |
| "Compatibility breaks: 0216, 0217, 0218, 0220, 0221" | The script also stops for 0228 (worker loses SELECT on `jobs.payload`) and 0230 (the old API refund route is refused) | INCOMPLETE; this is deploy-relevant |
| "Open owner questions": refund windows, the refunded pack's units, settlement boot without a key | Resolved by OWN-94 (5) to (9), implemented in 0227 and 0230 and in the boot checks | STALE |
| Invariants table: rows for 0224 to 0226 only | No rows for 0227 (gate), 0228 (`job_payload`), 0229 (dead letters and two routes), 0230 (refund through the billing operator, pack revoke), the Paystack fail-fast or the Caddy route | INCOMPLETE |
| "Full suites ran on `09e821a`" | CI integration suites are green on `095ff62`. No local run on the final head is recorded anywhere, and OWN-94 (3) requires a final-head rerun of both suites | Evidence exists in CI but is not recorded |
| "ADR 0035 Amendment 6 is PROPOSED" | Still PROPOSED; the text has since grown points 5 (0228) and 6 (0229) | Correct, but the amendment's content is overstated (A3) |

**Verdict:** the description does not describe the head the owner is asked to approve (P12: "on the exact head SHA you reviewed"). It needs a rewrite (correction 1).

### A2. rls-exemption-register contradictions (`docs/rls-exemption-register.md`, "Operator work lists added by PR B")

1. **Row `jobs.payload` via `job_payload` (0228).**
   - **Claim:** "it can no longer read payloads unpinned, across tenants or in bulk".
   - **Bulk under one pin:** `SELECT job_payload(id) FROM jobs WHERE business_id = <pin>` returns every payload of the pinned business in one statement. That is known R07, and `packages/db/src/repos/jobs.ts:684` uses the same per-row shape.
   - **Across tenants in one statement:** re-pinning per row with `set_config('app.business_id', business_id::text, true)` in the same target list plausibly reads across tenants in one statement. `set_config` is PUBLIC, and the worker can SELECT `jobs.id` and `business_id` across tenants under `worker_claim USING (true)`, as granted in 0228 l.45-48. Not executed: no database access.
   - **Settlement:** it holds EXECUTE (0228 l.43), and the definer reads `public.jobs` with no kind filter. Settlement can therefore read the payload of any job kind of the pinned business, bypassing `settlement_only_its_kinds` (0217 l.180). That is known R01. The row does not say so.
2. **The closing sentence** "No payload, error text, name or phone number is returned." contradicts row 1, which returns a payload.
3. **Row `dead_job_unrecorded_candidates` (0225).** Its caveat ("the worker's `worker_claim` policy still lets its credential read any job row") predates 0228. Since 0228 the worker reads coordination columns of any row, and the payload only through `job_payload`. This understates the change, which is the safe direction, but the row is now inaccurate.
4. **Section header.** "Not RLS exemptions (every table below has FORCE RLS and the canonical tenant policy ...)". This holds for `jobs`, `dead_job_exceptions`, `subscription_charges` and `dead_job_enrolment_failures` (0229 l.53-56). It is accurate.
5. **Formatting.** The 0199 `blocked_renewals_close_batch` row follows a blank line, so it renders as a headerless second table.
6. **Missing rows.** Two definers are not listed:
   - `dead_job_enrolment_failed`: a worker write, pinned, so arguably not an exemption.
   - `dead_job_enrolment_requeue` (0229): EXECUTE for `rekoda_app`. It takes a caller-supplied actor of at most 200 characters, which is known R04/R05 and R11.

   Neither is required by the register's own rule (cross-tenant reads), but row 3's route cell names the requeue.

### A3. ADR 0035 Amendment 6 guarantees against 0228

| Amendment 6 says | 0228 actual | Verdict |
| --- | --- | --- |
| "It narrows an existing read and grants nothing new" (l.311) | 0228 grants EXECUTE on `job_payload` to `rekoda_worker` **and `rekoda_settlement`**. 0229 grants EXECUTE on `dead_job_enrolment_failed`, `dead_job_enrolment_dead_letters` (worker) and `dead_job_enrolment_requeue` (app) | FALSE since points 5 and 6 were added |
| Point 5: "returning one job's payload only where that job's business is the pinned tenant (NULL otherwise)" | True per call (0228 l.36-39) | TRUE |
| Point 5: "An unpinned, cross-tenant or bulk payload read on the worker credential is refused by the database" | Unpinned direct column reads are refused, which is true (test "ATTACK: an unpinned or a pinned direct read of jobs.payload is refused"). Bulk under one pin is allowed (R07). Cross-tenant in one statement through per-row `set_config` is plausibly allowed (new, untested). `job-payload-isolation.integration.test.ts` has no bulk, re-pin or settlement case | FALSE as written |
| Point 5: "EXECUTE for the worker and settlement" (with no further qualification) | Settlement's EXECUTE is not limited to `billing.process` and `billing.apply_no_charge`, so it bypasses the 0217 kind isolation (R01). The uncommitted 0231 in the working tree targets this; it is not in HEAD | OMITS a material residual |
| "What the database still cannot enforce": "pin each business in turn and read its jobs one at a time" | The residual is wider: all of a business's jobs per statement, possibly all tenants per statement, and every kind on the settlement credential | UNDERSTATED |
| Point 6: "A requeue runs under `withBusiness()` ... through a definer that requires that pin, with its own scope (`ops:payment`) and an audit event" | The pin is required (0229 l.184). The audit actor is whatever the `rekoda_app` caller passes (R11) and is capped at 200 characters against the shared contract's 255 (R05). ADR 0034 point 6 says "the audit actor is the verified subject, and nothing else" | Partly true; the actor integrity is not database-enforced |
| Test pointers: `dead-job-enrolment-pin.test.ts`, `dead-job-enrolment-scope.integration.test.ts`, boundary rule `scripts/lib/job-payload-reads.mjs` ("cross-tenant job payload read") | All present at `095ff62` | TRUE |

Requirement OWN-94 (2) says any infeasible part must be documented with its compensating control and residual risk. That is not met accurately (correction 3).

### A4. Staging health migration count

- At `095ff62` the journal holds 231 tags. `/health` reports the count of applied tags, `applied.size`. `scripts/staging-readonly-check.sh:239-258` compares against the journal dynamically, so the script is right.
- If the uncommitted `0231` lands, the count becomes 232.
- The documents give fixed numbers that are wrong:

| Document | Says | Should say |
| --- | --- | --- |
| `docs/runbooks/staging-first-deploy-pr-b.md:567` (D3 pass condition) | `/health` shows `"migrations":225` | 231 (`0000` to `0230`), or "the journal's count" |
| `docs/runbooks/staging-first-deploy-pr-b.md:572` (D8) | "both pass on the 0223 schema" | the 0230 schema |
| `docs/runbooks/staging-first-deploy-pr-b.md:41`, `:86` (evidence) | backup and restore exercised "through 0223" | re-run against 0230, or mark that 0224 to 0230 are not drill-evidenced |
| `docs/runbooks/staging-acceptance-handoff.md:38` | "224, `0000` to `0223`, once PR B deploys" | 231, `0000` to `0230` |
| `docs/HANDOFF.md:16` (Product version) | "PR B #432 adds 0193 to 0226 (227 once it merges)" | 0193 to 0230 (231) |
| PR description | "0000 → 0226 (227 migrations)" | 0000 → 0230 (231) |
| `README.md:68` | "SQL migrations 0000–0151" | 0000–0230 |
| `docs/REKODA_CURRENT_STATE.md:31`, `CLAUDE.md:184` | 231 / `0000`–`0230` | correct |

### A5. OWN-92 remediation status across documents

| Document | States | Consistent with HEAD and OWN-94? |
| --- | --- | --- |
| `REKODA_OWNER_DECISIONS.md`, OWN-92 row | The ruling text says "not fixed and not accepted for production", which is historical, plus a numbering note ("written as 0227 on 15 Nov 2026"). There is no status line | Acceptable as a ruling, but it needs a status pointer |
| `REKODA_OWNER_DECISIONS.md`, OWN-94 row | "OWN-92's gate is to be resolved in migration 0227 ... not closed merely because the migration exists"; status CODE COMPLETE (0227 to 0230) | YES |
| `REKODA_LAUNCH_READINESS.md:454` (gate row), `:785` (GATE 8), `:142` (xxi) | CODE COMPLETE as 0227; not merged, not deployed, not staging-verified; the gate holds | YES |
| `REKODA_CURRENT_STATE.md:31` | "0227 (OWN-92 paid-launch gate)" | YES |
| `HANDOFF.md:20` (15 Nov note) | "0227 is the OWN-92 paid-launch gate" | YES |
| `HANDOFF.md:24` (14 Nov note) | "OWN-92's gate migration ... (written as 0227 on 15 Nov 2026, OWN-94)" | YES (dated note) |
| `docs/runbooks/staging-first-deploy-pr-b.md:662` | "written as 0227 ... not yet merged or staging-verified ... **are open, not fixed and not accepted for production**" | NO. "not fixed" contradicts 0227 |
| `docs/runbooks/deploy.md:645` | 0227 listed as "the paid-launch gate" | YES |
| PR description | "NOT fixed" | NO |
| `docs/plans/PR-B-plan.md` | No mention of OWN-92 or 0224 to 0230 | INCOMPLETE |

Related item. LAUNCH_READINESS l.142 OD-41 (iii) said the `refunded_*` rewrite would close "with the OWN-92 gate migration". It is closed by 0230 instead (guard l.328-335), and the row now says "only partly closed by 0230" (`applied_period_*` and `failure_reason` remain). That is consistent.

---

## B. Document-by-document

### B1. `CLAUDE.md` (changed in PR; not in the G6 list)

- **Relevant requirements:** invariants 2, 3, 5, 6, 9 and 11; the "Database principals" bullet; the migration range; §7 (final-head verification, independent review); §7b (no generated footers).
- **Matches HEAD:**
  - The migration range `0000`–`0230` (l.184).
  - The principals: `rekoda_owner`, four LOGIN roles and four NOLOGIN roles. These match the `CREATE ROLE` set in the migrations: `rekoda_app`, `rekoda_worker`, `rekoda_settlement`, `rekoda_billing_operator`, `rekoda_plan_writer`, `rekoda_usage_writer`, `rekoda_provenance_owner`, `rekoda_operator`.
  - "neither is a member of `rekoda_app`" matches 0211 and 0217.
- **Overstatements and gaps:**
  - `rekoda_billing_operator` is described as "(plan changes)". Since 0230 it is also the only refund recorder (`subscription_record_refund`, 0230 l.445-447).
  - Invariant 3's list of exception classes does not cover `job_payload()`, a worker and settlement definer read of tenant payloads under a caller-set pin. The definition of "ID-only scheduling discovery" (OWN-57) is exceeded by a function that returns payloads. ADR 0035 Amendment 6 is the place that is supposed to approve it, and it is still PROPOSED.
- **Verdict:** two corrections (corrections 13 and 3).

### B2. `README.md` (changed in PR)

- The new integration-URL block (five URLs) matches `packages/db/src/testing.ts:56-68` (`requireUrls`).
- l.68 "SQL migrations 0000–0151" is stale (correction 14).

### B3. `docs/HANDOFF.md`, top section

- **Relevant requirements:** CLAUDE.md §6.1 and §7.3: SHA, state, next actions, blockers.
- **Matches:** `main` SHA `58e6834` (PR B not merged); the 15 Nov note (0227 to 0230, Paystack fail-fast, P12 and Amendment 6 PENDING, OD-53 blockers); next actions (l.57-63).
- **Wrong:**
  - "Current date" is 14 Nov.
  - The Product version row says "0193 to 0226 (227 once it merges)".
  - The 15 Nov note repeats "reads one job's payload only through `job_payload()` under that job's pin", the A3 overstatement.
  - No final-head (`095ff62`) verification evidence is recorded, as OWN-94 (3) requires.

### B4. `docs/REKODA_CURRENT_STATE.md`

- **Matches:** the migration inventory (l.31: 231 files, every migration from 0193 to 0230 described); the billing routes (l.334, refund "records only").
- **Gaps:**
  - The operator-route inventory (l.397) omits the 0229 routes `GET /v1/ops/dead-jobs/enrolment-failures` and `POST /v1/ops/dead-jobs/:jobId/enrolment-requeue`, both present in `apps/api/src/health/dead-jobs.controller.ts:54,75`.
  - It does not say `refund` is served by the operator process (`ops.controller.ts:499-501`, `OperatorPlaneServedHere`; `Caddyfile:72`).
  - The payload-isolation statement for 0228 ("the worker reads no job payload across tenants") carries the A3 overstatement.

### B5. `docs/REKODA_LAUNCH_READINESS.md`

- **Matches HEAD:**
  - The gate row l.454, GATE 8 l.785.
  - OD-41 items (xxi) to (xxvii). They trace to 0227 to 0230, `paid-launch-gate.integration.test.ts`, `job-payload-isolation.integration.test.ts`, the 0229 routes, `subscription_record_refund`, the boot checks and `scripts/check-deploy-privileged.test.mjs`.
  - The paid-launch blockers OD-53 (4) and (5), verified NOT BUILT. Consistent with `billing-duplicate-payments.md` (no operator queue for `duplicate_payment`).
- **Overstated:** (xxii) states only the caller-set-pin residual. The bulk-per-pin (R07), settlement any-kind (R01) and per-row re-pin residuals are missing.
- **Contradiction (l.152):** "0213 to 0223 are additive and forward only", against the compatibility breaks 0216, 0217, 0218, 0220 and 0221 (`deploy.md:647`, `deploy-staging.sh:131`). The same paragraph mixes "through 0223" with "since extended through 0230" for `upgrade-from-main.integration.test.ts`, whose title at HEAD is "upgrading the database main leaves (0192) through 0230".
- **Known, recorded:** R09 (the "unused" test reads the current entitlement); OD-41 (iii) partly closed.
- **Missing:** the refund-policy contradiction in B9/B11 needs an OPEN OWNER DECISION row.

### B6. `docs/REKODA_OWNER_DECISIONS.md`

- **OWN-94 (1) to (9):**
  - (1) is implemented by 0229 (backoff of 5, 10, 20 and 40 minutes, then dead-lettered).
  - (2) is implemented by 0228, but its residual is misdocumented (A3).
  - (3): the final-head suites are green in CI on `095ff62` but not recorded.
  - (4) to (6) are in 0224, 0222 and 0227.
  - (7) and (8) are in 0230 l.399-426.
  - (9) is the boot check in config, per LAUNCH_READINESS (xxv). It was not re-traced in this audit; G6 covers docs only.
- **OWN-92 row:** add a status pointer (correction 9).
- **OWN-94 (8) against ADR 0024:** see B9.

### B7. `docs/REKODA_MVP_DELIVERY_LEDGER.md`

The single change (OWN-93 supersedes the `_LOCALE` default of `en`) is correct. Nothing else in it concerns PR B.

### B8. `docs/REKODA_REFERENCE_MANIFEST.md`

- The `runbooks/*` row says 15 files and there are 16. `staging-first-deploy-pr-b.md` is not named, and its verification date is not given.
- `docs/plans/` (`PR-A-plan.md`, `PR-B-plan.md`) is not catalogued at all.
- `docs/audits/pr-432/` will need a row once these audit files are kept.

### B9. ADRs

- **0022 (job queue in our schema; Accepted).**
  - **Requirements:** `worker_claim` is the worker's only cross-tenant reach, one table wide. "Payloads carry references, never content ... anything in `payload` is readable by every worker."
  - **At HEAD:** consistent. 0228 narrows the worker to columns plus `job_payload`, which is stricter than 0022, and `worker_claim USING (true)` is still in force.
  - **Correction:** the "one table wide" property is now qualified by the definer functions of Amendments 1, 2 and 6. ADR 0035 records this, so no edit to 0022 is needed (accepted ADRs are immutable).
- **0024 (commercial terms; Accepted, partly superseded).**
  - **Requirements (§Refunds):** duplicate or incorrect charge: full refund. Material Rekoda service failure: full or prorated. Add-on pack completely unused within 7 days: refundable. Partly consumed: not refundable.
  - **What 0230 enforces:**
    - A credited pack is refunded only once, in full, within 7 days of `units_credited_at`, when unused, which is computed as `used <= usage_entitlement + bonus - pack units` (R09).
    - A pack credited before 0230 is refused with "settle it by hand".
    - Plan charges and uncredited (set-aside) pack charges may be refunded in full or in part up to the amount.
  - **Contradiction:**
    - For a credited pack, the service-failure row ("full or prorated") and the incorrect-charge row cannot be recorded once any unit is used, after 7 days, or for a pre-0230 credit.
    - Since 0230 no runtime role can write `refunded_amount_k`, `refunded_at` or `status` (charge guard l.322-335), so "by hand" means the database owner.
    - The public page `apps/web/src/app/refunds/page.tsx:52-58` repeats ADR 0024's promises.
    - OWN-94 (8) ("a full pack refund is allowed only for an unused pack within seven days") narrows ADR 0024 without a superseding note.
  - **Consequence:** a Paystack refund made under the published policy leaves Rekoda's record `paid` with units credited. That is an unrecorded discrepancy (invariant 6). OPEN OWNER DECISION needed (correction 8).
- **0034 (operator plane has identities; Accepted).**
  - **Requirements:** point 4 gives "Five scopes"; point 6 says "The audit actor is the verified subject, and nothing else".
  - **At HEAD:** six scopes (`apps/api/src/auth/operator-identity.ts:33-38` adds `ops:staging`, OWN-77). There is a second token audience for the operator process (`OPERATOR_BILLING_OIDC_AUDIENCE`, `operator-plane/config.ts:133-156`), recorded only in ADR 0035 Amendment 5 and in the runbooks.
  - **Actor integrity:** it holds in the HTTP layer (`operatorActor(request)`). It is not held at the database boundary for `dead_job_enrolment_requeue`, which takes `p_actor` from the `rekoda_app` caller (R11), or for the 200-character caps in 0229 and 0230 (R04, R05).
  - **Correction:** add an amendment or superseding note for the sixth scope and the second audience (correction 15).
- **0035 (operational aggregate monitoring).**
  - Amendments 1 to 5 are "accepted with PR #432 (not merged at the time of writing)".
  - Amendment 6 is PROPOSED. Its overstatements are in A3.
  - Amendment 5 (settlement and operator processes) matches the compose and process split (`check-deploy.mjs` PRIVILEGED, `server.ts`).
  - Amendment 2's "fixed-column worker-only definer functions" holds for 0194, 0195, 0199 and 0229. `job_payload` is not a fixed-column work list, so it belongs under class 2 with an explicit residual, as point 5 attempts.
- **Other ADRs referencing settlement or operator** (0003, 0009, 0013, 0016, 0019, 0021, 0023, 0025, 0032, 0036): these use "settlement" in the merchant Paystack-settlement sense, or predate the PR. They make no claim PR B changes.

### B10. `docs/plans/PR-B-plan.md`

- Six items "ALL SIX ITEMS CODE COMPLETE". This is consistent with the code: the OD-40 columns, the 0194 dead-job exceptions, the 0195/0199 blocked renewals, the 0196/0200 plan guard and 0197 staging tools.
- "As built" stops at 0223. The plan does not record 0224 to 0230, OWN-92, OWN-93 (it does record OWN-93), OWN-94, the Caddy route or the Paystack fail-fast.
- "The operator process is plain `node:http` with two routes" is stale: `server.ts:4` says "Four routes": two plan operations, the refund, health.
- §5 "`subscription_operator_set_plan` ... (operator path; `rekoda_app` only)" and "Remaining limit" are superseded by 0202, 0205, 0211 and 0221 but carry no history marker.

### B11. `docs/rls-exemption-register.md`

See A2.

### B12. `docs/safety-review.md` and security documents

- **`safety-review.md`:** not changed by the PR. The RED list (never hold, route or delay funds; no screenshots as evidence; R28 no withholding settlement) is respected. The duplicate-payment runbook and 0230 keep refunds as Paystack-dashboard actions by a person and record only. No contradiction.
- **`SECURITY.md`:** not changed. It says nothing about database principals, so it has no stale claim.
- **`docs/compliance/*`:** not changed. The new tables `dead_job_enrolment_failures`, `plan_change_reviews` and `subscription_charges.credited_*` hold no personal data beyond business and job ids. Retention and erasure coverage of the new tables is known R10.

### B13. Runbooks

- **`deploy.md`**
  - **Correct:** l.188 (the stop list includes 0228 and 0230); the Paystack fail-fast paragraph (l.709-716); the "Docker cleanup by hand" section.
  - **Stale or incomplete:**
    - The section intro (l.647-651) names the breaks as 0216 to 0221 only. The script also stops for 0228 and 0230, and 0222 and 0223 are "not a break" but are listed at l.188, which is harmless because they ship in the same stopped window.
    - The smoke checklist ends at 0224, and "the ledger carries the tags 0213 to 0226" (l.703). The smoke checks 0227 to 0230 (`deploy-staging.sh:219-256`: refund-function grants, dead-letter grants, `job_payload` grants and the 0227 guard text).
    - Step 1 says "Operators who change plans need a token for the new audience carrying `ops:billing`". Refunds now need `ops:payment` on that same audience.
- **Staging acceptance (`staging-acceptance-handoff.md`):** l.38 has the stale count (A4). The service list (settlement and operator, MISSING before PR B) matches `staging-readonly-check.sh`.
- **`staging-first-deploy-pr-b.md`**
  - **Correct:** P1 to P12, P9a (OWN-93), P12 PENDING; D1 to D13 order; the rollback sequence (restore the database and the previous release before anything starts); §1 R2 setup.
  - **Wrong:**
    - D3 expects 225; D8 says the 0223 schema.
    - The evidence is through 0223.
    - l.662 says the OWN-92 weaknesses are "not fixed".
    - P10 lists a billing-audience token with `ops:billing` only. `billing-duplicate-payments.md` step 5.3 needs a billing-audience `ops:payment` token.
- **`backup-restore.md`:** the bootstrap creates all nine roles. BYPASSRLS is set for `rekoda_provenance_owner` and `rekoda_owner`, and the definer-owner and BYPASSRLS checks are at l.127-137. This matches the migrations' role set. `backup-scripts.test.mjs` keeps the list equal to the migrations, per the 12 Nov note. Its table (l.20-21) still names Backblaze B2 as the offsite target while the PR B staging plan uses R2; reconcile the wording.
- **`billing-duplicate-payments.md`:** consistent with 0214, 0230 and `server.ts:57-58`. The "do NOT call `/v1/ops/refund`" guidance for `duplicate_payment` is correct. Known R06: the refund record has no per-provider-refund identity, so a replayed request records a second refund up to the charge amount.
- **`incident.md`:** the refund-audience note is correct.
- **`docs/runbooks/README.md`** (index): omits `staging-first-deploy-pr-b.md`, `billing-staging-walkthrough.md` and `email-setup.md`. It says "B2 offsite".

### B14. `docs/TEST_MAP.md`

The file is at `docs/TEST_MAP.md` (none at the root). Two rows were added. 82 of the 84 test files new in PR B are unlisted, among them:

- `packages/db/src/ops/{paid-launch-gate,job-payload-isolation,dead-job-enrolment-scope,upgrade-from-main}.integration.test.ts`
- `packages/db/src/billing/pack-credit-terms.integration.test.ts`
- the settlement and operator process suites

The page says a new file must be listed "when it starts a feature", and the settlement and operator processes are new features.

---

## C. Required documentation corrections (numbered)

1. **PR #432 description:** rewrite for head `095ff62`:
   - migrations 0193 to 0230, 231 in total;
   - the commit table through `095ff62`;
   - OWN-92 as "implemented as 0227, CODE COMPLETE, the gate holds until merged and staging-verified";
   - compatibility breaks 0216, 0217, 0218, 0220, 0221, **0228, 0230**;
   - invariant rows for 0227, 0228 (with the A3 residuals), 0229, 0230, the Paystack fail-fast and the Caddy route;
   - remove the four owner questions OWN-94 resolved;
   - smoke "30 tags";
   - verification: CI run IDs for `095ff62` (all 12 green), and any local final-head runs (OWN-94 (3)).
2. **`docs/runbooks/staging-first-deploy-pr-b.md`:**
   - §8 D3: `"migrations":231` (or "the count of tags in the deployed journal");
   - §8 D8: "0230 schema";
   - §2 evidence rows l.41 and l.86: re-run the R2 drill against 0230, or state that 0224 to 0230 are not drill-evidenced;
   - l.662: replace "are open, not fixed" with the gate-row wording;
   - §7 P10: add "a billing-audience token with `ops:payment` (refund records, 0230)".
3. **`docs/adr/0035-operational-aggregate-monitoring.md`, Amendment 6:**
   - delete "grants nothing new" and list the new EXECUTE grants of 0228 and 0229;
   - in point 5, replace "An unpinned, cross-tenant or bulk payload read ... is refused" with the accurate statement: direct column reads are refused; `job_payload` checks the pin per call, so one statement can read every payload of the pinned business (R07), and per-row `set_config` can plausibly re-pin across tenants within one statement;
   - state that settlement's EXECUTE is not kind-limited (R01) until a kind filter lands (the uncommitted 0231);
   - widen "What the database still cannot enforce" to match;
   - the owner should not accept the amendment until the text matches 0228 (or 0231).
4. **`docs/rls-exemption-register.md`:**
   - the `job_payload` row: the same residual text as correction 3, plus the settlement any-kind note;
   - scope the closing "No payload ... is returned" sentence to the work-list functions;
   - update the `dead_job_unrecorded_candidates` caveat for 0228;
   - re-attach the 0199 close-batch row to the table;
   - optionally list `dead_job_enrolment_requeue` (app EXECUTE, caller-supplied actor; R11).
5. **`docs/REKODA_LAUNCH_READINESS.md`:**
   - OD-41 (xxii): add the residuals of correction 3;
   - OD-51 paragraph (l.152): replace "0213 to 0223 are additive and forward only" with "0213 to 0215, 0219, 0222 to 0227 and 0229 are additive; 0216 to 0218, 0220, 0221, 0228 and 0230 are compatibility breaks applied with every writing process stopped";
   - drop "through 0223" for `upgrade-from-main`;
   - add an OPEN OWNER DECISION for correction 8.
6. **`docs/HANDOFF.md`**, top table:
   - "Current date" to 15 Nov 2026 or later;
   - Product version to "PR B #432 adds 0193 to 0230 (231 once it merges)";
   - in the 15 Nov note, qualify the 0228 sentence as in correction 3;
   - record the final-head CI evidence for `095ff62`.
7. **`docs/runbooks/staging-acceptance-handoff.md`** l.38: "231, `0000` to `0230`, once PR B deploys". Preferably reference the journal count rather than a literal.
8. **Refund policy (`docs/adr/0024-the-commercial-terms.md` §Refunds, `apps/web/src/app/refunds/page.tsx`, `docs/REKODA_OWNER_DECISIONS.md` OWN-94 (8)):**
   - record an OPEN OWNER DECISION on how a credited pack is refunded under the "incorrect charge" and "Rekoda service failure" rows, and for packs credited before 0230 ("settle it by hand" has no sanctioned path);
   - then either a superseding note to ADR 0024 plus aligned `/refunds` copy, or an operator path in code.
   - Until ruled, `billing-duplicate-payments.md` and `incident.md` should say such a refund cannot be recorded.
9. **`docs/REKODA_OWNER_DECISIONS.md`, OWN-92 row:** append "Status: implemented as `0227_paid_launch_gate` in #432 (OWN-94), CODE COMPLETE; the gate holds until merged and staging-verified."
10. **`docs/runbooks/deploy.md`, "Deploy a release carrying 0213 to 0230":**
    - the intro: add 0228 and 0230 to the compatibility breaks;
    - step 3: add the 0225 to 0230 smoke checks (0227 guard text and `usage_bind_event`; `job_payload` grants; dead-letter grants; refund function grants and charge-guard text) and change "tags 0213 to 0226" to "0201 to 0230 (30 tags)";
    - step 1: add the `ops:payment` billing-audience token for refunds.
11. **`docs/REKODA_CURRENT_STATE.md`** l.397: add `dead-jobs/enrolment-failures` (`ops:read`) and `dead-jobs/:jobId/enrolment-requeue` (`ops:payment`) (0229); state that `refund` is served by the operator process since 0230; qualify the 0228 statement on l.31 as in correction 3.
12. **`docs/plans/PR-B-plan.md`:**
    - add "As built" bullets for 0224 to 0230, OWN-92 and OWN-94, the Paystack fail-fast and the Caddy route;
    - change "two routes" to "three routes plus health";
    - mark the §5 `rekoda_app`-only operator-writer text and "Remaining limit" as superseded by 0202 to 0221.
13. **`CLAUDE.md`**, "Database principals": change `rekoda_billing_operator` "(plan changes)" to "(plan changes and, since 0230, the only refund record)". Note `job_payload()` (0228) under invariant 3 once Amendment 6 is ruled.
14. **`README.md`** l.68: "SQL migrations 0000–0230".
15. **`docs/adr/0034-...`:** add an amendment note (or ADR 0035 cross-reference) for the sixth scope `ops:staging` and the operator process's own audience `OPERATOR_BILLING_OIDC_AUDIENCE`.
16. **`docs/REKODA_REFERENCE_MANIFEST.md`:** runbooks "16 files", naming `staging-first-deploy-pr-b.md`; add a `plans/*` row (PR-A and PR-B plans, class SUPPORTING or HISTORICAL); add a row for `audits/pr-432/*` if kept.
17. **`docs/runbooks/README.md`:** add `staging-first-deploy-pr-b.md`, `billing-staging-walkthrough.md` and `email-setup.md`; correct "B2 offsite" to the R2 plan. Also reconcile `backup-restore.md` l.20-21 (Backblaze B2) with R2.
18. **`docs/TEST_MAP.md`:** list the feature-starting PR B suites (paid-launch gate, payload isolation, dead-job enrolment scope and pin, pack-credit terms, upgrade-from-main, the settlement and operator process suites, staging tools).
