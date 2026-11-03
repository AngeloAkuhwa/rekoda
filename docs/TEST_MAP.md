# Test map

Which tests cover which feature, across every package. Tests stay next to the
code they test (see "Where tests go" in `CONTRIBUTING.md`), so one feature's
tests live in several packages; this page is the index. Start here when you
change a feature and want to know what to run.

- **Layers:** `unit` is `*.test.ts(x)` and needs no database. `integration` is
  `*.integration.test.ts` and needs PostgreSQL. `e2e` is a Playwright spec in
  `apps/web/e2e/`.
- **Grouping is by topic**, so a file can plausibly sit in two groups; it is
  listed once, in the closest one. The row is a pointer, not an ownership claim.
- **Kept honest by `scripts/check-test-layout.mjs`:** every path on this page
  must exist, so a rename that forgets this page fails CI. A new test file is
  not required to be listed, but add it when it starts a feature.
- Scripts under `scripts/*.test.mjs` are a fourth layer (see CONTRIBUTING) and
  are not listed here.

### Subscriptions, trial, billing and usage (Rekoda's own billing)

| Layer       | Test file                                                              |
| ----------- | ---------------------------------------------------------------------- |
| e2e         | `apps/web/e2e/billing-journey-lifecycle.spec.ts`                       |
| e2e         | `apps/web/e2e/billing-journey-states.spec.ts`                          |
| e2e         | `apps/web/e2e/billing-journey.spec.ts`                                 |
| e2e         | `apps/web/e2e/billing.spec.ts`                                         |
| integration | `apps/api/src/billing/annual-billing.integration.test.ts`              |
| integration | `apps/api/src/billing/annual-lifecycle.integration.test.ts`            |
| integration | `apps/api/src/billing/api-product.integration.test.ts`                 |
| integration | `apps/api/src/billing/billing-charge.integration.test.ts`              |
| integration | `apps/api/src/billing/billing-checkout-recovery.integration.test.ts`   |
| integration | `apps/api/src/billing/billing-checkout.integration.test.ts`            |
| integration | `apps/api/src/billing/billing-email-address-limit.integration.test.ts` |
| integration | `apps/api/src/billing/billing-email-verification.integration.test.ts`  |
| integration | `apps/api/src/billing/billing.integration.test.ts`                     |
| integration | `apps/api/src/billing/lapsed-plan.integration.test.ts`                 |
| integration | `apps/api/src/billing/pack-grant.integration.test.ts`                  |
| integration | `apps/api/src/billing/payment-record.integration.test.ts`              |
| integration | `apps/api/src/billing/retry-and-zero-charge.integration.test.ts`       |
| integration | `apps/api/src/billing/stale-charge.integration.test.ts`                |
| integration | `apps/api/src/billing/subscription-retention-race.integration.test.ts` |
| integration | `apps/api/src/billing/trial-notice-sweep.integration.test.ts`          |
| integration | `packages/db/src/add-ons.integration.test.ts`                          |
| integration | `packages/db/src/commercial-figures.integration.test.ts`               |
| integration | `packages/db/src/cost-schedules.integration.test.ts`                   |
| integration | `packages/db/src/entitlement-gate.integration.test.ts`                 |
| integration | `packages/db/src/entitlements.integration.test.ts`                     |
| integration | `packages/db/src/margin.integration.test.ts`                           |
| integration | `packages/db/src/operator-plan-change.integration.test.ts`             |
| integration | `packages/db/src/plan-catalogue.integration.test.ts`                   |
| integration | `packages/db/src/platform-costs.integration.test.ts`                   |
| integration | `packages/db/src/quota.integration.test.ts`                            |
| integration | `packages/db/src/subscription-journey.integration.test.ts`             |
| integration | `packages/db/src/subscription-origin.integration.test.ts`              |
| integration | `packages/db/src/subscriptions.integration.test.ts`                    |
| integration | `packages/db/src/tenant-fk-platform-costs.integration.test.ts`         |
| integration | `packages/db/src/trial-lifecycle.integration.test.ts`                  |
| integration | `packages/db/src/usage.integration.test.ts`                            |
| unit        | `apps/api/src/auth/operator-plane.test.ts`                             |
| unit        | `apps/api/src/billing/charge-status-contract.test.ts`                  |
| unit        | `apps/api/src/billing/paystack-key.test.ts`                            |
| unit        | `apps/web/src/lib/billing-copy.test.ts`                                |
| unit        | `apps/web/src/lib/billing-pay-copy.test.ts`                            |
| unit        | `apps/web/src/lib/billing-return.test.ts`                              |
| unit        | `apps/web/src/lib/charge-status.test.ts`                               |
| unit        | `apps/web/src/lib/payment-record-copy.test.ts`                         |
| unit        | `packages/core/src/ai-cost.test.ts`                                    |
| unit        | `packages/core/src/allowances.test.ts`                                 |
| unit        | `packages/core/src/billing-email.test.ts`                              |
| unit        | `packages/core/src/billing.test.ts`                                    |
| unit        | `packages/core/src/margin.test.ts`                                     |
| unit        | `packages/core/src/payment-record.test.ts`                             |
| unit        | `packages/db/src/plan-expiry-files.test.ts`                            |

