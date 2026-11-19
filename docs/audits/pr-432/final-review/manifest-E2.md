# Manifest E2 (PR #432, head 198d37a, base 58e6834)

| path                                                                        | status   | findings     |
| --------------------------------------------------------------------------- | -------- | ------------ |
| apps/api/src/ai/eval/report.test.ts                                         | reviewed | none         |
| apps/api/src/api/api-keys.controller.ts                                     | reviewed | none         |
| apps/api/src/api/api-keys.integration.test.ts                               | reviewed | none         |
| apps/api/src/api/api-metering.integration.test.ts                           | reviewed | none         |
| apps/api/src/api/public/merchant-api.integration.test.ts                    | reviewed | none         |
| apps/api/src/api/public/merchant-v1.controller.ts                           | reviewed | none         |
| apps/api/src/api/public/public-api.integration.test.ts                      | reviewed | none         |
| apps/api/src/api/sandbox.integration.test.ts                                | reviewed | none         |
| apps/api/src/app.module.ts                                                  | reviewed | none         |
| apps/api/src/auth/auth.controller.ts                                        | reviewed | none         |
| apps/api/src/auth/auth.integration.test.ts                                  | reviewed | none         |
| apps/api/src/auth/operator-actor.test.ts                                    | reviewed | none         |
| apps/api/src/auth/operator-actor.ts                                         | reviewed | none         |
| apps/api/src/auth/operator-identity.test.ts                                 | reviewed | none         |
| apps/api/src/auth/operator-identity.ts                                      | reviewed | none         |
| apps/api/src/auth/operator-plan-durations.integration.test.ts               | reviewed | E2-M8        |
| apps/api/src/auth/operator-plane-served.guard.test.ts                       | reviewed | none         |
| apps/api/src/auth/operator-plane-served.guard.ts                            | reviewed | none         |
| apps/api/src/auth/operator-plane.test.ts                                    | reviewed | none         |
| apps/api/src/auth/operator-support-review.integration.test.ts               | reviewed | none         |
| apps/api/src/auth/operator.guard.ts                                         | reviewed | none         |
| apps/api/src/auth/roles.integration.test.ts                                 | reviewed | none         |
| apps/api/src/commands/command-bus.integration.test.ts                       | reviewed | none         |
| apps/api/src/commands/order-commands.integration.test.ts                    | reviewed | none         |
| apps/api/src/config.ts                                                      | reviewed | E2-M1        |
| apps/api/src/config/env.fixtures.ts                                         | reviewed | none         |
| apps/api/src/config/numeric.test.ts                                         | reviewed | E2-M3        |
| apps/api/src/config/principals.test.ts                                      | reviewed | none         |
| apps/api/src/config/production.test.ts                                      | reviewed | E2-M1        |
| apps/api/src/config/templates.test.ts                                       | reviewed | none         |
| apps/api/src/db/app-pool-size.test.ts                                       | reviewed | none         |
| apps/api/src/db/db.module.ts                                                | reviewed | none         |
| apps/api/src/db/pool-probe.fixtures.ts                                      | reviewed | E2-M7        |
| apps/api/src/http/uuid.ts                                                   | reviewed | none         |
| apps/api/src/integration-setup.ts                                           | reviewed | none         |
| apps/api/src/main.ts                                                        | reviewed | E2-M2        |
| apps/api/src/observability/logs.integration.test.ts                         | reviewed | none         |
| apps/api/src/operator-main.ts                                               | reviewed | E2-M4, E2-M5 |
| apps/api/src/operator-plane/authenticate.ts                                 | reviewed | none         |
| apps/api/src/operator-plane/config.test.ts                                  | reviewed | none         |
| apps/api/src/operator-plane/config.ts                                       | reviewed | none         |
| apps/api/src/operator-plane/operator-process.integration.test.ts            | reviewed | none         |
| apps/api/src/operator-plane/plan-operations.ts                              | reviewed | none         |
| apps/api/src/operator-plane/refund-operations.ts                            | reviewed | E2-M6        |
| apps/api/src/operator-plane/server.ts                                       | reviewed | E2-M5        |
| apps/api/src/payments/adjustments-disputes.integration.test.ts              | reviewed | none         |
| apps/api/src/payments/adjustments-refund-envelope.integration.test.ts       | reviewed | none         |
| apps/api/src/payments/adjustments-refund-reads.integration.test.ts          | reviewed | none         |
| apps/api/src/payments/adjustments-reversals-chargebacks.integration.test.ts | reviewed | none         |
| apps/api/src/payments/adjustments.fixtures.ts                               | reviewed | none         |
| apps/api/src/payments/adjustments.integration.test.ts                       | reviewed | none         |
| apps/api/src/payments/paystack-pump.ts                                      | reviewed | none         |
| apps/api/src/payments/pipeline.integration.test.ts                          | reviewed | none         |
| apps/api/src/privacy/email-erasure.controller.ts                            | reviewed | none         |
| apps/api/src/privacy/gateway.service.ts                                     | reviewed | none         |
| apps/api/src/privacy/retention-drain.integration.test.ts                    | reviewed | none         |
| apps/api/src/privacy/retention-sweep.integration.test.ts                    | reviewed | none         |
| apps/api/src/replies/replies.module.ts                                      | reviewed | none         |
| apps/api/src/reports/exports.integration.test.ts                            | reviewed | none         |
| apps/api/src/reports/reports-quotes.integration.test.ts                     | reviewed | none         |
| apps/api/src/reports/reports.controller.ts                                  | reviewed | none         |
| apps/api/src/settlement-main.ts                                             | reviewed | E2-M3        |
| apps/api/src/settlement/config.test.ts                                      | reviewed | none         |
| apps/api/src/settlement/config.ts                                           | reviewed | E2-M1        |
| apps/api/src/settlement/runner.ts                                           | reviewed | none         |
| apps/api/src/settlement/settlement-process.integration.test.ts              | reviewed | none         |
| apps/api/src/shop/shop.integration.test.ts                                  | reviewed | none         |
| apps/api/src/template-check.ts                                              | reviewed | none         |
| apps/api/src/webhooks/webhook-delivery-meter.integration.test.ts            | reviewed | none         |
| apps/api/src/webhooks/webhooks.controller.ts                                | reviewed | none         |
| apps/api/src/webhooks/webhooks.fixtures.ts                                  | reviewed | none         |
| apps/api/src/webhooks/webhooks.integration.test.ts                          | reviewed | none         |
| apps/api/vitest.integration.config.ts                                       | reviewed | none         |

