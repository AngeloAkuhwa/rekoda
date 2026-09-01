# Adversarial security audit (R2), 1 September 2026

**Status:** findings only. No code change, no schema change, no migration.

**Baseline.** `main` at `2e4fa590e5c6dec47732c908e6fff21160b84b1b`, migration head
`0129`. Follows the R1 schema forensic audit and the owner ruling of 1 September.

**Priorities** as set in the ruling. Each section states **how deeply it was
covered**, because a security report that hides its own coverage is worth less
than one that admits it.

---

## Summary

| # | Area | Depth | Result |
|---|---|---|---|
| 1 | Reachability of the 34 tenant-FK gaps | Deep on the exposed subset | **No reachable cross-tenant write found.** The emblematic edge has no ingress at all |
| 2 | `external_events` cross-tenant access | **Answered definitively** | One estate-wide read on the application credential. Small, precise fix |
| 3 | Every `sql.raw` production site | Complete — all 6 | None exploitable. Two unescaped, safe only by provenance |
| 4 | Operator / admin authentication | Deep | Rebuilt this session (#196). No finding |
| 5 | HIGH_RISK direct execution | Deep | Closed this session (#194). No finding |
| 6 | Object-storage lifecycle | Deep | Closed this session (#197). No finding |
| 7 | Auth / IDOR / CSRF / SSRF / webhook / log / secret / DoS | **Bounded pass only** | Nothing alarming surfaced; not an exhaustive review |

---

## 1. Reachability of the 34 tenant-FK gaps

**Question.** R1 proved the database *permits* a tenant-owned row to reference
another tenant's parent on 34 edges. Does any code path reach it?

**Method.** For each edge, find every writer of the referencing column, then ask
whether the id reaches the INSERT from caller input **without** first being proved
to belong to the tenant — by a tenant-scoped fetch or an explicit `business_id`
predicate. Edges whose ids come from a row already fetched under the pin cannot be
walked.

### 1.1 The emblematic edge has no ingress at all

`goods_returns.invoice_id` is the edge that opened the whole finding, and it is
**unreachable**:

- `recordGoodsReturn` — zero non-test callers. Its only apparent "call site" is
  its own error string, `throw new Error('recordGoodsReturn: insert returned no row')`.
- `recordSupplierReturn` — zero non-test callers.
- `returnsRepo` and `goodsReturns` appear **nowhere** outside `packages/db`.

The goods-returns feature is written and not wired: structurally wrong, currently
unwalkable. The same shape as the six dormant HIGH_RISK commands.

### 1.2 Where ids do come from input, the application validates

Twelve columns take a value directly from `input.*`. Each was traced. Two
representative results, both **negative**:

**`payment_allocations.invoice_id` and `receipts.invoice_id`** — every writer uses
`invoice.id` from a row fetched as:

```sql
WHERE id = ${input.intent.invoiceId}::uuid
  AND business_id = ${input.businessId}::uuid
```

An explicit tenant predicate on top of RLS. Another tenant's invoice is not found
and the path returns before the insert.

**`bank_line_matches.transaction_id`** — this one looked reachable. The controller
takes `parsed.data.transactionId` straight from the request body and passes it
through untouched. It is still not reachable, because `matchByHand` verifies:

```ts
const open = await openMovements(tx, input.businessId, { ids: [input.transactionId] });
const movement = open.find((m) => m.transactionId === input.transactionId);
if (!movement) return { outcome: 'refused', reason: 'no_such_movement' };
```

`openMovements` is tenant-scoped, so another merchant's transaction is refused.
The code anticipates the case in a comment: *"Either it is not a bank movement of
this business at all, or somebody already claimed it."*

### 1.3 Conclusion, and what it does not license

**No reachable cross-tenant write was found.** Tenant isolation rests on **two**
layers today — application validation and RLS — and both held everywhere traced.

This does not license leaving the third layer out, and the ruling already says so:
*application reachability is not required to conclude that a tenant-owned child
must not be capable of referencing another tenant's parent.* What R2 changes is
**urgency, not direction**. The 34 are a structural defect to fix on the ruling's
schedule, not an active breach.

**Coverage caveat, stated plainly.** The twelve direct-input columns and the edges
R1 named as most exposed were traced individually. The remainder, whose writers
take ids from rows fetched under the pin, were assessed by that pattern rather
than one at a time. A path that fetched without an explicit tenant predicate and
leaned on RLS alone would still be safe today — and would stop being safe if RLS
were ever misconfigured on that table. That is precisely the argument for the
composite constraint.

---

## 2. `external_events` — the ruling's question, answered

**The question:** which credential do the operator exception-queue reads actually
run on? If `rekoda_app`, a tenant policy breaks them.

**The answer: the exception queue already runs on the worker.** One narrower read
does not.

| Path | Credential | Verdict |
|---|---|---|
| `events.exceptionQueue(this.workerDb, limit)` | **worker** | Correct already |
| `events.resolveEvent(this.workerDb, …)` | **worker** | Correct already, guarded by `if (!this.workerDb) throw ServiceUnavailable` |
| `events.eventHealth(this.db, 'meta')` | **application** | ← the only blocker |
| `events.eventHealth(this.db, 'paystack')` | **application** | ← the only blocker |

Both at `ops.controller.ts:108-109`, and both return estate-wide **counts**, not
rows.

### What this means

Applying migration 0124's pattern — a tenant policy plus a permissive worker
policy — would break **exactly two calls**, and both already sit in a handler that
injects `workerDb` and degrades honestly without it:

```ts
this.workerDb ? jobsRepo.queueHealth(this.workerDb) : Promise.resolve(null),
```

So the sequence the ruling asked for is available and small:

1. Move the two `eventHealth` calls from `this.db` to `this.workerDb`, matching
   the null-handling the same method already uses for `queueHealth`.
2. Then apply the tenant + worker policy pair to `external_events`.

That reaches the desired end state exactly: ordinary application activity sees
only its own tenant, the worker keeps its estate-wide sweep, and unattributed
events with a null `business_id` stay processable. **No estate-wide grant is
preserved for the application's benefit.**

**Ordering matters.** The policy before the credential move would break
`/v1/ops/health` on every deployment. Recommended as one PR, in that order, after
the R2 review.

---

## 3. `sql.raw` — all six sites

| Site | Interpolates | Escaped | Constrained | Verdict |
|---|---|---|---|---|
| `recognition.ts:49` | a ternary over two hardcoded strings | n/a | n/a | Safe by construction |
| `accounts.ts:30` | `ACCOUNTS[key].code`, a code-defined constant map | n/a | typed `AccountKey` | Safe |
| `reports.ts:41` | a module constant | n/a | n/a | Safe |
| `webhooks.ts:79` | `input.eventTypes` | **yes** (`'` → `''`) | **yes** (`z.enum(WEBHOOK_EVENT_TYPES)`) | Not exploitable |
| `evidence-retention.ts:64` | `evidenceIds` | **no** | no | Safe **only by provenance** |
| `evidence-retention.ts:122` | `evidenceIds` | **no** | no | Safe **only by provenance** |

### 3.1 The two unescaped sites

```ts
AND e.id = ANY(${sql.raw(`ARRAY[${evidenceIds.map((id) => `'${id}'::uuid`).join(',')}]`)})
```

No escaping whatsoever. Safe today for one reason only: the single caller passes
ids that came out of the database.

```
retention-sweep.ts:240  ->  expireEvidence(tx, businessId, ids, now)
   ids from             ->  evidenceRetentionRepo.dueForExpiry(deps.workerDb, now)
```

Uuids selected from a table, never from a request. **Not exploitable as written.**

It is still the weakest construct in the codebase, and the repository's own
comment elsewhere makes the argument better than this report can:

> *"These keys come from our own columns rather than from a request, but a
> repository that interpolates a value into SQL text teaches the next one to do
> it with a value that does."* — `object-deletions.ts`

The signature is `evidenceIds: readonly string[]`. Nothing in the type system and
nothing at the call boundary prevents a future caller passing ids from a request
body. **Recommendation: bind as parameters, or cast through `ANY($1::uuid[])`.
Hardening, not an incident.**

---

## 4. Operator and admin authentication

**No finding.** Rebuilt earlier in this session (PR #196); the audit confirms the
resulting state:

- Production verifies a signed OIDC token — issuer, audience, expiry, signature
  against a published JWKS, via `jose`.
- Five scopes; every operator route declares one; a route declaring none is
  refused 503 rather than defaulted, enforced by a test that reads the
  declarations off the controllers.
- Production **fails closed at boot** without a verifier, refuses half a
  configuration everywhere, and refuses the development secret in production.
- The audit actor is the verified subject; the caller-supplied `actor` field was
  removed from three contracts.
- 401 and 403 mean different things, and the authentication refusal stays uniform
  whatever failed.

## 5. HIGH_RISK direct execution

**No finding.** Closed earlier in this session (PR #194):

- The configuration bypass that let HIGH_RISK commands skip the bus was removed
  at all four reachable sites.
- Six of the nine HIGH_RISK commands have **no ingress at all** — registry
  entries only.
- `check-boundaries.mjs` rule 6 holds the property statically, including a thunk
  rule requiring every work function to be reached through `=>`.
- `EraseData`'s exact-phrase gate is structural in the chat router.

## 6. Object-storage lifecycle

**No finding.** Closed earlier in this session (PR #197):

- The upload route asks before it writes, so a refusal costs no bucket write.
- A compensating delete covers the race and the throw.
- The displaced key is enqueued **inside the transaction that orphans it**.
- A storage refusal falls back to the existing deletion queue rather than a log
  line.
- Two distinct reasons so an operator can tell a busy shop from a symptom.

---

## 7. Remaining boundaries — bounded pass

**Stated plainly: a sweep, not a review.** It looked for the absence of obvious
defences rather than proving each one correct. Nothing alarming surfaced, which is
a weaker claim than "these are sound".

- **Webhook signatures.** Verification is centralised in
  `packages/core/src/webhooks.ts`, with `timingSafeEqual` used there and in
  `identity.ts`, `vault.ts`, `tokens.ts` and `operator.guard.ts`. No hand-rolled
  comparison was found at a controller.
- **Secrets in logs.** No log call was found interpolating a secret, key or token.
  One message *names* a key without printing it — `'a sealed Paystack payload
  would not open — check VAULT_KEY'` — which is the correct shape.
- **SSRF.** 15 outbound `fetch` sites, all inside named provider adapters (Meta,
  Mono, Kuda, Paystack, OPay) whose base URLs come from configuration. No site was
  found taking a URL from a request. **Not verified exhaustively**, and the FX work
  will add provider endpoints where an allowlist was already required.
- **IDOR.** Partly covered by section 1: the id-from-input paths traced there are
  the same paths an IDOR attempt would use, and each validated the tenant.
- **CSRF and DoS. Not covered.** Bearer-token auth on an API surface makes
  classical CSRF unlikely, but that is an inference, not a finding.

---

## What R2 changes about the R1 rulings

| Ruling | Change |
|---|---|
| 1 — 34 tenant FKs | **Direction unchanged, urgency lowered.** No reachable write found; the emblematic edge has no ingress. Fix on schedule, not tonight |
| 2 — `external_events` | **Now actionable and small.** The blocker is two `eventHealth` calls on the wrong credential. Move them first, then apply the 0124 policy pair |
| 3 — status CHECKs | Untouched by R2; the evidence document already derived the sets |
| 4 — indexes | Untouched; still needs `EXPLAIN` evidence |
| 5 — duplicate FK | Untouched |
| 6 — sessions / magic_links | **No attack path found.** The exemption stands; the register records it |

**New, not in R1:** the two unescaped `sql.raw` interpolations in
`evidence-retention.ts`. Not exploitable; worth binding properly.

---

## What this audit did not do

- **Prove the absence of vulnerabilities.** It followed seven named paths.
- **Cover CSRF or DoS**, and only partially covered SSRF.
- **Examine the web tier** (`apps/web`) beyond its API boundary.
- **Test anything at runtime.** No exploit was attempted; every finding comes from
  reading code and the live catalogue. A negative here means "no path was found",
  not "no path exists".
- **Re-derive the RLS policy predicates.** R1 confirmed presence and FORCE;
  neither audit confirmed each `USING` clause is correct. That is the assumption
  most of section 1's negative results lean on, and it is the strongest candidate
  for a third pass.
