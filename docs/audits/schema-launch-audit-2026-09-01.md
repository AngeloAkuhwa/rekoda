# Schema forensic audit, 1 September 2026

**Status:** findings only. No migration, no schema change, no code change accompanies
this document. Nothing here is a decision; every item is a thing found, with the
evidence that found it, for the owner to rule on.

**Method.** Read out of the live catalogue of a database at migration head (130
migrations, `0000_init` through `0129`), not out of the migration files. A
migration says what was intended; `pg_constraint` says what is there. Every count
below is a query result, and the queries are given so they can be re-run.

**Scope.** 115 tables. Structure only: constraints, keys, types, row-level
security, delete behaviour, index coverage. What the application *does* with the
schema is the adversarial security audit's question, not this one, and the
distinction matters for several findings below: this audit can say the database
permits something, and cannot say whether a code path reaches it.

---

## Summary

| # | Finding | Severity | Reach |
|---|---|---|---|
| 1 | 34 foreign keys let a row reference **another tenant's** record | **High** | Structural; reachability unproven |
| 2 | Four status columns that drive logic have no CHECK and no trigger | **Medium** | Application is the only guard |
| 3 | `external_events` is readable across every tenant by the application role | **Medium** | Grant is live |
| 4 | 54 foreign keys lead no index | Low-Medium | Erasure and retention paths |
| 5 | `ledger_entries` carries a superseded duplicate foreign key | Low | Cosmetic |
| 6 | `sessions` and `magic_links` sit outside RLS with no written reason | Low | Believed correct, undocumented |

Three things came back **clean** and are recorded in full below, because a launch
audit that only lists faults misrepresents the estate.

---

## 1. Foreign keys that cross the tenant boundary

**High. The headline finding.**

The schema knows the right pattern and uses it 43 times:

```
goods_returns_product_fk  FOREIGN KEY (business_id, product_id)
                          REFERENCES products(business_id, id)
```

A composite key like that makes attaching another shop's product **structurally
impossible**. The database refuses it; no application discipline is required.

The same table, one constraint away, does not:

```
goods_returns_invoice_fk  FOREIGN KEY (invoice_id)
                          REFERENCES invoices(id)
```

Nothing in the database stops a return being attached to **another business's
invoice**. Row-level security filters what a query can *read*; it does not
constrain what a foreign key will *accept*. A write that takes an id from a
request and inserts it without first reading the row back under the tenant pin
will be accepted by PostgreSQL.

**34 foreign keys have this shape** — a tenant-owned table referencing another
tenant-owned table by `id` alone, where the target already exposes
`(business_id, id)` so the composite is available today:

```
bank_line_matches.transaction_id      -> ledger_transactions
credit_notes.invoice_id               -> invoices
credit_notes.ledger_transaction_id    -> ledger_transactions
customer_identities.customer_id       -> customers
expenses.ledger_transaction_id        -> ledger_transactions
expenses.supplier_id                  -> suppliers
fixed_assets.ledger_transaction_id    -> ledger_transactions
goods_returns.invoice_id              -> invoices
inventory_movements.product_id        -> products
invoice_items.invoice_id              -> invoices
invoices.customer_id                  -> customers
invoices.order_id                     -> orders
order_items.order_id                  -> orders
order_items.product_id                -> products
orders.customer_id                    -> customers
orders.invoice_id                     -> invoices
payment_allocations.invoice_id        -> invoices
payment_allocations.payment_id        -> payments
payment_evidence.customer_id          -> customers
payment_intents.customer_id           -> customers
payment_intents.invoice_id            -> invoices
payment_intents.order_id              -> orders
payment_verifications.payment_id      -> payments
payments.customer_id                  -> customers
payments.payment_intent_id            -> payment_intents
platform_cost_events.payment_id       -> payments
platform_cost_events.settlement_id    -> settlements
receipts.customer_id                  -> customers
receipts.invoice_id                   -> invoices
receipts.payment_id                   -> payments
reconciliations.payment_id            -> payments
supplier_payments.expense_id          -> expenses
supplier_payments.ledger_transaction_id -> ledger_transactions
waba_catalogue_items.waba_connection_id -> waba_connections
```

### Why the count is 34 and not 35

`ledger_entries.transaction_id` matches the shape but is **not** a gap: the table
also carries `ledger_entries_tx_business_fk` on `(business_id, transaction_id)`,
which already enforces the property. The single-column constraint is a leftover
(finding 5). It is excluded here rather than padding the number, and the same
exclusion was applied to every other column before counting.

### What this does and does not establish

It establishes that **the database permits cross-tenant references on these 34
edges**. It does not establish that any code path reaches them, and this audit
deliberately does not claim that: proving reachability means tracing every writer
of every one of those columns, which is the adversarial audit's work.

Two observations that bear on how urgent it is:

- The gaps cluster in the **oldest** tables — invoices, payments, customers,
  orders, receipts. The composite pattern arrives with the F1 accounting work and
  is used consistently from there on. This looks like a convention that was
  adopted mid-build and never backfilled, not a series of decisions.
