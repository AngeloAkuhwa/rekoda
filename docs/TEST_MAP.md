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

| Layer       | Test file                                                                 |
| ----------- | ------------------------------------------------------------------------- |
| e2e         | `apps/web/e2e/billing-journey-lifecycle.spec.ts`                          |
| e2e         | `apps/web/e2e/billing-journey-states.spec.ts`                             |
| e2e         | `apps/web/e2e/billing-journey.spec.ts`                                    |
| e2e         | `apps/web/e2e/billing.spec.ts`                                            |
| integration | `apps/api/src/billing/annual-billing-switching.integration.test.ts`       |
| integration | `apps/api/src/billing/annual-billing.integration.test.ts`                 |
| integration | `apps/api/src/billing/annual-lifecycle.integration.test.ts`               |
| integration | `apps/api/src/billing/api-product.integration.test.ts`                    |
| integration | `apps/api/src/billing/billing-charge.integration.test.ts`                 |
| integration | `apps/api/src/billing/billing-checkout-guards.integration.test.ts`        |
| integration | `apps/api/src/billing/billing-checkout-recovery.integration.test.ts`      |
| integration | `apps/api/src/billing/billing-checkout-replacement.integration.test.ts`   |
| integration | `apps/api/src/billing/billing-checkout.integration.test.ts`               |
| integration | `apps/api/src/billing/billing-email-address-limit.integration.test.ts`    |
| integration | `apps/api/src/billing/billing-email-live-payment.integration.test.ts`     |
| integration | `apps/api/src/billing/billing-email-verification.integration.test.ts`     |
| integration | `apps/api/src/billing/billing-grace.integration.test.ts`                  |
| integration | `apps/api/src/billing/billing-grandfathering.integration.test.ts`         |
| integration | `apps/api/src/billing/billing-paying.integration.test.ts`                 |
| integration | `apps/api/src/billing/billing-renewal.integration.test.ts`                |
| integration | `apps/api/src/billing/billing.integration.test.ts`                        |
| integration | `apps/api/src/billing/lapsed-plan.integration.test.ts`                    |
| integration | `apps/api/src/billing/pack-grant.integration.test.ts`                     |
| integration | `apps/api/src/billing/payment-record.integration.test.ts`                 |
| integration | `apps/api/src/billing/retry-and-zero-charge.integration.test.ts`          |
| integration | `apps/api/src/billing/stale-charge-exceptions.integration.test.ts`        |
| integration | `apps/api/src/billing/stale-charge.integration.test.ts`                   |
| integration | `apps/api/src/billing/subscription-retention-race.integration.test.ts`    |
| integration | `apps/api/src/billing/trial-notice-sweep-eligibility.integration.test.ts` |
| integration | `apps/api/src/billing/trial-notice-sweep-isolation.integration.test.ts`   |
| integration | `apps/api/src/billing/trial-notice-sweep.integration.test.ts`             |
| integration | `packages/db/src/billing/add-ons.integration.test.ts`                     |
| integration | `packages/db/src/billing/commercial-figures.integration.test.ts`          |
| integration | `packages/db/src/billing/cost-schedules.integration.test.ts`              |
| integration | `packages/db/src/billing/entitlement-gate.integration.test.ts`            |
| integration | `packages/db/src/billing/entitlements.integration.test.ts`                |
| integration | `packages/db/src/billing/margin.integration.test.ts`                      |
| integration | `packages/db/src/billing/operator-plan-change.integration.test.ts`        |
| integration | `packages/db/src/billing/plan-catalogue.integration.test.ts`              |
| integration | `packages/db/src/billing/platform-costs.integration.test.ts`              |
| integration | `packages/db/src/billing/quota.integration.test.ts`                       |
| integration | `packages/db/src/billing/subscription-journey.integration.test.ts`        |
| integration | `packages/db/src/billing/subscription-origin.integration.test.ts`         |
| integration | `packages/db/src/billing/subscriptions-sweeps.integration.test.ts`        |
| integration | `packages/db/src/billing/subscriptions.integration.test.ts`               |
| integration | `packages/db/src/billing/trial-lifecycle.integration.test.ts`             |
| integration | `packages/db/src/billing/usage-trial-migrations.integration.test.ts`      |
| integration | `packages/db/src/billing/usage-trial.integration.test.ts`                 |
| integration | `packages/db/src/billing/usage.integration.test.ts`                       |
| integration | `packages/db/src/tenancy/tenant-fk-platform-costs.integration.test.ts`    |
| unit        | `apps/api/src/auth/operator-plane.test.ts`                                |
| unit        | `apps/api/src/billing/charge-status-contract.test.ts`                     |
| unit        | `apps/api/src/billing/paystack-key.test.ts`                               |
| unit        | `apps/web/src/lib/billing-copy.test.ts`                                   |
| unit        | `apps/web/src/lib/billing-pay-copy.test.ts`                               |
| unit        | `apps/web/src/lib/billing-return.test.ts`                                 |
| unit        | `apps/web/src/lib/charge-status.test.ts`                                  |
| unit        | `apps/web/src/lib/payment-record-copy.test.ts`                            |
| unit        | `packages/core/src/ai-cost.test.ts`                                       |
| unit        | `packages/core/src/allowances.test.ts`                                    |
| unit        | `packages/core/src/billing-email.test.ts`                                 |
| unit        | `packages/core/src/billing.cycles.test.ts`                                |
| unit        | `packages/core/src/billing.test.ts`                                       |
| unit        | `packages/core/src/margin.test.ts`                                        |
| unit        | `packages/core/src/payment-record.test.ts`                                |
| unit        | `packages/db/src/billing/plan-expiry-files.test.ts`                       |

