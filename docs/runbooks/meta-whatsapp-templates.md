# WhatsApp templates: the five slots and how to verify them (OD-41(b))

Rekoda sends five message types as Meta templates on its own number, because each can reach a phone
that has not written in the last 24 hours, where Meta rejects free-form text (131047). All five
templates already exist in WhatsApp Manager (owner, 7 Nov 2026). Nothing in this repository creates,
submits or approves a template, and nothing in it can see Meta's approval, quality or active status.
This runbook is the manual check of those facts and of the staging configuration. It is performed by
the owner or the staging operator, not by engineering.

The authority for the slots in code is `apps/api/src/channels/template-slots.ts`. The read-only check
(`scripts/staging-readonly-check.sh`) carries the same list and a test keeps the two equal.

## 1. The five slots

All parameters are Meta `text` parameters. Dates are Lagos dates written `DD/MM/YYYY`. Days left is a
whole number written in digits.

| #   | Variable (language variable)                     | Agreed template               | Category       | Required | Sent by                                                               | Parameters, in order                                                                         |
| --- | ------------------------------------------------ | ----------------------------- | -------------- | -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `META_OTP_TEMPLATE` (`META_OTP_TEMPLATE_LOCALE`) | `rekoda_login_otp`            | AUTHENTICATION | yes      | sign-in (`auth/auth.service.ts`)                                      | body `{{1}}` the code; URL button index 0 (copy code), one parameter: the same code          |
| 2   | `META_BILLING_TEMPLATE` (`..._LOCALE`)           | `rekoda_billing_grace_notice` | UTILITY        | yes      | grace sweep after a failed renewal (`billing/grace-sweep.ts`)         | body `{{1}}` days of grace left, `{{2}}` the date grace ends, `{{3}}` the billing link       |
| 3   | `META_RETENTION_TEMPLATE` (`..._LOCALE`)         | `rekoda_retention_notice`     | UTILITY        | no       | retention sweep (`privacy/retention-sweep.ts`)                        | body `{{1}}` days until deletion, `{{2}}` the deletion date                                  |
| 4   | `META_DOCUMENT_TEMPLATE` (`..._LOCALE`)          | `rekoda_document_ready`       | UTILITY        | yes      | document delivery outside 24 h (`jobs/deliver-document.handler.ts`)   | body `{{1}}` what it is (`receipt`, `invoice`, `quote` or `document`), `{{2}}` its reference |
| 5   | `META_TRIAL_TEMPLATE` (`..._LOCALE`)             | `rekoda_trial_ending`         | UTILITY        | yes      | trial sweep at 7, 2 and 1 days left (`billing/trial-notice-sweep.ts`) | body `{{1}}` days of trial left, `{{2}}` the date the trial ends, `{{3}}` the billing link   |

- **Billing link** (`{{3}}` of slots 2 and 5): `<REKODA_WEB_URL>/app/billing`. On staging
  `REKODA_WEB_URL=https://staging.myrekoda.com`, so the link is `https://staging.myrekoda.com/app/billing`.
  Nothing is hardcoded: each environment's own `REKODA_WEB_URL` decides it. In production, setting
  slot 2 or 5 without an https `REKODA_WEB_URL` refuses to boot; elsewhere those notices are refused
  as not sent.
- **Language:** unset means `en`. The trial template's agreed language is `en`. For the other four, set
  the variable to exactly the code WhatsApp Manager shows (for example `en` or `en_US`). A malformed
  name or language refuses to boot, naming the variable only.
- **Required versus optional:** an unset required slot reads `ATTENTION` in the read-only check; the
  retention slot is optional because, unset, the retention sweep warns nobody and so deletes nobody.
  This is an engineering classification recorded in the PR A plan; changing it is one line in
  `template-slots.ts` and one in the script.
- **No free-form fallback:** with a slot unset (or no billing link for slots 2 and 5) the sender
  refuses that message as not sent. It never sends a text instead.

## 2. Manual check in WhatsApp Manager (owner)

For each of the five templates, record what WhatsApp Manager shows. Do not tick a line from memory or
from an earlier inventory.

