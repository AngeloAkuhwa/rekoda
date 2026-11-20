# G-135, G-136 and G-137 in PR #437: conversation privacy, implementation and decision package

**Status (20 Nov 2026):** CODE COMPLETE in PR #437. Not merged, not deployed, STAGING ACCEPTANCE PENDING.

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
| Deterministic route (H, unchanged)                                         | `[affirm]`, `[who_owes_me]` and similar                                                                                          |
| Message the gateway refused (unchanged)                                    | `[message too long to read]` / `[message withheld: …]`                                                                           |
| Integrate customer thread (`customer-message.handler.ts`)                  | `[customer message]`. The text is no longer tokenised either, so a phone the customer typed creates nobody.                      |
| Every chat reply (`reply.service.ts`)                                      | `[reply]`. A reply can repeat a name nobody recorded, such as a supplier on a purchase preview or a model-written clarification. |
| Message to a customer (`waba-templates.service.ts`, `reserveCustomerText`) | `[reply]`. It is no longer tokenised.                                                                                            |
| Template sends and document deliveries (unchanged)                         | `[template <name>]` and the document caption, which already held no name                                                         |

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
message is processed: by the handler, by stranger handling, and by dead-job recovery.

- **R4, built (§3):** the merchant's DELETE MY DATA now erases the payloads of finished WhatsApp
  message events.
- **R3, a proposal awaiting approval (§5):** a bounded time-based purge.

## 2. G-137 and G-135 part 2 (implemented)

### 2.1 G-137: writes name a customer only by a token issued to this message

H, before any customer is created (provisional or by mention): a non-Query command whose `customer` is
a token not in `tokens.displays` gets the following treatment.

- **What happens:**
  - The command is refused with `customerNotRecognised`, and nothing is drafted.
  - Its message unit is refunded, as for any refused request.
  - A warning is logged with the intent only.
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
- **In H: records.**
  - A record that names a customer, or carries a provisional token in any field, materialises the
    provisional tokens. This happens only after the G-137 check, so a refused record creates nobody.
  - Every string field of the command then carries the stored token (`withTokensReplaced`).
  - The two-record link proposal is recomputed (`linkFor`).
  - An expense that only mentions a phone creates nobody.
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
`customersRepo.eraseTextOutsideTheVault`. This is in the same transaction as `eraseAllIdentities`, and in
bounded batches of 5,000.

- **Conversation text.** `conversationsRepo.eraseStoredText` sets `[erased]` on every body of the
  business that is not already a structural placeholder. That is text written before this PR.
- **Webhook payloads.** `events.eraseFinishedMessagePayloads` sets `{"erased": true}` on the business's
  `meta` `message.*` events that were processed without error, or whose error an operator resolved.

**Left untouched:** events still in flight, failed and unresolved events, and every payment provider's
event (those are payment evidence).

**Audit.** One `audit_events` row with counts only.

**No migration.** `rekoda_app` already holds UPDATE on both columns under RLS.

**Behaviour change, flagged for the owner.** DELETE MY DATA used to delete vault identities only. It now
also blanks message text that could name a customer. The reply is unchanged and the rows stay.

## 4. Actual retention and erasure behaviour after this PR

| Data                                           | Kept                                                    | Erased by                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Conversation body, new rows                    | A placeholder only, never text                          | n/a                                                                                                    |
| Conversation body, rows written before this PR | Text until erased                                       | DELETE MY DATA (R4). Business deletion by the retention sweep (abandoned trials). R1 if approved (§5). |
| `external_events.payload` (WhatsApp messages)  | Sealed, for the life of the business                    | DELETE MY DATA, for finished events. Business deletion. R3 if approved.                                |
| Vault identities                               | Until erased                                            | DELETE MY DATA (all), per-facet erasure, business deletion                                             |
| Drafts (`command_drafts.command`)              | Tokens, figures and item words. The supplier is nulled. | Business deletion only. Unchanged.                                                                     |
| Books                                          | 6 years (`RETENTION.financialYears`)                    | Never by erasure (`/data-deletion`)                                                                    |

**Per-customer erasure.** `eraseFacet` does not reach a pre-PR body, because no reliable link from an
old body to one customer exists. A Query about an unknown name stores `{kind: 'none'}`. New bodies hold
no text, so this limitation does not grow.

## 5. Owner approval gates (not built, or built but not run)

### R1: historical conversation text across all businesses

**Mechanism built:** `conversationsRepo.eraseStoredText(tx, businessId, { dryRun, before, limit })`. It
is tenant-scoped, bounded, and returns a count only.

**Proposed procedure:**

1. Take a backup.
2. For each business, run `dryRun: true` with `before` set to the deploy time. Report counts only.
3. Get an owner go/no-go.
4. Run in batches of 5,000.
5. Write one counts-only audit row per business.

**Recovery:** the pre-run backup only, since erased text cannot be restored. The runner (a script or
ops route) is **not built**. Choosing it is the approval.

### R2: the conversation retention commitment

`/privacy` says "Chat history and drafts: While your account is open, then 90 days"
(`RETENTION.conversationDays`).

