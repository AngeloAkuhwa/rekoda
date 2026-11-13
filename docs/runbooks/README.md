# Runbooks

Operational procedures live here. Each runbook is written to be executed by
a person under stress: numbered steps, exact commands, no prose detours.

Planned (populated as the systems they describe land):

| Runbook                                                                                                                                    | Lands with                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `deploy.md` — zero-touch deploy + rollback                                                                                                 | M0 ✅                                                        |
| `backup-restore.md` — **restore drill** (automated in CI); nightly dumps + B2 offsite designed, enabled at deploy                          | M0 ✅ (drill automated, PR-107; production pipeline pending) |
| `incident.md` — triage off the §31 integrity probes, provider status                                                                       | S1 ✅ (PR-107)                                               |
| `privacy-security-incident.md` — breach response, NDPC decision points                                                                     | REM ✅ (PR-132)                                              |
| `key-rotation.md` — provider keys, vault key, session secrets                                                                              | S1 ✅ (PR-107)                                               |
| `data-erasure.md` — deletion requests end-to-end, three lanes                                                                              | REM ✅ (PR-132)                                              |
| `r0a-provenance.md` — run, review and approve the legacy provenance report                                                                 | R0A ✅ (PR-120), **gate OPEN**                               |
| `pr-quality-pipeline.md` — review signals, merge gate, CI-to-staging sequence, branch rules                                                | IN PROGRESS (#303)                                           |
| `meta-submission.md` — WhatsApp/app review, exact URLs per field                                                                           | M2 (owner, W0)                                               |
| `integrate-onboarding.md` — concierge WABA/catalogue/Paystack setup                                                                        | M5                                                           |
| `staging-acceptance-handoff.md` — post-deploy check, prerequisites and order for SUB-ACC and ACCEPT-01                                     | MVP (4 Nov 2026)                                             |
| `staging-test-business-tools.md` — staging-only date moves and one-shot send faults (G-119, OWN-77), with the owner's acceptance scenarios | PR B (#432, 8 Nov 2026); usable once merged and deployed     |
| `meta-whatsapp-templates.md` — the five template slots, manual Meta and staging verification                                               | PR A (OD-41(b), 7 Nov 2026)                                  |
| `billing-duplicate-payments.md` — a merchant paid Rekoda twice for one pack or charge: find, evidence, refund, record, tell                | PR B (#432, 13 Nov 2026); two steps await owner decisions    |

Rule: a backup that has not been restore-drilled does not count as a backup.

Status (10 September 2026): `meta-submission.md` and `integrate-onboarding.md`
are still unwritten; they are launch gaps G-03 and G-35 in
`../REKODA_LAUNCH_READINESS.md`. No production backup pipeline exists yet
(gap G-02); the restore drill in CI is real, the backup is not.