- The most exposed edges are the ones fed by ids that arrive from outside:
  `payment_allocations.invoice_id`, `payment_intents.invoice_id` and
  `receipts.invoice_id` are the ones worth tracing first.

### Cost of closing it

Each is one `ALTER TABLE ... ADD CONSTRAINT` against an existing composite key,
plus dropping the weaker constraint. Three preconditions apply and none is
assumed here:

1. The target must already expose `(business_id, id)` as a unique key. All 34
   do — that was the filter used to build the list.
2. Existing rows must satisfy the new constraint. On an estate with no production
   data this is free; it must still be verified rather than assumed.
3. `NOT VALID` then `VALIDATE CONSTRAINT` avoids a long exclusive lock if there
   is ever data to check.

**Recommendation, not an action:** treat as a small number of PRs grouped by
subject area rather than one sweeping migration, so each is reviewable and each
can be reverted alone.

---

## 2. Status columns with no constraint

**Medium.**

Four columns that drive branching logic accept any text at all. Verified: no
CHECK constraint, no trigger, on any of them.

| Column | Enforced by |
|---|---|
| `invoices.status` | application only |
| `orders.status` | application only |
| `expenses.status` | application only |
| `reconciliations.status` | application only |

The schema again shows it knows better a few lines away —
`goods_returns.disposition` carries
`CHECK (disposition IN ('RESALABLE','DAMAGED','QUARANTINED','SCRAPPED'))`, and
`invoices.sale_source` carries a ten-value CHECK on the same table whose `status`
has none.

The failure this admits is quiet rather than loud: a `'PAID'` where `'paid'` was
meant, or a `'paidd'`, is stored without complaint and then silently mis-buckets
every report that groups by status. Nothing raises.

A wider list of unconstrained text columns exists (roughly 50 matched a
`status|state|kind|_type|...` pattern), but most are legitimately open —
`payment_attempts.failure_reason` is provider prose, `payment_evidence.media_mime_type`
is a MIME type. The four above were confirmed individually as logic-bearing.

---

## 3. `external_events` is readable across every tenant

**Medium.**

```
external_events   RLS: disabled   policies: 0
rekoda_app   = SELECT, INSERT, UPDATE, DELETE
```

The table holds provider webhook payloads in `payload jsonb`, with a nullable
`business_id` because an unattributed event belongs to no tenant. That nullability
is a real architectural reason not to apply a naive tenant policy — and it is
**the same reason `pending_object_deletions` had**, which migration 0124 solved
without giving anything up:

```sql
CREATE POLICY tenant_isolation ON pending_object_deletions
  USING (business_id = nullif(current_setting('app.business_id', true),'')::uuid);
CREATE POLICY worker_sweeps_orphans ON pending_object_deletions
  TO rekoda_worker USING (true);
```

A tenant policy plus a permissive worker policy gives the worker its estate-wide
sweep while the application sees only its own tenant. The same shape appears to
fit here. Whether the operator exception queue's reads (which are deliberately
cross-tenant, and argued for in `ops.controller.ts`) run on the worker credential
needs confirming before this is actioned — if they run on the application role,
the policy would break them, and that is a design question rather than a
mechanical fix.

---

## 4. Foreign keys leading no index

**Low to Medium. 54 of 200.**

An unindexed foreign key makes a DELETE on the parent do a sequential scan of the
child while holding a lock. Rekoda has two paths that delete a tenant's rows
wholesale — the retention sweep and `EraseData` — so this is a lock-duration
question on exactly the paths that must not stall.

Notable entries, chosen because they sit on high-row-count children:
`conversation_messages.business_id`, `outbox_events.business_id`,
`invoice_items.business_id`, `order_items.business_id`,
`api_key_rate_windows.business_id`, `receipts.payment_id`, `payments.customer_id`.

Full list reproducible with the query in the appendix. Adding indexes is cheap and
individually safe, but 54 indexes also cost write throughput and storage, so this
warrants a judgement about which subset earns one rather than a blanket sweep.

---

## 5. `ledger_entries` carries a superseded duplicate

**Low. Cosmetic, with one real consequence.**

```
ledger_entries_transaction_id_ledger_transactions_id_fk   (transaction_id)               -- legacy
ledger_entries_tx_business_fk                             (business_id, transaction_id)  -- supersedes it
```

Both are enforced; the composite is strictly stronger, so correctness is unaffected
and the table is genuinely tenant-safe. The consequence is that a naive audit — including
the first pass of this one — reads the legacy constraint and reports a gap that
does not exist. Dropping it removes a false positive from every future review.

---

## 6. `sessions` and `magic_links` outside RLS

**Low. Believed correct; undocumented.**

Both carry `business_id`, both sit outside row-level security, and the application
role holds full DML on each.

There is a sound reason: a session or a magic link must be resolved **before** the
tenant is known. Pinning `app.business_id` requires knowing the business, and
knowing the business requires reading the session — a policy here would be a
circular dependency, not a control. Both are looked up by an unguessable
`token_hash`.

