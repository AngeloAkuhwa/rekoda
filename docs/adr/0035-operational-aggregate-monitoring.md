# 0035 — Operational aggregate monitoring is a narrow cross-tenant exception

**Status:** Accepted
**Date:** 2026-10-22
**Owner ruling:** OWN-36
**Amends:** ADR 0022's description of what the worker credential is for. It
does not supersede ADR 0022: the queue, the `worker_claim` policy and the
three roles are unchanged.

## Context

Tenant isolation is the rule: tenant data is reached through `withBusiness()`
and fenced by row-level security, and the worker role reads across tenants
only to claim a job (ADR 0022). Alerting (G-26) needs to know, for the whole
platform, whether jobs are dying, whether due work is unclaimed and whether
provider webhooks are backing up. Those are cross-tenant questions by nature.
`queueHealth` and `eventHealth` already answered them for `/v1/ops/health` on
the worker credential, without a recorded decision that this was allowed.

## Decision

Designated internal operational-monitoring functions may read explicitly
approved, non-identifying aggregate metrics across tenants:

- counts of pending, running and dead jobs, the age of the oldest due job and
  of the oldest queued job (`jobsRepo.queueHealth`);
- counts of unprocessed and flagged provider events and of WhatsApp
  `status.failed` receipts in the last 24 hours (`events.eventHealth`);
- later, by the same rules: failed OTP sends, failed sweeps and failure rates.

Rules for every such function:

1. It is a dedicated query that returns only counts, ages and statuses. It
   never returns or logs a business id, customer or supplier identity, message
   content, payment detail, decrypted PII, secret, token or raw payload.
2. It is read-only. It writes no financial or merchant record.
3. It runs under a trusted service credential (today the worker credential) and
   is reached only from an operator-guarded route (`/v1/ops/*`, ADR 0034) or the
   worker's own alert pass. It takes no merchant input: no route parameter,
   query string or body selects what it reads.
4. No general-purpose cross-tenant reader is added, and no RLS policy is
   widened for it.
5. Alert notices built from it carry fixed words, numbers, the release and the
   commit, and nothing tenant-shaped.

## Consequences

- `CLAUDE.md` invariant 3 and the CodeRabbit "Security boundaries hold" check
  name this exception, so an approved aggregate is not reported as a breach
  and anything outside it still is.
- **Residual privilege (recorded, not closed).** The worker credential is
  broader than monitoring needs: migration 0004 grants it `SELECT, INSERT,
UPDATE, DELETE` on all tables, and `worker_claim` lets it read and change any
  tenant's job row. Monitoring uses only two aggregate queries, but a defect or
  a compromise of the worker process has the worker's full reach. Tables under
  `tenant_isolation` still return nothing without a pinned tenant. The
  least-privilege follow-up is a dedicated read-only monitoring role, or
  `SECURITY DEFINER` aggregate functions with `EXECUTE` granted to it, so the
  alert pass no longer needs the worker credential. That change needs a
  migration and a new credential and is tracked in the launch backlog.
- An endpoint or query that does not meet every rule above is a tenant-isolation
  defect, whatever its purpose.

## Amendment 1 (25 Oct 2026, owner ruling OWN-57 / OD-33): three classes of access

The decision above stands unchanged for its own subject. A scheduler needs a
second, differently shaped cross-tenant read, so the policy now distinguishes
three classes. None weakens tenant isolation.

1. **Non-identifying aggregate operational queries** (this ADR's original
   decision). Counts, ages and statuses only; never a business id.
