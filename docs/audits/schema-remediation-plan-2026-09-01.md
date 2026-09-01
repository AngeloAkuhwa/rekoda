# R1 remediation plan, 1 September 2026

Follows `schema-launch-audit-2026-09-01.md` and the owner ruling of 1 September.
This document is the sequencing; it is not itself a change.

**Baseline.** `main` at `2e4fa590e5c6dec47732c908e6fff21160b84b1b`, migration head
`0129_product_image_deletion_reasons`, no `0130+`. Every R1 count was re-run at
that commit and came back identical, so no finding was revised.

---

## The gate that governs everything below

The owner ruling ends: **do not start schema migrations until R2 is reviewed.**
That is a hard gate, and it decides what happens now versus later regardless of
how ready a piece of work looks.

| Phase | Work | Gate |
|---|---|---|
| 0 | R1 audit as a documentation-only PR | none — done |
| 1 | RLS exemption register (ruling 6) | none — documentation |
| 2 | Status enum evidence: derive the authoritative sets (ruling 3, prep only) | none — analysis |
| 3 | **R2 adversarial audit, report only** | none — next |
| — | **OWNER REVIEW OF R2** | ← everything below waits here |
| 4 | Status CHECK constraints + drift test (ruling 3, migration) | after R2 review |
| 5 | Tenant-composite FKs, five grouped PRs (ruling 1) | after R2 review |
| 6 | `external_events` access (ruling 2) | after R2 proves the paths |
| 7 | Selective indexes on evidence (ruling 4) | after R2 / perf evidence |
| 8 | Drop the redundant `ledger_entries` FK (ruling 5) | opportunistic cleanup |

Phase 2 is deliberately split from phase 4. The ruling requires the valid set to
be *derived from evidence* before any constraint is written; doing that derivation
now costs nothing, is not a migration, and means phase 4 is mechanical when it is
unblocked.

---

## A precondition the ruling's checklist does not name

The ruling's per-relationship checklist is right, and one step has to go in front
of it, because without it a composite FK can be added, validated, reported as
fixed, and enforce nothing.

PostgreSQL's default foreign key match type is **`MATCH SIMPLE`**: if *any*
column of a composite key is NULL, **the constraint is not checked at all**. So
`FOREIGN KEY (business_id, payment_id)` on a row with `business_id IS NULL`
permits any `payment_id` whatsoever, silently.

Checked across all 21 source tables in the 34 gaps:

- **20 have `business_id NOT NULL`.** For these, a composite FK enforces exactly
  what it appears to, and a nullable *child* column (`invoice_id IS NULL`) still
  behaves correctly — an optional relationship stays optional.
- **`platform_cost_events.business_id` is NULLABLE.** Its two edges
  (`payment_id`, `settlement_id`) cannot be fixed by adding a composite FK alone.

For that one table the options are, in preference order:

1. **`MATCH FULL`** — forbids the mixed state exactly: all columns NULL is allowed,
   some NULL and some not is an error. This is the correct semantics for a
   nullable-tenant table and needs no data change.
2. Make `business_id NOT NULL` first — only if every platform cost row genuinely
   belongs to a business. It may not: this is Rekoda's own cost ledger and a
   platform-level cost attributable to no merchant is a legitimate row. Do not
   assume.
3. Leave and document.

**Ruling required at phase 5**, not before: option 1 unless someone can show a
reason it breaks a writer.

---

## Phase 5: the 34 relationships, grouped

Grouping follows the ruling's suggested domains. Counts are exact and sum to 34.

### Group A — invoices, orders, customers, items (9)

```
credit_notes.invoice_id        -> invoices
customer_identities.customer_id -> customers
invoice_items.invoice_id       -> invoices
invoices.customer_id           -> customers
invoices.order_id              -> orders
order_items.order_id           -> orders
order_items.product_id         -> products
orders.customer_id             -> customers
orders.invoice_id              -> invoices
```

### Group B — payments, intents, allocations, receipts, evidence (12)

```
payment_allocations.invoice_id   -> invoices
payment_allocations.payment_id   -> payments
payment_evidence.customer_id     -> customers
payment_intents.customer_id      -> customers
payment_intents.invoice_id       -> invoices
payment_intents.order_id         -> orders
payment_verifications.payment_id -> payments
payments.customer_id             -> customers
payments.payment_intent_id       -> payment_intents
receipts.customer_id             -> customers
receipts.invoice_id              -> invoices
receipts.payment_id              -> payments
```

The most exposed group. R1 flagged `payment_allocations.invoice_id`,
`payment_intents.invoice_id` and `receipts.invoice_id` as the edges most likely
to be fed by an id arriving from outside; R2 confirms or refutes that.

### Group C — spend, inventory, returns (4)

```
expenses.supplier_id       -> suppliers
goods_returns.invoice_id   -> invoices
inventory_movements.product_id -> products
supplier_payments.expense_id   -> expenses
```

`goods_returns.invoice_id` is the edge that opened the whole finding, and the
table already carries the correct composite for `product_id` — so this group
contains its own worked example.

