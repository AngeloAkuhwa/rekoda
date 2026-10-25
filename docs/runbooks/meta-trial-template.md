# Meta template: trial reminder (G-109, OWN-56, OWN-61)

Rekoda sends this template at 7, 2 and 1 days before a trial ends. The sweep is inert until
`META_TRIAL_TEMPLATE` names an APPROVED template, so submitting it changes nothing until the name is set.

| Field                | Value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| Suggested name       | `rekoda_trial_ending`                                                            |
| Category             | UTILITY (an account notice about the recipient's own trial)                      |
| Language             | English (`en`); set `META_TRIAL_TEMPLATE_LOCALE` to the code you pick            |
| Variables (in order) | `{{1}}` days left (for example `7`), `{{2}}` end date (for example `9 Nov 2026`) |

Body (no marketing wording, no link, no price):

> Your Rekoda free trial ends in {{1}} days, on {{2}}. Your records stay safe. To keep recording new transactions, choose a plan on your Rekoda billing page.

Notes for submission:

1. Create it in WhatsApp Manager under the business account that owns the Rekoda number, category Utility.
2. Add sample values `7` and `9 Nov 2026` when Meta asks for examples.
3. Once approved, set `META_TRIAL_TEMPLATE=rekoda_trial_ending` (and the locale) in the staging env file and
   restart the worker. Until then nothing is claimed or sent.
4. "1 days" reads oddly on the last day; if Meta rejects a pluralised body, submit a second template for
   the 1-day stage. The code sends the same parameters either way, so this is a wording choice, not a code change.
5. Approval and a real send to a number you control are separate steps; record each in the readiness register.
