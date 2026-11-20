# G-136 and ADR 0005 Amendment 1: conversation privacy decision package

**Status: PROPOSAL, NOT APPROVED (20 Nov 2026).** Prepared for the owner directive "PR #437:
consolidated owner directive, privacy corrections and final merge readiness" (20 Nov 2026). Nothing here
is accepted, published or executed:

- ADR 0005 Amendment 1 stays PROPOSED.
- The public `/ai-privacy` wording below is not applied.
- No historical cleanup runs.

Every fact below was read in code at PR #437 head `8c073b3` plus `a821999`. File references are
repository paths. Abbreviations: **H** is `apps/api/src/jobs/inbound-message.handler.ts`, **C** is
`packages/db/src/repos/conversations.ts`.

## 1. What is true today (verified)

### 1.1 Where message text is stored

| Store                                   | What it holds                                                                                                                                                                                                                           | Lifecycle                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external_events.payload`               | The whole Meta webhook body, the typed text included, sealed with AES-256-GCM under `VAULT_KEY` (`apps/api/src/channels/meta.service.ts`, `payload-vault.ts`)                                                                           | **Never purged** for a live business. Deleted only with the whole business, by the retention sweep's abandoned-trial deletion (`retention_delete_business`, 0161)       |
| `conversation_messages.body` (inbound)  | `tokenise(text).text`, written before the model call (H, typed text: `recordInbound`; voice note or photo: `setInboundBody` over the claim placeholder). Known names, phones, emails and accounts are tokens; **unknown names are raw** | Rewritten only by the mention scrub after a successful interpretation (H, Query and write branches of `interpretedReply`). Never deleted or expired for a live business |
| `conversation_messages.body` (outbound) | The tokenised reply text (`apps/api/src/replies/reply.service.ts`). A model-written clarification question passes through verbatim (`replies.clarification`), so it can echo an unknown name                                            | Same as inbound                                                                                                                                                         |
| `command_drafts.command`                | The command after mention resolution: customer as a token, `supplierMention` nulled                                                                                                                                                     | Draft lifecycle                                                                                                                                                         |
| `jobs.payload`                          | `{ eventId }` only                                                                                                                                                                                                                      | n/a                                                                                                                                                                     |
| Logs, `usage_events.meta`               | No text, prompt or name (observability contract)                                                                                                                                                                                        | n/a                                                                                                                                                                     |

**`conversation_messages.body` has no production reader.**

- `messagesFor` and `messagesForThread` (C) are called only from integration tests.
- The model receives only the current message (H, `interpret(businessId, safeText, { tokens })`).
- No web page, ops route or portability export reads the body.

So the stored body is retained text with no runtime purpose. Replacing it with a placeholder breaks nothing
the product does.

### 1.2 Transaction boundary

The whole handler, the inbound insert, the model call and the scrub included, runs in the job's one
`withBusiness` transaction (`apps/api/src/jobs/runner.ts`). A throw rolls back the inbound row and its body
together. A retry inserts it again. A dead job leaves **no** inbound row, so its text survives only in the
sealed `external_events.payload`.

A duplicate webhook is deduplicated at ingress (`recordEvent`). A re-run with `!message.isNew` returns
before anything is rewritten.

### 1.3 What stays in the body today, path by path

The mention scrub runs only when interpretation returns a command whose customer is a `mention`. Every
other path keeps `tokenise(text).text` as stored, unknown names in full:

- **The account cannot use Chat:** expired plan, not entitled to Chat, or quota exhausted.
- **A view-only member is refused**, before the model or after it (a message read as a write).
- **The model gives no usable answer:** outcome `refused`, `unavailable`, `unusable` or `disagreement`.
- **The command carries no customer mention:** intent `Unclear`, or any command without a customer field.
- **The photo classifier stops the page** (junk or refused).
- **A continuation answer:** the model is not called.
- **A supplier name** in a purchase: it is vaulted and nulled in the draft, but never scrubbed from the body.
  This contradicts H's own comment "Supplier names are never persisted (ADR 0005)".
- **The Integrate customer thread** (`customer-message.handler.ts`): its body is tokenised and never scrubbed.
- **A partial or reworded mention** ("Chiamaka" returned for "Chiamaka Okafor"): the remaining words stay.
  The test `scrubs only the words of the name the model returned (G-136)` pins `[name] Okafor`.
- **A decomposed (NFD) typed name with a composed mention:** `replaceOutsideTokens` does no Unicode
  normalisation, so nothing matches and the whole name stays (_inferred from the code_; covered by the
  tests in §3.7).

### 1.4 Erasure and retention against public claims

- **Two-ask erasure.** `eraseAllIdentities` and `eraseFacet` delete vault identities only. Neither touches
  `conversation_messages` or `external_events`.
- **Retention.** `RETENTION.conversationDays = 90` (`packages/core/src/retention.ts`) is read only by the
  `/privacy` page ("Chat history and drafts: while your account is open, then 90 days"). No code enforces
  it.
- **`/data-deletion`** lists "Your conversations with Rekoda." among what DELETE MY DATA removes. The code
  does not delete them. **This is a material contradiction, recorded in the G-136 row.**
- **`docs/compliance/record-of-processing.md`** says "payload vault for message bodies". That is true of
  `external_events`, not of `conversation_messages.body`.

## 2. PR sequencing and the #437 delta (directive §6)

### 2.1 Pre-existing, unchanged by #437

All of the following predate #437. #437 changes none of them:

- partial and reworded scrubs;
- every failure path in §1.3;
- supplier names;
- the Integrate thread;
- `external_events.payload` retention;
- the erasure gap.

### 2.2 What #437 changes

Before #437, the first successful question about an unrecorded name **created a customer**. That is the
defect BA-OD-3 forbids. It also had a side effect: later messages naming that person were tokenised
before storage.

After #437 the name is never vaulted. So, until a write records the person:

- **Model exposure.** Each later message carries the name to the model. This is the exception Amendment 1
  states (§4).
- **Storage.** A later message whose processing returns before the scrub (§1.3) keeps the raw name in
  `conversation_messages.body`. A successful later question scrubs the returned words, exactly as before
  #437.

**This is a widening, but a bounded one.** It covers only names a merchant asked about and never
recorded, only on failure or no-mention paths, and only for text that no production code reads. It is
the same exposure every first mention of every new name has today.

### 2.3 Can a small fix inside #437 close it?

**No.** The paths that keep the name never reach the Query branch #437 changed, so closing them is the
G-136 change itself (§3.4).

### 2.4 Would splitting leave the public copy materially wrong?

**Yes, for one sentence.** Today's `/ai-privacy` paragraph ("the model reads that one message … every
later message that names them is protected before it leaves") stops being true for questions the moment
#437 merges. So:

- **The model-exposure wording (§4.2) must land in #437**, once approved, together with Amendment 1.
- **The storage sentence ("nothing keeps a readable copy") is already untrue before #437** (§1.3). The
  directive says not to weaken it to excuse a correctable defect. It is corrected at source by the G-136
  PR. Until that PR merges, the contradiction is recorded in the G-136 row, and Rekoda has no real users
  (pre-launch, staging only).

### 2.5 Recommended sequence

1. **#437 (this PR).** G-135 part 1, the financial checks of directive §8 (`a821999`), Amendment 1 and the
   §4.2 copy, applied **only after owner approval** of their exact text.
2. **G-136 PR.** Store-side sanitisation (§3.1 to §3.5) and the fixes that need no owner decision (§3.6).
   P1. It must merge before launch.
3. **G-136 data-lifecycle PR,** after the owner approves §3.6. It covers conversation retention,
   `external_events.payload` purge, and erasure reach.
4. **G-137 PR.** The write-path token check (§5).
5. **G-135 part 2 PR.** A phone or email in a question resolved provisionally. Unchanged plan.

## 3. G-136 engineering design (proposal)

### 3.1 Principle: fail closed at the store, precise only when certain

**The body written before the model is never the raw tokenised text again.**

The inbound row is written as today, but its body is a structural placeholder: `[text message]`,
`[voice note]` or `[receipt photo]`, as the claim paths already use. The handler keeps the tokenised text
in memory (`safeText`) for the model call.

At the end of processing, **one** function decides the stored body:

1. **Deterministic route.** `describeIntent(intent)`, as today.
2. **Gateway refusal (`unread`).** The existing `UNREAD_MESSAGE` placeholder, as today.
3. **Interpreted command whose every name span is resolved with high confidence (§3.2).** The sanitised
   text, with names replaced by their token or `[name]` and structural PII redacted, as today.
4. **Every other path** (all of §1.3, low confidence, no mention returned, a model failure, refusal or
   timeout, a view-only or quota refusal, a classifier stop, a continuation answer): the placeholder
   stays. Nothing else is written.

Because the insert and the final write share the job transaction (§1.2), the placeholder-then-final
order never commits the raw text. A throw, a worker crash or a timeout rolls the row back. A dead job
leaves no row. The sealed webhook payload is the only copy, and §3.6 bounds it.

**Why this is the smallest change:**

- The body has no reader (§1.1), so the placeholder loses no function.
- It needs no migration, table or dependency.
- It reuses `recordInbound`, `setInboundBody`, `replaceOutsideTokens`, `openSegments` and
  `redactStructuralPiiAroundTokens`.
- It never touches drafts, figures, invoices or audit rows.

**Alternative, rejected as weaker:** keep writing the text before the model, and add a placeholder write
on each failure return. Every future early return becomes a new leak, so this fails open.

### 3.2 Name-span resolver (bounded, deterministic, no model call)

The resolver lives in `packages/core/src/privacy.ts`, next to `replaceOutsideTokens`. It is pure and
unit-testable.

```ts
resolveNameSpans(
  text,
  anchors: string[],              // every customer/supplier mention the command returned
  tokens: Iterable<string>,
  nonName: string[],              // words of the command's other fields
): { spans: Array<{ start: number; end: number }>; confident: boolean }
```

**Locate.** Find each anchor's whole-word occurrences inside `openSegments`, with the existing
`replaceOutsideTokens` pattern applied to the text and to the anchor **both NFC-normalised**. That
closes the composition miss. Every occurrence is a span, so repeats of one name are all covered.

**Extend.** Grow each span one word at a time, at most **3 words** each side. A name is then at most
the anchor plus 3 words; that bounds "Adaeze Obiageli Okonkwo" and stops a run-on. A neighbouring word
joins the span only if it is name-shaped:

- an initial (`O.` or `O`), or
- a word starting `\p{Lu}`, made of `\p{L}\p{M}`, with internal `'` or `-` allowed ("O'Neil",
  "Okafor-Bello").