- **What triggers it.** The trigger is the account **closing**, not a rolling 90 days.
- **The gap.** No account-closure state exists in the schema. The only deletion is the retention
  sweep's abandoned-trial deletion.
- **Decision needed:** define "closed". The options are a business deleted by request, a lapsed paid
  plan, or a separate closure state. Then the sweep can be built: it would remove bodies, drafts and
  payloads 90 days after closure. New bodies already hold no text.

### R3: a bounded lifecycle for `external_events.payload`

**Dependencies** on the payload while a message is processed:

- the handler;
- stranger handling (only for unattributed events);
- dead-job recovery (it requeues a dead job, which reopens the payload).

**Proposal:** a daily sweep sets `{"erased": true}` on `meta` `message.*` events of every business that
were finished more than 30 days ago (`processed_at`), are not open as an exception, and are not dead.
The selection is the same as R4, with a time cutoff.

- **Needs a migration.** The worker holds UPDATE on `(processed_at, error)` only (0204, 0210). Writing
  `payload` from the worker needs `GRANT UPDATE (payload) ON external_events TO rekoda_worker`, or a
  worker-only `SECURITY DEFINER` function that reaches each business through its own tenant pin.
- **ADR 0035.** That is a new cross-tenant write, so it needs its own line in ADR 0035.
- **Status.** The exact SQL is to be shown at approval. It is not written here.

### Public copy

`/ai-privacy` (§6). `/data-deletion` and `/privacy` are unchanged.

The `/data-deletion` line "Your conversations with Rekoda." describes the manual account-deletion
request, which a person handles. Its text part is now also true for DELETE MY DATA.

## 6. ADR 0005 Amendment 1 and the `/ai-privacy` wording (for approval)

The amendment text in `docs/adr/0005-pii-gateway-scope.md` is revised to match this implementation. It
stays PROPOSED.

**Proposed replacement** for the `/ai-privacy` paragraph "The first time you mention a new customer by
name…":

> When you record a sale, invoice, payment or order for someone new, the model reads that message to
> understand it, and their name is then stored encrypted with its own token, so later messages that name
> them are protected before they leave. When you only ask about someone you have not recorded, Rekoda
> does not create a customer for them, so the model reads their name each time you ask. A phone number or
> email address Rekoda detects is replaced with a token, whether or not you have recorded that person.
> Rekoda's chat history records that a message arrived, not what it said. The original WhatsApp message
> is kept encrypted, separately, and is erased when you send DELETE MY DATA, apart from a message Rekoda
> is still processing or could not process and is holding for review.

(Revised after the independent review of `e15b63a`: "detects" instead of "always", and messages held for
review named.)

### 6.1 Each claim, mapped to code and tests

| Claim                                                                                     | Code                                                                              | Test                                                                                                                              |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A record vaults a new name                                                                | H, `resolveMention`                                                               | `meta-customer-identity`; `meta-stored-body` "a sale keeps its product…"                                                          |
| A question creates nobody; the model reads the name each time                             | H Query branch, `findMention`                                                     | `meta-question-customer` "a repeated question about an unknown name…"                                                             |
| A detected phone or email is a token, recorded or not                                     | G `tokenise` (`provisional`)                                                      | `meta-customer-token` "a balance question about an unknown phone number…" (the model text holds `CUSTOMER_U01`, never the digits) |
| The history records arrival, not content                                                  | H, `customer-message.handler.ts`, `reply.service.ts`, `waba-templates.service.ts` | `meta-stored-body` (every case); `meta-webhook-ingress` "records everything else as what it was"                                  |
| The original is encrypted and erased by DELETE MY DATA, except in-flight or held messages | `payload-vault.ts`; `eraseFinishedMessagePayloads`                                | `erase-text-outside-vault.integration.test.ts`; `meta-consent-trial` "erasure takes two exact asks…" (through the chat path)      |

### 6.2 Remaining limitations

1. **Free text the gateway cannot recognise.** An unrecorded name still reaches the model, which is the
   stated exception. The existing caveat ("not a claim that every possible piece of personal information
   … is always detected") stays.
2. **R1 not run.** Text stored before this PR stays until DELETE MY DATA, business deletion, or R1.
3. **R3 not approved.** WhatsApp payloads stay sealed for the life of the business unless the merchant
   erases them.
4. **R2: no closure state.** The 90-day "after the account closes" commitment has no closure state to
   run from.
5. **Payloads DELETE MY DATA does not reach.** Messages still in flight; messages that failed and await
   review (processed with an error and not resolved), including those flagged with a reason such as
   "participant did not normalise"; delivery-status (`status.*`) events, which hold the recipient's
   phone; and a batched webhook body that carried two businesses' messages, because each business's row
   holds the whole sealed body. R3 would bound all of these by time.
6. **The dashboard debtors view on an overflow.** A total past what can be stated exactly (more than
   about ₦90 trillion) makes `GET /v1/reports/debtors` fail rather than show a rounded figure. The chat
   reply points to the invoices list instead. This is practically unreachable, and is recorded rather
   than built.
7. **Draft item words.** These are merchant-authored financial descriptions, such as an expense "fuel
   for Emeka's car". They are kept as part of the record and are outside G-136.