2. **Narrow ID-only scheduling discovery.** A trusted background worker may
   discover which business ids a scheduled operation must act on. Rules:
   - it is a dedicated `SECURITY DEFINER` function with a pinned `search_path`
     and `EXECUTE` granted to `rekoda_worker` only (revoked from `PUBLIC` and
     `rekoda_app`); broad table permissions are not the mechanism for new
     discovery;
   - it takes only scheduling inputs (a clock reading, a window, a page size, a
     keyset cursor), never merchant input;
   - it returns the business id and the minimum scheduling state the decision
     needs, and never a phone, name, consent flag, financial figure, contact
     detail, message, payload or credential;
   - it is limited to named, approved scheduling operations (today: trial
     reminders, `sweep_trial_candidates`, migration 0181; scheduled and bulk
     payment reminders, `sweep_due_reminder_batches`, migration 0189, REM-05,
     returning the batch id, business id and scheduled time only); a new operation
     needs its own function and a line here;
   - after discovery, every read of owner data and every write runs under
     `withBusiness()` on the application role, and eligibility, consent, expiry
     and plan are revalidated inside that scope before anything is dispatched;
   - the worker cannot use discovery to read arbitrary tenant records: the
     function returns a fixed column set, and tests prove the grants, the
     column set, and that a wrong tenant pin reads and changes nothing.
3. **Tenant-scoped business data access.** Everything else, through
   `withBusiness()` only.

The grace, renewal, retention and settlement sweeps predate this amendment and
list through the worker role's table policy (`ops_read_businesses`, migration
0019). They are not approved by precedent: they are recorded in the OD-33
readiness row with the data each discovery returns, and moving each to a
dedicated function (and removing the owner phone from grace discovery) is a
tracked follow-up.

**Residual privilege (unchanged, recorded).** The worker credential still holds
migration 0004's table grants and `ops_read_businesses`; the new function does
not remove them, because the older sweeps still rely on them. Removing them is
the end state of the follow-up above.

