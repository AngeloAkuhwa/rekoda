# PR A plan — templates, support reply-to, erasure/limit safeguards, reminders

Base: `main` at `a43675c` (PR #428 squash). Status: PLAN ONLY. Nothing here is implemented, merged or deployed.
Sequencing: PR A is built, reviewed and merged first. PR B does not start until PR A is merged.
Sources: `docs/REKODA_OWNER_DECISIONS.md`, `docs/REKODA_LAUNCH_READINESS.md` (OD-37..OD-43, G-03), and the code paths named below.

## 0. Read first: where the request and the repository disagree

The work-item names in the request do not all match what the repository records under the same OD number.
Implementation must not start on these items until the owner confirms the reading. Nothing below is guessed.

| Item | Request says | Repository records (`REKODA_LAUNCH_READINESS.md`) | Plan treatment |
|---|---|---|---|
| OD-41(b) | WhatsApp templates, explicit and validated | Which approved Meta template is the trial template (name, locale); `META_TRIAL_TEMPLATE` may have no approved template behind it | Matches. Built as requested. |
| OD-42(b) | Support Reply-To | Reminder-email reply-to is the merchant's verified billing email, omitted when none; options A/B/C open | Partly matches. See §2: the repo scope is reminder email, not "support email". Needs owner pick of A/B/C. |
| OD-39 | Email-address erasure safeguards | Per-address billing-email rate limit (OWN-66) can be exhausted by another business; asks whether one business gets a share | DOES NOT MATCH. Erasure exists separately (`EraseData`, `apps/api/src/privacy/retention-sweep.ts`). Owner must say which is meant. |
| OD-38 | Docs-only: no private beta, public signup unchanged | Asks whether a controlled private beta may run on operator-set plans; recommendation was YES | Opposite of the recorded recommendation. Docs-only is fine once the owner confirms the ruling; it must be recorded as an owner ruling and the recommendation text superseded. |
| OD-43 | Keep per-invoice reminders | Batch limits and cadence defaults (a)-(j); (f) is already "one reminder per invoice" | Matches item (f); the rest of OD-43 stays as engineering defaults. |

## 1. OD-41(b) WhatsApp templates

Existing code (inspected):
- `apps/api/src/config.ts` ~1465-1474 reads five slots, each with a locale defaulting to `en`: `META_OTP_TEMPLATE`, `META_BILLING_TEMPLATE`, `META_RETENTION_TEMPLATE`, `META_DOCUMENT_TEMPLATE`, `META_TRIAL_TEMPLATE` (+ `_LOCALE`).
- `config.ts` ~1293 is the only boot check: in production, `META_ACCESS_TOKEN` set without `META_OTP_TEMPLATE` is refused.
- `apps/api/src/channels/meta.sender.ts` throws `SendFailed('no <x> template configured ...')` per slot at send time (document ~114, trial ~148, retention ~185, billing ~222, OTP ~263). No free-form fallback was found in these paths; the plan's first task is to confirm that for every caller.
- `apps/api/src/billing/trial-notice-sweep.ts` does nothing when `META_TRIAL_TEMPLATE` is unset.
- `scripts/staging-readonly-check.sh` ~350 loops over the five slots; fixtures in `scripts/staging-readonly-check.fixtures.mjs`, tests `staging-readonly-check.test.mjs`.
- G-03 lists five slots; approval of each is NOT verified in the repository.

Open thread carried from #428: an unset slot currently yields `RESULT: ATTENTION`; the runbook says it "is expected". Decide which rule holds, then change script and runbook together.

Proposed change:
1. One authoritative slot table in code (e.g. `packages/core` or `apps/api/src/channels/template-slots.ts`): slot, env name, locale env name, `required` flag, flow(s) it serves, parameter count. Config, sender, trial sweep and the staging script read the same list (the script is bash; generate or assert equality in a test rather than duplicate silently).
2. Required vs optional per flow, derived from behaviour: OTP required in production (existing rule); others decided from the table, not assumed. Trial: required only if the trial notice is promised at launch (owner choice in OD-41(a)).
3. Validate at boot: name non-empty and matches Meta's template-name charset, locale non-empty and a plausible language code. Fail closed in production for required slots; warn for optional.
4. Sender keeps throwing `SendFailed` with the slot name when a required slot is missing; add a test that no path sends free text instead.
5. Staging script evaluates the same required list: optional unset = info, required unset = ATTENTION.

Tests: all required set; required missing; optional missing; malformed name; malformed locale; wrong parameter count; locale/component mapping per slot; send failure and retry with idempotent job (no duplicate); staging script complete and incomplete fixtures.

External dependency (do not invent): the approved template names and locales for each slot, and which one is the trial template. Record as owner/provider input.

## 2. OD-42(b) Reply-To

Existing code:
- `apps/api/src/email/email.port.ts`: `OutboundEmail.replyTo?` already exists; `resend.sender.ts:72` forwards it as `reply_to`.
- `apps/api/src/reminders/reminder.service.ts:664` `replyTo()` returns the merchant's verified billing email, null when unverified; set at ~561 for email only.
- Other email callers: `billing/billing-email.service.ts`, `replies/reply.service.ts`, `channels/stranger-sweep.ts`, `webhooks/delivery.sweep.ts`, `ai/interpreter.service.ts` (confirm which actually send mail).

Owner options on record: (A) keep verified billing email; (B) platform-configured reply address used when none verified or instead; (C) separate merchant reply-to.
Plan: implement the chosen option only. If B: new optional env (name to be added to `config.ts` and `.env.example`, validated as a single plain address, refused if malformed), applied only in `ReminderService.replyTo()` fallback, never accepted from request input. Sign-in, billing-confirmation and receipt mail unchanged. Tests assert the generated Resend request body for each mail kind (header present or absent), From unchanged, missing/invalid config. "Support email" as a separate flow does not exist in the code I inspected; if the owner means one, name it.

## 3. OD-39 (blocked on owner reading)

Reading 1, as recorded: per-address billing-email limit (OWN-66, ADR 0036; `billing-email.service.ts`, test `billing-email-address-limit.integration.test.ts`). Options are a per-business share of the hourly allowance or keep as is.
Reading 2, as requested: email-address erasure. Existing: `apps/api/src/commands/privacy-commands.ts` (`EraseData`), `apps/api/src/privacy/retention-sweep.ts`, `packages/db/src/repos/{retention,object-deletions,evidence-retention,email-suppressions}.ts`, `portability.ts`. An inventory of every email column (businesses/billing email, customers, users, suppression list, reminder rows, jobs payloads, vaulted event payloads, audit) is the first task; retention of invoices and ledger is fixed by invariant 6 and must not be deleted. Legal retention periods are not in my reading of the repo beyond the retention schedule; any gap goes to the owner as a decision, not a guess.
Do not start until confirmed.

## 4. OD-38 documentation only

Edit `REKODA_LAUNCH_READINESS.md` OD-38, `REKODA_OWNER_DECISIONS.md` (new OWN entry quoting the owner), HANDOFF, roadmap references to a private beta. No code. Check: grep for "private beta" claims in docs and `apps/web` copy; signup tests unchanged and green.

## 5. OD-43 per-invoice reminders

Existing: `apps/api/src/reminders/reminder.service.ts`, `reminder-batch.service.ts` (`REMINDER_BATCH_LIMITS`), `packages/db/src/repos/{reminders,reminder-batches}.ts`; advisory lock per (business, invoice, channel) and `reminder_in_flight`; balance re-read with `FOR SHARE`.
Plan: characterisation tests only unless a gap shows. Cases: three invoices, one customer, three reminders; one paid mid-batch skipped, others sent; duplicate job delivery gives one message (idempotency key); retry after provider refusal does not auto-resend (OD-43(e)); void/paid ineligible.

## 6. Cross-cutting
Migrations: expected none (OD-41/42/38/43); OD-39 either reading may need one; if so expand-only. Rollback: revert PR; env additions optional. Security: reply-to never from input; no template parameter carries secrets; erasure paths tenant-scoped via `withBusiness()`.
Done = focused tests, `pnpm turbo typecheck lint test build`, db then api integration suites serially if data/jobs touched, exact-head CI green, independent review, docs updated.