### Payments, settlement, bank and reconciliation

| Layer       | Test file                                                                     |
| ----------- | ----------------------------------------------------------------------------- |
| e2e         | `apps/web/e2e/bank.spec.ts`                                                   |
| e2e         | `apps/web/e2e/overpayment.spec.ts`                                            |
| e2e         | `apps/web/e2e/payments.spec.ts`                                               |
| e2e         | `apps/web/e2e/refunds.spec.ts`                                                |
| integration | `apps/api/src/bank/bank-forget-1.integration.test.ts`                         |
| integration | `apps/api/src/bank/bank-forget-2.integration.test.ts`                         |
| integration | `apps/api/src/bank/bank-pairing.integration.test.ts`                          |
| integration | `apps/api/src/bank/bank-release-1.integration.test.ts`                        |
| integration | `apps/api/src/bank/bank-release-2.integration.test.ts`                        |
| integration | `apps/api/src/bank/bank.integration.test.ts`                                  |
| integration | `apps/api/src/bank/feed.integration.test.ts`                                  |
| integration | `apps/api/src/commands/bank-commands.integration.test.ts`                     |
| integration | `apps/api/src/commands/payment-commands.integration.test.ts`                  |
| integration | `apps/api/src/email/resend-webhook.integration.test.ts`                       |
| integration | `apps/api/src/payments/adjustments-concurrency.integration.test.ts`           |
| integration | `apps/api/src/payments/adjustments-disputes.integration.test.ts`              |
| integration | `apps/api/src/payments/adjustments-refund-envelope.integration.test.ts`       |
| integration | `apps/api/src/payments/adjustments-refund-reads.integration.test.ts`          |
| integration | `apps/api/src/payments/adjustments-reversals-chargebacks.integration.test.ts` |
| integration | `apps/api/src/payments/adjustments.integration.test.ts`                       |
| integration | `apps/api/src/payments/connections.integration.test.ts`                       |
| integration | `apps/api/src/payments/merchant-key.integration.test.ts`                      |
| integration | `apps/api/src/payments/paystack.integration.test.ts`                          |
| integration | `apps/api/src/payments/pipeline.integration.test.ts`                          |
| integration | `apps/api/src/payments/settlement-sweep.integration.test.ts`                  |
| integration | `apps/api/src/payments/storefront-transfer.integration.test.ts`               |
| integration | `apps/api/src/reports/overpayment-bus.integration.test.ts`                    |
| integration | `apps/api/src/webhooks/webhooks.integration.test.ts`                          |
| integration | `packages/db/src/bank/bank-fingerprint.integration.test.ts`                   |
| integration | `packages/db/src/bank/bank-payment-references.integration.test.ts`            |
| integration | `packages/db/src/bank/bank.integration.test.ts`                               |
| integration | `packages/db/src/payments/charge-breakdown-order.integration.test.ts`         |
| integration | `packages/db/src/payments/charges.integration.test.ts`                        |
| integration | `packages/db/src/payments/connection-statuses.integration.test.ts`            |
| integration | `packages/db/src/payments/financial-account-connections.integration.test.ts`  |
| integration | `packages/db/src/payments/financial-event-identity.integration.test.ts`       |
| integration | `packages/db/src/bank/golden-bank-credit.integration.test.ts`                 |
| integration | `packages/db/src/payments/payment-evidence.integration.test.ts`               |
| integration | `packages/db/src/payments/payment-provenance.integration.test.ts`             |
| integration | `packages/db/src/payments/payments-hub.integration.test.ts`                   |
| integration | `packages/db/src/payments/provider-resolver.integration.test.ts`              |
| integration | `packages/db/src/bank/reconciliation-tiers.integration.test.ts`               |
| integration | `packages/db/src/payments/settle.integration.test.ts`                         |
| integration | `packages/db/src/payments/settlements.integration.test.ts`                    |
| integration | `packages/db/src/payments/webhooks.integration.test.ts`                       |
| unit        | `apps/api/src/bank/mono.provider.test.ts`                                     |
| unit        | `apps/api/src/payments/paystack.provider.test.ts`                             |
| unit        | `apps/api/src/payments/provider-conformance.test.ts`                          |
| unit        | `apps/api/src/webhooks/destination.test.ts`                                   |
| unit        | `apps/web/src/app/app/invoices/record-payment-action.test.ts`                 |
| unit        | `apps/web/src/lib/bank-release.test.ts`                                       |
| unit        | `packages/contracts/src/meta-webhook.test.ts`                                 |
| unit        | `packages/contracts/src/paystack-webhook.test.ts`                             |
| unit        | `packages/core/src/bank-matching.test.ts`                                     |
| unit        | `packages/core/src/bank-statement.test.ts`                                    |
| unit        | `packages/core/src/charges.test.ts`                                           |
| unit        | `packages/core/src/payments.test.ts`                                          |
| unit        | `packages/core/src/reconciliation.test.ts`                                    |
| unit        | `packages/core/src/webhooks-outbound.test.ts`                                 |
| unit        | `packages/core/src/webhooks.test.ts`                                          |

