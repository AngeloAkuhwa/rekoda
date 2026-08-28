# Runbooks

Operational procedures live here. Each runbook is written to be executed by
a person under stress: numbered steps, exact commands, no prose detours.

Planned (populated as the systems they describe land):

| Runbook                                                             | Lands with |
| ------------------------------------------------------------------- | ---------- |
| `deploy.md` — zero-touch deploy + rollback                          | M0 ✅      |
| `backup-restore.md` — nightly dumps, B2 offsite, **restore drill**  | M0 ✅ (drill automated, PR-107) |
| `incident.md` — triage off the §31 integrity probes, provider status | S1 ✅ (PR-107) |
| `key-rotation.md` — provider keys, vault key, session secrets       | S1 ✅ (PR-107) |
| `r0a-provenance.md` — run, review and approve the legacy provenance report | R0A ✅ (PR-120), **gate OPEN** |
| `meta-submission.md` — WhatsApp/app review, exact URLs per field    | M2 (owner, W0) |
| `erasure.md` — NDPA deletion requests end-to-end                    | M3         |
| `integrate-onboarding.md` — concierge WABA/catalogue/Paystack setup | M5         |

Rule: a backup that has not been restore-drilled does not count as a backup.
