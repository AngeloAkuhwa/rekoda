# G-135, G-136 and G-137 in PR #437: conversation privacy, implementation and decision package

**Status (20 Nov 2026):** CODE COMPLETE in PR #437. Not merged, not deployed, STAGING ACCEPTANCE PENDING.
Revised the same day after the owner's review of `3a60b0f` (items 1 to 12); what changed is marked
"(owner review of `3a60b0f`)".

**Owner directive:** "consolidate all necessary fixes into the existing PR" (20 Nov 2026). This document
replaces the proposal of the same name written earlier that day.

**Not done.** Approval is still pending for each of these:

- The ADR 0005 Amendment 1 status. The amendment stays PROPOSED.
- The public wording in §6, which is not applied to any page.
- Any historical clean-up run.
- Every item in §5.

**Abbreviations.**

- **H**: `apps/api/src/jobs/inbound-message.handler.ts`
- **G**: `apps/api/src/privacy/gateway.service.ts`

## 1. Storage decision: placeholder-only (Option A)

The owner asked us to compare two options before building a name-span resolver:

- **Option A:** placeholder-only storage.
- **Option B:** sanitised text, kept only when deterministic checks prove it is safe.

**Option A is implemented, and no resolver was built.** The reasons:

- **Nothing reads the stored text.** `conversation_messages.body` has no production reader. `messagesFor`
  and `messagesForThread` are called only from tests. The model receives only the current message, from
  memory. No web page, ops route or portability export reads the body. Delivery receipts, drafts and
  continuations use row ids and provider ids, never the body.
- **Option B keeps a failure mode Option A removes.** A resolver can be wrong in both directions. It can
  under-redact a surname, or over-redact a product name ("Sold Chiamaka Samsung Galaxy S25"). A
  placeholder has neither risk.
- **The audit trail does not depend on the text.** The record of what a message became lives in
  `command_drafts`: the command, its supersession and confirmation, and `conversation_message_id`. It
  also lives in the ledger and in `audit_events`. None of these change.

### 1.1 What is stored now

| Path                                                                       | Stored `body`                                                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Typed text, model route (H)                                                | `[text message]`                                                                                                                 |
| Voice note (H)                                                             | `[voice note]`. The transcript is never stored.                                                                                  |
| Photo or document (H)                                                      | `[receipt photo]`. The extracted text is never stored.                                                                           |
| Deterministic route (H, unchanged)                                         | `[affirm]`, `[debtors]` and similar                                                                                              |
| Message the gateway refused (unchanged)                                    | `[message too long to read]` / `[message withheld: …]`                                                                           |
| Integrate customer thread (`customer-message.handler.ts`)                  | `[customer message]`. The text is no longer tokenised either, so a phone the customer typed creates nobody.                      |
| Every chat reply (`reply.service.ts`)                                      | `[reply]`. A reply can repeat a name nobody recorded, such as a supplier on a purchase preview or a model-written clarification. |
| Message to a customer (`waba-templates.service.ts`, `reserveCustomerText`) | `[reply]`. It is no longer tokenised.                                                                                            |
| Template sends and document deliveries (unchanged)                         | `[template <name>]`, or the document's caption or notice: its number and amount, never a name                                    |

The placeholder is written in the job's own transaction (`runner.ts`, one `withBusiness` for the whole
handler). The raw or tokenised text therefore never commits to this table, on any path:

- **Interpreter outcomes:** `refused`, `unavailable`, `unusable`, `disagreement`, a timeout, or
  `Unclear`.
- **Refusals before interpretation:** a quota or entitlement refusal, a view-only refusal, or a
  classifier stop.
- **Answers that need no model:** a continuation answer.
- **Retries and duplicates:** a throw and retry (the row rolls back, and the retry writes the
  placeholder again), a dead job (no row at all), or a duplicate webhook (deduplicated at ingress;
  `!isNew` returns).

The after-model scrub (`replaceOutsideTokens` and `setInboundBody` in the Query and write branches) is
removed, because the body never held the text.

### 1.2 What still holds the text: `external_events.payload`

