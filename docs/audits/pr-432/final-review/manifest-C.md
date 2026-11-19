# Manifest C (apps/api/src/billing, packages/core, packages/contracts) vs 58e6834, head 198d37a

apps/api/src/billing/annual-billing-switching.integration.test.ts | reviewed | none
apps/api/src/billing/annual-billing.integration.test.ts | reviewed | none
apps/api/src/billing/annual-lifecycle.integration.test.ts | reviewed | none
apps/api/src/billing/billing-charge.integration.test.ts | reviewed | none
apps/api/src/billing/billing-checkout-replacement.integration.test.ts | reviewed | none
apps/api/src/billing/billing-checkout.integration.test.ts | reviewed | none
apps/api/src/billing/billing-checkout.service.ts | reviewed | none
apps/api/src/billing/billing-dead-job.integration.test.ts | reviewed | none
apps/api/src/billing/billing-email-live-payment.integration.test.ts | reviewed | none
apps/api/src/billing/billing-grace.integration.test.ts | reviewed | none
apps/api/src/billing/billing-grandfathering.integration.test.ts | reviewed | none
apps/api/src/billing/billing-paying.integration.test.ts | reviewed | none
apps/api/src/billing/billing-renewal.integration.test.ts | reviewed | none
apps/api/src/billing/billing.integration.test.ts | reviewed | none
apps/api/src/billing/billing.service.ts | reviewed | C-1, C-2, C-3
apps/api/src/billing/charge-provider-times.integration.test.ts | reviewed | none
apps/api/src/billing/checkout-recovery.fixtures.ts | reviewed | none
apps/api/src/billing/grace-sweep.ts | reviewed | none
apps/api/src/billing/lapsed-plan.integration.test.ts | reviewed | none
apps/api/src/billing/no-charge-upgrade-status.integration.test.ts | reviewed | none
apps/api/src/billing/pack-grant.integration.test.ts | reviewed | none
apps/api/src/billing/pack-purchase-identity.integration.test.ts | reviewed | none
apps/api/src/billing/payment-record.integration.test.ts | reviewed | none
apps/api/src/billing/plan-terms.ts | reviewed | none
apps/api/src/billing/priced-charge.fixtures.ts | reviewed | none
apps/api/src/billing/pricing-source-boot.integration.test.ts | reviewed | none
apps/api/src/billing/pricing-source.integration.test.ts | reviewed | none
apps/api/src/billing/renewal-gate-cursor.integration.test.ts | reviewed | none
apps/api/src/billing/renewal-gate-lease.integration.test.ts | reviewed | none
apps/api/src/billing/renewal-gate-paging.integration.test.ts | reviewed | none
apps/api/src/billing/renewal-gate.integration.test.ts | reviewed | none
apps/api/src/billing/renewal-initiate-pool.integration.test.ts | reviewed | none
apps/api/src/billing/renewal-initiate.integration.test.ts | reviewed | none
apps/api/src/billing/renewal-sweep.ts | reviewed | none
apps/api/src/billing/retry-and-zero-charge.integration.test.ts | reviewed | none
apps/api/src/billing/settlement-verifies-price.integration.test.ts | reviewed | none
apps/api/src/billing/staging-faults.test.ts | reviewed | none
apps/api/src/billing/staging-faults.ts | reviewed | none
apps/api/src/billing/stale-charge-exceptions.integration.test.ts | reviewed | none
apps/api/src/billing/stale-charge-tampered.integration.test.ts | reviewed | none
apps/api/src/billing/stale-charge.integration.test.ts | reviewed | none
apps/api/src/billing/stale-price-handback.integration.test.ts | reviewed | none
apps/api/src/billing/subscription-retention-race.integration.test.ts | reviewed | none
apps/api/src/billing/trial-notice-gate.test.ts | reviewed | none
apps/api/src/billing/trial-notice-sweep-eligibility.integration.test.ts | reviewed | none
apps/api/src/billing/trial-notice-sweep-isolation.integration.test.ts | reviewed | C-5
apps/api/src/billing/trial-notice-sweep.ts | reviewed | none
packages/contracts/src/billing-api.ts | reviewed | C-4
packages/contracts/src/identity.ts | reviewed | none
packages/contracts/src/reports-api.ts | reviewed | none
packages/core/src/billing.ts | reviewed | none
packages/core/src/ops-alerts.test.ts | reviewed | none
packages/core/src/ops-alerts.ts | reviewed | none
packages/core/src/replies.test.ts | reviewed | none
packages/core/src/replies.ts | reviewed | none

