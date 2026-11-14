# WhatsApp templates: the five slots and how to verify them (OD-41(b), OWN-93)

Rekoda sends five message types as Meta templates on its own number, because each can reach a phone
that has not written in the last 24 hours, where Meta rejects free-form text (131047). Nothing in
this repository creates, submits or approves a template, and nothing in it can see Meta's approval,
quality or active status. This runbook is the manual check of those facts and of the staging
configuration. It is performed by the owner or the staging operator, not by engineering.

**The environment is the single source of truth for every template name and language (OWN-93,
14 Nov 2026).** The repository defines each slot's _message contract_ (its variables, its parameters
in order, whether it is required); it does not know, default or compare the name of the template
created for it in WhatsApp Manager, and it assumes no language. Changing a template is a change to
`.env` and a recreate of the api and the worker, never a code change.

The authority for the slots in code is `apps/api/src/channels/template-slots.ts`. The read-only
check (`scripts/staging-readonly-check.sh`) and the staging deploy carry no copy of it: they run
`node dist/template-check.js` inside the container, which classifies that container's own settings
with the same table and validator the api boots with.

## 1. The five slots

All parameters are Meta `text` parameters. Dates are Lagos dates written `DD/MM/YYYY`. Days left is
a whole number written in digits.

| #   | Template variable         | Language variable                | Required | Sent by                                                               | Parameters, in order                                                                         |
| --- | ------------------------- | -------------------------------- | -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `META_OTP_TEMPLATE`       | `META_OTP_TEMPLATE_LOCALE`       | yes      | sign-in (`auth/auth.service.ts`)                                      | body `{{1}}` the code; URL button index 0 (copy code), one parameter: the same code          |
| 2   | `META_BILLING_TEMPLATE`   | `META_BILLING_TEMPLATE_LOCALE`   | yes      | grace sweep after a failed renewal (`billing/grace-sweep.ts`)         | body `{{1}}` days of grace left, `{{2}}` the date grace ends, `{{3}}` the billing link       |
| 3   | `META_RETENTION_TEMPLATE` | `META_RETENTION_TEMPLATE_LOCALE` | no       | retention sweep (`privacy/retention-sweep.ts`)                        | body `{{1}}` days until deletion, `{{2}}` the deletion date                                  |
| 4   | `META_DOCUMENT_TEMPLATE`  | `META_DOCUMENT_TEMPLATE_LOCALE`  | yes      | document delivery outside 24 h (`jobs/deliver-document.handler.ts`)   | body `{{1}}` what it is (`receipt`, `invoice`, `quote` or `document`), `{{2}}` its reference |
| 5   | `META_TRIAL_TEMPLATE`     | `META_TRIAL_TEMPLATE_LOCALE`     | yes      | trial sweep at 7, 2 and 1 days left (`billing/trial-notice-sweep.ts`) | body `{{1}}` days of trial left, `{{2}}` the date the trial ends, `{{3}}` the billing link   |

- **Name and language, together.** Set each template variable to the exact name WhatsApp Manager
  shows, and its language variable to the exact language code shown for that template (for example
  `en` or `en_US`). Meta matches a template by name **and** language. There is no default language:
  a template set without its language refuses to boot, naming the variable only. So does a name
  that is not lowercase letters, digits and underscores, or a language that is not a Meta code. A
  language set for an unset template is unused and only reported.
- **Category.** The send API takes no category and the code checks none, so any approved template
  with the contract above is sent as configured. The code's cost record prices slot 1 at the
  authentication rate and slots 2 to 5 at the utility rate; a template of another category (for
  example marketing) is still sent, but the provider-cost estimate then understates Meta's invoice.
  Meta's own rules for the category (for example marketing opt-outs and per-user limits) apply.
- **Billing link** (`{{3}}` of slots 2 and 5): `<REKODA_WEB_URL>/app/billing`. Each environment's
  own `REKODA_WEB_URL` decides it. In production, setting slot 2 or 5 without an https
  `REKODA_WEB_URL` refuses to boot; elsewhere those notices are refused as not sent.
- **Required versus optional:** an unset required slot reads `ATTENTION` in the read-only check; the
  retention slot is optional because, unset, the retention sweep warns nobody and so deletes nobody.
  This is an engineering classification recorded in the PR A plan; changing it is one line in
  `template-slots.ts`.
- **No free-form fallback:** with a slot unset (or no billing link for slots 2 and 5) the sender
  refuses that message as not sent. It never sends a text instead, and never a name or language of
  its own choosing.

## 2. Manual check in WhatsApp Manager (owner)

For each template you intend to configure, record what WhatsApp Manager shows. Do not tick a line
from memory or from an earlier inventory.

| Check                   | What to record                                                    | Expected                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Name                    | exact name                                                        | the value you will set in the slot's template variable                                                                   |
| Language                | exact language code                                               | the value you will set in the slot's language variable                                                                   |
| Category                | category                                                          | recorded (see §1, "Category")                                                                                            |
| Status                  | approval status (Approved, In review, Rejected, Paused, Disabled) | Approved. In review, Rejected, Paused or Disabled does not permit sending                                                |
| Quality                 | quality rating (High, Medium, Low, Pending)                       | recorded; Pending is not a refusal but is not evidence of good quality either                                            |
| Active                  | active or inactive                                                | active                                                                                                                   |
| Header, footer, buttons | each component as shown                                           | slot 1: copy-code button; slots 2 to 5: no header or button variables (a static footer is fine)                          |
| Body                    | the body text with its variables                                  | exactly the variables in §1, in that order, no more and no fewer                                                         |
| Parameter meaning       | what each `{{n}}` says in the body                                | matches §1 (for slots 2 and 5, `{{3}}` is where the billing link goes)                                                   |
| Contract match          | yes / no: does §1 match what you recorded?                        | yes. If not, stop and tell engineering before setting the variable: a mismatch is refused by Meta (132000) on every send |