## Findings

No BLOCKING. No IMPORTANT.

**E2-M1 MINOR**: the provider base-URL refusal text doesn't match the supported configuration. Locations: apps/api/src/config.ts:725-729 (`providerBaseUrl`, unchanged since the merge base and used for MONO_BASE_URL and PAYSTACK_BASE_URL) and apps/api/src/settlement/config.ts:131-136 (new; same text for PAYSTACK_BASE_URL). The behaviour is correct. Production boots with the variable unset, blank, or exactly `https://api.withmono.com` (`raw !== canonical` is the only refusal), and production.test.ts:63-67 proves this. Any other value is refused: trailing slash, case, port, path, userinfo, http. The message is the problem. It says "`MONO_BASE_URL must not be set in production` ... `Remove it.`" That contradicts OWN-96 and the docs this PR updates (deploy.md:168-170 and :1213, staging-first-deploy-pr-b.md:388, .env.example:526-530), which say staging keeps `MONO_BASE_URL=https://api.withmono.com`. Failure scenario: an operator writes `MONO_BASE_URL=https://api.withmono.com/` (or with a stray port). Boot is refused, which is correct, but the text says the variable may not be set at all. That conflicts with the runbook's "keep that exact value" and invites the opposite of the documented state. Not a security defect: it still fails closed. Suggested fix: "`${name}` must be blank or exactly `${canonical}` in production: any other host would receive the secret key." Update the regexes in production.test.ts:59, settlement/config.test.ts:93 and the grep in scripts/deploy-smoke.sh:300.

**E2-M2 MINOR**: stale comment at apps/api/src/main.ts:285-287. It says "a production worker holds the settlement credential". config.ts:1409-1419 refuses SETTLEMENT_DATABASE_URL in a production worker, and principals.test.ts:63 tests that. Binding the worker to loopback is still right, but the stated reason is wrong and misleads a reader about credential isolation. Fix: reword it.

