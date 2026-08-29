# Runbook — Incident triage

Written to be executed by a person under stress. Numbered steps, exact
commands, no prose detours. Every read here is an operator credential, never
a merchant session: nothing in it names a customer.

## First: is money still moving?

The one question that ranks every other. Poll, in order:

```bash
# 1. Is the estate healthy at all?
curl -fsS -H "x-rekoda-operator-secret: $REKODA_OPERATOR_SECRET" \
  https://api.rekoda/v1/ops/health | jq

# 2. Are the books still consistent? (§31 invariants, live)
curl -fsS -H "x-rekoda-operator-secret: $REKODA_OPERATOR_SECRET" \
  https://api.rekoda/v1/ops/financial-integrity | jq
```

`/v1/ops/health` reports the job queue, and the Meta and Paystack event
health. `/v1/ops/financial-integrity` reports the four invariants that are
NOT enforced by a constraint (PR-104): unbalanced journals, paid invoices
with no money trail, settlement drift, and dead outbox events, each with a
business id when nonzero. **Every count here should be zero forever.** A
nonzero is the incident.

## Triage table

| Symptom (from the probes)                     | Almost certainly            | Do this                                                                 |
| --------------------------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `queue.dead > 0`                              | A handler is throwing       | Read the job's `last_error` (owner SQL, below); fix code, redeploy; dead jobs do NOT auto-retry, re-enqueue after the fix |
| `meta.badSignatures` or `paystack` climbing   | Key rotation, or a probe    | Check whether `META_APP_SECRET` / Paystack secret was just rotated; if not, it is someone probing an unauthenticated route — the HMAC already rejects them, so this is a detection signal, not a breach |
| `financial-integrity.unbalancedJournals > 0`  | **STOP.** A trigger was circumvented | This is the worst signal the estate can emit (the balance trigger is supposed to make it impossible). Freeze writes if you can, snapshot the database, and reconstruct from the last green recovery drill point |
| `paidWithoutSettlement > 0`                    | A status flipped without its allocation | Named business id: read its invoices and payment_allocations; a paid invoice with no allocation and no applied credit is either a bug or a manual edit |
| `settlementDrift > 0`                          | An ingested settlement stopped reconciling | Named business id: net should equal gross less deductions plus additions; re-check the provider report against the stored components |
| `deadOutboxEvents > 0`                         | A subscriber never got an announcement | The event is VISIBLE by design (§26), never lost; decide per event whether to re-dispatch |

## Reading a job's failure, as the owner

```sql
-- The runner persists the thrown reason; state is 'dead' after max_attempts.
SELECT id, kind, state, attempts, last_error
FROM jobs WHERE state = 'dead' ORDER BY updated_at DESC LIMIT 20;
```

## Provider outage

Meta and Paystack both **retry** their webhooks, and every inbound is
idempotent on `(provider, external_id)` before any side effect. So a webhook
outage on our side is self-healing on recovery: do NOT replay by hand. Watch
`meta` / `paystack` event health recover on its own, and confirm the queue
drains.

- Meta status: https://metastatus.com/
- Paystack status: https://status.paystack.com/

## Comms

An incident that touched merchant money or data is a privacy matter, not
just an operational one: switch to `privacy-security-incident.md`, whose
Phase C holds the notification decision points (NDPC, data subjects,
providers) — those are DPCO/legal decisions, never made from this runbook.
Do not send merchant-facing comms that name a specific customer's data
without the owner's sign-off.

## Escalation to a restore

If `unbalancedJournals` is nonzero and cannot be explained, this is a
data-integrity incident, not a bug: follow `backup-restore.md` → "Real
restore (incident)". The recovery drill in CI is the proof that the restore
path produces a database that still ties.