### Ledger, close, statements and reports

| Layer       | Test file                                                               |
| ----------- | ----------------------------------------------------------------------- |
| e2e         | `apps/web/e2e/reports.spec.ts`                                          |
| integration | `apps/api/src/commands/ledger-commands.integration.test.ts`             |
| integration | `apps/api/src/commands/spend-commands.integration.test.ts`              |
| integration | `apps/api/src/reports/exports.integration.test.ts`                      |
| integration | `apps/api/src/reports/reports-close-compare.integration.test.ts`        |
| integration | `apps/api/src/reports/reports-exports.integration.test.ts`              |
| integration | `apps/api/src/reports/reports-idempotency.integration.test.ts`          |
| integration | `apps/api/src/reports/reports-invoices.integration.test.ts`             |
| integration | `apps/api/src/reports/reports-opening-journal.integration.test.ts`      |
| integration | `apps/api/src/reports/reports-payment.integration.test.ts`              |
| integration | `apps/api/src/reports/reports-purchase-orders-1.integration.test.ts`    |
| integration | `apps/api/src/reports/reports-purchase-orders-2.integration.test.ts`    |
| integration | `apps/api/src/reports/reports-purchase-orders-3.integration.test.ts`    |
| integration | `apps/api/src/reports/reports-quotes.integration.test.ts`               |
| integration | `apps/api/src/reports/reports-spend.integration.test.ts`                |
| integration | `apps/api/src/reports/reports-statements.integration.test.ts`           |
| integration | `apps/api/src/reports/reports-stock.integration.test.ts`                |
| integration | `apps/api/src/reports/reports.integration.test.ts`                      |
| integration | `apps/api/src/spend/depreciation.integration.test.ts`                   |
| integration | `apps/api/src/spend/recurring.integration.test.ts`                      |
| integration | `packages/db/src/ledger/accounts-lifecycle.integration.test.ts`         |
| integration | `packages/db/src/ledger/accounts.integration.test.ts`                   |
| integration | `packages/db/src/documents/bills.integration.test.ts`                   |
| integration | `packages/db/src/ledger/chart-seed.integration.test.ts`                 |
| integration | `packages/db/src/ledger/close.integration.test.ts`                      |
| integration | `packages/db/src/documents/due-time-precision.integration.test.ts`      |
| integration | `packages/db/src/ledger/fx.integration.test.ts`                         |
| integration | `packages/db/src/documents/issue.integration.test.ts`                   |
| integration | `packages/db/src/documents/numbering-year-boundary.integration.test.ts` |
| integration | `packages/db/src/ledger/journal-currency.integration.test.ts`           |
| integration | `packages/db/src/ledger/journal-drafts.integration.test.ts`             |
| integration | `packages/db/src/ledger/journal-invariants.integration.test.ts`         |
| integration | `packages/db/src/ledger/journal.integration.test.ts`                    |
| integration | `packages/db/src/ledger/ledger-account-id.integration.test.ts`          |
| integration | `packages/db/src/ledger/ledger-append-only.integration.test.ts`         |
| integration | `packages/db/src/ledger/opening.integration.test.ts`                    |
| integration | `packages/db/src/ledger/party-statements.integration.test.ts`           |
| integration | `packages/db/src/ledger/portability.integration.test.ts`                |
| integration | `packages/db/src/ledger/posting-key.integration.test.ts`                |
| integration | `packages/db/src/ledger/projections.integration.test.ts`                |
| integration | `packages/db/src/documents/purchase-identity.integration.test.ts`       |
| integration | `packages/db/src/ledger/recognition-events.integration.test.ts`         |
| integration | `packages/db/src/ledger/recognition-policy.integration.test.ts`         |
| integration | `packages/db/src/ledger/recognition.integration.test.ts`                |
| integration | `packages/db/src/documents/recurring.integration.test.ts`               |
| integration | `packages/db/src/ledger/reports.integration.test.ts`                    |
| integration | `packages/db/src/documents/spend.integration.test.ts`                   |
| integration | `packages/db/src/ledger/tax-model.integration.test.ts`                  |
| unit        | `apps/api/src/ai/eval/report.test.ts`                                   |
| unit        | `apps/api/src/reports/accounts.test.ts`                                 |
| unit        | `apps/api/src/reports/export-authorization.test.ts`                     |
| unit        | `apps/web/src/app/app/expenses/paid-by.test.ts`                         |
| unit        | `apps/web/src/app/app/expenses/receive-po-action.test.ts`               |
| unit        | `packages/core/src/chart.test.ts`                                       |
| unit        | `packages/core/src/costing.test.ts`                                     |
| unit        | `packages/core/src/due-dates.test.ts`                                   |
| unit        | `packages/core/src/expenses.test.ts`                                    |
| unit        | `packages/core/src/fx.test.ts`                                          |
| unit        | `packages/core/src/invoice-layout.test.ts`                              |
| unit        | `packages/core/src/ledger.test.ts`                                      |
| unit        | `packages/core/src/money.test.ts`                                       |
| unit        | `packages/core/src/periods.test.ts`                                     |
| unit        | `packages/core/src/purchase-identity.test.ts`                           |
| unit        | `packages/core/src/receipt-layout.test.ts`                              |
| unit        | `packages/core/src/recognition.test.ts`                                 |
| unit        | `packages/core/src/recurring.test.ts`                                   |
| unit        | `packages/core/src/statement-layout.test.ts`                            |
| unit        | `packages/core/src/statements.test.ts`                                  |
| unit        | `packages/core/src/tax.test.ts`                                         |
| unit        | `packages/core/src/xlsx.test.ts`                                        |
| unit        | `packages/db/src/ops/migration-journal-order.test.ts`                   |