What is missing is that this reasoning is written down anywhere. `retention_deletions`
and `platform_cost_events` both carry their exemption as a comment in the migration
that took it; these two do not. A future reviewer running the query in finding 3
will flag them again and have to re-derive the answer.

`migration_manifest_items` also appears in that query with `business_id` and no
RLS, and is a different case: it holds **no grants at all** to either application
role, so it is unreachable except by the owner. Not a leak.

---

## What is clean

Recorded deliberately. These were checked and found sound.

**Money is integer minor units, everywhere.** Zero columns matching
`amount|price|cost|total|balance|value|_k|_minor|_micros` use `real`, `double
precision` or `numeric`. Every one is `bigint`, `integer` or `smallint`. The only
non-integer matches were `jsonb` audit values, a uuid, and text currency and
type codes — all correct. For an accounting product this is the single most
important type property in the schema and it holds without exception.

**Every timestamp carries a time zone.** Zero columns of type `timestamp without
time zone`, across all 115 tables. No naive-datetime ambiguity exists anywhere.

**Delete behaviour is disciplined.** Of 200 foreign keys, exactly two are not
`NO ACTION`, and both are structurally correct: `journal_draft_lines` cascades
from its draft, `bank_line_matches` from its statement line. **No cascade touches
posted ledger data.** Deleting an invoice, a payment or a transaction cannot
silently take financial history with it.

**Row-level security is consistently applied where it is applied.** 89 of 115
tables have RLS, and all 89 have it both `ENABLED` and `FORCED` — no table is
half-configured, which is the state that reads as protected and is not.

---

## What this audit did not examine

Stated so the gaps are known rather than assumed covered:

- **Whether any code path reaches the 34 edges in finding 1.** Structural only.
- **Trigger logic.** Triggers were detected, not read. `ledger_transactions` and
  the journal invariants carry several; their correctness is unverified here.
- **Index quality beyond existence.** No query plans were examined; nothing here
  says an existing index is the right one.
- **The RLS policy predicates themselves.** Presence and FORCE were confirmed;
  whether each `USING` clause is correct was not re-derived.
- **Data.** The estate has no production rows. Every constraint proposed above
  needs a validation pass against real data before it is applied to a live
  database, and this audit cannot stand in for that.

---

## Appendix: reproducing the queries

Tenant-scoping gaps (finding 1) — the version that correctly excludes columns
already covered by a composite:

```sql
WITH composite_capable AS (
  SELECT DISTINCT con.conrelid AS reloid FROM pg_constraint con
   WHERE con.contype IN ('u','p')
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
            FROM unnest(con.conkey) k
            JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k)
         = ARRAY['business_id','id']::text[]
),
fks AS (
  SELECT con.conname::text cn, src.oid srcoid, src.relname::text st,
         tgt.relname::text tt, con.confrelid,
         (SELECT array_agg(a.attname::text ORDER BY x.ord)
            FROM unnest(con.conkey) WITH ORDINALITY x(k,ord)
            JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=x.k) cols
    FROM pg_constraint con
    JOIN pg_class src ON src.oid=con.conrelid
    JOIN pg_class tgt ON tgt.oid=con.confrelid
    JOIN pg_namespace n ON n.oid=src.relnamespace AND n.nspname='public'
   WHERE con.contype='f')
SELECT f.st||'.'||array_to_string(f.cols,',')||' -> '||f.tt
  FROM fks f
 WHERE f.confrelid IN (SELECT reloid FROM composite_capable)
   AND NOT ('business_id' = ANY(f.cols))
   AND EXISTS (SELECT 1 FROM information_schema.columns c
                WHERE c.table_schema='public' AND c.table_name=f.st
                  AND c.column_name='business_id')
   AND NOT EXISTS (SELECT 1 FROM fks g
                    WHERE g.srcoid=f.srcoid AND 'business_id'=ANY(g.cols)
                      AND f.cols[1]=ANY(g.cols))
 ORDER BY 1;
```

Tables with `business_id` and no RLS (finding 3, 6):

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r'
   AND EXISTS (SELECT 1 FROM information_schema.columns col
                WHERE col.table_schema='public' AND col.table_name=c.relname
                  AND col.column_name='business_id')
   AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
        OR (SELECT count(*) FROM pg_policy p WHERE p.polrelid=c.oid)=0);
```

Foreign keys leading no index (finding 4):

```sql
SELECT src.relname, con.conname
  FROM pg_constraint con
  JOIN pg_class src ON src.oid=con.conrelid
  JOIN pg_namespace n ON n.oid=src.relnamespace AND n.nspname='public'
 WHERE con.contype='f'
   AND NOT EXISTS (SELECT 1 FROM pg_index i
                    WHERE i.indrelid=con.conrelid AND i.indkey[0]=con.conkey[1]);
```

Non-integer money columns (clean result):

```sql
SELECT table_name, column_name, data_type FROM information_schema.columns
 WHERE table_schema='public'
   AND (column_name ~ '(_k|_minor|_micros|amount|price|cost|total|balance|value)$'
        OR column_name ~ '^(amount|price|cost|total)')
   AND data_type NOT IN ('bigint','integer','smallint');
```
