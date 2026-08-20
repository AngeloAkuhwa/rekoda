# Runbooks

Operational procedures live here. Each runbook is written to be executed by
a person under stress: numbered steps, exact commands, no prose detours.

Planned (populated as the systems they describe land):

| Runbook                                                             | Lands with |
| ------------------------------------------------------------------- | ---------- |
| `deploy.md` — zero-touch deploy + rollback                          | M0         |
| `backup-restore.md` — nightly dumps, B2 offsite, **restore drill**  | M0         |
| `incident.md` — triage, provider status pages, comms templates      | M2         |
| `meta-submission.md` — WhatsApp/app review, exact URLs per field    | M2         |
| `key-rotation.md` — provider keys, vault key, session secrets       | M2         |
| `erasure.md` — NDPA deletion requests end-to-end                    | M3         |
| `integrate-onboarding.md` — concierge WABA/catalogue/Paystack setup | M5         |

Rule: a backup that has not been restore-drilled does not count as a backup.
