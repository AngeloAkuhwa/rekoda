# PR B plan — dead-job recovery, plan-field protection, staging test tools

Base: `main` after PR A merges (currently `a43675c`). Status: PLAN ONLY. PR B must not start before PR A is merged.
Sources: `REKODA_OWNER_DECISIONS.md` (OWN-70, 73, 76, 77), `REKODA_LAUNCH_READINESS.md` (OD-37, OD-40, G-119, G-122), code named below.

## 0. Where the request and the repository disagree (owner to confirm before coding)

| Item | Request says | Repository records | Treatment |
|---|---|---|---|
| OD-40 | Payment timestamps | A top-up pack bought near month end that settles next month is credited to the settlement month (`usagePeriod` in `billing.service.ts`); spec silent on which month counts | DOES NOT MATCH. Owner decides: settlement month (current) or purchase month. A separate timestamp audit can ride along, but it is not what OD-40 records. |
| OWN-70 | Live Paystack renewal safeguards | `REKODA_PAYSTACK_PLATFORM_CONFIRMED` gates only `sk_live_` charges (option B, 3 Nov) | The recorded ruling is already implemented as a flag semantics. Renewal idempotency work is real but is not OWN-70; track it as its own item under G-122/renewal audit. |
| OWN-73, OWN-76, OD-37, OWN-77 | as described | as described | Match. |

## 1. What exists (inspected)