### Tenancy, RLS, privacy and identity

| Layer       | Test file                                                              |
| ----------- | ---------------------------------------------------------------------- |
| integration | `apps/api/src/api/api-keys.integration.test.ts`                        |
| integration | `apps/api/src/auth/auth.integration.test.ts`                           |
| integration | `apps/api/src/auth/roles.integration.test.ts`                          |
| integration | `apps/api/src/privacy/gateway.integration.test.ts`                     |
| integration | `apps/api/src/privacy/retention-sweep.integration.test.ts`             |
| integration | `packages/db/src/identity/api-keys.integration.test.ts`                |
| integration | `packages/db/src/channels/conversation-identity.integration.test.ts`   |
| integration | `packages/db/src/customers/customer-consent.integration.test.ts`       |
| integration | `packages/db/src/customers/customer-merge-indexes.integration.test.ts` |
| integration | `packages/db/src/privacy/evidence-retention.integration.test.ts`       |
| integration | `packages/db/src/identity/magic-links.integration.test.ts`             |
| integration | `packages/db/src/privacy/object-deletions.integration.test.ts`         |
| integration | `packages/db/src/tenancy/provision.integration.test.ts`                |
| integration | `packages/db/src/privacy/retention.integration.test.ts`                |
| integration | `packages/db/src/tenancy/rls-invariants.integration.test.ts`           |
| integration | `packages/db/src/tenancy/tenancy.integration.test.ts`                  |
| integration | `packages/db/src/tenancy/tenant-fk-group-a.integration.test.ts`        |
| integration | `packages/db/src/tenancy/tenant-fk-group-b.integration.test.ts`        |
| integration | `packages/db/src/tenancy/tenant-fk-group-c.integration.test.ts`        |
| integration | `packages/db/src/tenancy/tenant-fk-group-d.integration.test.ts`        |
| integration | `packages/db/src/tenancy/tenant-fk-group-e.integration.test.ts`        |
| integration | `packages/db/src/tenancy/tenant-fk-group-f1.integration.test.ts`       |
| integration | `packages/db/src/tenancy/tenant-fk-group-f2.integration.test.ts`       |
| integration | `packages/db/src/tenancy/tenant-fk-group-f3.integration.test.ts`       |
| integration | `packages/db/src/tenancy/tenant-fk-group-f4.integration.test.ts`       |
| integration | `packages/db/src/tenancy/tenant-fk-group-f5.integration.test.ts`       |
| integration | `packages/db/src/tenancy/tenant-fk-ruling5.integration.test.ts`        |
| integration | `packages/db/src/tenancy/tenant-fk-unconstrained.integration.test.ts`  |
| unit        | `apps/api/src/auth/operator-identity.test.ts`                          |
| unit        | `apps/api/src/auth/operator.guard.test.ts`                             |
| unit        | `apps/api/src/privacy/payload-vault.test.ts`                           |
| unit        | `packages/core/src/api-keys.test.ts`                                   |
| unit        | `packages/core/src/identity.test.ts`                                   |
| unit        | `packages/core/src/privacy.test.ts`                                    |
| unit        | `packages/core/src/retention.test.ts`                                  |
| unit        | `packages/core/src/vault.test.ts`                                      |
| unit        | `packages/db/src/tenancy/provision.test.ts`                            |

