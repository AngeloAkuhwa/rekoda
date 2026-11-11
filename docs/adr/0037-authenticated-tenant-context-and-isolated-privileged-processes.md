# ADR 0037: Authenticated tenant context and isolated privileged processes

**Status:** Proposed (11 Nov 2026). Step 1 (D4) is implemented in migration 0211; steps 2 to 7 are not. Required by owner ruling OWN-90 (the PR #432 final remediation
brief, §5.1, §5.2, §5.5, §6 and §8). Not implemented yet. The gaps it closes are G-125 to G-129 in
`docs/REKODA_LAUNCH_READINESS.md`, and they block launch. This ADR supersedes nothing until it is
Accepted. When it is, it amends ADR 0035, whose Amendments 1 to 3 describe the worker's current
cross-tenant access.

## Context

The tenant boundary today is `withBusiness()`. It sets the ordinary PostgreSQL setting
`app.business_id`, and RLS policies compare each row with it (`packages/db/src/client.ts`; 107 of
127 policies apply to every role). Any session can set that setting. So a holder of the
`rekoda_app` or `rekoda_worker` password can pin any business and act inside it as the application
would.

Migrations 0196 to 0210 took the _billing_ columns out of that reach. Only settlement opens a charge
or records a payment, and the price is recomputed from the catalogue. Only the billing operator
changes a plan or records a refund. Metering, scheduling and the trial start go through narrow
functions. Those protections still check the pin, but only against the writer's own `p_business`
argument. None of them stops a stolen general credential from reading or writing a tenant's
ordinary records (sales, invoices, customers in the vault-token form, stock).

Two further facts from the code:

- **Shared credentials.** The api process holds `SETTLEMENT_DATABASE_URL` and
  `OPERATOR_DATABASE_URL`. It prices and opens plan and pack charges on settlement and serves the
  operator routes. The worker holds settlement for `billing.process` and the renewal sweep. The
  production Compose file gives every service the same `.env`, with a few overrides
  (`docker-compose.prod.yml`).
- **Broad worker rights.** The worker has `SELECT, INSERT, UPDATE, DELETE` on every table by default
  privilege (`0004_jobs.sql`), and `USING (true)` policies on `jobs`, `businesses` (read),
  `subscription_charges` (read), `payment_intents`, `payments`, `outbox_events`,
  `webhook_deliveries` and others (0004, 0010, 0019, 0020, 0048, 0060, 0111, 0124, 0130, 0204). It
  also runs bounded `SECURITY DEFINER` discovery functions (0161, 0181, 0189, 0194, 0198, 0199).

## Decision (proposed)

### D1. Tenant context is a verified claim, not a setting

1. **Issuer.** A separate process, `rekoda-identity`, holds the context signing key `K_ctx`. The api,
   the worker and the web app never hold it. It issues a short-lived claim:
   `{ business, subject, purpose, iat, exp ≤ 60 s, nonce }`, authenticated with HMAC-SHA256 under
   `K_ctx`. It issues one only after verifying the caller's own authority:
   - a dashboard session token, checked against `sessions`, for a member's business and role;
   - a verified WhatsApp delivery: Meta's signature over the raw body, then the sender's phone mapped
     to a business (the webhook is verified by the issuer, or forwarded to it with the raw body);
   - a job: the job row's business, read by the issuer from a signed enqueue record;
   - the scheduler's own discovery, for sweeps (see D3).

2. **Database verification.** `rekoda_private.tenant_context_keys` holds `K_ctx`, readable only by a
   NOLOGIN role `rekoda_context_verifier`. That role owns `public.rekoda_enter_tenant(claim text)`, a
   `SECURITY DEFINER` function with a pinned `search_path` and no PUBLIC execute. The function checks
   the HMAC, the expiry and a single-use nonce, then records `(pg_backend_pid(), txid_current(),
business, subject, purpose, exp)` in `rekoda_private.tenant_context`. No runtime role may write
   that table.

3. **RLS reads the verified row, not the setting.** Every tenant policy becomes
   `business_id = (SELECT rekoda_private.current_tenant())`. `current_tenant()` is a STABLE definer
   function that returns the business recorded for this backend and transaction, if it has not
   expired. It is evaluated once per statement as an init-plan. Setting `app.business_id` no longer
   grants anything. Each existing writer's check, `p_business = pin`, becomes
   `p_business = current_tenant()`.

