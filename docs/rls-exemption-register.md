# RLS exemption register

Every table that carries `business_id` and does **not** have a tenant policy, with
the reason it does not, the control that stands in its place, and the credential
that reaches it.

This exists so a future audit stops rediscovering the same tables and re-deriving
the same answers. A table on this list is exempt **on the record**. A table with
`business_id`, no policy, and no entry here is a defect, not an exemption — that
is the whole point of keeping the list.

**Baseline.** Migration head `0130`. **Five** live exemptions: section 6,
`external_events`, was the sixth and is now closed. It is kept below rather than
deleted, because the reason it was open is the useful part.

**This register is enforced.** `packages/db/src/rls-invariants.integration.test.ts`
carries the live exemptions as an `EXEMPT` map and fails if a table with
`business_id` has no policy and no entry here — and fails the other way too, if an
entry here has since gained a policy and no longer needs one. That second
direction is what removed `external_events` from the map: the test refused to
pass while the register still called an exempt table something it no longer was.

The same suite pins the other four invariants this register depends on: RLS is
`ENABLE`d **and** `FORCE`d wherever it is on; every `USING (true)` policy belongs
to `rekoda_worker` and never to `rekoda_app` or `PUBLIC`; every tenant predicate is
written identically, with four **policies** excepted by name (see the test); and
no policy's `WITH CHECK` differs from its `USING`.

**Query that produces this list** — run it after any migration that adds a table
with `business_id`:

```sql
SELECT c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND EXISTS (SELECT 1 FROM information_schema.columns col
                WHERE col.table_schema = 'public' AND col.table_name = c.relname
                  AND col.column_name = 'business_id')
   AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 0;
```

---

## 1. `sessions`

| | |
|---|---|
| **Reason** | Resolved **before** the tenant is known |
| **Lookup key** | `sessions_token_ux`, a UNIQUE index on `token_hash` |
| **Credential** | `rekoda_app` (SELECT, INSERT, UPDATE, DELETE) |
| **Standing control** | Unguessable hashed bearer token |
| **Status** | Exempt. Correct as designed |

A tenant policy here is a circular dependency, not a control:

```
to set app.business_id you must know the business
   -> to know the business you must read the session
      -> to read the session you would need app.business_id
```

The security boundary is a different one and it is sound: a caller presents a
token, the token is hashed, and the row is found by a unique index on that hash or
not at all. Possession of the token *is* the authorisation to learn which business
it belongs to. Nothing about the row is reachable by guessing a `business_id`.

**Do not add a tenant policy to this table for consistency.** It would break sign-in
and buy nothing.

## 2. `magic_links`

| | |
|---|---|
| **Reason** | Identical to `sessions` — resolved before the tenant is known |
| **Lookup key** | `magic_links_token_ux`, a UNIQUE index on `token_hash` |
| **Credential** | `rekoda_app` (SELECT, INSERT, UPDATE, DELETE) |
| **Standing control** | Unguessable hashed single-use token, with `expires_at` and `used_at` |
| **Status** | Exempt. Correct as designed |

The sign-in link Rekoda sends to a merchant in chat. Same circular dependency, same
resolution, with two extra controls the session does not have: the link expires, and
`used_at` makes it single-use.

## 3. `retention_deletions`

| | |
|---|---|
| **Reason** | The row's purpose is to **outlive** the tenant it names |
| **Credential** | `rekoda_app` SELECT only; `rekoda_worker` INSERT, SELECT |
| **Standing control** | Holds nothing worth isolating; no write path from the application |
| **Status** | Exempt, documented at migration 0022 |

A policy keyed on a business that has just been deleted matches nothing, which
would make the row unreachable by every credential — precisely the failure the
table exists to prevent. It records that a deletion happened: a business id, a
reason, a row count, a timestamp. No names, no amounts, no content.

`rekoda_app` holds SELECT across tenants. Low sensitivity, and worth a second look
if the table ever gains a column that is not a count.

## 4. `platform_cost_events`

