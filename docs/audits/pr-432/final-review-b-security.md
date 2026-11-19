# PR #432 final independent review, Reviewer B: security, privacy, identity, authorisation, tenancy

- Branch: `angelo/magical-bell-s81mqc`, merge base `58e6834`.
- Reviewed head: `6cf9d45016e61ce0ef2ecf3fba6536c6a5094db7`. The branch moved while this review ran
  (`1376d7e` to `5d901dc` to `6534555` to `6cf9d45`). The later commits change tests, audit
  manifests and one script (`scripts/lib/job-payload-reads.mjs`); none touches a migration.
- The working tree also holds UNCOMMITTED edits to `docs/REKODA_LAUNCH_READINESS.md`, ADR 0034/0035,
  `docs/rls-exemption-register.md` and runbooks, made by another process while I worked. Among
  them are the OD-54 and OD-55 rows. Neither row exists at the committed head (`git show
HEAD:docs/REKODA_LAUNCH_READINESS.md` has no `| OD-54 |` or `| OD-55 |`), but 0235, ADR 0035
  Am. 6 and the exemption register already cite both. I review the committed head and point out
  where the uncommitted text would supersede a finding.
- Method: read-only. I read the migrations 0193 to 0237 for roles, grants, policies and definer
  functions, the repositories, the boot checks, the operator plane, the guards and the staging
  tools. I did not touch PostgreSQL. Every claim below comes from reading the code. None was
  executed.

## Findings

### B-1 (IMPORTANT): the worker can defeat 0234's "running or dying only" rule by moving the job's state itself, so a finished job's payload stays readable