It also must not be any of these:

- a token or a structural-PII placeholder;
- a number, an amount or a currency sign or word (`₦`, `k`, `naira`);
- a word in `nonName`: the words of the command's item names, product, description or supplier fields,
  so "Sold Chiamaka Samsung Galaxy S25" stops at "Samsung";
- a small closed stop list: the sentence-initial verb, `I`, weekday and month names, `Naira`,
  `WhatsApp`, `Rekoda`.

Growth stops at punctuation other than an initial's full stop, and at the segment edge.

**Confidence.** A span is **confident** when its anchor was found and it stopped at a hard boundary:

- a lowercase word,
- punctuation,
- the segment edge,
- a `nonName` word, or
- a figure or currency.

It is **not confident** when:

- no anchor occurrence was found (a reworded mention), or
- growth hit the 3-word cap with another name-shaped word still adjacent.

One unconfident span makes the whole message unconfident. The body then stays the placeholder (§3.1
rule 4). **The resolver never guesses wider and never deletes words it cannot classify:**

- when confident, it replaces exactly the spans;
- otherwise nothing of the text is stored.

**Multiple names.** Each anchor is resolved independently. A known customer's name was already a token
before the model (layer 1), so it is never an anchor. An unknown name and a known customer together
therefore work without special handling.

**Over-redaction is accepted, under-redaction is not.** A capitalised place word straight after a name
("Chiamaka Lagos") may be scrubbed. The stored body is not a financial record, so nothing is lost.

