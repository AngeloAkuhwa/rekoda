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