**Dependency (recorded after the retrospective review of #362).** `businesses` has
`FORCE ROW LEVEL SECURITY`, so a `SECURITY DEFINER` discovery function returns rows only while its
owner bypasses RLS. Today the function is owned by the migrating role, and
`packages/db/src/migrate.ts` (`assertCanReachEveryTenant`) refuses to migrate as a role that cannot
reach every tenant. That guard protects migration-time setup only: it does not keep the owner's
`BYPASSRLS` or the function's ownership after deployment. If the deployed owner loses effective RLS
bypass (neither `rolsuper` nor `rolbypassrls`), discovery returns zero rows and reminders can stop
silently; rotating to another owner that keeps the bypass is safe. Any later change to the function owner or its RLS capability must
be reviewed against this paragraph, and an alert on "reminders due but none claimed" is the
monitoring that would catch it (not built; tracked with backlog N8).

## Amendment 2 (8 Nov 2026, owner ruling OWN-85 / OD-47): operator work lists

The decision and Amendment 1 stand. Rekoda's operations team must be able to find failed work across
businesses (a dead payment or billing job, a renewal Rekoda could not take payment for) without
knowing the business first, so the policy now distinguishes four classes. None weakens tenant
isolation, and this amendment is not permission for any later feature to read across tenants.

1. **Aggregate operational queries** (the original decision).
2. **ID-only scheduling discovery** (Amendment 1).
3. **Approved operator work lists** (this amendment): a narrowly scoped, read-only, cross-tenant
   discovery of the records an operator must work.
4. **Ordinary tenant-scoped access**: everything else, through `withBusiness()` only.

**Approved operator work lists, and nothing else:**

| Workflow                                             | Function (migration)                                                                                                                               | Returns (fixed columns)                                                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dead payment and billing jobs                        | `dead_job_ops_queue`, `dead_job_find_for_ops` (0194)                                                                                               | job id, business id, kind, event id, Rekoda reference, status, failure category, fixed summary, attempts, death count, timestamps, recovery state; the queue also the current charge or intent status and plan state |
| The job behind an event                              | `dead_job_open_for_event` (0194)                                                                                                                   | a job id                                                                                                                                                                                                             |
| The worker's own passes                              | `dead_job_is_recovering`, `dead_job_has_record` (0194)                                                                                             | a boolean                                                                                                                                                                                                            |
| Blocked renewals                                     | `blocked_renewals_ops` (0195)                                                                                                                      | Rekoda reference, business id, plan, amount, block reason and time, the business's current plan and paid-to date                                                                                                     |
| Blocked renewals, close pass (worker only, no route) | `blocked_renewals_close_batch` (0199), and the close cursor's `renewal_block_close_claim` / `_advance` / `_finish` / `_release` / `_status` (0199) | the same columns as `blocked_renewals_ops` plus the exact block time in microseconds; the cursor functions read and write only the single cursor row (a position, counts, a lease) and return booleans or counts     |

**Rules for every work list:**

1. It is a dedicated `SECURITY DEFINER` function with a pinned `search_path`, `EXECUTE` granted to
   `rekoda_worker` only (revoked from `PUBLIC` and `rekoda_app`). There is no cross-tenant RLS policy
   on `dead_job_exceptions` or any new table, and no general-purpose cross-tenant repository method.
2. It returns a fixed column set and is bounded (at most 200 rows). It never returns or logs a
   customer or supplier identity, phone, message content, payload, error text, payment credential or
   secret, and it is not a business search.
3. It is reached only from an operator route that enforces `ops:read` (or the worker's own pass). It
   is read-only.
4. **Reading authorises nothing.** Every recovery, resolution or other mutation of the work-list
   records runs under `withBusiness()` for the record's own business (the one pre-existing exception
   is the generic `external_events` exception resolve, `POST /v1/ops/exceptions/:id/resolve`, which
   runs on the worker credential under the older `worker_reads_the_estate` policy of migration 0130
   and is listed under residual privilege below), enforces its own operator scope (`ops:payment`,
   `ops:staging`), validates the target and its business association, and writes an audit event with
   the operator, target, action, reason and outcome.
5. Business-facing endpoints stay tenant-scoped. A new cross-tenant read needs its own review and
   its own line here.

The close-pass functions (0199, added 11 Nov 2026 under owner direction OWN-88) follow the same rules: worker-only, pinned path, bounded, read-only for tenant data; the cursor table they write holds no tenant data, has forced RLS with no policy and no grant to any application role.

Tests (`packages/db/src/ops/operator-work-lists.integration.test.ts`) pin the grants, the
`SECURITY DEFINER` and `search_path` settings, the exact column sets, the bound, that the table
returns nothing to an unpinned worker, and that the application role cannot call any of them.

**Residual privilege (unchanged, recorded).** The worker credential still holds migration 0004's
table grants and `ops_read_businesses`, and the generic event-resolve write above, and the older cross-tenant reads (`worker_resolve` on
`subscription_charges` and `payment_intents`, the events exception queue) predate this amendment.
Narrowing them remains the least-privilege follow-up. The functions read tables under
`FORCE ROW LEVEL SECURITY` and so, like the discovery functions of Amendment 1, depend on their owner
bypassing RLS (the migrating role); a change to that owner must be reviewed against this paragraph.

## Amendment 3 (11 Nov 2026, owner review of PR #432, OWN-89): the event estate is a read; the generic resolve follows rule 4

Status: accepted with PR #432 (not merged at the time of writing). Amendment 2 recorded the generic
`external_events` exception resolve as the one exception to its rule 4. The owner asked for that
privilege to be assessed as a security issue in its own right. Findings, on the code at `a11e786`:

- `worker_reads_the_estate` (0130) was described as a read but created with no `FOR` clause and no
  `WITH CHECK`, so with 0004's table grants the worker credential could INSERT, UPDATE and DELETE
  any business's `external_events` rows on every column with no pin (re-point an event to another
  business, rewrite its payload or reservations, stamp it resolved).
- `POST /v1/ops/exceptions/:id/resolve` (`ops:payment`) used that write: no pin, no check that the
  row was an exception, no audit row.

That is broader than the approved model (discovery is cross-tenant and read-only; mutation is
tenant-scoped, validated and audited) and is a tenant-isolation and unauthorised-mutation risk for a
compromised worker credential, so it was treated as a merge blocker and closed (migration 0204):

