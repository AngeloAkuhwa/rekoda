# Staging test-business tools (G-119, OWN-77)

> **Staging only. Test businesses only. Never production.** These tools move a designated test
> business's dates and arm one-shot send faults so that the acceptance steps OWN-77 names can be run
> on staging without improvised SQL. They are not a general bypass: three dates, two faults. Automated
> tests are supporting evidence only. A step is accepted only on the staging observations recorded
> below (OWN-77; `REKODA_LAUNCH_READINESS.md` G-119).

Status: CODE COMPLETE in PR B (#432). Not usable until #432 is merged, deployed to staging, and the
two setup steps below are done. STAGING ACCEPTANCE PENDING.

## 1. What must all be true (fail-closed)

Every route refuses and writes nothing unless **every** item holds. The database repeats checks 3 and
4 inside its own functions, so a wrong flag on production still moves nothing.

| #   | Condition                                                                                         | Where it is enforced                                                                   |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | `REKODA_STAGING_TOOLS=1` in the **staging host's `.env`** (any value but `0`/`1` refuses boot)    | `apps/api/src/config.ts`                                                               |
| 2   | `PAYSTACK_SECRET_KEY` is a **test** key (`sk_test_…`); `REKODA_PAYSTACK_PLATFORM_CONFIRMED` unset | boot refuses otherwise (`config.ts`); re-checked per call (`staging-tools.service.ts`) |
| 3   | The database carries the staging marker (`staging_environment`, one row, owner-written)           | `staging-tools.service.ts`; `staging_move_date` and the fault queries (migration 0197) |
| 4   | The business is designated a test business                                                        | service; `staging_move_date`; `armFault`                                               |
| 5   | The operator token carries `ops:staging`                                                          | `OperatorGuard`; pinned by `apps/api/src/auth/operator-plane.test.ts`                  |

Also: the API refuses to **boot** when the database carries the staging marker and the Paystack key is
live (`apps/api/src/main.ts`), flag or no flag. `NODE_ENV` is never the discriminator (staging and
production both run production builds). `docker-compose.prod.yml` must never name the flag;
`scripts/check-staging-deploy.mjs` fails CI if it does.

## 2. One-time setup on the staging host

1. Confirm the staging `.env` holds a **test** Paystack key and no `REKODA_PAYSTACK_PLATFORM_CONFIRMED`.
2. Add `REKODA_STAGING_TOOLS=1` to the staging host's `.env` (never to a compose file), then recreate
   the api and worker containers (`docs/runbooks/deploy.md`).
3. Mark the database as staging, **as the database owner** (the one sanctioned SQL step; it writes a
   marker, never merchant data):

   ```sql
   INSERT INTO staging_environment (marked_by, note)
   VALUES ('owner:<your name>', 'staging acceptance, OWN-77');
   ```

4. Mint an operator token with `ops:staging` (and `ops:read` to see the exception queue).

To switch the tools off: remove the flag from `.env`, recreate api and worker, and as the owner
`DELETE FROM staging_environment;`.

## 3. The routes

All under `https://<staging api>/v1/ops/staging`, operator token in `Authorization: Bearer`.

| Route                                                  | Body                              | Does                                                                     |
| ------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------ |
| `POST businesses/:businessId/designate`                | `{ reason }`                      | Marks a business a test business (once; audited)                         |
| `POST businesses/:businessId/dates`                    | `{ field, expected, to, reason }` | Moves one date through `staging_move_date` (OD-37 sanctioned writer)     |
| `POST businesses/:businessId/actions/:actionId/revert` | `{ reason }`                      | Puts a moved date back, only if it still holds what the move wrote, once |
| `POST businesses/:businessId/faults`                   | `{ kind, reason }`                | Arms one fault, consumed by exactly one send for that business           |
| `GET businesses/:businessId/actions`                   |                                   | The append-only action log (the evidence to record)                      |

- `field`: `trial_end` (a business on its trial: `plan_expires_at`), `paid_to` (a dated paid plan:
  `plan_expires_at`, which is also the renewal date), `grace_clock` (a renewal in grace:
  `payment_failed_at`).
- `expected`: the current value, copied exactly (ISO 8601 with a zone) from
  `GET /v1/ops/business/:businessId` (`ops:read`): `renewsAt` for `trial_end` and `paid_to` (both are
  `plan_expires_at`), `paymentFailedAt` for `grace_clock`. The compare is exact, so a date read off
  `/app/billing` (shown as a Lagos day) never matches. A stale value answers 409 and changes nothing:
  read again. Each successful move answers with its action id; the new value is the `to` you sent.
- `to`: within 90 days of now (a revert is exempt only for the exact value its move replaced).
- `kind`: `send_timeout` (the send's outcome is unknown: the sweep never resends it) or
  `sender_refused` (definitely not sent, as a sender-wide refusal reports it: that business's
  reminder is released and retried on the next pass). It is one refusal for one send, so other
  businesses in the same pass are unaffected; a pass stops early only after several sender-wide
  refusals in a row, which one fault does not reach. Faults
  apply to the grace-reminder and trial-notice sends only. At most one armed per business.

Answers: 200 done; 400 bad shape; 403 tools off, database not staging, or not a test business; 404
unknown business or action; 409 stale value, fault already armed, move already reverted; 422 a move
the database refused (field does not fit the plan, out of bounds).

Every action is written to `staging_tool_actions` with operator, business, field, before, after,
reason, time and outcome. The application cannot change or delete those rows.

## 4. Acceptance scenarios

For every scenario: use a **fresh** test business created on staging for the run, designate it first
(`designate`, reason naming the scenario), record the deployed commit (`/health`), and capture the
action log (`GET …/actions`) as part of the evidence. Never designate a business that holds real
customer data.

### SUB-ACC 17: grace after the paid-to date passes

- **Preconditions:** a test business on a paid plan (paid in Paystack test mode, walkthrough 6–10).
- **Configuration:** §2 done; billing template slot configured (OD-41(b)).
- **Steps:** read the paid-to date as `renewsAt` from `GET /v1/ops/business/:businessId` (`ops:read`);
  move
  `paid_to` to one hour ago (`expected` = what you read); wait for the hourly renewal sweep (or the
  next worker pass); then move `grace_clock` back day by day to reach day 1, day 5 and day 7 of grace,
  letting the hourly grace sweep run after each move.
- **Expected:** a renewal charge is raised; the billing page shows the grace state; WhatsApp reminders
  arrive on day 1 and day 5 only; on day 7 the plan stops: records stay readable and exportable, new
  records are refused, and nothing is deleted.
- **Failure conditions:** a reminder on any other day or twice; records not readable after day 7; any
  copy saying data was deleted; a renewal raised twice.
- **Evidence:** screenshots of `/app/billing` at each stage; the reminders as received (time, text);
  the action log; the renewal charge reference.
- **Cleanup:** before day 7, revert the moves in reverse order. Once day 7 has stopped the plan, the
  moves cannot be reverted (the database refuses a `paid_to` move on an expired plan, and putting
  the dates back would not restore the plan): leave the business lapsed and stop using it.

### SUB-ACC 18: pay a new plan after expiry

- **Preconditions:** the business from step 17, now expired.
- **Steps:** choose a plan on `/app/billing` and pay in Paystack test mode.
- **Expected:** the plan reactivates with a fresh cycle from the payment day; no second trial is
  given; billing history shows the new payment.
- **Failure conditions:** a trial is offered or granted; the old renewal date is reused; two charges
  for one payment.
- **Evidence:** billing page before and after; the payment record page; the charge reference.
- **Cleanup:** none needed.

### SUB-ACC 19: a reminder send that times out, or a sender stopped for one sweep

- **Preconditions:** a test business in grace (as step 17, before day 1).
- **Steps (timeout):** arm `send_timeout`; move `grace_clock` so the next sweep is day 1; let the
  hourly sweep run twice. **Steps (refused):** on another business, arm `sender_refused` and do the
  same.
- **Expected:** timeout: the day-1 reminder is **not** sent and is **not** sent again later.
  Refused: nothing on the first pass, exactly one day-1 reminder on the next pass. After the merchant
  pays, no further reminder arrives.
- **Failure conditions:** a day-1 reminder received twice; a reminder after paying; the fault consumed
  by another business.
- **Evidence:** the action log showing `arm_fault` then exactly one `consume_fault`; reminders as
  received; worker log lines for the sweep (no message bodies are logged).
- **Cleanup:** none (a consumed fault is spent).

### SUB-ACC 22: a 14-day trial that runs out

- **Preconditions:** a fresh test business on its trial; a second business from step 17 whose paid
  plan lapsed.
- **Steps:** read the trial end (`renewsAt` from `GET /v1/ops/business/:businessId`); move `trial_end`
  to one hour ago; reload `/app/billing` for both
  businesses.
- **Expected:** the trial business reads "Your free trial ended on …"; the lapsed paid business reads
  "Your subscription stopped on …"; neither says anything was deleted; records are readable.
- **Failure conditions:** wrong wording for either; any deletion wording; writes still allowed.
- **Evidence:** screenshots of both pages; the action log.
- **Cleanup:** revert the `trial_end` move if the business is reused.

### ACCEPT-01 journey 2: trial state and expiry

As SUB-ACC 22, plus: before the move, check the days-left figure against the trial end you read
(the 14-day trial); after the move, check records stay readable. Evidence as SUB-ACC 22.

### ACCEPT-01 journey 3: trial communication

- **Preconditions:** OD-41(b) trial template configured; a fresh trial test business.
- **Steps:** move `trial_end` to 7 days from now; let the hourly trial-notice sweep run; then 2 days;
  then 1 day, letting the sweep run after each.
- **Expected:** one reminder per stage through the named template, none twice.
- **Failure conditions:** a stage missed or repeated; a reminder after the trial ended.
- **Evidence:** reminders as received (time, text); the action log.
- **Cleanup:** revert the last move or retire the business.

### ACCEPT-01 journey 9: trial reminders stop after paying

- **Steps:** on a fresh trial business, move `trial_end` to 3 days from now, so the 2-day stage is
  next; pay a plan in Paystack test mode before that stage is due; then let the hourly trial-notice
  sweep run past the stage's time. (A further `trial_end` move is refused once the business is on a
  paid plan, which is expected.)
- **Expected:** no trial reminder after the payment.
- **Evidence:** the payment record; absence of reminders after its time; the action log.

### ACCEPT-01 journey 10: renewal, grace and expiry

- **Steps:** (a) on a paid test business, move `paid_to` to one hour from now; let the renewal sweep
  run after it passes; pay the renewal in test mode before day 7. (b) Unpaid: as SUB-ACC 17.
- **Expected:** (a) the period is extended from the old renewal date and no grace remains. (b) 7-day
  grace, then read-only, records kept.
- **Failure conditions:** period extended from the payment day instead of the renewal date; a second
  extension for one payment; records lost.
- **Evidence:** billing page and payment record before and after; the action log.

## 5. What this does not do

No live charges, no production use, no raw SQL against merchant data, no general fault injection, no
change to a business that was not designated, and no automatic retry of a worker job (ACCEPT-01
journey 17(b) stays BLOCKED, `staging-acceptance-handoff.md`).