### Group D — reconciliation and ledger provenance (6)

```
bank_line_matches.transaction_id      -> ledger_transactions
credit_notes.ledger_transaction_id    -> ledger_transactions
expenses.ledger_transaction_id        -> ledger_transactions
fixed_assets.ledger_transaction_id    -> ledger_transactions
reconciliations.payment_id            -> payments
supplier_payments.ledger_transaction_id -> ledger_transactions
```

Highest care: these attach business records to **posted ledger transactions**.
A cross-tenant link here is a cross-tenant link into financial history.

### Group E — platform and integration (3)

```
platform_cost_events.payment_id      -> payments        (nullable tenant — see above)
platform_cost_events.settlement_id   -> settlements     (nullable tenant — see above)
waba_catalogue_items.waba_connection_id -> waba_connections
```

Split this group if the `platform_cost_events` ruling is not settled when the
`waba_catalogue_items` edge is ready; that one is ordinary and needs no ruling.

### Per-relationship procedure

The ruling's checklist, with the nullability step in front and the test shape made
explicit:

```
0. confirm the source table's business_id is NOT NULL  (else MATCH FULL, or stop)
1. confirm the target exposes UNIQUE (business_id, id)  [all 34 verified]
2. confirm existing rows satisfy the relationship
3. ADD CONSTRAINT ... FOREIGN KEY (business_id, <col>)
     REFERENCES <target> (business_id, id) NOT VALID
4. VALIDATE CONSTRAINT
5. DROP the weaker single-column constraint  (only after 4 succeeds)
6. update the Drizzle declaration if it names the constraint
7. test: same-tenant insert SUCCEEDS
8. test: cross-tenant insert FAILS at the database, with application
   validation bypassed — the test must write through a path that does not
   consult the application's own checks, or it proves the application and
   not the constraint
```

Step 8 is the one that matters. A test that goes through the service layer proves
the service layer. The constraint is only proven by an insert the service layer
would have refused.

**New corrective migrations only.** No historical migration is edited.

---

## Phase 4: status CHECK constraints

Four columns, confirmed by R1 to have no CHECK and no trigger:
`invoices.status`, `orders.status`, `expenses.status`, `reconciliations.status`.

Phase 2 (now) derives the authoritative set from evidence — production writers,
contract and Zod enums, TypeScript unions, fixtures, and any values present in a
database. Phase 4 (after R2) writes the constraint and the drift test.

The drift test is the durable half. A CHECK that agrees with the TypeScript union
today and is never re-checked will disagree with it within a year. The test must
assert both directions:

- every value the application can produce is **accepted** by the database;
- a value the application cannot produce is **rejected**.

The first direction is what stops a deploy that adds a status and forgets the
migration. Without it the constraint becomes an outage waiting for a feature.

---

## Phase 6: `external_events`

No mechanical change before R2. The desired end state, from the ruling:

```
rekoda_app      -> only the current business's events
rekoda_worker   -> estate-wide sweep
operator plane  -> explicit, privileged, estate-wide
```

Migration 0124 already solved the same shape for `pending_object_deletions` — a
tenant policy plus a permissive worker policy — and that pattern is the candidate.

R2 must answer one question before anything is written: **which credential do the
operator exception-queue reads actually run on?** If they run on `rekoda_app`, a
tenant policy breaks them, and the fix is to give the operator an intentional
privileged path rather than to preserve the estate-wide grant.

---

## Phase 7: indexes

54 foreign keys lead no index. The ruling is explicit that this is a queue and not
a sweep, and that is right: 54 indexes cost storage, write amplification and
maintenance, and most would never be used.

Prioritise on evidence from the paths that delete a tenant's rows wholesale —
`EraseData`, the retention sweep, outbox and webhook cleanup — using `EXPLAIN`
against representative volumes rather than intuition. R1's candidates, unranked:
`conversation_messages.business_id`, `outbox_events.business_id`,
`invoice_items.business_id`, `order_items.business_id`,
`api_key_rate_windows.business_id`, `receipts.payment_id`, `payments.customer_id`.

Only indexes with a demonstrated plan improvement are created. An initial
low-volume launch is not blocked on this.

---

## Phase 8: the redundant `ledger_entries` foreign key

`ledger_entries_transaction_id_ledger_transactions_id_fk` is superseded by
`ledger_entries_tx_business_fk`. No tenant defect. Drop it when a ledger or schema
cleanup PR passes nearby; do not spend a launch PR on it.

Its one real cost is that it makes a naive audit report a gap that does not exist —
as the first pass of R1 did.

---

## What is deliberately not in this plan

- **Anything that changes behaviour before R2 is reviewed.** The gate is the gate.
- **A ruling on `platform_cost_events`.** Recommended, not decided.
- **Any claim about reachability** of the 34 edges. R1 established the database
  permits them; only R2 can say whether anything walks them.
- **Sessions and magic links redesign.** Documentation only, per ruling 6, unless
  R2 finds an actual attack path.