| | |
|---|---|
| **Reason** | Rekoda's own cost ledger, not a tenant's. Margin surfaces read it **across** businesses by design |
| **Credential** | `rekoda_app` **INSERT only**; `rekoda_worker` INSERT, SELECT |
| **Standing control** | The application cannot read it at all — no SELECT grant |
| **Status** | Exempt, documented at migration 0124 |

The exemption is carried by the grant rather than by a policy, which is the
stronger of the two: `rekoda_app` cannot read one business's costs, let alone
another's, because it holds no SELECT.

**Note for the FK remediation:** `business_id` here is **nullable**, which means a
composite foreign key on `(business_id, payment_id)` would be silently unenforced
under `MATCH SIMPLE` for any row with a null tenant. See the remediation plan.

## 5. `migration_manifest_items`

| | |
|---|---|
| **Reason** | A one-off migration artefact |
| **Credential** | **None.** Neither application role holds any grant |
| **Standing control** | Unreachable except by the table owner |
| **Status** | Exempt. Not a leak |

Appears in the query above because it carries `business_id`, but no application
role can read or write it at all. Listed so it is not re-investigated.

## 6. `external_events` — CLOSED by migration 0130

| | |
|---|---|
| **Reason** | Nullable `business_id`: an unattributed provider event belongs to no tenant |
| **Credential** | `rekoda_app` sees its own tenant, plus the unattributed backlog. Nothing else |
| **Standing control** | Three policies (below), FORCE ROW LEVEL SECURITY, and the invariant test |
| **Status** | **Settled.** No longer an exemption |

This entry stays because the register is read by people asking why a table is
missing from it, and because the reason it was open is worth keeping.

The nullable tenant was a real architectural constraint, not an excuse: an event
arrives before anyone knows whose it is, so a policy keyed on `app.business_id`
alone would reject the very insert that decides it. What did not follow is the
conclusion drawn from it, that the whole table had to stay open to the
application role.

Three policies, and the third is the one that does the work:

```sql
CREATE POLICY tenant_isolation ON external_events
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
CREATE POLICY worker_reads_the_estate ON external_events
  TO rekoda_worker USING (true);
CREATE POLICY app_records_unattributed_ingress ON external_events
  TO rekoda_app USING (business_id IS NULL);
```

An event with no `business_id` belongs to nobody yet, so letting the ingress
store and dedupe one is not letting it read another tenant's event. The moment
the attribution pump sets `business_id`, the row leaves that view for good.

### The question this register asked, answered

> **which credential do the operator exception-queue reads actually run on?**

`rekoda_worker`, and they always did: `exceptionQueue` and `resolveEvent` were
already on the worker credential. Two calls were not — the estate-wide event
counts on `/v1/ops/health` — and they moved before the policy landed rather than
being used as a reason to keep an estate-wide grant for every ordinary request.
That is the answer the register asked for and the one the owner ruling required.

### Two changes had to ship first

A policy is a **contraction** in the runbook's expand -> deploy -> contract
sense: it removes visibility the running release depends on. Both prerequisites
deployed ahead of it, or the window between `migrate` and the container swap
would have been broken:

1. the health counts moved to the worker credential, or the endpoint reports
   zeros — silently, because row-level security filters rather than errors;
2. `recordEvent` stopped reading the conflicting row back, or every provider
   retry of an already-attributed event raises. `ON CONFLICT DO NOTHING`
   against a row the credential cannot see does nothing quietly, so the
   read-back found nothing and the old code threw — a 500 to a provider that
   had already been heard, until it disabled the webhook.

---

## Adding to this register

A new table with `business_id` gets a tenant policy. If it genuinely cannot, the
migration that creates it carries the reason as a comment **and** an entry here,
naming: the reason, the lookup key, the credential, the standing control.

"It seemed like a lot of work" is not a reason. "The row must outlive its tenant"
and "the row is resolved before the tenant is known" are the two that have been
accepted so far, and both are structural.
