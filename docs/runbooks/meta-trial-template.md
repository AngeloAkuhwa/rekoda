# Meta template: trial reminder (G-109, OWN-56, OWN-61)

Rekoda sends this template 7 days, 2 days and 1 day before a trial ends. The sweep is inert while
`META_TRIAL_TEMPLATE` is unset. The code does not check Meta's approval status: it sends through whatever
name is set, so setting the name before Meta approves it is an operator error (OWN-56, OWN-61). Set it only after approval.

| Field                | Value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| Suggested name       | `rekoda_trial_ending`                                                            |
| Category             | UTILITY (an account notice about the recipient's own trial)                      |
| Language             | English (`en`); set `META_TRIAL_TEMPLATE_LOCALE` to the code you pick            |
| Variables (in order) | `{{1}}` days left (for example `7`), `{{2}}` end date (for example `9 Nov 2026`) |

Body (no marketing wording, no link, no price):

> Your Rekoda free trial ends on {{2}}. Days left: {{1}}. Your records stay safe. To keep recording new transactions, choose a plan on your Rekoda billing page.

Notes for submission:

1. Create it in WhatsApp Manager under the business account that owns the Rekoda number, category Utility.
2. Add sample values `7` and `9 Nov 2026` when Meta asks for examples.
3. Once approved, set `META_TRIAL_TEMPLATE=rekoda_trial_ending` (and the locale) in the staging env file and
   restart the worker. Until then nothing is claimed or sent.
4. The body is worded so `{{1}}` reads correctly for 7, 2 and 1 ("Days left: 1"); one template serves all three
   stages, and the code has no per-stage template selector.
5. Approval and a real send to a number you control are separate steps; record each in the readiness register.