### 3.3 Read path and write path

There is one decision function for both paths.

- **Writes.** Customer creation (`resolveMention`), `linkAfterMention`, draft recording and confirmation
  are unchanged. Only the body decision moves to the end. The draft never held text, so previews,
  confirmations, corrections (CG5) and payments are untouched.
- **Questions.** The `[name]` and token replacement from #437 is kept. The span comes from the
  resolver.
- **Suppliers.** `supplierMention` becomes an anchor too (fixing §1.3).
- **Integrate customer thread.** Same placeholder rule. Its text is never interpreted for a name, so it
  stores the placeholder unless the gateway reported nothing to protect.
  - _Open sub-question for review:_ the Integrate thread may need the text for the merchant's reply
    view. No production reader exists today, so the proposal is the placeholder.
- **Outbound clarification.** A model-written question is stored as `[clarification]`. The text sent to
  the merchant is unchanged.

### 3.4 Failure, retry and terminal states

| Case                                                                             | Stored body after the change                                  | Mechanism              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------- |
| Provider timeout, `unavailable`, `refused`, `unusable` or `disagreement` outcome | placeholder                                                   | §3.1 rule 4            |
| Invalid structured command (`unusable`)                                          | placeholder                                                   | rule 4                 |
| No mention, or `Unclear`                                                         | placeholder                                                   | rule 4                 |
| Partial mention                                                                  | sanitised text if the resolver is confident, else placeholder | §3.2                   |
| Worker crash or a throw                                                          | no row (rolled back), then the retry decides afresh           | §1.2                   |
| Job retry                                                                        | decided afresh, the same result                               | deterministic resolver |
| Dead letter                                                                      | no row. Sealed payload only, bounded by §3.6                  | §1.2, §3.6             |
| Duplicate webhook                                                                | unchanged (dedup at ingress; `!isNew` returns)                | as today               |