### Payments, settlement, bank and reconciliation

| Layer       | Test file                                                           |
| ----------- | ------------------------------------------------------------------- |
| e2e         | `apps/web/e2e/bank.spec.ts`                                         |
| e2e         | `apps/web/e2e/overpayment.spec.ts`                                  |
| e2e         | `apps/web/e2e/payments.spec.ts`                                     |
| e2e         | `apps/web/e2e/refunds.spec.ts`                                      |
| integration | `apps/api/src/bank/bank.integration.test.ts`                        |
| integration | `apps/api/src/bank/feed.integration.test.ts`                        |
| integration | `apps/api/src/commands/bank-commands.integration.test.ts`           |
| integration | `apps/api/src/commands/payment-commands.integration.test.ts`        |
| integration | `apps/api/src/email/resend-webhook.integration.test.ts`             |
| integration | `apps/api/src/payments/adjustments.integration.test.ts`             |
| integration | `apps/api/src/payments/connections.integration.test.ts`             |
| integration | `apps/api/src/payments/merchant-key.integration.test.ts`            |
| integration | `apps/api/src/payments/paystack.integration.test.ts`                |
| integration | `apps/api/src/payments/pipeline.integration.test.ts`                |
| integration | `apps/api/src/payments/settlement-sweep.integration.test.ts`        |
| integration | `apps/api/src/payments/storefront-transfer.integration.test.ts`     |
| integration | `apps/api/src/reports/overpayment-bus.integration.test.ts`          |
| integration | `apps/api/src/webhooks/webhooks.integration.test.ts`                |
| integration | `packages/db/src/bank-fingerprint.integration.test.ts`              |
| integration | `packages/db/src/bank-payment-references.integration.test.ts`       |
| integration | `packages/db/src/bank.integration.test.ts`                          |
| integration | `packages/db/src/charge-breakdown-order.integration.test.ts`        |
| integration | `packages/db/src/charges.integration.test.ts`                       |
| integration | `packages/db/src/connection-statuses.integration.test.ts`           |
| integration | `packages/db/src/financial-account-connections.integration.test.ts` |
| integration | `packages/db/src/financial-event-identity.integration.test.ts`      |
| integration | `packages/db/src/golden-bank-credit.integration.test.ts`            |
| integration | `packages/db/src/payment-evidence.integration.test.ts`              |
| integration | `packages/db/src/payment-provenance.integration.test.ts`            |
| integration | `packages/db/src/payments-hub.integration.test.ts`                  |
| integration | `packages/db/src/provider-resolver.integration.test.ts`             |
| integration | `packages/db/src/reconciliation-tiers.integration.test.ts`          |
| integration | `packages/db/src/settle.integration.test.ts`                        |
| integration | `packages/db/src/settlements.integration.test.ts`                   |
| integration | `packages/db/src/webhooks.integration.test.ts`                      |
| unit        | `apps/api/src/bank/mono.provider.test.ts`                           |
| unit        | `apps/api/src/payments/paystack.provider.test.ts`                   |
| unit        | `apps/api/src/payments/provider-conformance.test.ts`                |
| unit        | `apps/api/src/webhooks/destination.test.ts`                         |
| unit        | `apps/web/src/app/app/invoices/record-payment-action.test.ts`       |
| unit        | `apps/web/src/lib/bank-release.test.ts`                             |
| unit        | `packages/contracts/src/meta-webhook.test.ts`                       |
| unit        | `packages/contracts/src/paystack-webhook.test.ts`                   |
| unit        | `packages/core/src/bank-matching.test.ts`                           |
| unit        | `packages/core/src/bank-statement.test.ts`                          |
| unit        | `packages/core/src/charges.test.ts`                                 |
| unit        | `packages/core/src/payments.test.ts`                                |
| unit        | `packages/core/src/reconciliation.test.ts`                          |
| unit        | `packages/core/src/webhooks-outbound.test.ts`                       |
| unit        | `packages/core/src/webhooks.test.ts`                                |

