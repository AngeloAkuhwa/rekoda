# PR #432 final engineering verification (19 Nov 2026)

Status: **CODE COMPLETE, PR OPEN, NOT MERGED, NOT DEPLOYED. STAGING ACCEPTANCE PENDING. P12 NOT APPROVED. Deployment
approval NOT GIVEN. Paid production NOT APPROVED.**

Owner instruction of 19 Nov 2026, "Rekoda PR #432: Final Engineering Verification and Merge Closeout". Head reviewed:
`198d37a8d35db1573234c3d8e19fc78bb57f1d3b`; merge base `58e6834e4e92efa702756594135f9aa125298cec`. Every finding below
was checked against source before it was accepted or fixed. Nothing here is an owner ruling unless it names one.

## 1. Coverage

Eight independent read-only reviewers, none of which wrote the code, one per risk domain. Each manifest in this folder
lists every file of its batch with its findings.

| Manifest                              | Batch                                                                     | Files   | B     | I     | M      |
| ------------------------------------- | ------------------------------------------------------------------------- | ------- | ----- | ----- | ------ |
| `manifest-A.md`                       | migrations 0193–0220, journal, schema                                     | 30      | 0     | 1     | 3      |
| `manifest-B.md`                       | migrations 0221–0245                                                      | 25      | 0     | 1     | 2      |
| `manifest-C.md`                       | `apps/api/src/billing`, `packages/core`, `packages/contracts`             | 55      | 0     | 0     | 5      |
| `manifest-D.md`                       | `packages/db` outside migrations                                          | 104     | 0     | 0     | 7      |
| `manifest-E1.md`                      | `apps/api/src/{channels,jobs,health}`                                     | 75      | 0     | 0     | 5      |
| `manifest-E2.md`                      | the rest of `apps/api`                                                    | 73      | 0     | 0     | 8      |
| `manifest-F.md`                       | scripts, deploy, CI, compose, web, docs                                   | 98      | 0     | 0     | 9      |
| `manifest-findings-reconciliation.md` | every earlier finding (R01–R18, rounds A–G, 47 threads, Qodo, CodeRabbit) | —       | —     | —     | —      |
| **Total**                             |                                                                           | **460** | **0** | **2** | **39** |

All 460 changed files against the merge base appear in a manifest (checked path by path). All 53 new migrations were
read in full (batches A and B).

## 2. The Playwright failure on `198d37a` (run 44422614518)

`[mobile] e2e/billing.spec.ts:88`: the onboarding helper stayed on `/start` for 5 s instead of reaching `/verify`
(91 passed, 1 failed).

**Root cause: not determined from the evidence available, and stated as such.** The trace and error-context artifact
could not be fetched: the session's egress proxy refuses the artifact store (`*.blob.core.windows.net`). What was ruled
out, with evidence:

| Candidate                               | Ruled out by                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone collision, cross-test data        | `0817…` is used by `billing.spec.ts` alone; desktop takes a separate block; RUN is per worker                                                                                                                 |
| Invalid number, OTP lockout, rate limit | a fresh 11-digit number; lockout needs 5 failures or 5 codes for that number; the per-IP limit is 2000/min in the suite                                                                                       |
| A server error                          | the job log has no `[WebServer]` line; a server action that throws (API 5xx, schema parse) logs to stderr, which Playwright prints                                                                            |
| A click before hydration                | a JavaScript-disabled submit of `/start` posts the form and lands on `/verify` (probe run locally)                                                                                                            |
| A regression of this PR                 | the OTP request path (`auth.service.requestOtp`, `identity.withPhoneLock`, the web `requestCode` action, `call()`) is unchanged since `58e6834`; the PR's identity change is the trial stamp, after `/verify` |
| Pool exhaustion                         | the suite's API runs without the worker, so its pool is 10, as on `main`                                                                                                                                      |
| Advisory-lock contention                | the phone lock uses a 64-bit `hashtextextended` key                                                                                                                                                           |
| Precedent                               | no earlier CI run of the suite failed this way (9 failed runs surveyed: build, Chromium download or other jobs)                                                                                               |

Reproduction attempts, all green: the full suite once (92/92); `billing.spec` and `bank.spec` repeated 15 times on 6
workers (210/210); the full suite six times pinned to two CPU cores with two workers, as on the CI runner (552/552).

