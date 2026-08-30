# Runbook — Data erasure (remediation R10)

The operator procedure behind every deletion promise `/data-deletion` and
`/privacy` make. Written so that the page and this procedure cannot
disagree: where the page promises a timeline, the step that meets it is
numbered here; where the page says something is kept, the step that keeps
it is named too.

There are three erasure lanes, and mixing them up is how a bookkeeping
service destroys books it was legally required to keep. Identify the lane
FIRST.

## Lane 1 — "Erase my customers" (self-service, automatic)

The merchant messages **DELETE MY DATA** on WhatsApp, from the account's
number, and confirms with the exact phrase the bot asks for (never a bare
"yes" — `EraseData` is the one command whose confirmation is a typed
phrase).

Nothing for an operator to do. The command:

- deletes every customer identity facet for that business, synchronously,
  in the same transaction (`customersRepo.eraseAllIdentities`);
- writes an `audit_events` row (`entity: customer_identities`,
  `action: erased`) recording the COUNT and never the identities;
- announces `data.erased` on the outbox, carrying the count only.

The financial records (invoices, receipts, ledger entries) survive with the
identities stripped, which is exactly what `/data-deletion` § "What we must
keep" promises. Verify after the fact, if asked:

```sql
-- as the owner; the audit row is the receipt
SELECT created_at, new_value, reason FROM audit_events
WHERE business_id = '<id>' AND entity = 'customer_identities'
ORDER BY created_at DESC LIMIT 5;
```

One thing this lane deliberately does NOT remove: `customer_message_optouts`
(PR-135). A customer who told that shop to stop messaging them is recorded
under the participant blind index, not under a customer identity, and it
holds no phone number to erase. Deleting those rows would resume messaging
somebody who asked not to be messaged, which is the opposite of what an
erasure lane is for. Both application roles have DELETE revoked on that
table for the same reason; only lane 2, deleting the whole business, takes
it, and only because there is no shop left to message from.

## Lane 2 — Full account deletion, on request (operator-executed)

The lane behind `/data-deletion`'s 48-hour acknowledgment and 30-day
completion. This one is manual on purpose: a deletion request nobody
verified is a way to erase someone else's books, and a full deletion is
not undoable by anybody.

1. **Log the request** the day it arrives: date, channel (WhatsApp or the
   privacy email), the account it names. The 30-day clock starts now.
2. **Acknowledge within 48 hours**, on the same channel, saying what will
   happen and when.
3. **Verify identity**: the request must come from the account's own
   WhatsApp number, or from an email address that can complete the
   dashboard sign-in for that account. Anything else is refused politely
   with the reason.
4. **Offer the narrower thing once.** Most people asking for deletion want
   the messages to stop (`STOP`) or their customer identities gone
   (lane 1). Say so once, plainly. If they still want full deletion,
   proceed — this step is a courtesy, never a stall.
5. **Remind them to export.** The dashboard's full export keeps working on
   a lapsed subscription; after deletion there is nothing to export.
6. **Run lane 1 first** (or confirm it already ran): customer identities
   go immediately, whatever the remaining steps' timing.
7. **Delete the non-financial estate** as the owner, tenant-pinned:
   conversations and drafts, sessions and sign-in history, provider
   connections (Paystack/OPay/Kuda credentials, the WABA connection, bank
   connections), products and shop pages, the business profile. The
   `retention_delete_business` function is NOT this tool — its predicate
   only accepts abandoned trials (lane 3). This lane's deletions are
   executed as owner SQL against the named business id, and each batch is
   recorded in the incident-free change log below.
8. **Keep what the law keeps**: invoices, receipts, ledger entries and the
   journal survive until the financial retention period (`RETENTION.financialYears`,
   published on `/privacy#retention`) has elapsed for their year — with
   identities already stripped by step 6. Do not invent a shorter or
   longer period under pressure; the schedule is the schedule.
9. **Write the confirmation** the page promises: what was deleted, what
   was kept, the retention period the kept records die at, and the audit
   reference. Send it on the verified channel, within the 30 days.
10. **Record completion**: request date, verification method, completion
    date, and the confirmation text sent, kept with the privacy
    correspondence. This record is itself personal data; it is kept
    because demonstrating the deletion happened requires it.

## Lane 3 — Abandoned trials (automatic sweep, notice first)

`sweepRetention` deletes businesses whose trial ended
`RETENTION.abandonedTrialDays` ago, only after a notice was sent
`RETENTION.noticeDays` before, and only when the business has never paid
(`retention_delete_business` refuses anything with a paid or refunded
charge — a refusal, `-1`, is the system working, never an error to retry).
Deletions are receipted in `retention_deletions`, which survives the
tenant. Nothing for an operator to do except read the receipts:

```sql
SELECT business_id, reason, rows_deleted, deleted_at
FROM retention_deletions ORDER BY deleted_at DESC LIMIT 20;
```

## What this runbook refuses to do

- Delete financial records inside their retention period, for anyone,
  however firmly they ask. The page says so; this procedure is why the
  page is true.
- Delete on an unverified request, however urgent it sounds.
- Improvise a retention period. Every period this runbook honours is in
  `@rekoda/core`'s `RETENTION` and published on `/privacy#retention`; if a
  case seems to need a different number, that is an owner decision and a
  page change, in that order, never an operator improvisation.
