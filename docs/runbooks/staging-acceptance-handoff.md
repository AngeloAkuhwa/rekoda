# Staging acceptance handoff (operator)

> **Status:** RUNBOOK, 4 Nov 2026. It sets the order in which staging is verified and accepted for
> the MVP. It records no result: nothing here is STAGING ACCEPTED until the result tables named below
> hold dated evidence. Sources:
>
> - `REKODA_MVP_DELIVERY_LEDGER.md` (the 4 Nov current-state block);
> - `REKODA_LAUNCH_READINESS.md`;
> - `runbooks/billing-staging-walkthrough.md`;
> - `REKODA_MVP_DELIVERY_PLAN.md` §A5;
> - `scripts/staging-readonly-check.sh`.

Staging only: TEST Paystack keys, a Meta test number, and phones and inboxes the tester controls.
Never use a real card or real money, never message a real customer, and never touch production.

## 0. Before you start

- **Who runs this.** A person with SSH access to the staging host as the deploy user, and a local
  checkout of this repository. The Claude engineering sessions have no access to the staging host,
  so they cannot verify any of it themselves. Everything in §1 to §4 is operator evidence.
- **Never share the environment file.** Do not paste `.env`, run `cat .env`, or copy a key, token,
  password or connection string into chat, a PR or a document. The check below reads what it needs
  and prints presence or a classification only.
- **Read-only.** The check runs no migration, writes nothing to the database or `.env`, restarts
  nothing, and sends no message, email or payment.

## 1. After Deploy staging run 41890201057 (`b8baf24`)

That run finished green: its "Staging answers with this commit" step got status ok, database up,
commit `b8baf24` and release `staging-b8baf24` from `/health`. Four things are still unverified, and an
operator must check each:

| Check                                                                                                                                                                                      | Why                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| The host checkout is `b8baf24…` with 0 tracked modifications                                                                                                                               | The deploy ran from this checkout                                        |
| The api and worker run the same image, `rekoda-app:staging-b8baf24`; the web runs `rekoda-web:staging-b8baf24`                                                                             | A stale worker applies payments and sends reminders with old code        |
| The applied migrations are exactly the 190 in the journal, 0000 to 0189                                                                                                                    | The deploy refuses fewer migrations, but nothing has read the list since |
| postgres, api, worker, web and caddy are running (and healthy where they have a healthcheck); migrate and edge-check did not exit with an error; no error-level log lines; the web answers | `/health` covers the api only                                            |

If `main` has moved on and a newer deploy is green, use that commit instead of `b8baf24`.

## 2. The read-only check

Run it from a checkout that contains the extended script: `main` once PR #428 has merged, or that PR's branch until then.
The copy at `b8baf24` lacks the 0187–0189, migration-ledger, image-parity, served-commit and
customer-reminders checks.

```bash
ssh <deploy-user>@<staging-host> 'EXPECT_SHA=b8baf24 bash -s' < scripts/staging-readonly-check.sh
```

`EXPECT_SHA` takes 7 to 40 hexadecimal characters.

What the script does and does not do:

- It changes nothing.
- It prints presence or a classification, never a key, token, password or connection string.
- Every database query runs in a read-only session.
- It ends with an `== attention` list: everything that is not as expected, or could not be checked.
  A check it could not make reads `unknown`; it never passes silently.

### The verdict

The last line is `RESULT: OK` (exit status 0) only when the `== attention` list is empty. Anything
else is `RESULT: ATTENTION (n item(s) above need a look)` with exit status 1. A migration line passes
only as `APPLIED`:

- `MISSING`: not applied (neither its objects nor its ledger tag);
- `INCOMPLETE`: its objects exist but the tag was never recorded;
- `INCONSISTENT`: the tag is recorded but its objects are missing (for example, a constraint
  dropped by hand);
- `unknown`: the check could not run.

The ledger lines compare tags only. A migration without its own object check (only 0171–0175, 0181–0183, 0185–0189 have one) whose objects were removed by
hand would still count as applied there, so a `degraded` `/health` is worth reporting even when
`not applied` reads `none`.

### If the commit does not match

Do not redeploy by hand and do not edit the checkout:

1. Open the repository's Actions tab and find the newest green **Deploy staging** run.
2. If the host's commit is that run's commit, re-run the check with that `EXPECT_SHA`.
3. Otherwise (the host is ahead of or behind every green deploy, or a deploy failed), send the owner
   the check output and the run links. Recovery is the owner's call, through `runbooks/deploy.md`.

### What to share

Paste the whole output into the owner's channel, with the time it was run and the commit of the script
used (`git rev-parse HEAD` in your checkout).