### Stock, catalogue, orders and storefront

| Layer       | Test file                                                                   |
| ----------- | --------------------------------------------------------------------------- |
| e2e         | `apps/web/e2e/stock.spec.ts`                                                |
| e2e         | `apps/web/e2e/storefront.spec.ts`                                           |
| integration | `apps/api/src/catalogue/catalogue.integration.test.ts`                      |
| integration | `apps/api/src/channels/catalogue-sync.integration.test.ts`                  |
| integration | `apps/api/src/commands/order-commands.integration.test.ts`                  |
| integration | `apps/api/src/shop/shop.integration.test.ts`                                |
| integration | `packages/db/src/documents/allocation-unwind-order.integration.test.ts`     |
| integration | `packages/db/src/stock/catalogue.integration.test.ts`                       |
| integration | `packages/db/src/channels/conversation-insertion-order.integration.test.ts` |
| integration | `packages/db/src/channels/draft-confirmation-order.integration.test.ts`     |
| integration | `packages/db/src/documents/goods-returns.integration.test.ts`               |
| integration | `packages/db/src/stock/orders.integration.test.ts`                          |
| integration | `packages/db/src/stock/shops.integration.test.ts`                           |
| integration | `packages/db/src/stock/stock-reservation.integration.test.ts`               |
| integration | `packages/db/src/stock/stock.integration.test.ts`                           |
| integration | `packages/db/src/stock/stocktake.integration.test.ts`                       |
| unit        | `apps/api/src/channels/meta-catalogue.publisher.test.ts`                    |
| unit        | `packages/core/src/fulfilment.test.ts`                                      |
| unit        | `packages/core/src/orders.test.ts`                                          |

### AI, chat engine and WhatsApp channel