### Ledger, close, statements and reports

| Layer       | Test file                                                   |
| ----------- | ----------------------------------------------------------- |
| e2e         | `apps/web/e2e/reports.spec.ts`                              |
| integration | `apps/api/src/commands/ledger-commands.integration.test.ts` |
| integration | `apps/api/src/commands/spend-commands.integration.test.ts`  |
| integration | `apps/api/src/reports/exports.integration.test.ts`          |
| integration | `apps/api/src/reports/reports.integration.test.ts`          |
| integration | `apps/api/src/spend/depreciation.integration.test.ts`       |
| integration | `apps/api/src/spend/recurring.integration.test.ts`          |
| integration | `packages/db/src/accounts-lifecycle.integration.test.ts`    |
| integration | `packages/db/src/accounts.integration.test.ts`              |
| integration | `packages/db/src/bills.integration.test.ts`                 |
| integration | `packages/db/src/chart-seed.integration.test.ts`            |
| integration | `packages/db/src/close.integration.test.ts`                 |
| integration | `packages/db/src/due-time-precision.integration.test.ts`    |
| integration | `packages/db/src/fx.integration.test.ts`                    |
| integration | `packages/db/src/issue.integration.test.ts`                 |
| integration | `packages/db/src/journal-currency.integration.test.ts`      |
| integration | `packages/db/src/journal-drafts.integration.test.ts`        |
| integration | `packages/db/src/journal-invariants.integration.test.ts`    |
| integration | `packages/db/src/journal.integration.test.ts`               |
| integration | `packages/db/src/ledger-account-id.integration.test.ts`     |
| integration | `packages/db/src/ledger-append-only.integration.test.ts`    |
| integration | `packages/db/src/opening.integration.test.ts`               |
| integration | `packages/db/src/party-statements.integration.test.ts`      |
| integration | `packages/db/src/portability.integration.test.ts`           |
| integration | `packages/db/src/posting-key.integration.test.ts`           |
| integration | `packages/db/src/projections.integration.test.ts`           |
| integration | `packages/db/src/purchase-identity.integration.test.ts`     |
| integration | `packages/db/src/recognition-events.integration.test.ts`    |
| integration | `packages/db/src/recognition-policy.integration.test.ts`    |
| integration | `packages/db/src/recognition.integration.test.ts`           |
| integration | `packages/db/src/recurring.integration.test.ts`             |
| integration | `packages/db/src/reports.integration.test.ts`               |
| integration | `packages/db/src/spend.integration.test.ts`                 |
| integration | `packages/db/src/tax-model.integration.test.ts`             |
| unit        | `apps/api/src/ai/eval/report.test.ts`                       |
| unit        | `apps/api/src/reports/accounts.test.ts`                     |
| unit        | `apps/api/src/reports/export-authorization.test.ts`         |
| unit        | `apps/web/src/app/app/expenses/paid-by.test.ts`             |
| unit        | `apps/web/src/app/app/expenses/receive-po-action.test.ts`   |
| unit        | `packages/core/src/chart.test.ts`                           |
| unit        | `packages/core/src/costing.test.ts`                         |
| unit        | `packages/core/src/due-dates.test.ts`                       |
| unit        | `packages/core/src/expenses.test.ts`                        |
| unit        | `packages/core/src/fx.test.ts`                              |
| unit        | `packages/core/src/invoice-layout.test.ts`                  |
| unit        | `packages/core/src/ledger.test.ts`                          |
| unit        | `packages/core/src/money.test.ts`                           |
| unit        | `packages/core/src/periods.test.ts`                         |
| unit        | `packages/core/src/purchase-identity.test.ts`               |
| unit        | `packages/core/src/receipt-layout.test.ts`                  |
| unit        | `packages/core/src/recognition.test.ts`                     |
| unit        | `packages/core/src/recurring.test.ts`                       |
| unit        | `packages/core/src/statement-layout.test.ts`                |
| unit        | `packages/core/src/statements.test.ts`                      |
| unit        | `packages/core/src/tax.test.ts`                             |
| unit        | `packages/core/src/xlsx.test.ts`                            |
| unit        | `packages/db/src/migration-journal-order.test.ts`           |

### Tenancy, RLS, privacy and identity

