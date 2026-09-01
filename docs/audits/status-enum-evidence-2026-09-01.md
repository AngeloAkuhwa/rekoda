# Status enum evidence, 1 September 2026

Phase 2 of the R1 remediation plan. Ruling 3 requires the authoritative set for
each logic-bearing status column to be **derived from evidence** — production
writers, contract enums, TypeScript unions, fixtures, stored values — before any
CHECK constraint is written, and explicitly forbids guessing them from comments.

**This document is that derivation. It adds no constraint.** The migration is
phase 4, gated on the R2 review.

**Baseline.** `main` at `2e4fa590`, migration head `0129`.

---

## Why the ruling was right

Three of the four schema comments are **wrong**, and a CHECK built from them would
have been an outage rather than a safeguard.

| Column | Comment says | Evidence says | Damage if the comment were trusted |
|---|---|---|---|
| `orders.status` | 4 values | **7 values** | Rejects `quoted`, `open`, `received`, `validated` — breaks quotes, purchase orders, receiving and validation |
| `invoices.status` | 4 values | **5 values** | Rejects `credited` — breaks the credit-note path |
| `reconciliations.status` | 4 values | **3 values** | Permits `UNMATCHED`, which nothing writes |
| `expenses.status` | no comment | **2 values** | — |

Counting how often a literal appears in the codebase is **also invalid**, and was
tried and discarded: `'paid'`, `'confirmed'` and `'cancelled'` each appear in
many files, but most of those are payment statuses, intent statuses and audit
actions — different columns entirely. Only per-column writer tracing answers this.

---

## `invoices.status` — 5 values

```
issued  partially_paid  paid  voided  credited
```

| Value | Written by | Evidence |
|---|---|---|
| `issued` | invoice creation with nothing paid | `repos/issue.ts:338`, `repos/opening.ts:163` |
| `partially_paid` | creation with a part payment; allocation leaving a balance | `repos/issue.ts:338`, `repos/settle.ts:274` |
| `paid` | creation fully paid; allocation clearing the balance | `repos/issue.ts:338`, `:1394`, `repos/settle.ts:274` |
| `voided` | withdrawal | `repos/issue.ts:615` |
| **`credited`** | **credit notes reaching the invoice total** | **`repos/issue.ts:1210`** |

The missing one is written in raw SQL inside a `CASE`, which is why a reader
skimming the Drizzle declaration would not see it:

```sql
UPDATE invoices
   SET credited_k = credited_k + ${input.amountK},
       status = CASE WHEN credited_k + ${input.amountK} >= total_k
                     THEN 'credited' ELSE status END
```

The schema comment at `schema/finance.ts:51` reads
`issued | partially_paid | paid | voided`. **A CHECK from that comment would make
every fully-credited invoice fail to save.**

## `orders.status` — 7 values

```
placed  quoted  open  confirmed  cancelled  received  validated
```

The `orders` table carries three different documents — a sales order, a quote and
a purchase order — which is why its set is larger than any one flow suggests.

| Value | Meaning | Evidence |
|---|---|---|
| `placed` | a sales order created | `repos/orders.ts:74` |
| `quoted` | a quote created | `repos/orders.ts:133` |
| `open` | a purchase order created | `repos/orders.ts:329` |
| `confirmed` | quote or order taken up, invoice attached | `sale-commands.ts:143`, `order-commands.ts:112` |
| `validated` | order validated with an invoice | `order-commands.ts:395` |
| `received` | purchase order received | `reports.controller.ts:1127` |
| `cancelled` | any of the three cancelled | `reports.controller.ts:1032`, `:1205`, `order-commands.ts:306` |

`paid`, which the comment lists, is **never written to this column** by any site.

### Why this one could not be read off the writer

```ts
export async function markOrder(
  tx: TenantDb, businessId: string, id: string,
  from: string,          // ← untyped
  to: string,            // ← untyped
  invoiceId?: string,
): Promise<MarkOutcome>
```

Every transition goes through `markOrder`, and both ends are bare `string`. The
set of reachable statuses is therefore a property of the **seven call sites**, not
of the repository, and the type system currently asserts nothing about it.

**Recommendation, not done here:** tighten `from` and `to` to a shared union once
the CHECK exists, so the database and the type system pin the same set. That is a
code change and is out of scope for this document.

## `expenses.status` — 2 values

```
recorded  voided
```

| Value | Written by | Evidence |
|---|---|---|
| `recorded` | column default; neither insert sets it explicitly | `schema/finance.ts:248`, inserts at `repos/spend.ts:118`, `:165` |
| `voided` | withdrawal | `repos/spend.ts:458`, `:467` |

**Disambiguation.** `repos/spend.ts:788` writes `'paid'` and `'partially_paid'`
but updates **`bills`**, not `expenses` — verified by reading the statement's
`.update(bills)` target. Those two values do **not** belong to this column.
`bills.status` is a separate column and is out of scope for ruling 3.

## `reconciliations.status` — 3 values

```
MATCHED  PARTIAL  EXCEPTION
```

Uppercase, unlike the other three columns. Derived in one place:

```ts
const status =
  reconciliation === 'matched'      ? 'MATCHED'
  : reconciliation === 'partial_match' ? 'PARTIAL'
  : 'EXCEPTION';
```

`repos/settle.ts:420`, with a second explicit `'EXCEPTION'` at `:511` for an
unattributable payment. A reader at `:748` types its filter as
`'EXCEPTION' | 'MATCHED'`, which is a subset and consistent.

**`UNMATCHED` is dead.** It appears in the schema comment at
`schema/finance.ts:633` and in **zero** non-test files. Including it in a CHECK
would enshrine a value the system does not use; the correct set is the three
above.

---

## The proposed constraints (phase 4, not applied here)

```sql
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('issued','partially_paid','paid','voided','credited'));

ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('placed','quoted','open','confirmed','cancelled','received','validated'));

ALTER TABLE expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN ('recorded','voided'));

ALTER TABLE reconciliations ADD CONSTRAINT reconciliations_status_check
  CHECK (status IN ('MATCHED','PARTIAL','EXCEPTION'));
```

Each as a new corrective migration after head, `NOT VALID` then `VALIDATE`, no
historical migration edited.

The stale comments at `schema/finance.ts:51`, `:633` and `schema/commerce.ts:151`
must be corrected in the same change, or the next reader inherits the same trap.

## The drift test (phase 4)

The constraint is the smaller half. A CHECK that agrees with the code today and is
never re-checked will disagree within a year, and it will disagree in the
direction that breaks writes.

The test must assert **both** directions per column:

1. **Every value in the set above is accepted by the database.** This is the one
   that matters — it fails the moment someone adds a status and forgets the
   migration, which is exactly how a CHECK becomes an outage.
2. **A value outside the set is rejected**, including the near-misses that
   motivated the finding: `'PAID'`, `'paidd'`, `''`.

It must run against a real database and write through a path that does not
consult the application's own validation — a test that goes through the service
layer proves the service layer, not the constraint.

## What is deliberately unresolved

- **`markOrder`'s untyped transitions.** Recorded above; the fix is a code change
  and belongs with phase 4, not before it.
- **The other ~46 unconstrained text columns** R1 matched. Ruling 3 named four,
  and only those four were traced. Several of the rest are legitimately open text
  (`failure_reason` is provider prose); some may deserve the same treatment, and
  none was assumed either way.
- **Stored values.** The development database holds no rows in these four tables,
  so no set could be widened by inspecting data. On any database that does hold
  rows, phase 4 must run `SELECT DISTINCT status` before applying a constraint —
  a value in the wild that is not in the set above would fail `VALIDATE`.