The script prints:

- the `/health` JSON;
- image tags;
- the release label;
- the values of `REKODA_WEB_URL`, `REKODA_ANNUAL_BILLING` and `REKODA_EMAIL_PROVIDER`;
- service states and log-line counts (never log text);
- migration tags;
- disk and memory figures.

None of these is secret. If any line shows something that looks like a key, a token, or a URL with
a user or password in it, remove it before sharing and report it as a defect in the script.

### How to read it

| Line                                                     | Expected for acceptance                                                                                      | If not                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout matches EXPECT_SHA`                            | `yes`                                                                                                        | The host is not at that commit: see "If the commit does not match" above                                                                                                                                      |
| `api and worker image`                                   | `SAME`                                                                                                       | Stop: a worker on another image is a deploy defect                                                                                                                                                            |
| `api image is the .env release`                          | `yes`                                                                                                        | As above                                                                                                                                                                                                      |
| `web image is the .env release`                          | `yes`                                                                                                        | As above                                                                                                                                                                                                      |
| `service postgres` … `service caddy`                     | `running` (and `healthy` where a healthcheck exists)                                                         | A service that is down, restarting or unhealthy: stop and tell the owner                                                                                                                                      |
| `job migrate`, `job edge-check`                          | `exited (0)` or `not present`                                                                                | `exited 1` (or another code): the migration or edge check failed; stop and tell the owner                                                                                                                     |
| `web status`                                             | a 2xx or 3xx code                                                                                            | The web tier is not answering: stop and tell the owner                                                                                                                                                        |
| `error-level lines in api` / `in worker`                 | `0`                                                                                                          | Ask the owner to read those log lines on the host (the check prints counts only). The `(info)` count also matches ordinary lines that mention a migration, so it is read by hand, not judged                  |
| `served commit matches EXPECT_SHA`                       | `yes`                                                                                                        | As above                                                                                                                                                                                                      |
| `served release is staging-<commit>`                     | `yes`                                                                                                        | As above                                                                                                                                                                                                      |
| `served status`, `served database`                       | `ok`, `up`                                                                                                   | `degraded` usually means a migration is missing; read the ledger lines below                                                                                                                                  |
| `0171` … `0189` lines                                    | every one `APPLIED`                                                                                          | `MISSING`, `INCOMPLETE` or `INCONSISTENT`: stop and tell the owner; do not run SQL by hand                                                                                                                    |
| `expected migrations` / `applied migrations`             | `190` / `190`                                                                                                | `not applied` names the missing tags; `applied but not in this checkout` names extras                                                                                                                         |
| `PAYSTACK_SECRET_KEY`                                    | `SET (TEST-KEY)`                                                                                             | Set an `sk_test_` key (owner); never a live key on staging                                                                                                                                                    |
| `REKODA_PAYSTACK_PLATFORM_CONFIRMED`                     | `UNSET` (OWN-70)                                                                                             | Unset it; a test key does not need it                                                                                                                                                                         |
| `WORKER_DATABASE_URL`                                    | `SET`                                                                                                        | The worker cannot claim jobs: payments are not applied and reminders are not sent. (`REKODA_WORKER` is set per service by the compose file, `0` on the api and `1` on the worker, so `.env` does not show it) |
| `REKODA_WEB_URL`                                         | `SET (https://staging.myrekoda.com)`                                                                         | Paystack cannot send the merchant back, and email links break                                                                                                                                                 |
| `REKODA_EMAIL_PROVIDER`, `RESEND_*`, `REKODA_EMAIL_FROM` | Resend set up, or the approved mock (owner's choice)                                                         | Billing-email steps cannot be walked                                                                                                                                                                          |
| `META_*_TEMPLATE`                                        | `SET` for every slot the journey uses (an unused slot reads `UNSET` under attention; that alone is expected) | That message is held, not sent. SET means configured, not approved by Meta: check approval in WhatsApp Manager                                                                                                |
| `REKODA_CUSTOMER_REMINDERS (api)` / `(worker)`           | `OFF` until §4 step 4, then `ON (1)` in both                                                                 | `INVALID` means the process refuses to boot with that value                                                                                                                                                   |

## 3. Staging prerequisites still outstanding (4 Nov 2026)

| Prerequisite                                                                                                   | Needed by                                   | Who          | Evidence                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| The read-only check output, with no unexpected attention lines                                                 | everything below                            | Operator     | The pasted output (§2)                                                  |
| Paystack TEST key and the test-mode webhook URL                                                                | walkthrough 6–12, 15, 18; A5 4, 5, 7, 8, 10 | Owner        | Check reads `SET (TEST-KEY)`; one test charge reaches Paid exactly once |
| `REKODA_PAYSTACK_PLATFORM_CONFIRMED` left UNSET                                                                | the same steps                              | Owner        | Check reads `UNSET`                                                     |
| `REKODA_ANNUAL_BILLING=1`                                                                                      | walkthrough 4, 14; A5 5                     | Owner        | Check reads `SET (1)`                                                   |
| Resend sending domain, or the approved mock                                                                    | walkthrough 7; A5 6, 11, 13                 | Owner        | One confirmation email delivered to an inbox the tester controls        |
| Meta test number, and a test phone that messaged it within 24 hours                                            | A5 3, 11, 13, 14, 16                        | Owner        | One delivered in-window message, with its message id                    |
| Template approval for each slot in use (`META_BILLING_TEMPLATE` for grace, `META_TRIAL_TEMPLATE` per OD-41(b)) | walkthrough 17, 19; A5 3, 9, 10             | Owner + Meta | Status APPROVED in WhatsApp Manager, with the name and locale recorded  |
| Payment instructions saved in Settings by the owner                                                            | A5 15                                       | Owner        | A reminder showing account, balance and invoice reference               |
| `REKODA_CUSTOMER_REMINDERS=1` on staging only, set at §4 step 4                                                | A5 11–17                                    | Owner        | Check reads `ON (1)` in api and worker                                  |

## 4. Order

1. **Verify the deploy (§1, §2).** Continue only when every `== attention` line is understood and none is
   a deploy or migration defect.
2. **Owner decisions** that the journeys need (§5).
3. **SUB-ACC.** Run `runbooks/billing-staging-walkthrough.md` steps 1–23 on desktop and mobile, and
   fill its §4 result table with the date, tester and notes for each step.
   - Steps 17 and 22 need an operator to move a test business's dates on staging. That is test data
     only, never a production row.
4. **Switch reminders on.** The owner sets `REKODA_CUSTOMER_REMINDERS=1` in staging's `.env` and recreates the
   api and worker so they read it (`runbooks/deploy.md`: `dc up -d --wait`). Then re-run the check:
   both containers must read `ON (1)`.
5. **ACCEPT-01.** Run the 17 A5 journeys (`REKODA_MVP_DELIVERY_PLAN.md` §A5). Journeys 1–10 reuse
   SUB-ACC's evidence where it covers them; 11–17 are the reminder journeys. Record for each:
   - environment;
   - deployed commit;
   - migration status (the check's ledger lines);
   - the case;
   - expected result;
   - actual result;
   - PASS or FAIL.
6. **Record the results** in the ledger rows SUB-ACC and ACCEPT-01. A journey is PASS only with that
   evidence. A green CI run or deploy is not a pass.

## 5. Owner decisions before the affected journeys

| Decision | Blocks                        | Recommended default, if the owner accepts it                          |
| -------- | ----------------------------- | --------------------------------------------------------------------- |
| OD-41(b) | A5 3 and 9 (trial messages)   | None: the owner must name the approved trial template and its locale  |
| OD-41(a) | A5 3                          | Keep the 7, 2 and 1-day reminders; no Day 0 or expiry message for MVP |
| OD-42(b) | A5 11 (email)                 | Reply-to is the verified billing email                                |
| OD-43    | A5 16                         | Keep the batch limits as built                                        |
| OD-40    | wording only (walkthrough 15) | A pack counts toward the month its payment settles                    |
| OD-39    | none                          | Keep OWN-66, with operator erase                                      |
| OD-38    | beta path, not staging        | Operator-set plans for a small named beta group                       |
| OD-37    | public launch, not staging    | A database trigger before public launch                               |

## 6. Staging blockers and production-only gates

**Staging blockers:**

- §2 output;
- §3 prerequisites;
- OD-41(b);
- SUB-ACC and ACCEPT-01 themselves.

**Production only.** None of these is needed for staging, and nothing in this runbook does them:

- G-05: a live Paystack key, the written §47 confirmation, `LIVE_MODE_ALLOWED = YES`, a controlled
  ₦100 live drill, and the OWN-70 renewal-hold ruling;
- G-06: live refund, reversal and dispute webhooks;
- G-03: the Nigerian production number, App Review and production template approval;
- OWN-65: real customer email, with authorisation and legal release;
- G-02: off-box backups and a restore drill;
- G-26: alert delivery;
- G-04: legal facts;
- G-47: tax and accounting sign-off;
- G-07: the live AI evaluation;
- G-09: branch protection;
- G-08: the production host and `.env`, and the owner's explicit production deploy instruction.