AI timeouts, the refusal boundary (OWN-98) and provider routing do not change.

### 3.5 Tests (RED first)

**Unit tests** of `resolveNameSpans` (`packages/core`) cover directive §5 items 1 to 12:

- first name and surname; first, middle and last names; a partial anchor; initials;
- hyphen and apostrophe; NFC and NFD; accented names; repeats; two names;
- an unknown name beside a token; a name next to a phone or email;
- "Sold Chiamaka Samsung Galaxy S25 for ₦900,000", which keeps "Samsung Galaxy S25" and "for ₦900,000";
- amounts and quantities kept;
- the cap reached, which is unconfident.

**Integration tests** (`apps/api/src/channels`, a new file split by concern) cover:

- §5 items 13 to 15 and every row of the §3.4 table, each asserting the exact stored `body`;
- a supplier name;
- the Integrate thread;
- the clarification echo;
- a correction (CG5) naming the customer differently.

The test `scrubs only the words of the name the model returned (G-136)` **flips**: it must store no part
of "Okafor".

**Non-regression** reruns the existing suites unchanged:

- tokenisation, new-customer creation and confirmation;
- balances, invoices, payments and allocations;
- corrections, continuations and replies;
- the privacy-safe failure suites (`meta-*`, `privacy/*`).

**Migration:** none. No column changes. The placeholder is text in the existing column.

**File inventory:**

- `packages/core/src/privacy.ts` and `privacy.test.ts`;
- H (one body-decision function, the placeholder at insert, anchors from the command);
- `customer-message.handler.ts`;
- `reply.service.ts` (the clarification body);
- one new integration test file;
- docs: G-136 row, `CURRENT_STATE`, `HANDOFF`, `record-of-processing.md`.

### 3.6 Historical data, retention and erasure (needs owner approval; not built until approved)

**What can and cannot be found later.** An old body whose name was never vaulted cannot be linked to a
person:

- the Query branch stores `{ kind: 'none' }`;
- there is no draft link.

Matching old bodies against today's vault would mean decrypting and matching names across every message.
That is the decrypt-and-match search BA-OD-1 gates, so it is not proposed. **Targeted historical
sanitisation is therefore not a defensible completeness claim.** The defensible control is retention.

**Proposed rules,** each an owner decision:

- **R1. Bodies.** Old bodies of **model-routed inbound messages** (and of outbound clarifications)
  committed before the G-136 PR are replaced with the placeholder. The scope is identified by
  `kind = 'text'`, `direction = 'inbound'`, a business-scoped id range and `created_at` before the
  deploy. Deterministic-route bodies are already `describeIntent` text and are left alone.
  - **Procedure:**
    - a dry run that returns **counts only** per business;
    - an owner go/no-go;
    - a tenant-scoped batched UPDATE through a worker-only function, with an audit event carrying counts
      only.
  - **Rollback:** none possible by design (the text is gone). The backup taken before the run is the
    recovery point, and it ages out under the backup retention.
  - It touches no financial, draft or audit row.
- **R2. Conversation retention.** Enforce the `/privacy` page's existing 90 days for every business: a
  sweep placeholders bodies older than `RETENTION.conversationDays`. Today the table states a rule the
  code does not keep.
- **R3. `external_events.payload`.** Null or replace the sealed payload of a **processed** event after
  a bound, proposed at 30 days. Dedup needs only the provider message id, which stays. A dead or
  unprocessed event keeps its payload until it is resolved, then the same bound applies.
  - _A migration may be needed_ if `payload` is `NOT NULL` or the sweep needs a new grant. That is
    assessed and shown to the owner before it is written.
- **R4. Erasure reach.** Two-ask DELETE MY DATA:
  - **(a)** applies R1's placeholder to every body of the business, not only old ones;
  - **(b)** purges the business's processed `external_events.payload`.
  - This makes `/data-deletion`'s "Your conversations with Rekoda." true.
  - Per-customer erasure (`eraseFacet`) also placeholders the bodies whose drafts or continuations carry
    that customer's token: the one reliable link (`command_drafts.conversation_message_id`,
    `conversation_continuations.source_message_id`). It does not claim more than that link reaches.

**Safeguards for all four rules:**

