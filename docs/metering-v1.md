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

| Unit                   | What counts                                                                                                                             | Trial | Chat | Integrate | Complete |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- | --------- | -------- |
| `AI_ACTIONS`           | A message the model had to interpret. Router-served turns (greetings, _help_, _who owes me_, confirmations) are FREE and never metered. | 50    | 400  | 0         | 1,200    |
| `VOICE_MINUTES`        | Minutes of voice notes transcribed. Sold in minutes, counted in seconds (see below).                                                    | 10    | 60   | 0         | 120      |
| `DOCUMENT_GENERATION`  | Financial documents GENERATED (invoices, receipts)                                                                                      | 25    | 100  | 500       | 750      |
| `DOCUMENTS_UNDERSTOOD` | Uploaded documents READ by the vision role (the new cost class; pricing-model "Known gap")                                              | 10    | 50   | 0         | 200      |
| `CATALOGUE_ORDERS`     | Catalogue orders captured (Integrate/Complete)                                                                                          | 10    | 0    | 300       | 300      |

The twelve with no plan allowance yet: `SERVICE_MESSAGE`,
`UTILITY_TEMPLATE`, `AUTH_TEMPLATE`, `AUTH_INTL_TEMPLATE`,
`MARKETING_TEMPLATE`, `PAYMENT_CONNECTIONS`,
`FINANCIAL_ACCOUNT_CONNECTIONS`, `ACCOUNTANT_USERS`, `REPORT_EXPORTS`,
`API_REQUEST_UNITS`, `API_APPLICATIONS`, `WEBHOOK_DELIVERIES`. Each gets its
plan figure in the PR that wires its consumer, not before.

### The two kinds of unit (owner ruling, 28 August 2026)

The seventeen are not all the same kind of thing, and treating them as one
kind produced a real defect. `UNIT_KIND` in `@rekoda/core` names the two.

A **`CONSUMABLE_MONTHLY`** unit is SPENT and RESET. Sending a message,
generating a document, making an API request: something was used up, the
allowance returns next month, and a usage pack tops it up within the month
it was bought. Thirteen units are of this kind, and only these may go
through `consumeUnit`.

A **`CAPACITY`** unit is HELD, not spent. A merchant does not consume an API
application or an accountant seat; they are permitted to maintain some
number of them at once. The ceiling is answered by counting how many
currently exist, so disabling one frees the slot the same day, and a month
boundary means nothing to it. Four units are of this kind:
`ACCOUNTANT_USERS`, `PAYMENT_CONNECTIONS`, `FINANCIAL_ACCOUNT_CONNECTIONS`
and `API_APPLICATIONS`.

Three consequences, each enforced rather than documented:

1. A capacity unit never reaches `consumeUnit`, `refundUnit` or
   `creditBonus`. `scripts/check-boundaries.mjs` refuses the call in source,
   and it is the one boundary rule tests are not exempt from: a suite that
   credits a month's bonus to buy capacity is asserting the wrong model
   however green it runs.
2. A capacity unit is sold as a RECURRING add-on, never as a one-off pack.
   "Fifty more applications, once" is not a sentence about standing
   capacity, and a pack credits a single month's bonus, which cannot express
   a permanent seat. Migration 0112 narrows `usage_packs.unit` to the
   thirteen consumables so the catalogue cannot express one.
3. `usage_counters.used` means "spent this period", so a capacity unit never
   writes a counter row at all. A row there would be a lie about what
   happened.

The two questions are read through two functions, `meterAllowance` and
`standingCapacity`, and each REFUSES the other's units rather than quietly
answering: a silent answer is how the confusion returns.

Where a capacity ceiling and a monthly allowance both come from beyond the
plan, they come from `add_on_grants` (migration 0112): a held add-on grants
an entitlement, standing capacity, or monthly units, at the version it was
sold at. Ending the holding ends all three, with nothing to un-copy.

### The three API units keep a plan allowance of zero, on purpose (PR-113)

PR-113 wired their consumers, and the figure it wrote is zero on every plan.
That is canon rather than an omission: spec §27 says the public API "is a
separate commercial entitlement … not automatically included with Chat,
Integrate or Complete", so a plan that sold API capacity would contradict the
sentence that defines the product.

What a merchant buys therefore arrives from the API product rather than the
plan, and the two consumables and the one capacity unit arrive differently
(PR-116). `API_REQUEST_UNITS` and `WEBHOOK_DELIVERIES` are consumables: they
arrive as a monthly grant from the held add-on, or as `bonus` from a top-up
pack bought inside one month. `API_APPLICATIONS` is capacity: it arrives as
a standing grant from the held add-on, and never as a pack.

The ceiling every API consume reads is `allowance + grants + bonus`, so:

- a business without the `REKODA_API` entitlement is refused at the gate,
  before any meter is touched;
- a business with the entitlement and no capacity is refused at the meter,
  with the public code `quota_exhausted` — a 429 with no `Retry-After`,
  because waiting will not help and buying will;
