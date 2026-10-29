# Billing: staging walkthrough and acceptance checklist

Status words in this file follow the repository's scale: CODE COMPLETE, MERGED, DEPLOYED TO STAGING,
STAGING ACCEPTED, LIVE PROVIDER VERIFIED. Nothing here is STAGING ACCEPTED until a person has done the
steps below and written the result in the table at the end. CI proves Rekoda's side with a stand-in for
Paystack; only a real Paystack TEST payment proves the provider side.

## 0. Staging settings that must be on first

If one of these is missing, the matching step below shows a plain "not switched on" message and
charges nothing, except `REKODA_WEB_URL`: without it checkout still opens, but Paystack cannot send
the merchant back to Rekoda afterwards. They live in the staging host's env file, never in source or chat.

| Setting                                                                                        | Needed for                                                                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `PAYSTACK_SECRET_KEY=sk_test_...` (a TEST key)                                                 | opening Paystack checkout and verifying a payment                                               |
| `REKODA_PAYSTACK_PLATFORM_CONFIRMED=1`                                                         | "Confirm and pay" opens a payment instead of "card payments are not switched on"                |
| `REKODA_WEB_URL=https://staging.myrekoda.com`                                                  | Paystack sending the merchant back to `/app/billing/return`, and the emailed confirmation link  |
| Paystack dashboard (test mode) webhook URL `https://<api host>/webhooks/paystack`              | the payment being confirmed and applied                                                         |
| `REKODA_WORKER=1` with `WORKER_DATABASE_URL` (or the separate worker process running)          | applying a verified payment and sending reminders                                               |
| `REKODA_ANNUAL_BILLING=1`                                                                      | the Yearly option (only once every process is annual-aware)                                     |
| `REKODA_EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `REKODA_EMAIL_FROM`, `RESEND_WEBHOOK_SECRET` | the billing-email confirmation mail (a TEST Paystack key does not wait for it; a LIVE key does) |
| `META_BILLING_TEMPLATE` (approved)                                                             | grace-period WhatsApp reminders; without it they are held, not sent                             |

## 1. The journey (sign up, trial, pay, manage)

Use a phone you control. On mobile and on a laptop-sized window.

| #   | Do                                                                                      | Expect                                                                                                                    |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open `/start`, enter your phone, enter the WhatsApp code, give a business name and type | You land on the setup-complete page                                                                                       |
| 2   | Open `/app/billing`                                                                     | Heading "Your plan and what it costs"; "Free trial"; days left in plain words (14-day trial, no countdown); empty history |
| 3   | Under "Change plan" read the prices                                                     | Chat ₦9,900, Integrate ₦19,900, Complete ₦29,900 a month                                                                  |
| 4   | Open the Yearly option                                                                  | Each price is ten months' price (₦99,000, ₦199,000, ₦299,000) for twelve months                                           |
| 5   | Choose Rekoda Chat                                                                      | "Moving to Rekoda Chat", "₦9,900 today"; nothing is charged by looking                                                    |
| 6   | Press "Confirm and pay"                                                                 | A payment appears under "Pay": amount, plan, reference, a "Billing email" field                                           |
| 7   | Type your billing email, press "Pay with Paystack"                                      | Paystack's hosted test page opens                                                                                         |
| 8   | Pay with a Paystack TEST card (their published test numbers)                            | Paystack sends you back to Rekoda                                                                                         |
| 9   | On `/app/billing/return`                                                                | "Confirming your payment" for a few seconds, then "Payment received" and "Your Chat plan is active until <date>"          |
| 10  | Press "Back to billing"                                                                 | Current plan Rekoda Chat; the history row says Paid with the same reference                                               |
| 11  | Ask a developer to resend the same webhook (or use Paystack's dashboard "resend")       | Nothing changes: still one paid payment and one period                                                                    |

## 2. Managing the subscription

| #   | Do                                                                       | Expect                                                                                                                          |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 12  | Choose Rekoda Integrate                                                  | A quote with a pro-rated amount for the days left; pay as above; plan becomes Integrate                                         |
| 13  | Choose Rekoda Chat again                                                 | "Takes effect at your next renewal"; nothing charged; a way to keep the current plan                                            |
| 14  | "Billing frequency": press "Switch to yearly at my next renewal"         | Confirmation that it will switch at renewal; a way to undo                                                                      |
| 15  | "Need more this month": press Buy on a pack, pay                         | After payment the units appear under "This month"; the history shows the pack as Paid                                           |
| 16  | "Leaving Rekoda": "Cancel my subscription"                               | The plan stays until the paid-to date, which is named; an undo button                                                           |
| 17  | After the paid-to date passes (an operator can move the date on staging) | A 7-day grace with reminders on day 1 and 5, then read-only: your records stay readable and exportable, new records are refused |
| 18  | Pay a new plan after expiry                                              | The plan reactivates; no second trial is given                                                                                  |

## 3. Not built yet, so do not expect it

- A receipt or invoice document for your Rekoda subscription payment (Paystack emails its own receipt;
  the tax treatment of Rekoda's own subscription needs the owner's legal review).
- Trial reminders on days 7, 11 to 12, 13 and 14, and a reminder before renewal (they need approved
  Meta templates).
- A screen for staff to refund a subscription payment (refunds are done by an operator by hand).

## 4. Result table (fill in on staging)

| #   | Date | Tester | Desktop | Mobile | Notes |
| --- | ---- | ------ | ------- | ------ | ----- |

## 5. Automated evidence per step (status as of 29 Oct 2026)

Every step in sections 1 and 2 is **MERGED code with automated tests and STAGING ACCEPTANCE PENDING**: the
result table in section 4 is empty, so no step has been walked on staging, and nothing here is live provider
verified (Paystack test mode only, once walked). The files below exercise the area of each step; they are
where to look, not a claim that a test asserts the exact wording on screen.

| Steps | Area                                   | Automated tests that exercise it                                                                                                                                                                    | Staging walk |
| ----- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1-2   | Sign-up, 14-day trial, days left       | `packages/db/src/trial-lifecycle.integration.test.ts`, `apps/api/src/billing/trial-notice-sweep.integration.test.ts`, `apps/web/e2e/billing.spec.ts`                                                | PENDING      |
| 3-5   | Plan prices, yearly option, quote      | `apps/api/src/billing/annual-billing.integration.test.ts`, `apps/web/e2e/billing-journey.spec.ts`                                                                                                   | PENDING      |
| 6-10  | Checkout, Paystack return, history     | `apps/api/src/billing/billing-checkout.integration.test.ts`, `billing-checkout-recovery.integration.test.ts`, `payment-record.integration.test.ts`, `apps/web/e2e/billing-journey.spec.ts`          | PENDING      |
| 11    | Webhook replay applies once            | `apps/api/src/billing/billing-charge.integration.test.ts`, `retry-and-zero-charge.integration.test.ts`, `stale-charge.integration.test.ts`                                                          | PENDING      |
| 12-14 | Upgrade proration, scheduled downgrade | `packages/db/src/subscription-journey.integration.test.ts`, `packages/db/src/subscriptions.integration.test.ts`                                                                                     | PENDING      |
| 15    | Pack purchase, units granted once      | `apps/api/src/billing/pack-grant.integration.test.ts`, `packages/db/src/usage.integration.test.ts`, `quota.integration.test.ts`                                                                     | PENDING      |
| 16-18 | Cancel, grace, read-only, reactivation | `apps/api/src/billing/lapsed-plan.integration.test.ts`, `annual-lifecycle.integration.test.ts`, `subscription-retention-race.integration.test.ts`, `apps/web/e2e/billing-journey-lifecycle.spec.ts` | PENDING      |

Not covered by any automated test, so only a staging walk can show it: Paystack's hosted page and the live
redirect back to Rekoda, the emailed confirmation link, and the WhatsApp grace reminders (held until
`META_BILLING_TEMPLATE` is approved).