- no decrypt-and-match;
- no new copy of any name;
- tenant-scoped functions only;
- logs and audit events carry counts only;
- no financial row is touched;
- a dry run before any production run;
- **no production execution without the owner's approval of the exact procedure.**

## 4. ADR 0005 Amendment 1 and `/ai-privacy`: exact proposed text

### 4.1 Amendment 1 (replaces the PROPOSED text now in the ADR; stays PROPOSED until approved)

The exact text is in `docs/adr/0005-pii-gateway-scope.md` § "Amendment 1" on this branch. In summary, it
states:

- **The architecture.** Narrowed Option A: a read never creates a customer, and no store of unknown names
  exists (Options B and C are rejected).
- **The three cases.** Recognised customer, unknown name in a question, and name in a write.
- **The exception's exact bounds.** Per interpretation attempt, at most two Anthropic interpretation
  calls, plus the Anthropic document classifier for photographed text. Retries repeat the attempt. There
  is no other processor, intent or stored copy, and no logging.
- **Storage as a separate obligation.** It names G-136 and states that the exception never permits a
  stored readable copy.

### 4.2 Proposed replacement for the `/ai-privacy` paragraph (not applied)

> Customers you have recorded are protected before anything leaves Rekoda: their names, phone numbers
> and email addresses are replaced with meaningless tokens. The first time you record a sale, invoice or
> payment for someone new, the model reads that message to understand it, and the name is then stored
> encrypted with its own token. When you only ask about someone you have not recorded, Rekoda does not
> create a customer for them, so the model reads the name each time you ask, to understand the question.
> In every case the model is Anthropic's, under terms that do not allow training on your data. Rekoda
> does not log these names.

**What it deliberately does not say yet.** It does not repeat "nothing keeps a readable copy". That
sentence is restored, worded as "Rekoda does not keep a readable copy of the message in your chat
history", **only in the G-136 PR, once it is provably true**. Weakening it now would hide a correctable
defect.

### 4.3 Each claim, mapped to code and tests

| Claim                                                            | Implementation                                                                              | Test                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Recorded names, phones and emails become tokens before the model | gateway layers 1 and 2 (`PrivacyGateway.tokenise`)                                          | `meta-question-customer` "a known name never reaches the model: the question carries its token"; `privacy/*`                                           |
| A first write vaults the name                                    | H, the write branch (`resolveMention`)                                                      | `meta-customer-identity`                                                                                                                               |
| A question creates no customer                                   | H, the Query branch (`findMention`)                                                         | `creates no customer for a balance question about a name it does not know`; `gateway-find-mention`                                                     |
| The model reads an unknown name each time                        | `findMention` does not vault                                                                | `meta-question-customer` (a repeated unknown name)                                                                                                     |
| Anthropic only, no training                                      | `apps/api/src/ai` routing; OWN-98                                                           | `interpreter.integration.test.ts`                                                                                                                      |
| No logging of names                                              | the observability contract (`usage_events.meta` holds role, model, purpose and policy only) | `apps/api/src/ai/interpreter.integration.test.ts` (usage-event shape); no #437 test asserts it for a question naming someone, so the G-136 PR adds one |

### 4.4 Remaining limitations (honest list)

1. Free text may hold personal details the gateway cannot recognise, such as an unrecorded name inside
   a write before interpretation. The existing `/ai-privacy` caveat ("not a claim that every possible
   piece of personal information … is always detected") stays.
2. Until the G-136 PR merges, the stored chat history can hold unknown names (§1.3).
3. Until R3 or R4 are approved and built, the sealed webhook payload keeps the text, encrypted, for the
   life of the business.
4. Per-customer erasure cannot reach a body that no draft or continuation links to that customer (§3.6).

## 5. G-137 (new, pre-existing, IMPORTANT): write commands accept any well-formed token

The issued-token check #437 added applies to questions only (H: the one `tokens.displays.has`). A write
command (sale, payment, invoice) resolves **any** `CUSTOMER_…` token in the business:

- `customerIdFor` and `confirmSale`;
- `openInvoiceForPayment`.

**Scenario.** The model invents an example-shaped token that happens to be another real customer's. A
payment preview then targets that customer's open invoice. The preview shows the raw token, because
`rehydrate` leaves an unknown token as it is. A "yes" posts it against the wrong customer.

- **Mitigations today:** the merchant must confirm the preview; there is no cross-tenant reach; the model
  sees only this message's tokens.
- **Proposed fix:** a separate small PR. A write whose customer token was not issued to this message is
  answered with a clarification and never drafted, with RED tests for a sale, a payment and an invoice.

The G-137 row is recorded in `REKODA_LAUNCH_READINESS.md`.