| Layer       | Test file                                                     |
| ----------- | ------------------------------------------------------------- |
| integration | `apps/api/src/api/api-keys.integration.test.ts`               |
| integration | `apps/api/src/auth/auth.integration.test.ts`                  |
| integration | `apps/api/src/auth/roles.integration.test.ts`                 |
| integration | `apps/api/src/privacy/gateway.integration.test.ts`            |
| integration | `apps/api/src/privacy/retention-sweep.integration.test.ts`    |
| integration | `packages/db/src/api-keys.integration.test.ts`                |
| integration | `packages/db/src/conversation-identity.integration.test.ts`   |
| integration | `packages/db/src/customer-consent.integration.test.ts`        |
| integration | `packages/db/src/customer-merge-indexes.integration.test.ts`  |
| integration | `packages/db/src/evidence-retention.integration.test.ts`      |
| integration | `packages/db/src/magic-links.integration.test.ts`             |
| integration | `packages/db/src/object-deletions.integration.test.ts`        |
| integration | `packages/db/src/provision.integration.test.ts`               |
| integration | `packages/db/src/retention.integration.test.ts`               |
| integration | `packages/db/src/rls-invariants.integration.test.ts`          |
| integration | `packages/db/src/tenancy.integration.test.ts`                 |
| integration | `packages/db/src/tenant-fk-group-a.integration.test.ts`       |
| integration | `packages/db/src/tenant-fk-group-b.integration.test.ts`       |
| integration | `packages/db/src/tenant-fk-group-c.integration.test.ts`       |
| integration | `packages/db/src/tenant-fk-group-d.integration.test.ts`       |
| integration | `packages/db/src/tenant-fk-group-e.integration.test.ts`       |
| integration | `packages/db/src/tenant-fk-group-f1.integration.test.ts`      |
| integration | `packages/db/src/tenant-fk-group-f2.integration.test.ts`      |
| integration | `packages/db/src/tenant-fk-group-f3.integration.test.ts`      |
| integration | `packages/db/src/tenant-fk-group-f4.integration.test.ts`      |
| integration | `packages/db/src/tenant-fk-group-f5.integration.test.ts`      |
| integration | `packages/db/src/tenant-fk-ruling5.integration.test.ts`       |
| integration | `packages/db/src/tenant-fk-unconstrained.integration.test.ts` |
| unit        | `apps/api/src/auth/operator-identity.test.ts`                 |
| unit        | `apps/api/src/auth/operator.guard.test.ts`                    |
| unit        | `apps/api/src/privacy/payload-vault.test.ts`                  |
| unit        | `packages/core/src/api-keys.test.ts`                          |
| unit        | `packages/core/src/identity.test.ts`                          |
| unit        | `packages/core/src/privacy.test.ts`                           |
| unit        | `packages/core/src/retention.test.ts`                         |
| unit        | `packages/core/src/vault.test.ts`                             |
| unit        | `packages/db/src/provision.test.ts`                           |

### Stock, catalogue, orders and storefront

| Layer       | Test file                                                          |
| ----------- | ------------------------------------------------------------------ |
| e2e         | `apps/web/e2e/stock.spec.ts`                                       |
| e2e         | `apps/web/e2e/storefront.spec.ts`                                  |
| integration | `apps/api/src/catalogue/catalogue.integration.test.ts`             |
| integration | `apps/api/src/channels/catalogue-sync.integration.test.ts`         |
| integration | `apps/api/src/commands/order-commands.integration.test.ts`         |
| integration | `apps/api/src/shop/shop.integration.test.ts`                       |
| integration | `packages/db/src/allocation-unwind-order.integration.test.ts`      |
| integration | `packages/db/src/catalogue.integration.test.ts`                    |
| integration | `packages/db/src/conversation-insertion-order.integration.test.ts` |
| integration | `packages/db/src/draft-confirmation-order.integration.test.ts`     |
| integration | `packages/db/src/goods-returns.integration.test.ts`                |
| integration | `packages/db/src/orders.integration.test.ts`                       |
| integration | `packages/db/src/shops.integration.test.ts`                        |
| integration | `packages/db/src/stock-reservation.integration.test.ts`            |
| integration | `packages/db/src/stock.integration.test.ts`                        |
| integration | `packages/db/src/stocktake.integration.test.ts`                    |
| unit        | `apps/api/src/channels/meta-catalogue.publisher.test.ts`           |
| unit        | `packages/core/src/fulfilment.test.ts`                             |
| unit        | `packages/core/src/orders.test.ts`                                 |

