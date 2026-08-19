# 0022 — The job queue lives in our schema, and claiming it is a role

**Status:** Accepted
**Date:** 2026-08-19
**Implements:** MASTER-PLAN §5.3.1 · **closes** 4.4 #3
**Builds on:** [0001](0001-modular-monolith-typescript.md) (RLS as the second line of defence),
[0020](0020-identity-persistence-and-the-setup-grant.md) (the second pin, and why
`SECURITY DEFINER` is not available to us)

## Context

The plan named pg-boss. Writing the runner surfaced a problem with that which is
worth recording, because the reasoning generalises to anything else we might
bolt onto this database.

Every tenancy guarantee in Rekoda rests on one sentence: the application
connects as a role that is not the table owner and has no `BYPASSRLS`, so the
policies are live for every query it runs. Background work is exactly where that
sentence gets forgotten — a worker has no request, no session and no user, so
there is nothing in its ambient context to remind anybody that a tenant needs
pinning. MASTER-PLAN 4.4 #3 anticipated this and asked for a wrapper.

A wrapper is a convention. We have spent two milestones turning conventions into
things the database enforces, and this is the last place where the difference
still matters.

### What pg-boss would have cost

1. **Its tables sit outside our RLS perimeter.** pg-boss owns a `pgboss` schema
   with its own `job` table, and nothing about `business_id` means anything
   there. Tenant safety in the worker would then rest entirely on the wrapper
   being applied correctly at every call site — the convention we were trying to
   escape.
2. **It needs DDL rights.** Installing it means letting something create a
   schema and tables. Our application role deliberately cannot reshape the
   schema it is constrained by. Solvable by running the install as the owner,
   but it adds a second migration mechanism.
3. **It brings a second driver.** pg-boss uses `node-postgres`; we use
   `postgres.js`. Two pools, two TLS configurations, two sets of timeout
   semantics, in the one process that must not lose a merchant's sale.

None of these is fatal. Together, for a queue whose entire requirement today is
"run this soon, retry it if it fails, exactly once", they buy a dependency we
would have to work around in the one dimension we care most about.

## Decision

**A `jobs` table in `public`, under the same row-level security as everything
else, and a second login role — `rekoda_worker` — that is the only thing able
to claim from it.**

```sql
CREATE POLICY tenant_isolation ON jobs
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

CREATE POLICY worker_claim ON jobs FOR ALL TO rekoda_worker USING (true) WITH CHECK (true);
```

Three consequences follow, and they are the whole point:

* **The API cannot read another tenant's queue.** `rekoda_app` matches only
  `tenant_isolation`, so an unpinned `SELECT` over `jobs` returns nothing.
  Enqueueing happens under an ordinary tenant pin, exactly like writing an
  invoice.
* **The worker's extra reach is one table wide.** `worker_claim` names `jobs`
  and nothing else. For `invoices`, `ledger_entries`, `customers` — everything
  that matters — `rekoda_worker` is as constrained as the API, and the runner
  must pin a tenant to touch any of it.
* **Forgetting to pin fails closed.** A runner that skipped `withBusiness` would
  not read the wrong tenant's rows; it would read none.

### Why claiming needs a role rather than a function

The obvious alternative is a `SECURITY DEFINER` function that claims a job. It
does not work here, for the reason recorded in ADR 0020: under `FORCE ROW LEVEL
SECURITY` the policies apply to the table owner too, so a definer function gains
nothing. The other alternative — a third GUC, `app.worker`, unlocked by a policy
— is weaker than what we have, because any code holding the application's
connection could set it. A role is a credential: the reach is bounded by which
secret a process was started with, and it is visible in `\dp` rather than buried
in a code path.

### The handler signature is the enforcement

```ts
export type JobHandler = (ctx: { tx: TenantDb; businessId: string; … }) => Promise<void>;
```

A handler receives a transaction that is *already pinned* and no other database
handle. There is no version of a handler that reads across tenants by
forgetting something, because there is nothing to forget — the runner pins once,
in one place, and the type carries the guarantee the rest of the way. That is
what closes 4.4 #3, rather than a convention that jobs "should" use
`withBusiness`.

### A job and its effects commit together

The runner marks a job `done` **inside the handler's own transaction**. Split
into two commits, a worker that dies in between leaves a job that already did
its work looking claimable — and the second run issues a second document, sends
a second WhatsApp message, or posts a second set of ledger entries. Committing
them together makes "did this job run?" a question the database answers rather
than one we reason about.

`markDone` is therefore typed to `TenantDb`, not `Db`: the signature will not
let a future caller complete a job outside the transaction that did the work.

## Consequences

**Payloads carry references, never content.** The queue is the one table a
worker reads across tenants, so anything in `payload` is readable by every
worker. Job payloads hold an event id or a document id; message text stays in
the vault. This is a rule the schema comment states and reviewers must hold.

**A third connection string.** Deployments now configure `DATABASE_URL`
(`rekoda_app`), `OWNER_DATABASE_URL` (migrations) and `WORKER_DATABASE_URL`
(`rekoda_worker`). `WORKER_DATABASE_URL` deliberately does **not** fall back to
`DATABASE_URL`: that convenience would hand the runner a role with no claim
policy, so the queue would look permanently empty and jobs would pile up
silently — and in an environment where `DATABASE_URL` is the owner, it would
hand the runner `BYPASSRLS`.

**We own the retry semantics.** Exponential backoff, a `dead` state after
`max_attempts`, and a reclaim sweep for jobs whose worker died mid-run — about
150 lines of SQL, all of it tested against a real PostgreSQL under real
concurrency. If we outgrow it (priorities, cron, throughput past a single
polling loop) the table is a normal table and moving to something bigger is a
migration, not a rewrite.

**One image, two roles.** The API and the worker deploy from the same build and
are chosen by `REKODA_WORKER=1`, so a handler cannot exist in one and be missing
from the other. In development a single process does both; in production they
scale apart.

## Revisit when

* Throughput outgrows one polling loop per worker process — the fix is
  `LISTEN`/`NOTIFY` before it is another dependency.
* We want scheduled/cron jobs, at which point pg-boss's feature set starts to
  earn its cost again — but the tenancy argument above does not change, so
  anything we adopt has to answer it.