Creation, "In review" and "Active, quality pending" are not approval for sending. Record the status
you actually see on the day.

## 3. Staging configuration (owner, on the Hetzner host's `.env`)

Engineering does not read or edit the host. The values go in the staging host's `.env` only, never
in `docker-compose.prod.yml` (shared with production) and never in the repository. The api and
worker both load `.env` (`env_file: .env`), so one line configures both. After editing, and
**before** recreating anything, check the edited `.env` against the running release's own rules:

```
dc run --rm -T --no-deps api node dist/template-check.js
```

It prints each slot's state (never a value) and must end `RESULT BOOTS`. `RESULT REFUSED` names the
variable to fix on stderr; recreating with it would take the api and worker down. Then recreate both
(`dc up -d --wait --force-recreate api worker`).

```
META_OTP_TEMPLATE=<approved name, as WhatsApp Manager shows it>
META_OTP_TEMPLATE_LOCALE=<its language code>
META_BILLING_TEMPLATE=<approved name>
META_BILLING_TEMPLATE_LOCALE=<its language code>
META_RETENTION_TEMPLATE=<approved name, or leave both lines empty: optional>
META_RETENTION_TEMPLATE_LOCALE=<its language code>
META_DOCUMENT_TEMPLATE=<approved name>
META_DOCUMENT_TEMPLATE_LOCALE=<its language code>
META_TRIAL_TEMPLATE=<approved name>
META_TRIAL_TEMPLATE_LOCALE=<its language code>
REKODA_WEB_URL=<the dashboard origin of this environment>
```

Set a slot only once its template is Approved (OWN-61): the code sends through whatever name is set.

**Before the first deploy of the release that carries OWN-93 (PR #432):** that release refuses to
boot when a template is set without its language. Earlier releases sent `en` when a `_LOCALE` was
unset, so an older `.env` may have a template line with no language line. Add the language of every
configured template first. The staging deploy checks this in the new image before it stops anything
and refuses with the variable's name if one is missing (nothing live changes).

**Switching a slot to a new template (for example a new trial template):**

1. Leave the slot on its current approved template while the new one is In review. Never point a
   slot at a template that is not Approved.
2. When WhatsApp Manager shows the new template Approved and active, record §2 for it.
3. Set the slot's template variable to the new name and its language variable to the new template's
   language, together, in `.env`.
4. Run the `template-check.js` command above (it must end `RESULT BOOTS`), recreate the api and
   the worker, then run §4. The template variable must read `SET` in both, and
   `Meta template settings, api and worker` must read `SAME`.
5. Keep the old template in WhatsApp Manager until §5 has a delivered message through the new one.

## 4. Read-only check (operator)

```
ssh <deploy-user>@<host> 'EXPECT_SHA=<deployed sha> EXPECT_WEB_URL=<dashboard origin> bash -s' < scripts/staging-readonly-check.sh
```

Under `== Meta template slots in the running api and worker`, for both `(api)` and `(worker)`:

- each configured `META_*_TEMPLATE` reads `SET (approval is checked in WhatsApp Manager)`;
- each of their `..._LOCALE` lines reads `SET (confirm it is the template's language in WhatsApp
Manager)`; `UNSET (required with ...)` or `SET but not a Meta ...` is ATTENTION and means a process
  started now would refuse to boot;
- `Meta template settings, api and worker` reads `SAME`: both processes send through the same
  templates (compared by digest; no value is printed);
- `billing link in templates` reads `EXPECT_WEB_URL/app/billing`;
- `META_RETENTION_TEMPLATE` may read `UNSET (optional; information only)` without blocking
  `RESULT: OK`.

No template name or language is printed. A container running a release older than PR #432 has no
template report and reads `unknown`, never a pass. The check reads configuration only. Its
`RESULT: OK` says nothing about Meta approval; §2 does.

## 5. Behaviour checks on staging (owner, manual acceptance)

Engineering has covered these with automated tests (supporting evidence only). The staging
observation is the acceptance evidence.

1. **Trial reminders 7, 2 and 1 days before expiry.** A designated test business whose trial
   reaches 7, then 2, then 1 days left receives exactly one message per stage, through the template
   configured in `META_TRIAL_TEMPLATE`, showing the days left, the trial end date and the link
   `<REKODA_WEB_URL>/app/billing`. Capture: each message on the tester phone (screenshot), its time,
   and the business's trial end date. No message at or after expiry.
2. **Grace reminder.** A test business in grace receives the template configured in
   `META_BILLING_TEMPLATE` with days left, the grace end date and the same billing link. Capture the
   message and the business's grace dates.
3. **Billing link.** Tapping the link in both messages opens the staging billing page. Capture the
   page URL as the phone shows it.
4. **Document ready, sign-in code, retention warning.** Where the journeys reach them, capture one
   delivered message of each, with the template name visible in the WhatsApp Manager message log.
5. **A controlled send:** only to tester phones you control. If Meta refuses a send (for example a
   template not yet approved), capture the refusal shown in the worker log (`refused by the
provider`) and confirm nothing was reported as delivered.
6. **Cleanup:** none needed for configuration; test businesses follow `staging-acceptance-handoff.md`.

Record each result in `docs/REKODA_LAUNCH_READINESS.md` (G-03, OD-41) with date and evidence.
Approval, configuration and a delivered message are three separate facts; record each.