The webhook body is sealed with AES-256-GCM under `VAULT_KEY` (`payload-vault.ts`). It is needed while the
message is processed: by the inbound and customer-message handlers, and by stranger handling (unattributed
events only). Dead-job recovery never reopens a WhatsApp message: it covers `payment.process` and
`billing.process` only (`DEAD_JOB_EXCEPTION_KINDS`). A finished message's body is never read again, and
one opened after erasure reads as "unreadable payload" (owner review of `3a60b0f`).

**Each event row seals only its own message** (`bodyForEvent` in `@rekoda/contracts`, applied by
`meta.controller.ts`; CodeRabbit on #437, RED first: `a webhook body batched for two businesses`). Before
this, every event sealed the WHOLE webhook body, so a body Meta batched for two businesses was held once
under each business's row, and erasing one business's rows did not reach its message's copy inside the
other's. Rows stored before this change still hold whole bodies; R1-style historical clean-up (§5) or R3
would reach them.

- **R4, built (§3):** the merchant's DELETE MY DATA now erases the payloads of finished WhatsApp
  message events.
- **R3, a proposal awaiting approval (§5):** a bounded time-based purge.

## 2. G-137 and G-135 part 2 (implemented)

### 2.1 G-137: writes name a customer only by a token issued to this message

H, before any customer is created (provisional or by mention): a non-Query command whose `customer` is
a token not in `tokens.displays` gets the following treatment.

- **What happens:**
  - The command is refused with `customerNotRecognised`, and nothing confirmable is drafted.
  - Its message unit is refunded, as for any refused request.
  - A warning is logged with the intent only.
  - **The refusal stands as the newest draft** (owner review of `3a60b0f`): an `Unclear` draft holding
    only the reply sentence, never the preview shown before the refusal.
    Reproduced first: before this, a "yes" after the refusal posted the older sale. The same held, and
    is fixed the same way, for every other sentence Rekoda answers instead of a record: on the model
    path the AI allowance exhausted, the daily ceiling, the provider down, an unusable answer and a
    document reading disagreement (`refusedAs`); outside it a voice note or photo that could not be
    fetched, read or allowed (every refusal of the two readers), a message the gateway would not hand
    on, a page the classifier called junk or refused, and an unsupported message type (`recordRefusal`).
    The refusal is a pending `Unclear` draft marked `refused`. A "yes" from the member it answered closes
    it and saves nothing: "Nothing was saved from your last message. There is still a preview waiting
    from before it…" when one is, otherwise "nothing waiting for a yes"; the next "yes" is about that
    preview, as Build 6 treats a question asked since a preview. Another member's refusal is closed and
    passed over, so it never stands between a member and their own preview. A "no" closes it too and
    never reports it as cancelled. It is never `abandoned`, which would read as a retired purchase
    question and leave the preview before it unconfirmable for good. A later, explicit preview is
    confirmed as before.
- **What counts as issued:**
  - the gateway's own tokens for this message: stored ones from the known-name pass, phones and
    emails, and provisional ones (`CUSTOMER_U…`), which the record then materialises;
  - a mention (not a token), which is resolved after the check.
- **Corrections (CG5).** A correction is re-interpreted from its own message, and the model never sees
  an earlier turn. So a correction carries the customer only if the correction itself names them. That
  was already true, and nothing changes here.

### 2.2 G-135 part 2: a phone or email nobody recorded creates no customer until a record needs one

- **In G: tokenisation.**
  - `tokenise(…, { provisional: true })` looks a phone or email up and never creates a customer.
  - An unknown one stands as `CUSTOMER_U01`, `CUSTOMER_U02` and so on. `U` is outside the Crockford
    alphabet that stored tokens are drawn from, so a provisional token can never name a recorded
    customer.
  - The token has a stored token's length, so the structural-PII probe reads it the same way.
- **In G: `materialise`.** For a record, it finds or creates each provisional customer exactly as
  `tokenise` used to, then rekeys the live token table.
- **In H: questions.**
  - A `Query` that names a provisional token is answered `customerNotKnown`, and nobody is created.
  - An `Unclear` message creates nobody.
- **In H: records (owner review of `3a60b0f`).** Customer creation follows what the record means, never
  where the model put a token. Before this revision any provisional token found anywhere in the
  serialised command was materialised, so "paid the plumber 5k, his number 0803…" created a customer when
  the model copied the token into the description. Now, only after the G-137 check (a refused record
  creates nobody):
  - **The record's own customer.** Only a sale, a payment and an order have one (`CUSTOMER_BEARING`). If
    its `customer` is a provisional token, that token is materialised: found or created, vaulted, and
    the record carries the stored token.
  - **A second facet typed beside that customer** (PR #77's owner rule: "Ada 0803… ada@…" is asked about
    in the preview, "same customer?", and never joined without a yes). It is created only when that
    question is really asked: exactly two people in the message, at least one new, the facet placed in
    none of the record's words, and only once the answer turns out to be the preview that carries the
    question (`pendingBeside`, after `acknowledge`). An arithmetic question, "which invoice?" or any other
    answer asks nothing, so the facet is never created (independent review of these fixes; RED: "a
    second facet beside a sale customer creates nobody when no preview asks about it"). Beside a name the
    model reports as a mention, only a phone can be asked about, and only when the name is new: the new
    name is the orphan and the phone the survivor, as `linkAfterMention` proposes it. A recorded name the
    merchant typed is already a stored token (the known-name pass), so a new phone beside it is asked
    about, as before.
  - **Every other phone or email** (an expense's plumber, a supplier on a purchase, a contact in an
    order's note, forwarded text, a second phone on a payment) creates nobody. Wherever the model put
    its token in the record's words, the words keep `[phone]` or `[email]` (`neutraliseTokens` in
    `@rekoda/core/privacy`): the preview reads "repairs for [phone]", and the books hold neither the
    number nor a token that would mean nothing once the job ends.
  - **A customer token in a record's words that this message was not issued** (invented, or another
    real customer's copied by the model) reads `[customer]`, so it can never resolve to that customer
    later. A token the message was issued (a recorded customer the merchant typed) is kept, as before.
  - The two-record link proposal is recomputed (`linkFor`).
- **Other callers.** Every other `tokenise` caller keeps the old behaviour.

### 2.3 Financial corrections

| Correction           | Detail                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact balance totals | `openInvoicesForCustomer`: window totals cover every open invoice; ties are ordered by number; amounts are checked as safe integers (`a821999`).                                                                                                     |
| Debtors list         | `debtorsFor` gets the same safe-integer check and a unique tie-breaker.                                                                                                                                                                              |
| Overflow reply       | A balance too large to state exactly is answered with `balanceNotStated`. The job finishes, and the merchant is never left without a reply while the job dies and is retried. This applies to the model path and to the deterministic "who owes me". |
| Wording              | "additional outstanding invoices".                                                                                                                                                                                                                   |

## 3. R4: erasure reaches the text outside the vault (implemented)

DELETE MY DATA (`eraseDataWork`, `apps/api/src/commands/privacy-commands.ts`) runs
`customersRepo.eraseTextOutsideTheVault` in the same transaction as `eraseAllIdentities`.

- **Conversation text.** `conversationsRepo.eraseStoredText` sets `[erased]` on every body of the
  business that is not one of the exact labels the product writes **in that row's direction** (owner
  review of `3a60b0f`): an inbound body is kept only as an inbound label (`[text message]`, `[affirm]`,
  `[number:2]`, `[image message]`, the gateway's refusals); an outbound body only as `[reply]`. A
  `[template name]` body is erased too (CodeRabbit on #437): the shape does not prove which writer
  made it, and erasing a label loses nothing. A merchant's pre-G-136 message typed as "[template chiamaka]" or "[reply]" is their
  words and is erased. So is anything only shaped like a label: other case, Unicode, punctuation,
  padding, a second line. A label added later and missing from the list is erased, which loses nothing.
  Document captions and notices (number and amount) are erased too.
- **Webhook payloads.** `events.eraseFinishedMessagePayloads` sets `{"erased": true}` on the business's
  `meta` `message.*` events that are finished (`processed_at` set). **Changed** (owner review of
  `3a60b0f`): the earlier rule also required `error IS NULL` unless resolved, but the customer-message
  handler writes its ordinary outcome into `error` ("assistant answered", "handed off to a human", "order
  refused: …"), so almost every Integrate customer's message kept its body after DELETE MY DATA.
  `processed_at` is set only at an end of an event's life (its handler committed, a dead job was
  reconciled, an operator resolved it), and no path reopens a finished message (§1.2), so `error` is no
  reason to keep one. The row, its error text and timing stay; a redelivery is still deduplicated by
  provider id (`meta-consent-trial`, "erasure takes two exact asks…").

**Left untouched:** events not yet processed (waiting, running, retrying, including the DELETE MY DATA
message itself), delivery-status (`status.*`) events, events with no business, and every payment
provider's event (payment evidence).

**Bounded passes (owner review of `3a60b0f`).** The earlier batches (`id IN (SELECT … ORDER BY created_at,
id LIMIT 5000)`) were planned as a nested loop over the business's whole history: one batch of a
12,345-row business took **17.7 s**, so a business with about 20,000 rows would pass the 30 s
`statement_timeout` on every attempt and its DELETE MY DATA could never complete. Each pass now
(`eraseInBatches`):

- picks at most 5,000 ids in this business, after the previous pass's last id, once (an InitPlan);
- updates them by primary key (`id = ANY (ARRAY (…))`). RLS pins the update to the business; repeating
  `business_id =` on the update side makes the planner test each row of the history against the 5,000
  ids (4 s a pass at 200,000 rows), so it is left out, and the ids come only from the scoped selection.

Measured at 200,000 rows each, with no planner statistics (the worst case): a pass took 0.17 s on
`conversation_messages` and 0.26 s on `external_events`. Conversation passes read about the rows they
erase (the `(business_id, id)` index). `external_events` has only a `business_id` index, so each of its
passes reads the business's events once: the whole erasure is about 27 passes × 0.26 s at 200,000 events,
and grows with the square of the event count beyond that (about 4 minutes at a million, extrapolated,
not measured). Every statement
stays far below the 30 s timeout at any size; what grows is the transaction. An index on
`external_events (business_id, id)` would make it linear; it needs a migration and is proposed, not built
(§5 R3).

**Transaction and failure behaviour, tested** (`erase-text-outside-vault.integration.test.ts`):

- 12,345 rows of each, across three passes, erased exactly once; another business's rows untouched; a
  second run erases nothing and writes a zero-count audit row.
- A failure after the erasure in the same transaction leaves every row as it was and writes no audit
  row; the retry then erases everything. In the chat path, `eraseDataWork` runs before the reply is
  built, so a failed pass throws, the job rolls back and retries, and the merchant is never told the
  erasure is done before it is (the reply is sent inside the job's transaction after the work, as every
  reply is).
- The job keeps its lease while it runs (heartbeat, `runner.ts`); the business's later messages wait
  behind it (OWN-74), which is the intended order for an irreversible request. Rows are locked only as
  they are erased; ingress keeps inserting new events and messages meanwhile.
- WAL: each erased row writes one new row version with a short body or `{"erased": true}`.

**Audit.** One `audit_events` row with counts only, written after both erasures in the same transaction.

**No migration.** `rekoda_app` already holds UPDATE on both columns under RLS.

**Behaviour change, flagged for the owner.** DELETE MY DATA used to delete vault identities only. It now
also blanks message text that could name a customer. The reply is unchanged and the rows stay.

## 4. Actual retention and erasure behaviour after this PR

| Data                                           | Kept                                                    | Erased by                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Conversation body, new rows                    | A placeholder only, never text                          | n/a                                                                                                    |
| Conversation body, rows written before this PR | Text until erased                                       | DELETE MY DATA (R4). Business deletion by the retention sweep (abandoned trials). R1 if approved (§5). |
| `external_events.payload` (WhatsApp messages)  | Sealed, for the life of the business                    | DELETE MY DATA, for every processed event. Business deletion. R3 if approved.                          |
| Vault identities                               | Until erased                                            | DELETE MY DATA (all), per-facet erasure, business deletion                                             |
| Drafts (`command_drafts.command`)              | Tokens, figures and item words. The supplier is nulled. | Business deletion only. Unchanged.                                                                     |
| Books                                          | 6 years (`RETENTION.financialYears`)                    | Never by erasure (`/data-deletion`)                                                                    |

**Per-customer erasure.** `eraseFacet` does not reach a pre-PR body, because no reliable link from an
old body to one customer exists. A Query about an unknown name stores `{kind: 'none'}`. New bodies hold
no text, so this limitation does not grow.

## 5. Owner approval gates (not built, or built but not run)

### R1: historical conversation text across all businesses

**Mechanism built:** `conversationsRepo.eraseStoredText(tx, businessId, { dryRun, before, limit, after })`.
It is tenant-scoped, keyset-paged and returns counts only. **Not run, and not to be run without the
owner's approval.**

**The exact eligible count** is the dry run (`dryRun: true`), which since the owner review of `3a60b0f`
counts every eligible row of the business (before, it counted at most one batch). It can only be taken
against the real database, which this session cannot reach; the figure per business is the first step
of the procedure, reported to the owner before anything is written:

```sql
-- As the migration owner, read-only, one row per business (counts only, nothing of the text):
SELECT business_id, count(*) AS eligible
  FROM conversation_messages
 WHERE created_at < :deployed_at
   AND NOT ((direction = 'inbound'  AND body ~ :inbound_labels) OR
            (direction = 'outbound' AND body ~ :outbound_labels))
 GROUP BY business_id ORDER BY eligible DESC;
```

(`:inbound_labels` and `:outbound_labels` are `INBOUND_STRUCTURAL_BODY` and `OUTBOUND_STRUCTURAL_BODY`
from `conversations.ts`, exactly.)

**Proposed procedure:**

1. Take a backup and confirm it restores (the off-box drill in `docs/runbooks/`).
2. Report the counts above to the owner. Go/no-go.
3. For each business: one transaction per pass of 5,000, `before` = the deploy time of #437, `after` =
   the previous pass's `last`, until a pass returns `last: null`. Short transactions, so no business's
   inbound messages wait behind a long one.
4. One counts-only `audit_events` row per business (as `eraseTextOutsideTheVault` writes).
5. Re-run the counts: every business must read 0.

**Recovery:** only the pre-run backup, since erased text cannot be restored. Nothing financial is
touched (the rows, drafts, books and audit stay). The runner (a script or an ops route) is **not
built**; choosing it is part of the approval.

### R2: the conversation retention commitment

`/privacy` says "Chat history and drafts: While your account is open, then 90 days"
(`RETENTION.conversationDays`). The trigger is the account **closing**, not 90 days after each message.

**What the lifecycle has today** (verified in `businesses` and the retention sweep): a trial,
paid plans with `plan_expires_at`, grace and read-only (lapsed) states, `ever_paid_at`, and one deletion,
the retention sweep's removal of an abandoned trial 90 days after it ends (with a 30-day notice). There is
no "closed" state, and a lapsed paid business is kept read-only indefinitely.

**What R2 still has to cover** after #437: not conversation text (new bodies hold none, R1 covers the
old ones), but `command_drafts.command` (tokens, figures and item words) and the sealed webhook payloads.

**Smallest viable policy, proposed (owner decision):**

- **Option A (recommended): "closed" = a business deleted at the merchant's request, or a trial
  abandoned** (both already exist). Nothing new is built; `/privacy` is reworded to say so, and to say
  that a lapsed paid account is kept read-only until the merchant asks for deletion. Risk: a lapsed paid
  merchant's drafts and payloads live indefinitely, which R3 bounds for payloads.
- **Option B: also "closed" = a paid plan lapsed for N days** (from `plan_expires_at` and the grace
  end). The retention sweep would then erase drafts' words and payloads 90 days later, with the same
  notice the abandoned-trial path sends. Risk: a merchant returning after N + 90 days finds their drafts'
  wording gone (their books are untouched). Needs a migration only if a closure timestamp is stored.

### R3: a bounded lifecycle for `external_events.payload`

**Dependencies** on the payload while a message is processed: the handlers, and stranger handling (only
for unattributed events). Dead-job recovery does not reopen WhatsApp messages (§1.2), and retries reopen
only unprocessed events, which R3 never touches. Deduplication uses `(provider, external_id)`, never the
payload, so an erased row still deduplicates a redelivery (tested).

**Proposal:** a daily sweep, per business, erases the payloads of `meta` `message.*` events finished more
than 30 days ago: R4's selection (`eraseFinishedMessagePayloads`) with a cutoff on `processed_at`, so the
30 days run from when each event finished. Today's `before` option compares `created_at`; R3 needs a
`finishedBefore` option on `processed_at` (CodeRabbit on #437).

- **No new write grant is needed.** The worker does its work on the application connection, which
  already holds UPDATE on `external_events.payload` under RLS. What the worker lacks is a way to find
  which businesses have such events without reading across tenants. Following the OWN-57 / ADR 0035
  Amendment 1 class (ID-only scheduling discovery), the migration would add one worker-only `SECURITY
DEFINER` function returning business ids only:

  ```sql
  -- PROPOSED, not applied. Needs its own line in ADR 0035 (a new ID-only discovery function).
  CREATE FUNCTION businesses_with_finished_message_payloads(p_cutoff timestamptz, p_limit int)
    RETURNS TABLE (business_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT DISTINCT e.business_id FROM external_events e
       WHERE e.business_id IS NOT NULL AND e.provider = 'meta'
         AND e.event_type LIKE 'message.%' AND e.processed_at < p_cutoff
         AND e.payload <> '{"erased": true}'::jsonb
       LIMIT least(p_limit, 200) $$;
  REVOKE ALL ON FUNCTION businesses_with_finished_message_payloads(timestamptz, int) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION businesses_with_finished_message_payloads(timestamptz, int) TO rekoda_worker;
  -- Optional, for linear passes on a large business (§3):
  CREATE INDEX CONCURRENTLY external_events_business_id_ix ON external_events (business_id, id);
  ```

  Two details to settle at approval, following the existing discovery functions (0225): which NOLOGIN
  role owns the function (it must read `external_events` across tenants, as those owners do), and that
  `CREATE INDEX CONCURRENTLY` cannot run inside the migration runner's transaction, so the index needs
  its own non-transactional step or a plain `CREATE INDEX` at a quiet time. Each business is then erased
  under `withBusiness` in short per-pass transactions, with a counts-only audit row, exactly as R1.

- **Owner approval needed:** the 30-day figure, the ADR 0035 line, and the migration.

### Public copy

`/ai-privacy` (§6). `/data-deletion` and `/privacy` are unchanged.

The `/data-deletion` line "Your conversations with Rekoda." describes the manual account-deletion
request, which a person handles (business deletion removes the rows). The page does not claim that DELETE
MY DATA erases messages, so it stays true; the reply to DELETE MY DATA also claims only the customer
details and points to the page for "your conversations and account". Nothing on it is changed here.

## 6. ADR 0005 Amendment 1 and the `/ai-privacy` wording (for approval)

The amendment text in `docs/adr/0005-pii-gateway-scope.md` is revised to match this implementation. It
stays PROPOSED.

**Proposed replacement** for the `/ai-privacy` paragraph "The first time you mention a new customer by
name…" (revised after the owner review of `3a60b0f`; **not applied** to any page):

> **Customers you have recorded.** Their names, phone numbers and email addresses are replaced with a
> token before anything is sent to the AI model, in questions and in records alike.
>
> **Someone new.** When you record a sale, invoice, payment or order for someone you have not recorded
> before, the model reads that message to understand it, and the new customer is then stored encrypted
> with their own token, so later messages that name them are protected before they leave. When you only
> ask about someone you have not recorded, Rekoda does not create a customer for them, so the model reads
> the name you typed each time you ask.
>
> **Phone numbers and email addresses.** One that Rekoda detects is replaced with a token before the
> model sees it, whether or not you have recorded that person. It becomes a customer only when it is the
> customer of a sale, invoice, payment or order, or when Rekoda asks you in the preview whether it
> belongs to the customer you named ("same customer?"). Anywhere else in a record, such as a plumber's
> number in an expense, it is saved as "[phone]" or "[email]", not as the number.
>
> **What the chat history keeps.** It records that a message arrived and what kind it was, not what it
> said. The original WhatsApp message is kept encrypted, separately, while Rekoda processes it. When you
> send DELETE MY DATA, the originals of the messages Rekoda has finished processing are erased along
> with your customers' details. Messages still being processed at that moment, delivery receipts, and
> your books are kept. A message delivered before this change together with another business's
> message can still have an encrypted copy stored with that other business's message.

What it deliberately does not claim: that every piece of personal information is always detected (the
existing caveat stays), that erasure reaches a copy stored before this change in another business's batched
webhook (§1.2), or any time limit on the encrypted originals (R3 is not approved).

### 6.1 Each claim, mapped to code and tests

| Claim                                                                                | Code                                                                              | Test                                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A record vaults a new name                                                           | H, `resolveMention`                                                               | `meta-customer-identity`; `meta-stored-body` "a sale keeps its product…"                                                          |
| A question creates nobody; the model reads the name each time                        | H Query branch, `findMention`                                                     | `meta-question-customer` "a repeated question about an unknown name…"                                                             |
| A detected phone or email is a token, recorded or not                                | G `tokenise` (`provisional`)                                                      | `meta-customer-token` "a balance question about an unknown phone number…" (the model text holds `CUSTOMER_U01`, never the digits) |
| The history records arrival, not content                                             | H, `customer-message.handler.ts`, `reply.service.ts`, `waba-templates.service.ts` | `meta-stored-body` (every case); `meta-webhook-ingress` "records everything else as what it was"                                  |
| The original is encrypted and erased by DELETE MY DATA once processed                | `payload-vault.ts`; `eraseFinishedMessagePayloads`                                | `erase-text-outside-vault.integration.test.ts`; `meta-consent-trial` "erasure takes two exact asks…" (through the chat path)      |
| A phone or email becomes a customer only as a record's customer; elsewhere "[phone]" | H, `CUSTOMER_BEARING`, `neutraliseTokens`                                         | `meta-customer-token` "customer creation follows the record…"; `meta-identity-journey`                                            |

### 6.2 Remaining limitations

1. **Free text the gateway cannot recognise.** An unrecorded name still reaches the model, which is the
   stated exception. The existing caveat ("not a claim that every possible piece of personal information
   … is always detected") stays.
2. **R1 not run.** Text stored before this PR stays until DELETE MY DATA, business deletion, or R1.
3. **R3 not approved.** WhatsApp payloads stay sealed for the life of the business unless the merchant
   erases them.
4. **R2: no closure state.** The 90-day "after the account closes" commitment has no closure state to
   run from.
5. **Payloads DELETE MY DATA does not reach.** Messages not yet processed when it runs (its own
   message included); delivery-status (`status.*`) events, which hold the recipient's phone; events with
   no business; and, for rows stored before this PR only, a message's copy inside another business's row
   when Meta batched both into one webhook body (§1.2; new rows seal only their own message). R3 as
   proposed bounds only processed `message.*` events of a business; the retention of delivery-status
   events and events with no business is left for the owner to decide (CodeRabbit on #437).
6. **The dashboard debtors view on an overflow.** A total past what can be stated exactly (more than
   about ₦90 trillion) makes `GET /v1/reports/debtors` fail rather than show a rounded figure. The chat
   reply points to the invoices list instead. This is practically unreachable, and is recorded rather
   than built.
7. **Draft item words.** These are merchant-authored financial descriptions, such as an expense "fuel
   for Emeka's car". They are kept as part of the record and are outside G-136.
8. **A long history makes a long erasure.** Every pass is short, but DELETE MY DATA erases a business's
   whole history in one transaction, and `external_events` passes each read the business's events
   (§3). The optional index in R3 removes that.