4. **What a stolen database credential still allows.** Without `K_ctx` it allows no tenant access at
   all: every tenant policy yields no rows. With a compromised api process, it allows only the
   businesses whose live sessions or verified webhooks pass through that process while it is
   compromised. Arbitrary businesses stay out of reach.

### D2. Privileged processes are separate services with their own secrets

- **`rekoda-settlement`** holds only `SETTLEMENT_DATABASE_URL` and the Paystack secret. It consumes
  durable `billing.process` and `billing.open_charge` work. The api enqueues a request, and the
  settlement service verifies the merchant's entitlement, prices the charge, opens it and returns the
  checkout link over an authenticated internal channel: mutual TLS, or a signed request with a service
  identity and a replay window, on a private network. An internal URL alone is never treated as
  authentication. A zero-priced upgrade, now settled inline by the api, is queued to the settlement
  service like any other charge.
- **`rekoda-operator`** holds only `OPERATOR_DATABASE_URL` and the OIDC configuration. It serves
  `POST /v1/businesses/plan` and `POST /v1/ops/refund` itself, after verifying the OIDC identity and
  the `ops:billing` or `ops:payment` scope, and it writes an audit row for every success and refusal
  (0207 already records refusals). The api no longer mounts these routes.
- **Compose** stops using the shared `.env` and gives each service an explicit allowlist instead: an
  `environment:` list or a per-service secret file. Only the migrate job sees the owner credential.
  Boot checks already refuse an owner, superuser, `BYPASSRLS` or reserved-role connection; they are
  extended to refuse a privileged URL present in a general process.

### D3. The worker gets bounded discovery and verified tenant access

The blanket default privileges of 0004 are revoked. Each `USING (true)` worker policy is replaced
with a `SECURITY DEFINER` discovery function that:

- returns fixed, minimal, non-identifying columns (ids, statuses, due times);
- applies a row limit and keyset pagination;
- is read-only, with EXECUTE granted to `rekoda_worker` only.

Grace, renewal, retention, settlement and operational discovery all move to such functions. ADR 0035
Amendment 1 already set this pattern for scheduling discovery. Acting on a discovered business needs
a claim from the issuer (D1), which the scheduler requests for that business and purpose, and
every mutation re-checks it. The event table keeps 0204's read-only estate and its write-once
attribution function. Processing columns move behind a transition function as well.

### D4. Explicit grants for every principal

`rekoda_settlement` and `rekoda_billing_operator` stop inheriting `rekoda_app` and get exact table,
column and function grants. A privilege matrix test checks every principal against every table and
function and fails on any grant not in the reviewed list, in the same way
`plan-expiry-files.allowed.ts` pins the plan-field writers.

## Implementation sequence

Each step is its own reviewed PR with RED-first tests, run as the real principals.

1. **D4.** Explicit grants for settlement and the operator, and the privilege-matrix test. This needs
   no new process and no change to the tenant pin.
2. **D2 Compose and secrets.** Per-service environment allowlists, so each privileged URL reaches
   only the process that uses it today, plus boot refusal of a misplaced privileged URL.
3. **D2 operator service.** `rekoda-operator` takes the operator plan and refund routes, which the
   api then stops mounting.
4. **D2 settlement service.** `rekoda-settlement` takes charge opening and settlement, the internal
   authenticated request channel is added, and the api loses `SETTLEMENT_DATABASE_URL`.
5. **D1 issuer and verifier.** The `rekoda-identity` service, the key table, `rekoda_enter_tenant`
   and `current_tenant`. Built and tested alongside the old pin, without enforcing it yet.
6. **D1 enforcement, table by table.** Policies switch to `current_tenant()`, with `withBusiness`
   taking a claim instead of an id. The RLS invariant suite asserts that setting `app.business_id`
   alone grants nothing.
7. **D3.** Worker discovery functions, revocation of the 0004 default privileges and the `USING
(true)` policies, scheduler-issued claims for sweeps, and an update to the RLS exemption register
   and ADR 0035.

## Consequences

- Every database call path changes in steps 5 to 7, and so do the fixtures that set the pin
  directly.
- A claim round-trip is added per request or job. The issuer must be highly available: if it is
  down, tenant work stops (it fails closed).
- `K_ctx` rotation needs two active keys in the verifier table, and the runbook gains a rotation
  procedure.
- The database owner and superuser remain the infrastructure root of trust. They can read `K_ctx`
  and change any rule, and no application grant removes that (OWN-90 §5.7). They never connect at
  runtime, and boot checks refuse a runtime role that is one or can become one.