**E2-M3 MINOR**: comment drift on pool sizing. apps/api/src/settlement-main.ts:30-33 says "One above the lanes" but the code opens `concurrency * 2 + 2`. The code agrees with deploy.md:70; the comment does not. apps/api/src/config/numeric.test.ts:55-60 says the estate's worst case is "91", while docs/runbooks/deploy.md:73 says 93. Fix: align the comment and the number.

**E2-M4 MINOR**: the header of apps/api/src/operator-main.ts:6-7 says the process "serves only the two operator plan operations". server.ts:58 also serves `/v1/ops/refund` (ops:payment). Fix: name the refund route.

**E2-M5 MINOR**: the operator health check doesn't probe the database (apps/api/src/operator-plane/server.ts:106-114). It answers `status: ok` without touching the database. The compose health check (docker-compose.prod.yml:244-247) accepts that, so an operator process whose login was revoked or whose database is unreachable reports healthy while every plan and refund request returns 500. The settlement process probes `SELECT 1` and answers 503. Fix: apply the same bounded probe.

**E2-M6 MINOR**: a malformed businessId reaches the database as a 500 (apps/api/src/operator-plane/refund-operations.ts:30-46). `opsRefundRequest.businessId` is `/^[0-9a-f-]{36}$/i` (packages/contracts/src/billing-api.ts:517), so 36 dashes or misplaced dashes pass the check. `subscriptionsRepo.recordRefund` then casts `::uuid` and gets 22P02, which is not mapped to `RefundRefused`. An authenticated operator's typo gets a 500 and an error log line instead of a 400. Nothing is written. Fix: use `z.string().uuid()` in the contract, or `isUuid`.

**E2-M7 MINOR**: the connection probe can under-count (apps/api/src/db/pool-probe.fixtures.ts:20-35). It counts only `pool.transaction(...)`. A `db.execute`/`select` made directly on the pool while a transaction is open also checks out a connection and isn't counted. The "holds one connection, not two" tests (waba-templates-pool, meta-catalogue-order-pool) can therefore pass while a code path takes a second connection through a bare execute. Fix: also count `execute`/`select`/`insert`/`update`/`delete` on the root pool, or count at the postgres-js client level.

**E2-M8 MINOR**: stale test header in apps/api/src/auth/operator-plan-durations.integration.test.ts:1-8. It describes "a monthly plan ends within one calendar month... A date outside the rule is a 400". Since 0207 a paid plan or trial with any date is refused, and the test body asserts that (line 74). Fix: correct the header.

## Notes (no finding)

- Credential isolation: a production API or worker refuses non-empty SETTLEMENT_DATABASE_URL and OPERATOR_DATABASE_URL. Compose blanks both for api and worker. Settlement and operator each refuse their foreign-secret list in production and refuse a credential equal to another. Each boot checks the exact principal, that it cannot bypass RLS, and that the test-fixture writer is absent. Settlement also checks key enrolment and the pricing source.
- OIDC: the operator process verifies its own audience (OPERATOR_BILLING_OIDC_AUDIENCE). It refuses one equal to the API's (compose passes OPERATOR_OIDC_AUDIENCE for this) and refuses multi-audience tokens. `exp` is now required on both planes. Scopes: plan routes need ops:billing, refund needs ops:payment. The actor comes from the token subject only (`^[!-~]{1,255}$`, matching the database rule). The API answers 404 on the plan and refund routes before reading an identity when it holds no operator pool.
- Refund idempotency (R06) is tested through the operator process: a same-id replay gives replayed:true with the amount unchanged. Over-refund is refused and ops:billing alone gets 403.
- Merchant API customerId cross-tenant check: an HTTP test exists in health/business-object-authorisation-*.integration.test.ts (another batch).
- Test moves are verbatim, with the same assertion counts: webhooks → webhook-delivery-meter (7/7), retention-sweep drain → retention-drain. No assertion was weakened. auth.integration's changed body and response follow OD-50 (0207). The setPlanForTest/settlementDb/ownerDb swaps follow the 0202/0210 privilege removal.
- Template config: a set template without its locale now refuses to boot. This is intended (OWN-93).