1. `worker_reads_the_estate` is `FOR SELECT` only. The worker keeps UPDATE of `processed_at` and
   `error` on rows that are still unattributed (`worker_marks_unattributed_ingress`, USING and
   WITH CHECK both `business_id IS NULL`), attributes an event only through
   `attribute_external_event(event, business)` (worker-only `SECURITY DEFINER`, pinned search_path,
   write-once from NULL to an existing business), and has no INSERT, DELETE or other column UPDATE.
2. The generic resolve now follows rule 4 with no exception: the target is read on the worker
   credential and must be an open exception (flagged, or never processed); the write runs on the
   application credential under `withBusiness()` for the event's own business (re-checked by RLS),
   and an `exception_resolved` audit event is written there in the same transaction. An unattributed
   event belongs to no business: it is resolved on the application credential, which reaches only
   unattributed rows without a pin (0130's `app_records_unattributed_ingress`), and the event's own
   `resolved_by`, `resolved_at` and `resolution` are its record (there is no tenant to own an audit
   row).

Residual (recorded, unchanged by this amendment): `app.business_id` is an ordinary setting, so the
worker credential can still pin a business and write that business's `processed_at`/`error` through
the tenant policy; the older SELECT-only `worker_resolve` reads on `subscription_charges` and
`payment_intents`; and 0004's blanket grants on other tables (the OD-33-F1 follow-up). Tests:
`packages/db/src/ops/external-events-worker-write.integration.test.ts`; the staging pre-start smoke
checks the policy command and the column grants.

## Amendment 4 (11 Nov 2026, owner closeout instruction for PR #432, OWN-90): the worker writes only what its jobs make

Status: accepted with PR #432 (not merged at the time of writing). It closes the residual
Amendment 3 recorded. Assessed on the code at `51f800f`:

- 0004's blanket grants were still in force. The worker credential could write almost every table,
  and every future one through default privileges, including column INSERT on the append-only books.
  Because the pin is caller-settable, that reached any business: identity (sessions, users,
  memberships), the migration ledger, the merchant's books, explicit entitlements and other
  businesses' jobs.
- Through the tenant policy, the worker could still mark another business's attributed event
  processed, or clear its flag. That hides a payment from both the handler and the operators'
  flagged list.
- `retention_delete_business` took its cutoff from the caller. With the worker credential, any
  warned trial or expired business that had never paid could be erased early.

Migration 0210 closes all three:

1. Every worker INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER, at table and column level,
   is revoked, default privileges included. Only the writes its jobs make are granted back:
   - queue UPDATE;
   - outbox UPDATE;
   - webhook deliveries INSERT and UPDATE, and the endpoint health columns;
   - object-deletion UPDATE and DELETE;
   - stranger replies;
   - usage counters (webhook-delivery metering, a dead job's reserved meters);
   - the dead-job record with its audit row and merchant exception;
   - the two event columns.

   Discovery stays cross-tenant and read-only (rule 2, Amendment 1).

2. A trigger limits the worker's event writes:
   - on an attributed event, it may only add the dead-job flag (`error` from none to a value, with
     `processed_at` left empty);
   - on an unattributed event, it may mark it processed once, with a reason for a Paystack event, so
     an unmatched payment stays in the flagged list.
3. The retention deletion applies its own policy (ended at least 90 days ago, warned at least 30
   days ago, core `RETENTION`) whatever cutoff it is given. Its unchecked body runs for no runtime
   role, and no runtime role can backdate a retention notice.
4. No runtime role writes `rekoda_migrations` or `business_entitlements`.

Residual: the worker still updates any business's job row, because it coordinates the queue (ADR
0022). The table owner and the infrastructure administrator are an administrative trust boundary,
exempt from every guard. That is not the same class as a runtime role.

Tests:

- `packages/db/src/tenancy/worker-least-privilege.integration.test.ts`;
- the pre-start smoke (`scripts/deploy-staging.sh`, `deploy-smoke-sql.integration.test.ts`), which
  checks the worker's exact write set and has a tampering case for each rule.
