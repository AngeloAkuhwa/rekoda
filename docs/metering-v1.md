# Metering V1 — exhaustible allowances, no abuse by construction

**Owner directive, 20 August 2026**: usage must be meterable like credits. A
merchant can exhaust their plan's allowance; when they do, they choose to top
up or upgrade to continue. No gaps.

## 1. The unit model

Merchants never see tokens or "AI credits" (pricing-model commercial rule 3).
They see the concrete units the plans already advertise, and those units are
now ENFORCED, not decorative:

The vocabulary is the canonical seventeen (`REKODA_CANONICAL_SPEC` §4.2).
Five of them are metered today; the other twelve exist so the counter can
hold them the day a consumer does. A unit nothing consumes sells zero on
every plan, because capacity the product cannot spend is capacity the
pricing page must not promise.

| Unit                   | What counts                                                                                                                             | Trial | Chat  | Integrate | Complete |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----- | --------- | -------- |
| `AI_ACTIONS`           | A message the model had to interpret. Router-served turns (greetings, _help_, _who owes me_, confirmations) are FREE and never metered. | 50    | 400   | 0         | 1,200    |
| `VOICE_MINUTES`        | Minutes of voice notes transcribed. Sold in minutes, counted in seconds (see below).                                                     | 10    | 60    | 0         | 120      |
| `DOCUMENT_GENERATION`  | Financial documents GENERATED (invoices, receipts)                                                                                      | 25    | 100   | 500       | 750      |
| `DOCUMENTS_UNDERSTOOD` | Uploaded documents READ by the vision role (the new cost class; pricing-model "Known gap")                                              | 10    | 50    | 0         | 200      |
| `CATALOGUE_ORDERS`     | Catalogue orders captured (Integrate/Complete)                                                                                          | 10    | 0     | 300       | 300      |

The twelve not yet metered: `SERVICE_MESSAGE`, `UTILITY_TEMPLATE`,
`AUTH_TEMPLATE`, `AUTH_INTL_TEMPLATE`, `MARKETING_TEMPLATE`,
`PAYMENT_CONNECTIONS`, `FINANCIAL_ACCOUNT_CONNECTIONS`, `ACCOUNTANT_USERS`,
`REPORT_EXPORTS`, `API_REQUEST_UNITS`, `API_APPLICATIONS`,
`WEBHOOK_DELIVERIES`. Each gets its plan figure in the PR that wires its
consumer, not before.

Integrate carries no merchant-side capacity because it holds
`REKODA_INTEGRATE` and not `REKODA_CHAT` (owner decision, 26 August 2026):
the entitlement gate refuses those capabilities before the meter is reached,
so an allowance for them would never be spendable.

All numbers are the pricing model's planning figures; the first-50-merchants
checkpoint re-examines every one against real P50/P95 usage.

### Voice is sold in minutes and counted in seconds

`VOICE_MINUTES` is the only unit whose merchant word and countable increment
differ. A voice note is not a whole number of minutes, and rounding each one
up would cost a merchant sending twenty-second notes three times the capacity
they were sold. So `usage_counters.used` holds SECONDS, the plan table holds
MINUTES, and `UNIT_SCALE` in `@rekoda/core` holds the ratio between them.
`allowanceFor` applies it, so every consume site is handed the ceiling in the
same units the column counts in.

## 2. The enforcement shape (no gaps means no read-then-write)

One table, `usage_counters (business_id, period, unit, used, bonus)`, under
row-level security, keyed by calendar month in Africa/Lagos (fixed UTC+1, no
DST). Consumption is a SINGLE statement whose WHERE clause carries the
precondition:

```sql
INSERT ... ON CONFLICT DO UPDATE SET used = used + n
  WHERE used + n <= allowance + bonus
RETURNING ...
```

The database decides; a loser learns it was refused. Two simultaneous
messages cannot both take the last unit, the same way two "yes" taps cannot
issue two invoices. There is no code path that increments without checking
and no path that checks without incrementing.

**Layered backstops stay layered.** Monthly allowances sit ON TOP of the
existing daily AI ceilings (per business and global) and per-IP rate limits.
A stolen session or a runaway integration hits the daily wall long before it
drains a month; the month wall is the commercial meter, not the only fence.

## 3. Exhaustion is a doorway, not a wall

Soft-limit rules (pricing-model rule 4) hold: nobody is cut off
mid-transaction, and reading is never gated — _who owes me_, _records_, the
dashboard and every existing document stay available at zero units forever.
When a unit runs out BETWEEN transactions, the reply says exactly three
things: what ran out, that nothing was lost, and the two ways to continue
(top up or upgrade).

## 4. Top-ups and upgrades are Rekoda.Billing transactions (M4)

Buying more units is real money and follows §B of payments-v1: a billing
invoice, a verified payment, a receipt, and ONLY THEN `bonus` is credited on
the counter row — by the billing event, never by a support hand. Until M4
ships, `bonus` exists in the schema (so the counter arithmetic is final) and
is credited by nothing; upgrades change `businesses.plan`, which changes the
allowance at the next consume. Top-up packs are priced per unit class in M4
against telemetry, not guessed now.

## 5. Wiring order

1. **Now**: the counter table, the atomic gate, plan allowances in
   `@rekoda/core`, the exhaustion reply, and enforcement on the `AI_ACTIONS`
   unit (the interpreter path).
2. **With each capability slice**: voice wires `VOICE_MINUTES`, document
   upload wires `DOCUMENTS_UNDERSTOOD` (the rekoda-chat-v1 gate), document
   generation wires `DOCUMENT_GENERATION`, Integrate order capture wires `CATALOGUE_ORDERS`.
   A capability PR that spends a unit class without wiring its consume call
   does not merge.
3. **M4**: top-up purchase and plan upgrade as billing transactions crediting
   `bonus` / changing `plan`.