### AI, chat engine and WhatsApp channel

| Layer       | Test file                                                             |
| ----------- | --------------------------------------------------------------------- |
| e2e         | `apps/web/e2e/reminders.spec.ts`                                      |
| integration | `apps/api/src/ai/eval/eval.integration.test.ts`                       |
| integration | `apps/api/src/ai/interpreter.integration.test.ts`                     |
| integration | `apps/api/src/channels/customer-route.integration.test.ts`            |
| integration | `apps/api/src/channels/meta.integration.test.ts`                      |
| integration | `apps/api/src/channels/stranger-sweep.integration.test.ts`            |
| integration | `apps/api/src/channels/waba-templates.integration.test.ts`            |
| integration | `apps/api/src/commands/command-bus.integration.test.ts`               |
| integration | `apps/api/src/commands/outbox-dispatcher.integration.test.ts`         |
| integration | `apps/api/src/commands/sale-commands.integration.test.ts`             |
| integration | `apps/api/src/documents/pdf.integration.test.ts`                      |
| integration | `apps/api/src/reminders/reminder-batch.integration.test.ts`           |
| integration | `apps/api/src/reminders/reminder-channel-optout.integration.test.ts`  |
| integration | `apps/api/src/reminders/reminder-optout-throttle.integration.test.ts` |
| integration | `apps/api/src/reminders/reminder.integration.test.ts`                 |
| integration | `apps/api/src/replies/reply.integration.test.ts`                      |
| integration | `packages/db/src/continuations.integration.test.ts`                   |
| integration | `packages/db/src/draft-expiry.integration.test.ts`                    |
| integration | `packages/db/src/email-suppressions.integration.test.ts`              |
| integration | `packages/db/src/waba.integration.test.ts`                            |
| unit        | `apps/api/src/ai/audio-duration.test.ts`                              |
| unit        | `apps/api/src/ai/eval/dataset.test.ts`                                |
| unit        | `apps/api/src/ai/eval/gate.test.ts`                                   |
| unit        | `apps/api/src/ai/eval/harness.test.ts`                                |
| unit        | `apps/api/src/ai/model-prices.test.ts`                                |
| unit        | `apps/api/src/ai/ocr.vision.test.ts`                                  |
| unit        | `apps/api/src/ai/prompt.test.ts`                                      |
| unit        | `apps/api/src/ai/stt.openai.test.ts`                                  |
| unit        | `apps/api/src/ai/transports.test.ts`                                  |
| unit        | `apps/api/src/channels/meta.sender.test.ts`                           |
| unit        | `apps/api/src/documents/r2.storage.test.ts`                           |
| unit        | `apps/api/src/documents/r2.storage.wire.test.ts`                      |
| unit        | `apps/api/src/email/resend.sender.test.ts`                            |
| unit        | `apps/api/src/jobs/receipt-document.test.ts`                          |
| unit        | `apps/api/src/replies/replies.module.test.ts`                         |
| unit        | `apps/web/src/app/app/reminders/reminder-actions.test.ts`             |
| unit        | `apps/web/src/app/reminders/opt-out/token.test.ts`                    |
| unit        | `apps/web/src/lib/reminder-copy.test.ts`                              |
| unit        | `packages/contracts/src/business-command.test.ts`                     |
| unit        | `packages/contracts/src/reminder-batch-create.test.ts`                |
| unit        | `packages/contracts/src/reminder-batch-list.test.ts`                  |
| unit        | `packages/core/src/assistant.test.ts`                                 |
| unit        | `packages/core/src/capabilities.test.ts`                              |
| unit        | `packages/core/src/chat-access.test.ts`                               |
| unit        | `packages/core/src/command-persistence.test.ts`                       |
| unit        | `packages/core/src/confirmation-context.test.ts`                      |
| unit        | `packages/core/src/continuation.test.ts`                              |
| unit        | `packages/core/src/document-status.test.ts`                           |
| unit        | `packages/core/src/extraction-compare.test.ts`                        |
| unit        | `packages/core/src/images.test.ts`                                    |
| unit        | `packages/core/src/messaging.test.ts`                                 |
| unit        | `packages/core/src/notification-policy.test.ts`                       |
| unit        | `packages/core/src/reminders.test.ts`                                 |
| unit        | `packages/core/src/replies.test.ts`                                   |
| unit        | `packages/core/src/request-kind.test.ts`                              |
| unit        | `packages/core/src/router.test.ts`                                    |
| unit        | `packages/core/src/words.test.ts`                                     |