| Check                   | What to record                                                    | Expected                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Name                    | exact name                                                        | the agreed name in §1                                                                                                    |
| Language                | exact language code                                               | `en` for `rekoda_trial_ending`; for the others, the value you will set in `..._LOCALE`                                   |
| Category                | category                                                          | as §1                                                                                                                    |
| Status                  | approval status (Approved, In review, Rejected, Paused, Disabled) | Approved. In review, Rejected, Paused or Disabled does not permit sending                                                |
| Quality                 | quality rating (High, Medium, Low, Pending)                       | recorded; Pending is not a refusal but is not evidence of good quality either                                            |
| Active                  | active or inactive                                                | active                                                                                                                   |
| Header, footer, buttons | each component as shown                                           | slot 1: copy-code button; slots 2 to 5: no header or button variables (a static footer is fine)                          |
| Body                    | the body text with its variables                                  | exactly the variables in §1, in that order, no more and no fewer                                                         |
| Parameter meaning       | what each `{{n}}` says in the body                                | matches §1 (for slots 2 and 5, `{{3}}` is where the billing link goes)                                                   |
| Repository match        | yes / no: does §1 match what you recorded?                        | yes. If not, stop and tell engineering before setting the variable: a mismatch is refused by Meta (132000) on every send |

Creation, "In review" and "Active, quality pending" are not approval for production sending. Record
the status you actually see on the day.

## 3. Staging configuration (owner, on the Hetzner host's `.env`)

Engineering does not read or edit the host. The values below go in the staging host's `.env` only,
never in `docker-compose.prod.yml` (shared with production). The api and worker both load `.env`
(`env_file: .env`), so one line configures both; recreate both containers after editing.

```
META_OTP_TEMPLATE=rekoda_login_otp
META_OTP_TEMPLATE_LOCALE=<code shown in WhatsApp Manager>
META_BILLING_TEMPLATE=rekoda_billing_grace_notice
META_BILLING_TEMPLATE_LOCALE=<code shown in WhatsApp Manager>
META_RETENTION_TEMPLATE=rekoda_retention_notice
META_RETENTION_TEMPLATE_LOCALE=<code shown in WhatsApp Manager>
META_DOCUMENT_TEMPLATE=rekoda_document_ready
META_DOCUMENT_TEMPLATE_LOCALE=<code shown in WhatsApp Manager>
META_TRIAL_TEMPLATE=rekoda_trial_ending
META_TRIAL_TEMPLATE_LOCALE=en
REKODA_WEB_URL=https://staging.myrekoda.com
```

Set a slot only once its template is Approved (OWN-61): the code sends through whatever name is set.

## 4. Read-only check (operator)

```
ssh <deploy-user>@<host> 'EXPECT_SHA=<deployed sha> EXPECT_WEB_URL=https://staging.myrekoda.com bash -s' < scripts/staging-readonly-check.sh
```

Under `== Meta template slots in the running api and worker`, for both `(api)` and `(worker)`:

- each `META_*_TEMPLATE` reads `SET, the agreed name`;
- `META_TRIAL_TEMPLATE_LOCALE` reads `en, the agreed language`; the other languages read as reported;
- `billing link in templates` reads `EXPECT_WEB_URL/app/billing`;
- `META_RETENTION_TEMPLATE` may read `UNSET (optional; information only)` without blocking `RESULT: OK`.

The check reads configuration only. Its `RESULT: OK` says nothing about Meta approval; §2 does.

## 5. Behaviour checks on staging (owner, manual acceptance)

Engineering has covered these with automated tests (supporting evidence only). The staging
observation is the acceptance evidence.

1. **Trial reminders 7, 2 and 1 days before expiry.** A designated test business whose trial reaches
   7, then 2, then 1 days left receives exactly one message per stage, through `rekoda_trial_ending`,
   showing the days left, the trial end date and the link `https://staging.myrekoda.com/app/billing`.
   Capture: each message on the tester phone (screenshot), its time, and the business's trial end date.
   No message at or after expiry.
2. **Grace reminder.** A test business in grace receives `rekoda_billing_grace_notice` with days left,
   the grace end date and the same billing link. Capture the message and the business's grace dates.
3. **Billing link.** Tapping the link in both messages opens the staging billing page. Capture the
   page URL as the phone shows it.
4. **Document ready, sign-in code, retention warning.** Where the journeys reach them, capture one
   delivered message of each, with the template name visible in the WhatsApp Manager message log.
5. **A controlled send:** only to tester phones you control. If Meta refuses a send (for example a
   template not yet approved), capture the refusal shown in the worker log (`refused by the provider`)
   and confirm nothing was reported as delivered.
6. **Cleanup:** none needed for configuration; test businesses follow `staging-acceptance-handoff.md`.

Record each result in `docs/REKODA_LAUNCH_READINESS.md` (G-03, OD-41) with date and evidence. Approval,
configuration and a delivered message are three separate facts; record each.
