# PR A plan (revision 2): WhatsApp template slots, reminder reply-to, per-invoice reminders, OD-38 docs

Base: `main` at `a43675c` (PR #428 squash). **Status: PLAN ONLY. Not implemented, no PR open.**
PR A is built, reviewed and merged before PR B starts. Revision 2 corrects revision 1 against the repository's decision records and your instructions of 7 Nov 2026.

## 0. Starting state (verified 7 Nov 2026)

- Deploy staging run #183 (`workflow_run` after CI run 2086 on `a43675c`): **success**, 09:10:35 to 09:20:34 UTC. It built `rekoda-app:staging-a43675c` and `rekoda-web:staging-a43675c`.
- Migration `0190_failed_inbound_and_failure_category` **applied** (log: "applied: 0190_..."), then the **application was also deployed**: api, worker, web and edge-check were recreated and reported healthy. Caddy and postgres were not recreated. `/health` answered `status ok, database up, migrations 191, release staging-a43675c`, and the workflow's own "Staging answers with this commit" step passed.
- So staging is NOT unchanged: it runs `a43675c`. That is deployment only. **Staging acceptance is a separate fact and remains PENDING** (nothing here records an acceptance run).
- Observation, not a finding: the staging containers are named `rekoda-prod-*`, i.e. the staging host uses the shared `docker-compose.prod.yml`.
- Deferred review threads on PR #428 (unresolved, kept deliberately, not to be closed before the fix is implemented and verified):

| Thread | File | Owner item | Assigned to |
|---|---|---|---|
| 1 | `packages/db/src/repos/jobs.ts` (Major, `billing.process` dead job) | OWN-76 | PR B |
| 2 | `packages/db/src/repos/jobs.ts` (Codex P2, same gap) | OWN-76 | PR B |
| 3 | `scripts/staging-readonly-check.sh` (unset Meta slot vs `RESULT: OK`) | OD-41 | PR A |

## 1. Work items: meaning, scope, decision status

| Item | Repository-recorded meaning | Proposed scope | Decision status |
|---|---|---|---|
| OD-41(b) | Which approved Meta template is the trial template (exact name, locale); code reads `META_TRIAL_TEMPLATE` but G-03's approved list (older wording) names four | Authoritative slot table, validation, staging check on the same list. No invented names. | **Scope confirmed (kept in PR A).** Needs your input on the trial slot (D4) and on Meta approvals (external). |
| OD-42(b) | Reply-to of the **reminder email** (not a support-email flow) | Implement the option you choose. Nothing if (A). | **OPEN: awaiting your selection (D2).** |
| OD-39 | Repo: per-address billing-email rate limit consumed by another business. Earlier brief: email-address erasure. | None until you say which. | **OPEN: awaiting confirmation (D1).** The two readings are not combined. |
| OD-38 | Repo: may a private beta run on operator-set plans (recommendation was yes) | **Your ruling, authoritative:** documentation only; no private-beta mechanism; public signup unchanged. Overrides the repository's earlier recommendation. | **RULED by you. Scope confirmed.** |
| OD-43 | Repo: reminder batch limits and cadence defaults (a)-(j); item (f) is "one reminder per invoice, no per-customer consolidation" | Retain item (f) only: characterisation tests plus docs that confirm it. Other defaults untouched. | **Scope confirmed for (f) only.** The rest of OD-43 stays an engineering default (still OPEN in the register; no change here). |

## 2. Decisions I need from you (PR A)

### D1 OD-39: which one?
- **Reading R (repository):** the per-address billing-email limit (OWN-66, 5 an hour per address across all businesses, 60 s spacing; `apps/api/src/billing/billing-email.service.ts`, ADR 0036, test `billing-email-address-limit.integration.test.ts`). One business typing someone else's address can use up that address's hourly allowance, delaying the real owner's confirmation by up to an hour; any business can also learn one bit (that someone asked for the address in the last hour). Question on record: should a single business be held to a share of an address's allowance?
  - Consequence of a per-business share: the abuse limit stays but one business can no longer starve another; needs a design for the share, a new counter keyed by (business, address), a migration probably, and the one-bit leak is reduced, not removed.
  - Consequence of keeping it: no change; documented as inherent.
- **Reading E (earlier brief):** erasure of an email address. Existing pieces are the `EraseData` command (`apps/api/src/commands/privacy-commands.ts`), `apps/api/src/privacy/retention-sweep.ts`, repos `retention.ts`, `object-deletions.ts`, `evidence-retention.ts`, `email-suppressions.ts`. It is not recorded as an OD item I can find; it would need a new owner decision with legal retention input (invoices and ledger are immutable, invariant 6).
- Please answer: **R, E, both as separate later items, or neither.** I will not start either until you do.

### D2 OD-42(b): reminder-email Reply-To (repository options)
Today (`apps/api/src/reminders/reminder.service.ts`, `replyTo()` ~line 664): reply-to is the merchant's verified billing email; if none is verified it is omitted and a reply goes to Rekoda's sending address. The port already supports `replyTo` (`apps/api/src/email/email.port.ts`, `resend.sender.ts` line 72).
- **A. Keep the verified billing email.** Benefit: the only merchant mailbox Rekoda has proven; replies reach the merchant. Risk: with no verified address replies go to Rekoda's sending address. Code change: none. This is the repository recommendation.
- **B. A platform-configured reply address** (an env value, as closed PR #407 proposed), used when the merchant has none verified, or instead of the merchant's. Benefit: replies never lost. Risk: customers' replies land with Rekoda rather than the merchant (a privacy and support burden); "instead of" removes the merchant's own reply path. Change: new validated env, fallback in `replyTo()`, tests on the generated Resend body.
- **C. A separate merchant reply-to address you confirm.** Benefit: merchant chooses. Risk: new field, verification flow, UI and migration; larger scope.
- No separate support-email workflow will be invented. Please pick **A, B (fallback only or instead), or C.**

### D3 OD-38: nothing to decide
Recorded as ruled (section 4).

### D4 OD-41(b): the trial template and the required list
Needs from you or Meta, not from code: the exact approved name and locale for each of the five slots (below), and which template is the trial one (G-03 lists approval as NOT verified in the repository). Also choose the verdict rule for the open thread: should an unset **optional** slot read as information (RESULT: OK) while an unset **required** slot is ATTENTION? Recommended: yes, with the trial slot required only if you want the 7/2/1-day trial reminders live at launch.

### D5 OD-43
Confirm that only item (f) is in PR A. (Other items (a)-(e), (g)-(j) remain open engineering defaults.)

## 3. Existing code per item

**OD-41(b)**
- Slots read in `apps/api/src/config.ts` (lines ~1465-1474), each with a locale defaulting to `en`:

| Slot (env) | Flow / sender method | Today's behaviour when unset | Required? |
|---|---|---|---|
| `META_OTP_TEMPLATE` | sign-in code, `sendAuthCode`, `auth/auth.service.ts:142` | `SendFailed`; in production with `META_ACCESS_TOKEN` set it refuses to boot (`config.ts` ~1293) | **Required** (existing rule) |
| `META_BILLING_TEMPLATE` | grace reminder, `sendBillingNotice` | `SendFailed` (definite non-delivery) | Not decided |
| `META_RETENTION_TEMPLATE` | retention warning, `sendRetentionNotice` | `SendFailed` | Not decided |
| `META_DOCUMENT_TEMPLATE` | "document ready" outside the window, `sendDocumentNotice` (`jobs/deliver-document.handler.ts:185`) | `SendFailed` | Not decided |
| `META_TRIAL_TEMPLATE` | trial reminders 7/2/1 days, `sendTrialNotice`; `billing/trial-notice-sweep.ts` does nothing when unset | silent no-op (claims nothing) | Depends on D4 |

  "Not decided" is deliberate: whether each is launch-required is a product call, not derivable from code. I will not mark any of them required except OTP without your answer.
- Senders: `apps/api/src/channels/meta.sender.ts` (no free-form fallback seen in the template paths; the plan's first task is to prove that for every caller by test).
- Staging check: `scripts/staging-readonly-check.sh` ~345-365 loops the five slots and calls `flag` (ATTENTION) for UNSET; fixtures `scripts/staging-readonly-check.fixtures.mjs`, tests `scripts/staging-readonly-check.test.mjs`; runbook `docs/runbooks/staging-acceptance-handoff.md` says an unset trial slot "is expected", which conflicts with `RESULT: OK` needing an empty attention list.
- Also relevant: G-03 and OD-41(a) (Day 0 and expiry messages have no slot; out of scope).

**OD-42(b):** files in D2. Other email callers to confirm unchanged: `billing/billing-email.service.ts`, `replies/reply.service.ts`, `channels/stranger-sweep.ts`, `webhooks/delivery.sweep.ts`.

**OD-43(f):** `apps/api/src/reminders/reminder.service.ts`, `reminder-batch.service.ts` (`REMINDER_BATCH_LIMITS`), `packages/db/src/repos/{reminders,reminder-batches}.ts`, `packages/contracts` (`REMINDER_BATCH_MAX`), tests `apps/api/src/reminders/*.integration.test.ts`. Existing behaviour: one reminder per invoice and channel; advisory lock per (business, invoice, channel); `reminder_in_flight` refusal; balance re-read `FOR SHARE`; no cooldown (OWN-67); refused/failed recipients not retried automatically; unknown outcome never resent (OWN-47).

**OD-38:** docs only: `REKODA_LAUNCH_READINESS.md` (OD-38 row, roadmap P0-8 references), `REKODA_OWNER_DECISIONS.md`, `HANDOFF.md`.

## 4. Implementation steps and tests (confirmed items only)

One item at a time, in this order.

**Step 1 OD-38 (docs).** Add an OWN entry quoting your ruling; mark OD-38 RULED; supersede the "yes, for a small named group" recommendation text; grep docs and `apps/web` for any text promising a private-beta mechanism and correct it; no code, no flags, no signup change. Check: existing signup tests unchanged and green; `git diff` shows no file outside `docs/`.

**Step 2 OD-43(f) (characterisation).** Tests, no production change unless one fails: three unpaid invoices for one customer give three reminders; one invoice paid before dispatch is skipped while the others send; duplicate job delivery produces one message; a refused recipient is not retried automatically; void/paid/cancelled invoices are ineligible. Docs: record the criteria under OD-43(f).

**Step 3 OD-41(b) (after D4).**
1. One authoritative slot table (slot, env names, flow, required flag) in code, consumed by `config.ts`, `meta.sender.ts`, `trial-notice-sweep.ts`.
2. Boot validation: required slots present and well-formed (template name charset, non-empty locale); production fails closed for required, warns for optional; the OTP rule is preserved.
3. A test that fails if any template flow can send free text instead.
4. Staging script and fixtures read the same list (a test asserts the bash list equals the code list); optional unset is info, required unset is ATTENTION; update the runbook line; only then resolve thread 3.
5. Tests: all set; required missing; optional missing; malformed name; malformed locale; parameter count per slot; send failure and retry without duplicate; staging output for complete and incomplete configuration.
The staging check is not described as complete until the required list is defined and validated.

**Step 4 OD-42(b) (after D2).** A: docs only. B or C: the change described in D2 with tests on the real Resend request body (reply-to present/absent/malformed, From unchanged, other mail unchanged).

**Step 5 OD-39 (after D1).** Not planned until answered.

## 5. Dependencies, migrations, rollback
- Migrations: none expected for Steps 1-3; Step 4 B none, C yes; Step 5 depends on the answer. Any migration is expand-only.
- External: approved Meta template names and locales and the trial-template decision (D4); Meta approval of each (G-03). Without them the work records a dependency, it does not invent values.
- Rollback: revert the PR; env additions are optional; documentation steps are reversible.

## 6. Explicit exclusions
No private-beta mechanism, flag or invitation logic (OD-38). No erasure work unless D1 says so. No support-email flow. No Day 0 or trial-ended messages or new slots (OD-41(a)). No reminder-cadence, cooldown, consolidation or batch-limit change (OD-43 other items, OWN-67). No payment, billing-job, renewal, plan-field or staging-tool work (all PR B). No dead-job work (OWN-73/76 are PR B).

## 7. Recommended order
OD-38 docs, then OD-43(f) tests, then OD-41(b), then OD-42(b), then OD-39 only if confirmed. Verify at each step (focused tests, then `pnpm turbo typecheck lint test build`, db then api integration suites serially if data touched), exact-head CI, independent review, docs updated.