- **Where:** `packages/db/migrations/0234_job_payload_live_or_dying_only.sql:24-30,34-47`;
  `docs/adr/0035-operational-aggregate-monitoring.md:352-366` (Am. 6 point 5: "a pending backlog and
  a finished job's history are not returned to any caller", "(c) only running or dying jobs are
  readable"). The privilege that defeats it: `0212_closeout_review_fixes.sql:32-34`, which grants
  `rekoda_worker` UPDATE (state, ...) on `jobs`. `0004_jobs.sql:78-82` gives `worker_claim` with
  `USING (true) WITH CHECK (true)`. `0221_...:207-210` adds the restrictive
  `worker_leaves_settlement_jobs`, but only for the two settlement kinds. The transition guard in
  `0223_...` (`jobs_application_transition_guard`) returns at once for any role that is not
  `rekoda_app`.
- **Scenario:** someone holds the worker credential, the only role that executes `job_payload`.
  They run:
  `BEGIN; UPDATE jobs SET state='running' WHERE id=$done_inbound_job; SELECT set_config('app.business_id',$biz,true); SELECT job_payload($done_inbound_job); ROLLBACK;`.
  The `UPDATE` is allowed: there is a column grant on `state`, the permissive policy is `true`, the
  restrictive policy covers only `billing.*`, no trigger guards worker transitions, and the
  `CHECK (state IN ...)` accepts `running`. `job_payload` then returns the historical merchant
  message or document payload. The rollback leaves no trace, and no audit row is written. A pending
  or dead job of any kind can be read the same way. With a per-row re-pin, one statement reads every
  tenant's history.
- **Why it matters:** R07 asks for the guarantees to be stated exactly, including the residual
  capabilities of the worker. 0234's header, ADR 0035 Am. 6 point 5 and the RESIDUAL cases in
  `packages/db/src/ops/job-payload-isolation.integration.test.ts` (lines 156-212) present the
  state filter as something the database enforces. They say nothing about the worker being able to
  set the state the filter reads. As written, the guarantee is not true. (For context, the worker
  also keeps cross-tenant SELECT, under the pin, on every other tenant table; 0210 revoked only
  writes. The job-payload narrowing therefore limits only this one column.)
- **Fix:** either:
  - (a) add a BEFORE UPDATE guard for `rekoda_worker` on `jobs` that allows only the transitions
    its code makes (pending to running on a claim, running to done/pending/dead, dead to pending
    for an operator recovery, plus the coordination columns), add an ATTACK test (done to running,
    then `job_payload`, must be refused), and add the guard to the deploy smoke; or
  - (b) restate the residual exactly in 0234's header (by a new migration comment or the ADR), in
    ADR 0035 Am. 6 point 5 and in the exemption register ("the worker can move any non-settlement
    job to `running` and read it"), and pin it with a RESIDUAL test.

  (a) is preferred, because the guarantee was the point of 0234.

- **Confidence:** high (privilege chain read in full; not executed).

### B-2 (IMPORTANT): several operator-actor columns added by the PR do not enforce the operator-actor contract, and the application credential writes them directly

- **Where:**
  - `packages/db/migrations/0194_dead_job_exceptions.sql:46,52,217-219`: `recovery_requested_by`
    and `closed_by` are free text, with UPDATE for `rekoda_app`.
  - `0217_settlement_isolation.sql:166`: `closed_by` also has UPDATE for `rekoda_settlement`.
  - `0195_renewal_blocked.sql:21`: `blocked_resolved_by` is free text, written by
    `packages/db/src/repos/subscriptions.ts:2835` on the application credential.
  - `0197_staging_test_business_tools.sql:39,56,111`: `designated_by`, `operator` and `armed_by`
    are free text, with INSERT for `rekoda_app`.
  - Writers of the dead-job columns: `packages/db/src/repos/dead-jobs.ts:376,439`.
- **Scenario:** someone holds the application credential (or the settlement credential, for a
  `billing.process` record). They pin a business and run
  `UPDATE dead_job_exceptions SET status='resolved', closed_at=now(), closed_by='operator:alice', resolution='settled by hand' WHERE ...`.
  The operator item disappears from `dead_job_ops_queue`, attributed to an operator who never acted.
  A malformed actor (`alice`, `operator:`, text with a newline) is accepted too. The HTTP routes use
  `operatorActor()` (`apps/api/src/auth/operator-actor.ts:20-31`), so honest code writes the
  contract. The database does not hold it.
- **Why it matters:**
  - R04/R05 require `operator:<subject>`, with a subject of 1 to 255 printable characters, "in
    every operator function/column". 0233 and 0235 fixed `requeued_by` and `subscription_refunds.actor`
    but left these columns alone.
  - R11 asks whether the application credential can forge operator audit identities. It can: here,
    in `dead_job_enrolment_requeue` (EXECUTE for `rekoda_app`, `0229:211`, actor supplied by the
    caller), and in `audit_events` (INSERT for `rekoda_app` since 0001, and for
    `rekoda_worker`/`rekoda_settlement` since 0210/0217, with any `actor` and `source_type`).
  - This is a pre-existing boundary, not a new weakness of the requeue function. But at the
    committed head the owner decision it is attributed to (OD-54, cited by
    `docs/rls-exemption-register.md:237` and ADR 0035:375) does not exist in
    `REKODA_LAUNCH_READINESS.md`. The uncommitted OD-54 row in the working tree describes the
    boundary accurately and recommends B (move these routes to the operator process and
    credential, guard `source_type='operator'` inserts, revoke the closing columns). It still omits
    `blocked_resolved_by`, the staging columns and settlement's `closed_by` grant.
- **Fix:**
  - Commit the OD-54 row and extend it to every column above.
  - Add CHECK constraints now:
    `closed_by IS NULL OR closed_by ~ '^(operator:[!-~]{1,255}|system:[a-z_]+)$'`, and the same for
    `recovery_requested_by` and `blocked_resolved_by` (the sweep writes a system actor), plus
    `^operator:[!-~]{1,255}$` on the staging actor columns.
  - Add boundary (255/256) and malformed tests.
  - Revoking the closing columns from `rekoda_app`, and from settlement, is the option-B follow-up.
- **Confidence:** high.

### B-3 (MINOR): settlement can close its own kind's dead-job records under any actor

`0217_settlement_isolation.sql:166` grants `rekoda_settlement` UPDATE (closed_at, closed_by,
resolution) on `dead_job_exceptions`, limited to `billing.process` by `0223:63-67`. A compromised
settlement credential can close a dead billing job's operator item as `operator:<anyone>`, which
hides a payment it is withholding from the operator list. This is the same kind of denial OD-51
already records for settlement. It is not named in OD-51 or in the uncommitted OD-54. Fix: name it
in OD-54, and allow only the `system:recovery` close from settlement (CHECK, or a guard keyed on
`current_user`). Confidence: high.

### B-4 (MINOR): the identity verifier trims the subject, so two IdP subjects can share one audit actor

`apps/api/src/auth/operator-identity.ts`, in `verify`: `payload.sub.trim()`. The subjects `" ada"`
and `"ada"` both become `operator:ada`. Rejecting the token is better than normalising it: refuse a
`sub` that is not already `^[!-~]{1,255}$`. Low practical risk with a single IdP. Confidence: high.

### B-5 (MINOR): a stale boot-check comment says settlement inherits `rekoda_app`

`packages/db/src/repos/boot-checks.ts:222-223` says "Settlement acts with the application's
ordinary rights (it inherits `rekoda_app`)". The code a few lines below refuses exactly that
(`in_app !== false`, which 0217 requires). Fix: correct the comment. Confidence: high.

### B-6 (MINOR): the R10 retention list guard cannot fail for a forgotten table

`packages/db/src/privacy/retention-pr432-tables.integration.test.ts:148-158` checks only that each
table already in the list has a `business_id` column. A new tenant table missing from the list is
never detected. Coverage itself is generic: `retention_delete_business` walks every table that has
`business_id`, and the deletion case does exercise all nine tables with a neighbouring tenant left
untouched. So the risk is a future foreign key that blocks the walk on an untested table. Fix:
compare against every `public` table with `business_id` whose creating migration is at or after
0193, or against the full set minus a pinned pre-PR baseline. Confidence: high.

## Checked and found sound

- **R01:**
  - `0231:22-35` revokes EXECUTE on `job_payload` from settlement and asserts it with
    `has_function_privilege`, which counts inherited membership. `0234:45-47` re-asserts the grants.
  - Settlement's only route to payloads is its SELECT on `jobs`, filtered by the permissive
    `settlement_claim` and the restrictive `settlement_only_its_kinds` (`0217:175-183`), and
    `pinnedPayload` picks that path by privilege (`packages/db/src/repos/jobs.ts:535-551`).
  - Settlement holds no other definer function that returns payload data: its grants are
    `subscription_apply_paid_charge`, `usage_credit_pack`, `dead_job_has_record` and
    `dead_job_is_recovering`, all of which return booleans or charge outcomes.
  - The membership matrix in `0217:202-221` forbids settlement being a member of any other role, or
    any other role a member of it.
  - The events it can see are restricted to the Paystack events its own jobs name
    (`0223:52-63`), and its dead-job records to `billing.process` (`0223:63-67`).
- **Worker column revoke:** `0228:45-48`. A table-level REVOKE also removes column grants. The
  default privileges from 0001/0004 cannot re-grant on `jobs`, because that table already exists.
  `rekoda_usage_writer`'s SELECT(payload) (`0227:38`) is held by a NOLOGIN role, and the boot checks
  refuse any app or worker connection that is a member of it (`boot-checks.ts:206`).
- **New tables (0193-0237):** each enables and forces RLS with `tenant_isolation`, and each revokes
  the 0001/0004 default grants from `rekoda_app`/`rekoda_worker` and then grants an exact set:
  - `dead_job_exceptions` (0194:64-66,212-219)
  - `staging_*` (0197:31-32,42-49,76-82,117-124)
  - `plan_change_reviews` (0213:55-63)
  - `billing_pricing_source(_history)` (0215:70-73)
  - `usage_reservations` (0216:83-95)
  - `renewal_block_close_cursor` (0199:75-78)
  - `dead_job_enrolment_failures` (0229:53-61)
  - `subscription_refunds` and `pack_credit_entitlements` (0235:62-87)
- **Definer functions:**
  - Every new SECURITY DEFINER function pins `search_path` (pg_catalog first, pg_temp last) and
    revokes PUBLIC on first creation. The later `CREATE OR REPLACE` keeps owner and ACL. I checked
    this mechanically across 0193-0237.
  - The boot checks refuse any runtime role that can create objects in `public` (`boot-checks.ts:118`).
  - `subscription_record_refund`: the 5-argument form is dropped before the 6-argument form is
    created (`0235:411`), and EXECUTE goes to `rekoda_billing_operator` only (`0235:538-541`).
- **R04/R05 in the functions:** `^operator:[!-~]{1,255}$` is enforced in `set_plan` (0221:59),
  `correct_subscription_period` (0208:139), `resolve_review` (0232:141), `dead_job_enrolment_requeue`
  plus `requeued_by` (0233:27-41), and `subscription_record_refund` plus `subscription_refunds.actor`
  (0235:52,435). The API (`operator-actor.ts:10-31`) and the operator process
  (`operator-plane/authenticate.ts:111-115`, `server.ts:125-131`) refuse with a 400 before any write.
  Boundary tests exist: `operator-actor.test.ts`, `dead-job-enrolment-dead-letter`, `pack-refund`,
  `plan-writer-boundary`. The column gaps are in B-2.
- **Operator plane routing:**
  - Caddy sends `/v1/businesses/plan*` and `/v1/ops/refund` to `operator:3002`
    (`deploy/Caddyfile:72-80`).
  - The API answers 404 before reading any identity: `OperatorPlaneServedHere` is listed before
    `OperatorGuard` on a controller with no class-level guard (`ops-refund.controller.ts:52-57`;
    `auth.controller.ts:386,406`).
  - In production the API refuses `OPERATOR_DATABASE_URL` and `SETTLEMENT_DATABASE_URL`
    (`config.ts:1406-1431`).
  - The operator process (`operator-plane/config.ts:117-156`):
    - accepts only its own exclusive audience, which must differ from the API's;
    - requires OIDC in production and uses https issuer/JWKS URLs;
    - matches routes with `Object.hasOwn`;
    - checks identity, then scope, then the body, with a 16 KB edge limit.
- **Boot checks:**
  - `assertDatabasePrincipal` is used by the settlement and operator processes (`settlement-main.ts:36-45`,
    `operator-main.ts:23-26`). It checks: exact role name; no super/bypass; own writer only; no
    membership of app, worker, plan/usage writer or table owner; no CREATE on `public`; all 13 guard
    triggers enabled.
  - API and worker: `assertRoleHoldsNoReservedWriter` (`main.ts:98-104`).
  - Key fingerprints: settlement compares and never enrols (`assertKeyEnrolled`,
    `boot-checks.ts:348-372`; `0237:18-19` is SELECT only). The API compares and enrols
    (`assertKeyUnchanged`). The errors name fingerprints only, never keys.
- **Staging tools:**
  - Service fence: the flag, a test Paystack key, no §47 confirmation, and the database marker
    (`staging-tools.service.ts:62-75`).
  - The marker can be written only by the owner (`0197:31-32`).
  - `staging_move_date` re-checks the pin, the marker and the designation inside the definer
    (`0197:152-159`).
  - The API refuses to boot with a live key on a staging-marked database (`staging-boot-check.ts`).
  - Every route requires `ops:staging`.
- **R10:** retention deletes rows in all nine new tenant tables and leaves the neighbouring tenant
  untouched (`retention-pr432-tables.integration.test.ts:160-186`). No new foreign key has a
  RESTRICT that blocks the walk, and the composite tenant foreign keys keep references inside one
  business. The singleton tables carry no tenant data.
- **PII and secrets in logs:** the new log lines carry business ids, charge references, counts,
  SQLSTATEs and `redactForLog` output. None contains a message body, a name, a payload or a key.
  The operator process's `describe()` drops the "Failed query" text and the bound values
  (`operator-plane/server.ts:162-171`). The boot errors name environment variables, never their
  values.
- **R11, overall:** the requeue function and the dead-job and exception routes run on the
  application credential, so the database does not assert operator identity there. This is the same
  class as `audit_events` INSERT, which `main` has had since 0001. It is not new to PR #432, but it
  needs the committed OD-54 row and the column coverage described in B-2.

BLOCKING=0 IMPORTANT=2 MINOR=4
