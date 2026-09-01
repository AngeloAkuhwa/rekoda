# RLS exemption register

Every table that carries `business_id` and does **not** have a tenant policy, with
the reason it does not, the control that stands in its place, and the credential
that reaches it.

This exists so a future audit stops rediscovering the same six tables and
re-deriving the same answers. A table on this list is exempt **on the record**.
A table with `business_id`, no policy, and no entry here is a defect, not an
exemption — that is the whole point of keeping the list.

**Baseline.** `main` at `2e4fa590`, migration head `0129`. 115 tables, 89 with
row-level security both `ENABLE`d and `FORCE`d. The six below are the remainder
that carry a tenant column.

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

## 6. `external_events`

| | |
|---|---|
| **Reason** | Nullable `business_id`: an unattributed provider event belongs to no tenant |
| **Credential** | `rekoda_app` **SELECT, INSERT, UPDATE, DELETE** across every tenant |
| **Standing control** | Payload sealed under `VAULT_KEY`; ops responses carry ids and counts, never payloads |
| **Status** | **NOT settled. Open pre-launch item** |

The only entry on this list that is not an accepted exemption.

The nullable tenant is a real architectural reason not to apply a naive policy —
and it is the same reason `pending_object_deletions` had before migration 0124,
which solved it without giving anything up:

```sql
CREATE POLICY tenant_isolation ON pending_object_deletions
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
CREATE POLICY worker_sweeps_orphans ON pending_object_deletions
  TO rekoda_worker USING (true);
```

A tenant policy plus a permissive worker policy gives the worker its estate-wide
sweep while ordinary application activity sees only its own tenant.

The open question, which the adversarial audit must answer before anything is
written: **which credential do the operator exception-queue reads actually run
on?** If they run on `rekoda_app`, a tenant policy breaks them — and the answer is
to give the operator an intentional privileged path, not to keep an estate-wide
grant for every ordinary request because one operator endpoint needs it.

---

## Adding to this register

A new table with `business_id` gets a tenant policy. If it genuinely cannot, the
migration that creates it carries the reason as a comment **and** an entry here,
naming: the reason, the lookup key, the credential, the standing control.

"It seemed like a lot of work" is not a reason. "The row must outlive its tenant"
and "the row is resolved before the tenant is known" are the two that have been
accepted so far, and both are structural.