| Layer       | Test file                                                             |
| ----------- | --------------------------------------------------------------------- |
| e2e         | `apps/web/e2e/reminders.spec.ts`                                      |
| integration | `apps/api/src/ai/eval/eval.integration.test.ts`                       |
| integration | `apps/api/src/ai/interpreter.integration.test.ts`                     |
| integration | `apps/api/src/channels/customer-route.integration.test.ts`            |
| integration | `apps/api/src/channels/meta-catalogue-order-1.integration.test.ts`    |
| integration | `apps/api/src/channels/meta-catalogue-order-2.integration.test.ts`    |
| integration | `apps/api/src/channels/meta-chat-entitlement-1.integration.test.ts`   |
| integration | `apps/api/src/channels/meta-chat-entitlement-2.integration.test.ts`   |
| integration | `apps/api/src/channels/meta-chat-entitlement-3.integration.test.ts`   |
| integration | `apps/api/src/channels/meta-consent-trial.integration.test.ts`        |
| integration | `apps/api/src/channels/meta-continuations-1.integration.test.ts`      |
| integration | `apps/api/src/channels/meta-continuations-2.integration.test.ts`      |
| integration | `apps/api/src/channels/meta-cross-product.integration.test.ts`        |
| integration | `apps/api/src/channels/meta-customer-identity.integration.test.ts`    |
| integration | `apps/api/src/channels/meta-customer-thread.integration.test.ts`      |
| integration | `apps/api/src/channels/meta-delivery-status.integration.test.ts`      |
| integration | `apps/api/src/channels/meta-forwarded-order.integration.test.ts`      |
| integration | `apps/api/src/channels/meta-g68-codex-review.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-g68-final-review.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-g68-review.integration.test.ts`           |
| integration | `apps/api/src/channels/meta-invoices.integration.test.ts`             |
| integration | `apps/api/src/channels/meta-order-ingress.integration.test.ts`        |
| integration | `apps/api/src/channels/meta-pidgin-continuations.integration.test.ts` |
| integration | `apps/api/src/channels/meta-plan-example.integration.test.ts`         |
| integration | `apps/api/src/channels/meta-preview-expiry-1.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-preview-expiry-2.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-preview-expiry-3.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-purchase-truth-1.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-purchase-truth-2.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-purchase-truth-3.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-purchase-truth-4.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-purchase-truth-5.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-receipt-photo-1.integration.test.ts`      |
| integration | `apps/api/src/channels/meta-receipt-photo-2.integration.test.ts`      |
| integration | `apps/api/src/channels/meta-receipt-photo-3.integration.test.ts`      |
| integration | `apps/api/src/channels/meta-record-payment-1.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-record-payment-2.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-routing-language.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-stock-count.integration.test.ts`          |
| integration | `apps/api/src/channels/meta-stock-purchase-1.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-stock-purchase-2.integration.test.ts`     |
| integration | `apps/api/src/channels/meta-understanding.integration.test.ts`        |
| integration | `apps/api/src/channels/meta-voice-note-1.integration.test.ts`         |
| integration | `apps/api/src/channels/meta-voice-note-2.integration.test.ts`         |
| integration | `apps/api/src/channels/meta-webhook-ingress.integration.test.ts`      |
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
| integration | `packages/db/src/channels/continuations.integration.test.ts`          |
| integration | `packages/db/src/channels/draft-expiry.integration.test.ts`           |
| integration | `packages/db/src/channels/email-suppressions.integration.test.ts`     |
| integration | `packages/db/src/channels/waba.integration.test.ts`                   |
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