What remains consistent with the evidence is a call from the web tier to the API that failed in transport (the
merchant sees "We could not reach Rekoda just now" and the URL stays `/start`), or a stall over 5 s on the shared
two-core runner. The web tier swallowed transport failures without a log line, which is why the run could not tell the
two apart. **Correction:** `call()` and the photo upload now log one line naming the path (without its query) and the
transport's error code, never the body (`apps/web/src/server/api-unavailable.test.ts`, RED then GREEN). No assertion,
timeout or retry was changed, and the test was not skipped. If it recurs, the job log names the cause.

## 3. Findings fixed in this round (RED, then GREEN)

| ID    | Severity  | Defect                                                                                                                                                                                                                                 | Fix                                                                                                                                                                                                        | Regression test                                                                                                                              |
| ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1   | IMPORTANT | A pack credited before 0193 (main wrote the bonus directly; `units_credited_at` NULL) was refunded with no units revoked, in full or in part, skipping the seven-day and unused rules, against 0230's header and OD-55                 | **Migration 0246**: the refund refuses a paid pack with no recorded credit that was not set aside, with 0230's wording; a set-aside duplicate stays refundable. Smoke md5 pin and ledger (46 tags) updated | `upgrade-from-main`: "refuses to refund a pack main credited…" (at 0245: refunded); smoke tampers "refund back at 0244", "0246 not recorded" |
| A-I1  | IMPORTANT | The retention sweep stamped each notice claim with its pass start; 0210's guard refuses a stamp older than a minute, so a pass over a minute long failed after the notice was sent and billed, re-sent it every pass and skipped erase | `claimRetentionNotice` stamps `clock_timestamp()`; the pass start stays the eligibility cutoff; `when` is now fixture-only                                                                                 | `retention-sweep`: "claims a delivered notice even when the pass started more than a minute ago" (at `198d37a`: 42501)                       |
| C-1   | MINOR     | Stale plan name: an old `?done=processing` address said "You are on {plan} now" after a later plan change                                                                                                                              | the overview reports `applied` only while that plan is the current plan                                                                                                                                    | `no-charge-upgrade-status`: "stops saying the upgrade is on once a later change has moved the plan"                                          |
| C-3   | MINOR     | A fully refunded set-aside payment still said "our team is reviewing this second payment"                                                                                                                                              | a full refund is read as the review's outcome; a part refund keeps the pending wording                                                                                                                     | `payment-record-copy`: "a fully refunded payment never says it is still being reviewed"                                                      |
| E2-M1 | MINOR     | `MONO_BASE_URL` / `PAYSTACK_BASE_URL` refusal said "must not be set in production … Remove it", while production accepts blank or exactly the canonical host (and staging keeps the Mono value, OWN-96)                                | the message says "must be blank or exactly <host> in production"; behaviour unchanged                                                                                                                      | `production.test.ts`, `settlement/config.test.ts`, `deploy-smoke.sh` expectations                                                            |
| F-1   | MINOR     | `scripts/job-payload-reads.test.mjs` never ran in CI (also Qodo #34)                                                                                                                                                                   | added to the "Architectural boundaries" step                                                                                                                                                               | the CI step itself                                                                                                                           |
| P-1   | MINOR     | Transport failures from the web tier to the API left no log line (§2)                                                                                                                                                                  | one redacted log line                                                                                                                                                                                      | `api-unavailable.test.ts`                                                                                                                    |

Merchant-facing questions from the owner's item 3: stale plan names, **confirmed narrowly and fixed (C-1)**; the
`paid_twice` wording assuming a top-up, **not a defect**: `duplicate_purchase` is written only by the pack branch of
`applySettledCharge`, and a duplicate plan payment is `plan_changed`; the Mono error text, **confirmed and fixed (E2-M1)**.

## 4. Remaining MINOR findings (not fixed; none affects financial truth, privacy, authorisation, billing state or a launch gate)

Recorded in full in the manifests. In short:

- **Copy:** C-2 (a payment link retired by the system reads "You chose something else").
- **Contract and tests:**
  - C-4: contract comment placement.
  - C-5, D-4: bare `rejects.toThrow()` on privilege refusals.
  - D-2: the retention "nothing left" scan, as at the base.
  - D-6: test period from the host clock.
  - E1-2: the G-57 test name overstates; its invariant still holds, after 0222.
  - E2-M7: the pool probe counts transactions only.
  - E2-M8: a stale test header.
- **Defence in depth, reachable only with a stolen credential or a future catalogue:**
  - A-M1: `subscription_expire_plan` timing.
  - B-2: settlement and `plan_version_id`, once plans have two versions.
  - B-3: settlement claim and defer.
  - D-1: the boot check uses `USAGE` rather than `MEMBER`.
  - D-3: the fixture writer disables the 0206 guard in suites.
- **Operational:**
  - D-5: a lock-order deadlock between reclaim and an overrunning handler. PostgreSQL detects it, and either outcome is safe.
  - D-7: the pack credit's month across a host/database clock split; it retries.
  - E1-1: `/v1/ops/health` alert input.
  - E1-3: development-only lane fall-through.
  - E1-4: `gate_closed` renewals are not re-queued; the merchant can pay from the billing page.
  - E1-5: a millisecond check-then-act gap in exception resolution.
  - E2-M5: the operator `/health` does not probe the database.
  - E2-M6: a malformed refund business id returns 500, not 400; nothing is written.
  - F-8: the audience check compares raw `.env` text.
  - F-9: an exported principal URL in local Playwright.
- **Docs:**
  - A-M2: schema file columns.
  - A-M3: backfill length.
  - E2-M2, E2-M3, E2-M4: stale comments, and 91 versus 93 connections.
  - F-2: stale open statuses for F-2, E-F4 and E-F5 in the readiness document and audit README.
  - F-4: rollback does not re-apply 0109's TEMPORARY revokes.
  - F-5: deploy.md backup wording.
  - F-7: a name collision in one journey spec, once in 900 runs; it makes the test flaky, never falsely green.

**Fixed as documentation in this round:** F-3 (CLAUDE.md migration range) and F-6 (services stopped by hand are restarted if a run is rejected).

## 5. Earlier findings and external reviewers

`manifest-findings-reconciliation.md`: about 150 findings. Every code fix holds at `198d37a`: the fixing commits are
in history and the named tests exist and assert their rules. 47 threads, 0 unresolved, no comment after the last
resolution.

Not supported, and now dispositioned:

- **CodeRabbit:** its review skipped itself (file limit), which is **not a review**. Its last real review is of an
  early head. Its pre-merge checks did run on `198d37a` and report 3 errors and 1 warning:
  - **"Financial changes name invariant and test":** valid. The PR description's table now names the invariant and
    tests for OD-40, OWN-70, OD-37 and OWN-73/76, as well as rounds F, G and this round.
  - **"CI and deployment stay safe":** the flagged literals are placeholder passwords in test fixtures. gitleaks passes
    on the full history, and `.gitleaksignore` entries are commit-pinned. Not a defect.
  - **"Security boundaries hold":** the five worker-only cross-tenant functions (0194, 0198, 0199) are the class ADR
    0035 Amendment 2 records (OWN-85). The check's "owner question" is a bot's question, not an open owner decision.
  - **"Test coverage is not quietly reduced":** removed test titles are mapped in `final-review-e-closeout.md` §3. The
    PR description now points there instead of saying none was removed.
- **Qodo:** the live comment was renumbered after `final-closeout-g.md` §2 was written, so its dispositions are by
  content, not by number. #34 is fixed in this round (F-1). Items #7, #8, #28 and #43, about the PR wording, are met by
  the updated description.

## 6. Owner decisions reconciled

- OWN-95 and OWN-96 are unchanged: Amendment 6 is accepted for isolated test-mode staging only, with no Hetzner
  snapshot, 4 GB and 2 GB swap, and G-126 to G-133 as separate workstreams.
- OWN-97 (19 Nov 2026) records the owner's P7 and configuration evidence.
- No business rule was changed. 0246 enforces what 0230's header and OD-55 already said. The base-URL message change
  states the existing rule.
- Approval for isolated test-mode staging is not approval for paid production.

## 7. Verification on the final candidate

In progress when this file was first committed. The unsharded db and api integration suites, the three Playwright
configurations and CI on the final head are recorded here, from their actual output, once they complete.
