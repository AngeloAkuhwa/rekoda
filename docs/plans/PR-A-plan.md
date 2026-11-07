# PR A (revision 4, as implemented): WhatsApp templates, Reply-To, billing-email erasure, OD-38 docs

Base: `main` `a43675c` (PR #428). Branch: `angelo/magical-bell-1djjc3`. Status: **CODE COMPLETE, PR OPEN, not merged, not deployed.** PR B starts only after PR A merges.

Owner baseline: the 7 Nov 2026 PR A/PR B brief (recorded as OWN-78 to OWN-82). It supersedes revision 3 of this plan where they differ.

## Staging state at the start (verified from GitHub, 7 Nov 2026)

PR #428 merged as `a43675c`; Deploy staging run #183 succeeded: migration 0190 applied, api, worker, web and edge-check recreated and healthy, `/health` `staging-a43675c`. **Staging acceptance: PENDING** (the owner runs it manually). Deferred #428 threads: two on `jobs.ts` (OWN-76, PR B), one on `staging-readonly-check.sh` (OD-41, resolved by this PR once its CI is green).

## Scope as built

| Item     | Ruling            | What changed                                                                                                                                                                                                                                                                                                                                                                                                                  | Tests                                                                                                                                                                       |
| -------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OD-41(b) | OWN-80            | `apps/api/src/channels/template-slots.ts` (five slots, agreed names, required/optional, parameters); grace and trial templates carry `{{3}}` billing link from `REKODA_WEB_URL` (`meta.sender.ts`, `grace-sweep.ts`, `trial-notice-sweep.ts`, `jobs.module.ts`); boot validation in `config.ts`; `scripts/staging-readonly-check.sh` five-slot section for api and worker; runbook `docs/runbooks/meta-whatsapp-templates.md` | `template-slots.test.ts`, `meta.sender-templates.test.ts`, `config/templates.test.ts`, trial and grace sweep integration tests, `staging-readonly-check.templates.test.mjs` |
| OD-42(b) | OWN-81 (option B) | `REKODA_SUPPORT_EMAIL` in `config.ts` (one bare address; required when reminders are on); `reminder.service.ts` uses it as Reply-To                                                                                                                                                                                                                                                                                           | `config/support-email.test.ts`, `reminder-reply-to.integration.test.ts`, billing-email confirmation carries none                                                            |
| OD-39    | OWN-79            | Shared limit unchanged (already cross-business, locked, 5/h, 60 s). `POST /v1/ops/privacy/email-erasure` (`ops:privacy`), `apps/api/src/privacy/email-erasure.{controller,service}.ts`, repo functions in `subscriptions.ts`, contract `opsEmailErasureRequest`, migration **0191** (function + receipt table)                                                                                                                | `email-erasure.integration.test.ts`; existing `billing-email-address-limit.integration.test.ts` pins the shared limit                                                       |
| OD-38    | OWN-78            | Documentation only (owner decisions, readiness, roadmap)                                                                                                                                                                                                                                                                                                                                                                      | no code                                                                                                                                                                     |
| OD-43    | OWN-82            | Excluded; one reminder per invoice unchanged                                                                                                                                                                                                                                                                                                                                                                                  | existing suites                                                                                                                                                             |

Migration 0192 was NOT needed: the shared limit already serialises on an advisory lock (0185) and its concurrency tests pass.

## Decisions taken by engineering inside the rulings (flagged for review)

1. Required versus optional template slots: OTP, billing, document and trial required; retention optional (unset retention means no warning and therefore no deletion).
2. Billing template `{{3}}` = billing link, mirroring the trial template, per the brief's "URL parameter". If Meta's `rekoda_billing_grace_notice` puts the link elsewhere (a button, or not at all), the parameter list in `template-slots.ts` and `meta.sender.ts` must change before that slot is set on staging; Meta refuses a mismatch (132000).
3. OD-42(b): the support address replaces the merchant's verified billing email as Reply-To (not only a fallback).
4. OD-39 erasure never searches other businesses: the operator names each business.

## Owner actions (not engineering)

- WhatsApp Manager check of all five templates, `docs/runbooks/meta-whatsapp-templates.md` §2.
- Staging `.env` (host only, never `docker-compose.prod.yml`): the template values in that runbook §3, `REKODA_WEB_URL=https://staging.myrekoda.com`, and `REKODA_SUPPORT_EMAIL` (the owner's support address) before `REKODA_CUSTOMER_REMINDERS=1` (boot refuses reminders without it). Recreate api and worker.
- Read-only check with `EXPECT_WEB_URL=https://staging.myrekoda.com`; staging behaviour checks in that runbook §5.

## Rollback

Revert the PR. Migration 0191 is additive (a table and a function nobody else calls); its rollback statements are in the file. Env additions are optional except `REKODA_SUPPORT_EMAIL` when reminders are on.