| Layer       | Test file                                                       |
| ----------- | --------------------------------------------------------------- |
| integration | `apps/api/src/health/ops.integration.test.ts`                   |
| integration | `apps/api/src/jobs/jobs-chat-roles-1.integration.test.ts`       |
| integration | `apps/api/src/jobs/jobs-chat-roles-2.integration.test.ts`       |
| integration | `apps/api/src/jobs/jobs-chat-roles-3.integration.test.ts`       |
| integration | `apps/api/src/jobs/jobs-documents.integration.test.ts`          |
| integration | `apps/api/src/jobs/jobs-lanes.integration.test.ts`              |
| integration | `apps/api/src/jobs/jobs-lease.integration.test.ts`              |
| integration | `apps/api/src/jobs/jobs.integration.test.ts`                    |
| integration | `apps/api/src/observability/logs.integration.test.ts`           |
| integration | `apps/api/src/http/rate-limit.integration.test.ts`              |
| integration | `apps/api/src/risk/risk-policy.integration.test.ts`             |
| integration | `packages/db/src/tenancy/boot-checks.integration.test.ts`       |
| integration | `packages/db/src/ops/idempotency.integration.test.ts`           |
| integration | `packages/db/src/ops/jobs.integration.test.ts`                  |
| integration | `packages/db/src/ops/load.integration.test.ts`                  |
| integration | `packages/db/src/ops/ops-health.integration.test.ts`            |
| integration | `packages/db/src/ops/outbox.integration.test.ts`                |
| integration | `packages/db/src/channels/preview-delivery.integration.test.ts` |
| integration | `packages/db/src/ops/recovery-drill.integration.test.ts`        |
| integration | `packages/db/src/ops/risk.integration.test.ts`                  |
| integration | `packages/db/src/ops/service-window.integration.test.ts`        |
| integration | `packages/db/src/ops/status-drift.integration.test.ts`          |
| integration | `packages/db/src/tenancy/testing.integration.test.ts`           |
| unit        | `apps/api/src/edge-check.test.ts`                               |
| unit        | `apps/api/src/edge-proxies.test.ts`                             |
| unit        | `apps/api/src/health/health.test.ts`                            |
| unit        | `apps/api/src/health/ops-alerts.test.ts`                        |
| unit        | `apps/api/src/jobs/sweep-schedule.test.ts`                      |
| unit        | `apps/api/src/http/client-address.test.ts`                      |
| unit        | `apps/api/src/http/rate-limit-exempt.test.ts`                   |
| unit        | `packages/core/src/ops-alerts.test.ts`                          |
| unit        | `packages/core/src/risk.test.ts`                                |
| unit        | `packages/db/src/ops/entrypoint.test.ts`                        |

### Other

| Layer       | Test file                                                            |
| ----------- | -------------------------------------------------------------------- |
| e2e         | `apps/web/e2e/onboarding.spec.ts`                                    |
| e2e         | `apps/web/e2e/populated-month.spec.ts`                               |
| e2e         | `apps/web/e2e/team.spec.ts`                                          |
| integration | `apps/api/src/api/api-metering.integration.test.ts`                  |
| integration | `apps/api/src/api/public/merchant-api.integration.test.ts`           |
| integration | `apps/api/src/api/public/public-api.integration.test.ts`             |
| integration | `apps/api/src/api/sandbox.integration.test.ts`                       |
| integration | `packages/db/src/documents/assets.integration.test.ts`               |
| integration | `packages/db/src/stock/cross-product.integration.test.ts`            |
| integration | `packages/db/src/customers/customer-credits.integration.test.ts`     |
| integration | `packages/db/src/customers/customers.integration.test.ts`            |
| integration | `packages/db/src/ledger/golden-fixture.integration.test.ts`          |
| integration | `packages/db/src/payments/provenance-classifier.integration.test.ts` |
| integration | `packages/db/src/payments/provenance-writers.integration.test.ts`    |
| unit        | `apps/api/src/api/public/sale-event-id.test.ts`                      |
| unit        | `apps/api/src/config/ai-provider.test.ts`                            |
| unit        | `apps/api/src/config/command-bus.test.ts`                            |
| unit        | `apps/api/src/config/feature-flags.test.ts`                          |
| unit        | `apps/api/src/config/fx.test.ts`                                     |
| unit        | `apps/api/src/config/hardening.test.ts`                              |
| unit        | `apps/api/src/config/media.test.ts`                                  |
| unit        | `apps/api/src/config/numeric.test.ts`                                |
| unit        | `apps/api/src/config/production.test.ts`                             |
| unit        | `apps/api/src/config/trust.test.ts`                                  |
| unit        | `apps/web/src/app/app/export/[kind]/route.test.ts`                   |
| unit        | `apps/web/src/app/og.test.tsx`                                       |
| unit        | `apps/web/src/components/legal/LegalPage.test.tsx`                   |
| unit        | `apps/web/src/lib/intent-key.test.ts`                                |
| unit        | `apps/web/src/lib/legal-gate.test.ts`                                |
| unit        | `apps/web/src/lib/plans.test.ts`                                     |
| unit        | `apps/web/src/lib/return-path.test.ts`                               |
| unit        | `apps/web/src/server/client-address.test.ts`                         |
| unit        | `apps/web/src/server/visitor-forwarding.test.ts`                     |
| unit        | `packages/contracts/src/public/v1/shape.test.ts`                     |
| unit        | `packages/core/src/audit.test.ts`                                    |
| unit        | `packages/core/src/csv.test.ts`                                      |
| unit        | `packages/core/src/gates.test.ts`                                    |
| unit        | `packages/core/src/period-compare.test.ts`                           |
| unit        | `packages/core/src/provenance.test.ts`                               |