### Jobs, outbox, health and operations

| Layer       | Test file                                              |
| ----------- | ------------------------------------------------------ |
| integration | `apps/api/src/health/ops.integration.test.ts`          |
| integration | `apps/api/src/jobs/jobs.integration.test.ts`           |
| integration | `apps/api/src/observability/logs.integration.test.ts`  |
| integration | `apps/api/src/rate-limit.integration.test.ts`          |
| integration | `apps/api/src/risk/risk-policy.integration.test.ts`    |
| integration | `packages/db/src/boot-checks.integration.test.ts`      |
| integration | `packages/db/src/idempotency.integration.test.ts`      |
| integration | `packages/db/src/jobs.integration.test.ts`             |
| integration | `packages/db/src/load.integration.test.ts`             |
| integration | `packages/db/src/ops-health.integration.test.ts`       |
| integration | `packages/db/src/outbox.integration.test.ts`           |
| integration | `packages/db/src/preview-delivery.integration.test.ts` |
| integration | `packages/db/src/recovery-drill.integration.test.ts`   |
| integration | `packages/db/src/risk.integration.test.ts`             |
| integration | `packages/db/src/service-window.integration.test.ts`   |
| integration | `packages/db/src/status-drift.integration.test.ts`     |
| integration | `packages/db/src/testing.integration.test.ts`          |
| unit        | `apps/api/src/edge-check.test.ts`                      |
| unit        | `apps/api/src/edge-proxies.test.ts`                    |
| unit        | `apps/api/src/health/health.test.ts`                   |
| unit        | `apps/api/src/health/ops-alerts.test.ts`               |
| unit        | `apps/api/src/jobs/sweep-schedule.test.ts`             |
| unit        | `apps/api/src/rate-limit-exempt.test.ts`               |
| unit        | `packages/core/src/ops-alerts.test.ts`                 |
| unit        | `packages/core/src/risk.test.ts`                       |
| unit        | `packages/db/src/entrypoint.test.ts`                   |

### Other

| Layer       | Test file                                                   |
| ----------- | ----------------------------------------------------------- |
| e2e         | `apps/web/e2e/onboarding.spec.ts`                           |
| e2e         | `apps/web/e2e/populated-month.spec.ts`                      |
| e2e         | `apps/web/e2e/team.spec.ts`                                 |
| integration | `apps/api/src/api/api-metering.integration.test.ts`         |
| integration | `apps/api/src/api/public/merchant-api.integration.test.ts`  |
| integration | `apps/api/src/api/public/public-api.integration.test.ts`    |
| integration | `apps/api/src/api/sandbox.integration.test.ts`              |
| integration | `packages/db/src/assets.integration.test.ts`                |
| integration | `packages/db/src/cross-product.integration.test.ts`         |
| integration | `packages/db/src/customer-credits.integration.test.ts`      |
| integration | `packages/db/src/customers.integration.test.ts`             |
| integration | `packages/db/src/golden-fixture.integration.test.ts`        |
| integration | `packages/db/src/provenance-classifier.integration.test.ts` |
| integration | `packages/db/src/provenance-writers.integration.test.ts`    |
| unit        | `apps/api/src/api/public/sale-event-id.test.ts`             |
| unit        | `apps/api/src/client-address.test.ts`                       |
| unit        | `apps/api/src/config.production.test.ts`                    |
| unit        | `apps/api/src/config.test.ts`                               |
| unit        | `apps/web/src/app/app/export/[kind]/route.test.ts`          |
| unit        | `apps/web/src/app/og.test.tsx`                              |
| unit        | `apps/web/src/components/legal/LegalPage.test.tsx`          |
| unit        | `apps/web/src/lib/intent-key.test.ts`                       |
| unit        | `apps/web/src/lib/legal-gate.test.ts`                       |
| unit        | `apps/web/src/lib/plans.test.ts`                            |
| unit        | `apps/web/src/lib/return-path.test.ts`                      |
| unit        | `apps/web/src/server/client-address.test.ts`                |
| unit        | `apps/web/src/server/visitor-forwarding.test.ts`            |
| unit        | `packages/contracts/src/public/v1/shape.test.ts`            |
| unit        | `packages/core/src/audit.test.ts`                           |
| unit        | `packages/core/src/csv.test.ts`                             |
| unit        | `packages/core/src/gates.test.ts`                           |
| unit        | `packages/core/src/period-compare.test.ts`                  |
| unit        | `packages/core/src/provenance.test.ts`                      |