- a business that bought capacity spends exactly what it bought.

The three consume like this:

| Unit | Kind | How the ceiling is enforced |
| --- | --- | --- |
| `API_REQUEST_UNITS` | consumable | one taken per authenticated request, after the per-minute key ceiling so a flood cannot burn a month faster than that ceiling allows; never given back, because the request was served |
| `WEBHOOK_DELIVERIES` | consumable | one taken per delivery, before the send; refunded on every attempt that delivered nothing, so a merchant's own outage is not billed six times |
| `API_APPLICATIONS` | capacity | nothing is taken: registration counts the ACTIVE applications and refuses the one past the ceiling. Disabling an application frees its slot immediately |

PR-113 metered `API_APPLICATIONS` as a monthly tally, which meant a merchant
who registered their applications and then deleted every one of them still
could not register another until the month turned over. The correction is
PR-116, and the row above is the corrected behaviour.

A delivery refused at the ceiling is an ordinary failed attempt rather than a
lost fact: the backoff spreads six attempts over more than a day, so capacity
bought inside that window still delivers, and the reason is readable in the
merchant's delivery log.

### The five message categories are Rekoda's cost, not the merchant's

The five WhatsApp categories are metered, just not against an allowance. They
name what Rekoda pays Meta, they are written to `usage_events`, and the
margin view totals them by category (ADR 0029).

Every outbound message today is Rekoda talking to the merchant on Rekoda's
own number: a reply to something they said, a sign-in code, a notice that
their card failed. Charging a merchant's allowance for a billing reminder
would bill them for being told their payment failed, and the reply to their
own message was already paid for as an `AI_ACTION`. Commercial rule 3 of
`pricing-model.md` says the same thing in the other direction: template fees
are "tracked internally per business".

The allowance side is early rather than absent. When a merchant's own WABA
lands in W1/W2 they message their OWN customer, the category is chosen at
send time, and metering it against their plan is right, because then it is
their message.

| Category | Rekoda's cost | What sends it |
|---|---|---|
| `SERVICE_MESSAGE` | ₦0 today, chargeable 1 Oct 2026 | Every reply and document, inside the 24-hour window |
| `UTILITY_TEMPLATE` | ₦9.72 | Grace-period and retention notices |
| `AUTH_TEMPLATE` | ₦21.03 | Sign-in codes, Nigeria-registered WABA |
| `AUTH_INTL_TEMPLATE` | ₦108.75 | The same code, WABA registered elsewhere |
| `MARKETING_TEMPLATE` | ₦74.82 | Nothing. Commercial rule 2 excludes it from V1 |

The rate card lives in `@rekoda/core`'s `messaging.ts`, sourced from the
external cost stack in `pricing-model.md`.

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

### 2.1 Order: authorisation before the bill

Spec §4.3 fixes the order and this is where it is enforced:

```
entitlement  →  allowance  →  THEN the provider that costs money
```

A capability the plan does not hold is refused before the media is even
fetched, so an Integrate-only merchant's voice note never reaches the
transcriber and their photograph never reaches the OCR engine. A capability
the plan holds but the allowance no longer covers is refused before the same
call, for the same reason: metering after the work is done means an exhausted
merchant spends Rekoda's provider budget one message at a time and only
learns afterwards.

Where the work fails, the unit goes back. That part never changed: a page
nobody could read is still a page nobody pays for. What changed is that the
refund is now a compensation for a unit already taken, rather than a decision
not to take one.

### 2.2 Voice: measured before it is spent

Everything the meter counts is known before it is spent, voice included. That
was not obvious: neither the WhatsApp webhook nor the media endpoint reports a
duration, and the first implementation concluded that only the transcriber
knows and turned the merchant's length limit into a reservation window.

That was wrong, and it is worth writing down why. The media binary is
downloaded before anything is spent, and a container that stores audio stores
how much of it there is. `AudioMetadataProbe` reads it in process, for the five
containers Meta accepts:

```
entitlement  →  download  →  read the length from the audio
             →  over the limit?  refuse, no provider called
             →  unreadable?      ask for it again, no provider called
             →  take exactly the seconds it runs
             →  transcribe
```

`VOICE_NOTE_MAX_DURATION_SECONDS` is therefore a real rejection limit rather
than a budget, which is what makes it cost protection: a note past it never
reaches a transcription provider at all. That matters most against the case a
budget cannot defend, which is a merchant with no allowance left sending a
long note every few seconds.

Unreadable is never treated as zero. A caller that cannot tell "silent" from
"could not be measured" transcribes the second one for free, and the recovery
for the two is not the same. The merchant is asked to record it again;
nothing was metered and nothing was sent anywhere.

The audio is the source of truth for the length, not the transcriber's
report. They should agree, and where they do not, the number the merchant is
charged is the one that was checked against their allowance before the spend.

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