- Queue: `packages/db/src/repos/jobs.ts`. `markFailed` (line ~443) goes `dead` once `attempts >= max_attempts`, sets `failure_category='handler_error'`. `reclaimStalled` (~486) lets a job run once past `max_attempts`, then `dead` with fixed `last_error` and a category (migration 0190). Nothing moves a job out of `dead`. `queueHealth` counts dead jobs.
- Kinds: `apps/api/src/jobs/queue.service.ts` `ProcessPaymentEvent: 'payment.process'`, `ProcessBillingCharge: 'billing.process'`. Singleton-keyed on the event id; `hasJobForSingleton` (jobs.ts ~310) counts any state, so the Paystack pump (`apps/api/src/payments/paystack-pump.ts`) never re-enqueues an event whose job is dead.
- Handlers: `apps/api/src/jobs/process-billing-charge.handler.ts` (verifies with provider first, then `applySettledCharge` in `apps/api/src/billing/billing.service.ts`; partial payment does not settle a plan; refund/dispute events are flagged for an operator, never booked) and `process-payment-event.handler.ts` (turns an unread refund/dispute into a merchant exception on its last attempt).
- Ops queue already present: `external_events` has `error`, `resolved_at/by`, `resolution` (`packages/db/src/schema/ops.ts`); `events.exceptionQueue` feeds `GET /v1/ops/exceptions` (stuck and flagged); `subscriptionsRepo.unappliedCharges` lists paid-but-unapplied Rekoda charges; `POST /v1/ops/exceptions/charges/:reference/resolve` and `/exceptions/:id/resolve` record an operator resolution but "apply nothing" (`apps/api/src/health/ops.controller.ts` ~541-650, scopes `ops:read`, `ops:payment`).
- Merchant-visible exceptions: I found `apps/web/src/app/app/payments/page.tsx` and `page.tsx` referencing exceptions but did not trace the API behind them. First task of PR B: confirm what merchant surface exists for exceptions, and reuse it. Do not build a second one.
- Plan fields: `businesses.plan`, `plan_expires_at` (`packages/db/src/schema/tenancy.ts` ~58-63); writers include `packages/db/src/repos/subscriptions.ts` (`applyCycle`, the G-62 static guard #396 and tests under `packages/db/src/billing/`). Latest migration is 0190, so PR B starts at 0191.
- Environment: `isProductionEnv` (`apps/api/src/config.ts` ~1201) is NODE_ENV-based and fails closed to production for unknown values. Staging may itself run NODE_ENV=production; verify in the deploy config before choosing the staging gate.

## 2. Work items

### OWN-73 and OWN-76: terminal job exceptions plus verified recovery (build together, one mechanism)
Design:
1. A single `onJobDead(tx|db, job, category)` called from both `markFailed` (when exhausted) and `reclaimStalled` (when it sets `dead`). Because `reclaimStalled` is a bulk UPDATE across tenants, change it to `RETURNING id, kind, business_id, payload keys` and create the exception rows in the same statement/transaction (or a worker-role SECURITY DEFINER function, following the OWN-57 pattern in ADR 0035) so no dead job exists without its rows.
2. Rows: reuse `external_events`-style open/resolved semantics where it fits; add one table only if it does not (migration 0191, expand-only, RLS, tenant policy plus worker policy, entry in the RLS exemption register test). Unique key (job_id) makes creation idempotent; link business_id, kind, event id, Paystack reference, failure_category, created_at, safe summary. No payload, no provider text.
3. Merchant side: one idempotent exception saying payment/billing processing needs attention; copy never says "payment failed" and never says funds were collected.
4. Ops side: appears in `GET /v1/ops/exceptions` (new `deadJobs` list or flagged entry), scope `ops:read`.
5. Recovery: `POST /v1/ops/exceptions/jobs/:id/recover` (scope `ops:payment`), body has reason. It re-verifies the Paystack reference with the provider server-side, then calls the existing `applySettledCharge` / payment confirm path, keyed on the Paystack reference (existing unique `rekoda_reference` and charge status transitions are the backstop). Never automatic. Conditional update so two operators produce one outcome. Audit record: operator, reason, verified status, outcome. An unverifiable or partial payment applies nothing.
6. Keep the poison-payload bound: recovery re-enqueues at most one fresh attempt with its own attempt budget, and a second death reopens the same exception rather than creating another.
State diagram (text): `pending -> running -> done | pending(retry) | dead`; `dead -> [exception open] -> operator recover -> verify -> applied | refused`; `reclaimStalled: running -> pending (attempts <= max) -> running (one extra) -> dead`.

### OD-37: plan-field protection
Per the recorded option: `BEFORE UPDATE OF plan, plan_expires_at ON businesses` trigger refusing the update unless a transaction-local setting (set only by the single sanctioned writer function) is present; owner-role bypass for migrations and operator repair; fixture helper for integration tests that set the plan directly (many under `packages/db/src/billing/`). Inventory every writer first (`grep` for `plan` and `plan_expires_at` assignments across `repos/` and handlers). Expand-only migration, rollback by dropping the trigger. Must keep upgrade, downgrade, renewal, trial expiry, operator change and retention exemption paths working; tests for each plus a rejected direct UPDATE.

### OWN-77 / G-119: staging-only test-business tools
Per the ruling: designated test businesses only, server-side staging-only enforcement, every action audited (operator, business, old/new values, reason, time, outcome), rollback procedure, plan/date moves through the OD-37 sanctioned path, not a general bypass. Needs: a `test_business` designation (migration 0191/0192), a staging gate that is not just NODE_ENV (explicit marker env plus refusal when an `sk_live_` key or production marker is present; fails closed when unset), ops-scoped endpoints, operator OIDC scope, runbook update, and a test that the module does not register or refuses in a production-like config. Also covers forced notification failures for walkthrough steps 17, 18, 19, 22 and ACCEPT-01 journeys 2, 3, 9, 10. After merge and staging deploy those steps run on staging and the observations are recorded as evidence.

### Payment timestamps (as requested) and OD-40 (as recorded)
Inventory only first: `subscription_charges.paid_at/failed_at/created_at`, `payments.settled_at`, `external_events.created_at/processed_at`, `usagePeriod(now)` in `billing.service.ts`. Record what each means and whether provider time is kept anywhere. Any new column (for example provider event time) is additive and nullable, never overwriting. OD-40 needs the owner's month rule before a change.

### Renewal safeguards (not OWN-70)
Audit-first: renewal sweep (`apps/api/src/billing/renewal-sweep.ts`), `applySettledCharge`, unique references, out-of-order and duplicate events, cancelled/expired subscription. Add tests for each case; fix only proven gaps. No live charges, Paystack test mode and fixtures only.

## 3. Regression matrix (summary)
Dead via `markFailed`; dead via `reclaimStalled`; repeat processing; exception and ops item idempotent; cross-tenant isolation; operator scope; unverifiable reference; verification failure; recover once; recover twice with same reference; no second extension; no second settlement; no auto replay; poison bound; direct plan UPDATE rejected; sanctioned writers pass; staging tools absent in production config; every tool action audited.

## 4. Rollback and safety
All migrations expand-only; triggers droppable; recovery endpoint disabled by removing the route; no data rewrite. Never log secrets or raw Paystack bodies. No production deploy, no live charges.

## 5. Sequencing inside PR B
(1) docs ruling commit; (2) OD-37 trigger and fixture helper; (3) dead-job exception mechanism for both kinds; (4) verified recovery endpoint; (5) staging test-business tools; (6) timestamp/renewal audits and tests. One PR, reviewed as a whole, only after PR A merges.