## Findings

C-1 | MINOR | apps/api/src/billing/billing.service.ts:1166-1201 (noChargeUpgradeView) -> apps/web/src/lib/billing-pay-copy.ts:410-413, apps/web/src/app/app/billing/page.tsx:247
Failure: the view reports the LATEST zero-priced upgrade charge ever made, with no tie to the current plan. Merchant with <1 day left upgrades Chat->Complete at no charge, lands on /app/billing?done=processing, worker applies it. Later (next renewal applies a scheduled downgrade to Chat, an operator move, or any later plan change) the merchant reopens/refreshes that address from history: overview.noChargeUpgrade = {plan:'complete', state:'applied'} and the strip says "Done. You are on Complete now ... your renewal date has not changed" while overview.plan is 'chat'. Stale plan name; reachable only through the stale ?done=processing address.
Fix: return `applied` only while latest.plan equals the current plan and the cycle is the one the charge landed in (else null), or have the page suppress the strip when view.plan !== overview.plan; alternatively carry the charge reference in the redirect and read that charge.

C-2 | MINOR | apps/api/src/billing/billing.service.ts:230-235 (paymentRecord `replaced`) -> apps/web/src/lib/payment-record-copy.ts:28-32
Failure: the apply_no_charge handler withdraws a zero-priced upgrade through retirePendingCharge (superseded_at + abandoned_at). Its payment record is then `replaced`: "Replaced by a newer choice. You chose something else after this, so it should not be paid." The merchant chose nothing; the cycle ended while the job waited (or the price check withdrew it). Same wording for a pack link retired by retirePurchaseSiblings after the other link credited. Copy invents a merchant action.
Fix: derive a distinct state/reason for a withdrawn no-charge upgrade (noCharge && audit no_charge_upgrade_withdrawn) and for a sibling of a credited purchase, or word `replaced` neutrally ("no longer needed").

C-3 | MINOR | apps/api/src/billing/billing.service.ts:275 (`reconciled` = unapplied && unappliedResolvedAt) -> apps/web/src/lib/payment-record-copy.ts:115-121
Failure: an operator records a refund (POST /v1/ops/refund) of a set-aside duplicate pack payment; recordRefund does not stamp unapplied_resolved_at, so the record reads "Refunded. All of the charged amount has since been returned... It was not applied because this top-up had already been paid for. No extra units were added, and our team is reviewing this second payment." The review is effectively over. (Same pre-existing shape for under_review.)
Fix: treat a refunded/part-refunded unapplied charge as reviewed for the copy (use the `reviewed` wording when refundedAmountK > 0), or have the refund writer resolve the unapplied item.

C-4 | MINOR | packages/contracts/src/billing-api.ts:219-245
Failure: the OWN-76 JSDoc meant for `processingIssue` sits stacked above `noChargeUpgrade`'s own JSDoc, so `processingIssue` is undocumented and `noChargeUpgrade` carries a wrong description; `noChargeUpgrade` has `.default(null)` "so a page reading an older API still parses" but `processingIssue` (added in the same PR) does not, so the stated compatibility does not hold for the object as a whole. No runtime failure while API and web deploy together.
Fix: move the OWN-76 comment onto `processingIssue`; give it `.nullable().default(null)` or drop the compatibility claim.

C-5 | MINOR | apps/api/src/billing/trial-notice-sweep-isolation.integration.test.ts:201-206
Failure: `rejects.toThrow()` with no matcher passes on any error (an SQL typo, a missing column after a rename), so it no longer proves the 0210 privilege refusal it describes.
Fix: assert the SQLSTATE, e.g. `rejects.toMatchObject({ cause: { code: '42501' } })`, as charge-provider-times does.

## Specific checks

(a) Stale plan name after upgrade: no API field is stale (overview.plan comes from planFor at read time; charges[].plan is the charge's own historical plan; ops currentPlan is read now). The one stale path is C-1 (no-charge upgrade notice, gated by ?done=processing).
(b) paid_twice: does NOT wrongly assume a top-up. notAppliedReason maps only `duplicate_purchase` -> paid_twice (billing.service.ts:1074); `duplicate_purchase` is written in exactly one place, the add_on branch of applySettledCharge (billing.service.ts:793); no SQL function or other writer sets it (grep of migrations/repos). A duplicate payment of a plan upgrade/renewal is set aside as subscription_decided_after_charge -> plan_changed, never paid_twice. The web copy "this top-up had already been paid for" (payment-record-copy.ts:76-81) is therefore accurate for every reachable paid_twice record.
