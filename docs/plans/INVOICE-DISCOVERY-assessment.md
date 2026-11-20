# Books assistant: invoice discovery, analytics, comparisons and report PDFs — technical assessment

> **Status: PROPOSAL FOR OWNER REVIEW. Not approved. No code written.**
>
> **Revision 2 (20 Nov 2026).** This revision combines two owner specifications into one assessment:
>
> 1. "Invoice Discovery, Advanced Search, Retrieval & Intelligent Document Summaries" (assessed in revision 1, commit `9d7227b`).
> 2. The follow-up directive "Unified Document Discovery, Intelligent Business Analytics, Dynamic Comparative Reporting & Professional PDF Reports".
>
> Every requirement from (1) is kept. The original 15 owner decisions keep their numbers (OD-1 to OD-15) and are reassessed in §23. New decisions continue from OD-16.
>
> **Baseline:** `main` at `dbe99b741d4ce68b69c5b798fc22db8415cb8999`. The branch head adds only this document.
>
> Every repository claim is cited as `path:line` at that SHA. Inferences are marked _(inference)_. Where I could not measure something, I say so.
>
> **Not yet listed in `docs/REKODA_REFERENCE_MANIFEST.md`.** It needs a row there if it is kept.

## Owner rulings (revision 3, 20 Nov 2026)

The owner has ruled on every decision in §23. The rulings are recorded as **OWN-99** in `docs/REKODA_OWNER_DECISIONS.md`.

The repository already uses OD-1 to OD-56 for other questions, so this register's decisions are cited there and in new rows as **BA-OD-n**. BA-OD-n is the same decision as OD-n in §23.

Where a ruling differs from a §23 recommendation, **the ruling wins**:

| Decision | Ruling                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BA-OD-1  | Conditional C. Exact HMAC stays primary. Fuzzy matching is used only after exact matching fails, and never auto-selects. The "5,000" figure is not approved as a bound.           |
| BA-OD-11 | B, as revised.                                                                                                                                                                    |
| BA-OD-14 | Configurable ceilings, on existing rate-limit infrastructure where it suffices.                                                                                                   |
| BA-OD-21 | **The 20% threshold is not adopted.** Profit is withheld when cost completeness is insufficient. The answer then shows verified sales, recorded costs and a completeness warning. |
| BA-OD-22 | The merchant is invited to "Reply PDF"; a PDF is never produced automatically.                                                                                                    |
| BA-OD-24 | Names are approved as a capability. Storage is gated by BA-OD-25.                                                                                                                 |
| BA-OD-25 | **The 90-day expiry is not approved.**                                                                                                                                            |
| BA-OD-28 | Conditional: only if Noto Sans is not equally professional, and existing documents are unchanged.                                                                                 |
| BA-OD-31 | Engineering defaults, never "statistically significant".                                                                                                                          |
| BA-OD-33 | Direction approved; **M4 is held** until the exact SQL is approved.                                                                                                               |
| BA-OD-35 | Measure first; +15% is a review trigger.                                                                                                                                          |

Every other decision is approved as recommended.

### Five gates (evidence the owner must approve before that part is built)

| Gate     | Evidence required                                                                                                                               | What is held                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| BA-OD-1  | Privacy and performance bounds for decrypt-and-match name search                                                                                | Fuzzy name matching                                |
| BA-OD-21 | Exact cost-coverage rules with worked examples                                                                                                  | Any profit figure that depends on incomplete costs |
| BA-OD-25 | Report retention and erasure reconciled with existing policy                                                                                    | Storing customer-identifiable reports              |
| BA-OD-33 | Exact SQL, field-by-field rationale, compatibility, privileges and RLS, size limits, validation, rollback, tests, and why no-migration is worse | Migration M4 (the pure context model may be built) |
| BA-OD-35 | Measured schema size, token cost, Sonnet, Opus and Haiku 5.5 compatibility, accuracy, escalation rate and cost per request                      | Enabling the expanded command contract             |

### Progress

| Item                                                 | Status                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| P0 item 1 (BA-OD-3)                                  | **Part 1 in its first PR**: a question resolves a customer _name_ by lookup only. Gap **G-135** in `REKODA_LAUNCH_READINESS.md`. |
| P0 item 1, part 2                                    | Phones and emails typed in any message are still resolved find-or-create before the model. That is the next PR.                  |
| P0 items 2–4 (BA-OD-16, BA-OD-17, the expense label) | Follow, one PR each.                                                                                                             |

## Contents

1. Acknowledgment
2. Verified implementation inventory
3. Combined feature coverage matrix
4. Recommended architecture
5. Analytical query contract
6. Time-comparison semantics
7. Financial metric definitions
8. Advanced invoice search design
9. Conversational context design
10. Insights engine
11. PDF rendering architecture
12. Report design specification
13. Generation and delivery lifecycle
14. Voice integration
15. Performance and cost assessment
16. Security and financial integrity review
17. Existing files to modify
18. Justified new files
19. Database migration assessment
20. Dependency assessment
21. Development stages and PR boundaries
22. Testing and staging acceptance matrix
23. Owner decision register (consolidated)
24. Final architecture recommendation

---

## 1. Acknowledgment

The follow-up directive **continues and expands** the approved document-discovery specification. It does not replace it. Everything below treats the following as one product capability over one set of authoritative data sources:

- invoice retrieval, search, filtering, summaries, PDF resend and voice;
- business analytics, period comparisons, insights and report PDFs.

That capability is called the **books assistant** in this document. The scope is not reduced to "invoice lookup plus a sales chart".

The repository already carries an owner ruling that covers most of the analytics scope:

- **OWN-44** (`docs/REKODA_OWNER_DECISIONS.md:150`, 23 Oct 2026) makes "financial insights and period comparisons" MVP scope. It covers daily, weekly, monthly and custom ranges; absolute and percentage change "only where mathematically valid"; rankings; trends; PDF and Excel output; and web charts.
- It also requires that "every figure comes from verified tenant-scoped records computed by `@rekoda/core`; the model explains and summarises but invents no value".
- It ends: "audit the existing reports API, web reports page and chat query first and build only the gap".
- Backlog row **N2** (`docs/REKODA_LAUNCH_BACKLOG.md:92`) records:
  - slice 1 merged (#372): the comparison engine and `GET /v1/reports/compare`;
  - slice 2 (product rankings) **blocked on an open owner decision**;
  - not started: trends, PDF and Excel, web charts, and natural-language custom ranges in chat.

This proposal is the plan for the rest of N2, together with the invoice-discovery capability.

---

## 2. Verified implementation inventory

Findings come from seven read-only audits plus my own spot checks. They are grouped by area.

### 2.1 Chat ingestion, routing and interpretation

| Concern                       | Where                                                                                                          | Verified fact                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound job                   | `apps/api/src/jobs/inbound-message.handler.ts`                                                                 | Order: `continueConversation` (:612-622) → `deterministicReply` (:1593) → `interpretedReply` (:5013). A photo skips the router; everything else is routed (:452).                                                                                                                                                                                     |
| Deterministic router          | `packages/core/src/router.ts`                                                                                  | Intents at :27-62 include records, debtors, stock, `remind{invoiceNumber}`, payment_details, dashboard, resend and upgrade. Exact phrases are in the table at :176-385. Anything over 60 characters goes to the model (:1109).                                                                                                                        |
| Invoice numbers in the router | `router.ts:173-174, :1187-1203`                                                                                | Only `remind INV YYYY NNNNNN` is parsed. Everything else that holds a number goes to the model, deliberately (`router.test.ts:243, :351-352`).                                                                                                                                                                                                        |
| Period follow-ups             | `router.ts:1225-1286`                                                                                          | `periodAnswer` takes whole-message periods plus lead words ("what about", "and for", Pidgin forms). "Last week" and "past month" are deliberately excluded.                                                                                                                                                                                           |
| Command contract              | `packages/contracts/src/business-command.ts:105-244`                                                           | A `z.discriminatedUnion('intent')` over 8 intents. `Query` (:212-227) has `topic`, `customer`, `period` (today, week, month, custom), `periodText` and `format` (chat, pdf, excel). **`format` is never read** (grep: construction sites only).                                                                                                       |
| Tool schema and strict mode   | `business-command.ts:278-301`; `apps/api/src/ai/strict-schema.ts:50-55`; `anthropic.transport.ts:73, :144-157` | `z.toJSONSchema` with `oneOf` changed to `anyOf`. Limits are 16 union parameters and 24 optional ones. The business command is refused strict mode; the G-134 row records 26 union parameters. **I did not re-measure it** (no `node_modules`). `tool_choice` is auto with `disable_parallel_tool_use`.                                               |
| Interpreter                   | `apps/api/src/ai/interpreter.service.ts:178-229, :602-613`; `prompt.ts:23, :33, :68`                           | Primary call plus one escalation. A refusal is terminal (OWN-98). The prompt says "you do not chat, advise, or write prose" and "Rekoda recomputes every total".                                                                                                                                                                                      |
| Query answers                 | `inbound-message.handler.ts:3365-3489`                                                                         | Sales and expenses go through `periodAnswer` → `resolvePeriod` → `reportsRepo.summaryFor`. Debtors, `customer_balance` (`openInvoicesForCustomer`), supplier balances and unreconciled are also handled. `report_request` → `reportRequestAnswer()` (`replies.ts:1762`) points to the dashboard; "WhatsApp delivery of it is not wired" (:1754-1761). |
| Replies                       | `packages/core/src/replies.ts`                                                                                 | All templates. "Every figure here came from SQL" (:1615-1620). **No reply compares periods.** `recordsSummary` (:1814) shows this month at a glance. `help()` (:41-56) lists no reports or questions.                                                                                                                                                 |
| View-only classifier          | `packages/core/src/request-kind.ts:532`; handler :5091-5117                                                    | Accountants: READ is allowed, WRITE and UNKNOWN are refused before any model call (OWN-25). Report and statement words count as reads (:300-340, :1764-1766, :2007-2025). G-100 is open (`REKODA_LAUNCH_READINESS.md:277`).                                                                                                                           |

### 2.2 Reporting and ledger

| Function or area                           | Where                                                                                                                                                    | Verified fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summaryFor(from,to)`                      | `packages/db/src/repos/reports.ts:862-1014`                                                                                                              | **The ledger-based window summary** (G-118, merged as #384, `c868cce`). Returns `salesK` (revenue plus VAT, voids netted, credit notes excluded), `handPostedK`, `invoices` (count), `creditedK`, `moneyInK` (cash from customers, net of reversals and chargebacks), `refundedK`, `moneyOutK` (recorded spend, stock at full value), `expenses` (count), `cashInK`, `cashOutK`. Window: `e.created_at BETWEEN from AND to`. **No COGS and no profit.**                                                                                                                                        |
| `overviewFor`                              | `reports.ts:79-120`                                                                                                                                      | Month-to-date. `salesK = SUM(credit_k)` on account 4000 only, **so voids and credit notes are not subtracted** (verified :94). This differs from `summaryFor`, so `records` in chat can disagree with the sales answer after a void _(inference from the SQL; no test pins the difference)_.                                                                                                                                                                                                                                                                                                   |
| `cashflowFor(months)`                      | `reports.ts:145-181`                                                                                                                                     | Monthly cash-account debits and credits with no posting-purpose filter. **Opening-balance cash and transfers between the merchant's own cash accounts count as both in and out** (verified :152-163).                                                                                                                                                                                                                                                                                                                                                                                          |
| `debtorsFor`, `ageingFor`                  | `reports.ts:207-247, :275-327`                                                                                                                           | Per invoice, open statuses. Ageing uses Lagos dates with buckets current, 1-30, 31-60, 61-90 and 90+.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `accountSumsFor(period 'YYYY-MM')`         | `reports.ts:424-459`                                                                                                                                     | Per-account sums for one month plus cumulative. Feeds the four statements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `expenseScheduleFor`, `revenueScheduleFor` | `reports.ts:515-579, :621-688`                                                                                                                           | By expense category; by `invoices.sale_source` (channel). Monthly only. **`expenseScheduleFor` labels a NULL category as "fees"** (:564), which states a classification the entry does not have.                                                                                                                                                                                                                                                                                                                                                                                               |
| Activity and registers                     | `reports.ts:343, :717, :786, :1049`                                                                                                                      | `activityFor`, `invoicesFor`, `receiptsFor`, `auditFor`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Missing                                    | (grep for `top.?(customer\|product)`, `best.?sell`, `byCustomer`, `GROUP BY`)                                                                            | **No daily or weekly series, no top-customer and no top-product function.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Period engine                              | `packages/core/src/periods.ts:22, :44-161`; `period-compare.ts:60-140`                                                                                   | `PeriodName` is today, week (the last 7 days), month (month to date) or last_month. `resolveCustomRange` caps at 366 days and clamps to today. `changeOf`: `percent = previous > 0 ? round(abs*1000/previous)/10 : null` (one decimal place). `comparePeriods` gives sales, credited, collected, refunded, spent, cashMovement and `previousIsEmpty`. `previousWindow` compares a whole month with the previous whole month; **any other window, month-to-date included, with the equal-length span immediately before**. **No quarter, year, yesterday or like-for-like elapsed comparison.** |
| Compare API                                | `apps/api/src/reports/reports.controller.ts:2508-2557`                                                                                                   | `GET /v1/reports/compare?from&to`. **No caller in `apps/web`** and none in chat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Statements                                 | `packages/core/src/statements.ts:141-280`; `reports.controller.ts:413-557, :2628-2635`                                                                   | P&L (`costOfSalesK` from the COGS role, `grossProfitK`, `netProfit`), balance sheet, direct cash flow and trial balance. Monthly only.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| COGS                                       | `packages/core/src/ledger.ts:654-662`; `sale-commands.ts:74-79, :219-235`; `order-commands.ts:149-169`; `costing.ts:35-65`; `stock.ts:181-216, :457-520` | COGS is posted at sale time at the weighted-average `products.unit_cost_k`. **A line with no matched product or no cost posts no COGS, and no per-sale "uncosted" flag is stored**, so gross profit is overstated by uncosted revenue. The web reports page warns about this (`apps/web/src/app/app/reports/page.tsx:544-550`).                                                                                                                                                                                                                                                                |
| Expenses                                   | `packages/db/src/schema/finance.ts:275-305`; `packages/core/src/expenses.ts:38-154`                                                                      | `category` is nullable text. Ten fixed categories are assigned by rules from the model's word or the description, falling back to `other`. Stock purchases are `category='stock'` and debit Inventory.                                                                                                                                                                                                                                                                                                                                                                                         |
| Products                                   | `finance.ts:120-134`; `commerce.ts:32-87, :211-228`                                                                                                      | `invoice_items` has no `product_id`. Sale stock movements are keyed by `product_id`, with `source_id` = the **invoice number**, only when the line's folded name matched a product (`stock.ts:88-123`). **No product categories exist.** `sale_source` is on invoices.                                                                                                                                                                                                                                                                                                                         |
| Customers                                  | `party-statements.ts:78`                                                                                                                                 | `customerStatementFor` covers one customer. No ranking exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Ledger schema                              | `finance.ts:347-424`; `issue.ts:262-374`                                                                                                                 | Indexes `ledger_entries (business_id, created_at)` and `(business_id, account_id, created_at)` exist. **Backdating sets `created_at`**; there is no separate effective date.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Period close                               | `migrations/0034_period_close.sql:54-80`; `0067`; `repos/close.ts:43-207`                                                                                | Triggers reject postings at or before the closed month. Closed history cannot change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Opening balances                           | `ledger.ts:288-335`; `opening.ts:54-63`                                                                                                                  | Dated at the merchant's `asAt`, credited to owner's equity. Opening receivables create real invoices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Web                                        | `apps/web/src/app/app/page.tsx:6-158`; `CashflowChart.tsx:10-21`; `apps/web/package.json`                                                                | The dashboard has a **hand-written SVG cash-flow chart. No chart library is installed.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 2.3 Invoices, payments, documents and storage

These rows are carried over from revision 1 and verified again.

| Concern                 | Where                                                                                       | Fact                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoices`              | `finance.ts:43-118`                                                                         | Money columns in kobo: `subtotal_k`, `discount_k`, `delivery_fee_k`, `vat_k`, `total_k`, `paid_k`, `balance_due_k`, `credited_k`. Also `invoice_number`, `customer_id` (nullable), `status` (CHECK in `0131:34-35`: issued, partially_paid, paid, voided, credited), `due_date`, `snapshot_json`, `doc_hash`. The issue time is `created_at`.                                                                              |
| Numbering               | `numbering.ts:47-57`; `issue.ts:201-225`                                                    | `doc_counters` per business, document type and Lagos year. Format `INV-YYYY-NNNNNN`.                                                                                                                                                                                                                                                                                                                                       |
| Snapshot                | `issue.ts:453-475`                                                                          | Items, totals, `paidK` at issue, `customerToken`, due date. **Chat invoices have `customer_id = NULL`**; the customer exists only as the snapshot token (`issue.ts:1154-1187`).                                                                                                                                                                                                                                            |
| Balance projection      | `repos/projections.ts:51-101`; `settle.ts:291-295`; `payment-adjustment-commands.ts:53-120` | `paid_k`, `balance_due_k`, `credited_k` and `status` are kept current through allocations, reversals, refunds, chargebacks and credit applications.                                                                                                                                                                                                                                                                        |
| Invoice reads           | `issue.ts:1036-1292`; `reports.ts:717`; `merchant-api.ts:147-215`                           | `invoiceByNumber` (`upper()` match), `openInvoicesForCustomer` (open only, limit 20), unfiltered registers, and a public-API keyset on `(created_at, id)`. **No search: no `ILIKE`, `pg_trgm` or `tsvector` anywhere.**                                                                                                                                                                                                    |
| Indexes                 | `0000_init.sql:416-424`; `0003_hot_path_indexes.sql:21,23`                                  | `(business_id, invoice_number)` UNIQUE, `(business_id, status)`, `(business_id, customer_id)`, `invoice_items(invoice_id)`, `alloc(invoice_id)`. No `created_at`, `due_date` or snapshot-token index.                                                                                                                                                                                                                      |
| `documents`             | `schema/ops.ts:184-200`                                                                     | `kind` (free text, **no CHECK**), `storage_key`, `ref_number`, `bytes`, `created_at`. **No `invoice_id`.** Written kinds: `invoice_pdf`, `receipt_pdf`, `quote_pdf`. The comment lists `snapshot_pdf`, `excel_export` and `records_csv`, which nothing writes.                                                                                                                                                             |
| Render                  | `sale-commands.ts:54-69`; `render-document.handler.ts:41-215`                               | One handler branches on the payload (`receiptId`, `quoteId`, `invoiceId`). **A sale that is paid gets a receipt and no invoice PDF** ("one paper, not both"). Each branch puts to R2, then records the document, then enqueues `document.deliver` with `deliver:<docId>`. The render reads the **live** business name; the invoice PDF prints the customer **token** under "Billed to" (`:68`; `invoice-layout.ts:86-87`). |
| Storage                 | `documents/storage.ts:16-49`; `r2.storage.ts:19-81`                                         | `put`, `get` (returns `null` on `NoSuchKey`) and `delete`. Private bucket, no presigned URLs.                                                                                                                                                                                                                                                                                                                              |
| Delivery                | `deliver-document.handler.ts:44-258`; `meta.sender.ts:317-407`                              | **Always to `ownerPhoneFor`** (:65). STOP is overridden when `requestedByMerchant`. 24-hour window, then the `META_DOCUMENT_TEMPLATE` notice. The PDF is uploaded as raw bytes. **A missing object throws and is retried up to 5 times** (:80-84). Captions and labels are known only for receipt, invoice and quote (:224-258). No outbound size limit.                                                                   |
| Resend                  | handler :2202-2221; `issue.ts:1015-1033`                                                    | Sends the **newest document of any kind**. Requires `mayTransact`. Job key `redeliver:<docId>:<eventId>`.                                                                                                                                                                                                                                                                                                                  |
| Statement PDF and Excel | `reports.controller.ts:474-557`                                                             | Rendered **synchronously** and streamed. Never stored. Metered with one `REPORT_EXPORTS` unit through `consumeUnit` (no refund, :274-307).                                                                                                                                                                                                                                                                                 |
| Jobs                    | `queue.service.ts:6-68`; `0004_jobs.sql:15, :38-40`                                         | `jobs.kind` has no CHECK. The singleton key is unique while a job is pending or running. 5 attempts, then dead.                                                                                                                                                                                                                                                                                                            |
| Retention               | `retention.ts:20`; `repos/retention.ts:115-140`; `0122`; `0129:27-28`                       | Only whole-business deletion feeds `pending_object_deletions`. Its `reason` CHECK allows a fixed set. **No per-document deletion path exists.**                                                                                                                                                                                                                                                                            |

### 2.4 PDF engine and brand

| Concern      | Where                                                                                                  | Fact                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library      | `apps/api/package.json`; `pnpm-lock.yaml:1599`                                                         | **pdfkit 0.20.2** (MIT) with fontkit. Pure JavaScript.                                                                                                                                                                                                                                                                                                                                                           |
| Model        | `packages/core/src/invoice-layout.ts:17-40`; `apps/api/src/documents/pdf.ts:74-94, :163-329`           | Pure core layouts return `LayoutBlock {kind, text, value?}` with 13 kinds. One renderer, `renderBlocksPdf`, does a one-column flow with label and amount pairs. Pagination via `ensureRoom`, a "Page N of M" footer when there is more than one page, A5 by default and A4 for statements, 36 pt margins. **No colour, no table model, no charts.** Vector calls are used only for rules and one box (:218-255). |
| Fonts        | `apps/api/assets/fonts/NotoSans-{Regular,SemiBold}.ttf`; `pdf.ts:39-57`; `scripts/fetch-pdf-fonts.mjs` | Embedded Noto Sans, chosen because ₦ is not in WinAnsi. A missing font raises `FontsMissing` (503 on the web).                                                                                                                                                                                                                                                                                                   |
| Tests        | `pdf.integration.test.ts:46-262`; `*-layout.test.ts`                                                   | Byte-level checks (magic bytes, embedded font, page count, row kept with its figure) plus layout-block assertions. **No text extraction and no visual comparison.**                                                                                                                                                                                                                                              |
| Brand tokens | `design-system/rekoda/MASTER.md:88-201`; `docs/REKODA_DESIGN_SYSTEM.md` §2, §6, §8                     | Teal scale (accent `#0f766e`), sand scale (text `#1c1b19`, muted `#6b6862`, border `#ddd9d0`). Status colours are not series colours. Chart series: in `#0d9488`, out `#9d3557`. Type: Calistoga for display, Inter for body, tabular numerals for money. **There is no PDF or print guidance**, and no Inter or Calistoga TTF exists in the repo.                                                               |
| Container    | `Dockerfile` (`node:24-bookworm-slim`, no `apt-get`); `docs/runbooks/deploy.md:179, :1118`             | No Chromium or native canvas libraries. The staging host is 4 GB / 2 vCPU with recorded memory pressure.                                                                                                                                                                                                                                                                                                         |

### 2.5 Customers, identity, privacy and roles

These rows are unchanged from revision 1.

- **Names and phones live only in `customer_identities`** as AES-256-GCM ciphertext with an exact business-scoped HMAC `match_key` (`vault.ts:64-145`; `0000_init.sql:77-92`). There is one customer per trusted normalised value (`0005_identity_match_unique.sql:16-26`). There is no customer business-name field, no aliases and no verified flag. Storefront names are untrusted and cannot be matched.
- **The gateway tokenises phones and known names** before the model (`gateway.service.ts:180-411`). **Resolving a mention or an unknown phone creates a customer, on reads too** (handler :5232-5262; gateway :240-246, :610-672).
- **Roles:** owner, accountant (view only) and delegate. `mayTransact` = owner or delegate (handler :2139-2146). Every member may use `debtors` and `records`. `resend` requires `mayTransact`. `roleOfPhone` does not filter `memberships.active` (`identity.ts:577-589`): verify before launch.
- **Entitlements and units:**
  - `REKODA_CHAT` is on trial, chat and complete.
  - Router reads are free.
  - A message that reaches the model takes one `AI_ACTIONS` unit.
  - `REPORT_EXPORTS` per plan: trial 10, chat 50, integrate 100, complete 200, expired 0 (`allowances.ts:252-321`; OWN-4).
  - `DOCUMENT_GENERATION` covers invoices and receipts only.
  - Retrieval and resend are free on any plan (OWN-45, OWN-60).

### 2.6 Conversation state

- **Repository:** `packages/db/src/repos/continuations.ts` (`openContinuation` :99, `currentContinuation` :177, `consumeContinuation` :217, …). Revision 1 named the wrong file; corrected here.
- **Table** (`0154`, `0155`, `0156`, `0158`):
  - Member-scoped, with at most one open row per member; TTL 600 s.
  - `kind` is `clarification` or `query`.
  - `topic`, `period`, `expects` and `document_ref` are **closed CHECK lists**.
  - The only jsonb column is `options`, validated by a database function as **1–9 `{ordinal, ref:{kind:'invoice', invoiceNumber}}` entries**. That list type exists and nothing uses it.
  - The migration header says "No column holds words anybody typed" (0154:26).
- **Resume path:** `resumedRead` (`continuation.ts:272-295`) resumes only period reads for sales and expenses. **A topic switch ("what about expenses?") does not exist.**

### 2.7 Voice

Unchanged from revision 1:

- the transcript enters the same router and interpreter (handler :447-454);
- the model is `whisper-1` and **confidence is always null** (`stt.openai.ts:79`);
- the feature flag `VOICE_TRANSCRIPTION_ENABLED` is off by default;
- `VOICE_MINUTES` are metered;
- **no document records whether staging has voice on.**

### 2.8 Rulings and gaps that bind this work

| Ruling or gap           | Summary                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OWN-44                  | §1.                                                                                                                                                                                                                                                   |
| OWN-60 / OWN-45         | Historical retrieval is free and needs no active plan.                                                                                                                                                                                                |
| OWN-25                  | View-only members may read.                                                                                                                                                                                                                           |
| OWN-98                  | A refusal is terminal; the 20 s timeout stays.                                                                                                                                                                                                        |
| OWN-4                   | Report exports are metered.                                                                                                                                                                                                                           |
| OWN-5                   | Portability is never metered.                                                                                                                                                                                                                         |
| G-67                    | Residuals: no retention filter on resend; a delegate's resend goes to the owner; "retrieve of a specific older document has no path yet".                                                                                                             |
| G-100                   | View-only read phrasings.                                                                                                                                                                                                                             |
| G-118                   | `summaryFor` definitions. **The readiness row still says "PR OPEN" although #384 merged.** Stale; corrected in Stage I.                                                                                                                               |
| Spec                    | §5.1 (`REKODA_CANONICAL_SPEC.md:247-248`): "Reports / financial Q&A — read the ledger, never recompute from source events"; "AI explains; deterministic logic or a human decides". There is no spec section on retrieval, search or insights (OD-15). |
| `docs/pricing-model.md` | :63 says "unlimited PDF/Excel reports" for Chat, which contradicts :144-152 and OWN-4. Stale; corrected in Stage I.                                                                                                                                   |

---

## 3. Combined feature coverage matrix

Legend:

- **R**: reuse as is.
- **E**: extend an existing function or file.
- **N**: new, inside a justified file (§18).
- **OD**: depends on an owner decision.

| #                              | Requirement                                                                                                  | Plan                                                                 | Primary location                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------- |
| **Invoice discovery (spec 1)** |                                                                                                              |                                                                      |                                                   |
| 1                              | Retrieve by exact reference (typed and voice)                                                                | E router fast path; N `invoiceByReference`; R `document.deliver`     | `router.ts`, `invoice-search.ts`, deliver handler |
| 2                              | By customer name                                                                                             | E gateway lookup-only; N search                                      | `gateway.service.ts` (OD-1, OD-3)                 |
| 3                              | By phone                                                                                                     | E gateway lookup-only                                                | (OD-3)                                            |
| 4                              | By customer business name                                                                                    | Treated as a name                                                    | (OD-2)                                            |
| 5                              | By item or description, quantity                                                                             | N item predicate                                                     | `invoice-search.ts`                               |
| 6                              | Dates, amounts, status, outstanding, overdue, due date                                                       | E periods.ts, money.ts; N filter builder                             | core (OD-9, OD-10, OD-19)                         |
| 7                              | Compound filters, sorting, keyset pagination, ranking tiers                                                  | N                                                                    | core `analytics.ts`, `invoice-search.ts`          |
| 8                              | Disambiguation and selection                                                                                 | R continuation `options` (invoice choice list)                       | continuations                                     |
| 9                              | Single-invoice summary (as issued versus now)                                                                | N assembler and templates                                            | core                                              |
| 10                             | Multi-invoice aggregates                                                                                     | N `invoiceAggregate`                                                 | `invoice-search.ts`                               |
| 11                             | Follow-ups ("the second one", "only unpaid")                                                                 | E continuation with a context column                                 | (OD-33)                                           |
| 12                             | Stored-PDF retrieval and failure outcomes                                                                    | E deliver handler (requester, missing-object check)                  | (OD-4, OD-5, OD-7, OD-11)                         |
| 13                             | Customer-directed send                                                                                       | Not built; gated                                                     | (OD-8)                                            |
| **Analytics (spec 2)**         |                                                                                                              |                                                                      |                                                   |
| 14                             | Today vs yesterday, week vs week, month vs month, quarter, year, YoY, custom vs custom, last N vs previous N | E periods.ts, period-compare.ts                                      | core (OD-18, OD-19)                               |
| 15                             | Daily, weekly and monthly trends; strongest period                                                           | N series from `summaryFor`'s definitions                             | `reports.ts` (refactor)                           |
| 16                             | Sales: gross, net, count, average, by customer, product, channel; top transactions and days                  | E `summaryFor`, `revenueScheduleFor`; N rankings                     | `reports.ts` (OD-16, OD-20)                       |
| 17                             | Collections and receivables: rate, ageing, overdue, payment patterns                                         | R `ageingFor`, `debtorsFor`; N rate and days-to-pay                  | (OD-34)                                           |
| 18                             | Expenses: total, trend, category, share, ratio                                                               | E `expenseScheduleFor` for windows                                   | (fix the NULL→"fees" label)                       |
| 19                             | Profitability: COGS, gross profit, margin, net                                                               | E `accountSumsFor` for windows; R `buildProfitAndLoss`               | (OD-21)                                           |
| 20                             | Product performance                                                                                          | N ranking                                                            | (OD-20)                                           |
| 21                             | Customer performance                                                                                         | N ranking with rehydrated names                                      | (OD-24)                                           |
| 22                             | Cash flow: receipts, payments, net, opening and closing                                                      | E cash measures excluding own-account transfers and opening balances | (OD-17)                                           |
| 23                             | Dynamic query representation (no per-phrase methods)                                                         | N `Analyse` intent plus a core metric registry                       | contracts, core                                   |
| 24                             | Insights with data-confidence labels                                                                         | N deterministic rules plus templates                                 | core `analytics.ts` (OD-27, OD-31)                |
| 25                             | Conversational context (topic switch, period switch, "generate the PDF")                                     | E continuation context                                               | (OD-33)                                           |
| 26                             | Professional report PDF with charts, KPIs, tables and methodology                                            | E `pdf.ts`; N `report-layout.ts`                                     | (OD-28, OD-30)                                    |
| 27                             | Auto versus explicit PDF policy                                                                              | Policy in core                                                       | (OD-22)                                           |
| 28                             | Store, deliver, retry, idempotency, retention                                                                | E render and deliver handlers; R R2                                  | (OD-23, OD-25, OD-26)                             |
| 29                             | Visual QA of PDFs                                                                                            | Dev-only tooling                                                     | (OD-29)                                           |
| 30                             | Voice for all of the above                                                                                   | R existing pipeline                                                  | (OD-13)                                           |
| 31                             | Anthropic compatibility of the expanded schema                                                               | Measure plus an owner-run probe                                      | §5.4                                              |

Nothing in either specification is deferred without an owner decision.

---

## 4. Recommended architecture

```
 text ─┐                          (existing claim, idempotency, role, entitlement, metering)
 voice ┴─► inbound-message.handler ──► STT (voice only, existing)
                 │
                 ├─ continueConversation ── open books continuation? ── ordinal / "send it" /
                 │                                                       topic or period switch / "PDF"
                 ├─ routeMessage (core) ── NEW invoice_ref intents ("send INV-…")
                 └─ interpreter (existing) ──► InvoiceQuery | Analyse   (criteria only, zod-validated)
                                    │
                    core: resolve periods, amounts, references, comparison windows, metric plan
                                    │
          apps/api/src/jobs/books-answer.ts (NEW orchestration; one entry point for all paths)
             ├─ db: invoice-search.ts (NEW)   ── records: list / one / aggregate
             └─ db: reports.ts (EXTENDED)     ── ledger figures: windows, series, schedules, rankings
                                    │
                  core: BooksResult (one immutable, validated data object)
             ┌──────────────────────┼─────────────────────────────┐
     replies.ts templates     continuation context        report PDF (when requested, OD-22)
     (chat answer)            (follow-ups, 600 s)         job document.render{report}: core report-layout
                                                           → pdf.ts → R2 (PDF + JSON) → documents row
                                                           → document.deliver (to requester)
```

**Principles.** Each one names the rule it serves.

1. **One result object feeds every output.** The chat answer, the PDF and the follow-up context are all rendered from the same `BooksResult`, computed once. A PDF never re-queries. The result is carried in the render job's payload (§13), so the chat answer and the PDF cannot contradict each other.
2. **The model proposes criteria; deterministic code disposes** (invariant 2, OWN-44, spec §5.1). The model never sees a figure, an ID or a result, and never writes SQL.
3. **The ledger is the authority for money in a period** (spec §5.1, G-118). Every period figure comes from `summaryFor` definitions or the same SQL generalised to buckets. Invoice-level facts (status, balance, items) come from the invoice projection and snapshot. Each metric names its source (§7).
4. **No new writes to financial tables.** Retrieval and analytics bypass `CommandBus` entirely and run under `withBusiness()` with RLS, as `resendReply` does today.
5. **Reuse over invention.** Existing pieces stay where they are and are extended rather than wrapped:
   - router, continuations, `summaryFor`, `comparePeriods`, `changeOf`, `previousWindow`, `ageingFor`, the schedules, `buildProfitAndLoss`;
   - pdfkit and `renderBlocksPdf`, R2, `document.render`, `document.deliver`;
   - the STT pipeline.

---

## 5. Analytical query contract

### 5.1 Two intents, one engine

Recommendation: add **two** intents to `StructuredBusinessCommand` (`packages/contracts/src/business-command.ts`):

- `InvoiceQuery` asks for **records**: find, retrieve, summarise or aggregate invoices.
- `Analyse` asks for **business figures**: metrics over periods, comparisons, series, breakdowns, rankings and report output.

They are separate because they have different filters and different sources (invoice rows versus ledger windows). Merging them into one intent would put about 25 optional fields into every call. Five or more intents would multiply union branches.

**Compatibility with `Query`:**

- `Query` stays for backward compatibility: its topics, continuations (CHECK lists) and eval cases.
- `Query.sales_summary` and `expenses_summary` are re-pointed internally to the same engine, so the definitions cannot drift.
- The prompt steers new analytical phrasing to `Analyse` and keeps `Query` for its existing topics.
- The redundancy can be retired later (OD-15 records it).

```ts
// Proposed (illustrative; field names subject to Stage B review)
const phrase = (n: number) => text(n); // raw words; core resolves them
export const InvoiceCriteria = z.object({
  references: z.array(text(40)).max(3).nullable(),
  customer: CustomerRef.nullable(),
  itemText: phrase(80).nullable(),
  itemQuantity: z.number().int().positive().max(1_000_000).nullable(),
  periodText: phrase(60).nullable(),
  dateField: z.enum(['issued', 'due']).nullable(),
  amountText: phrase(40).nullable(), // "more than 100k"
  amountField: z.enum(['total', 'outstanding', 'paid']).nullable(),
  payment: z.enum(['unpaid', 'partly_paid', 'paid', 'outstanding', 'overdue']).nullable(),
  includeVoided: z.boolean().nullable(),
  sort: z
    .enum(['newest', 'oldest', 'highest', 'lowest', 'largest_balance', 'most_overdue', 'customer'])
    .nullable(),
  limit: z.number().int().min(1).max(10).nullable(),
});
export const InvoiceQuery = z.object({
  intent: z.literal('InvoiceQuery'),
  operation: z.enum(['find', 'retrieve', 'summarise', 'aggregate']),
  detail: z.enum(['brief', 'itemised', 'payments']).nullable(),
  groupBy: z.enum(['customer', 'month']).nullable(),
  criteria: InvoiceCriteria,
});

export const METRICS = [
  'sales',
  'collections',
  'expenses',
  'receivables',
  'overdue',
  'cash_flow',
  'gross_profit',
  'profit',
  'invoice_count',
  'average_sale',
  'collection_rate',
] as const;
export const Analyse = z.object({
  intent: z.literal('Analyse'),
  metrics: z.array(z.enum(METRICS)).min(1).max(4),
  periodText: phrase(60).nullable(), // "this month", "Q3", "since January"
  compareText: phrase(60).nullable(), // "last month", "same month last year", "yesterday"
  series: z.enum(['day', 'week', 'month', 'quarter']).nullable(), // "trend", "month by month"
  breakdown: z.enum(['customer', 'product', 'expense_category', 'channel']).nullable(),
  rank: z.enum(['top', 'bottom']).nullable(),
  rankBy: z.enum(['value', 'quantity', 'count', 'balance']).nullable(),
  limit: z.number().int().min(1).max(10).nullable(),
  customer: CustomerRef.nullable(), // "Ada's sales this month"
  output: z.enum(['answer', 'pdf']).nullable(), // explicit "PDF/report" words only
  depth: z.enum(['brief', 'detailed']).nullable(),
});
```

### 5.2 What deterministic code does

The model returns words. Core turns them into an `AnalysisPlan` or an `InvoiceFilter`, or a refusal or clarification:

- **Periods.** `periodText` and `compareText` go to `parsePeriodPhrase` (extended `periods.ts`, §6). A missing `compareText` together with comparison words means the default comparison for that period (§6.3).
- **Metric registry** (core `analytics.ts`). A fixed table gives each metric:
  - its source function;
  - its unit (kobo, count or percent);
  - its definition text (printed in the PDF methodology);
  - the breakdowns and series it supports;
  - its data preconditions.

  For example, `gross_profit` needs a cost-coverage statement (OD-21), and `breakdown: product` follows OD-20. A metric and breakdown pair outside the registry gets an honest "I can't break X down by Y yet" plus what it can do. This registry is what makes the engine dynamic: requests are compositions validated against data, not one method per phrase.

- **Amounts.** `amountText` goes to `parseAmountBound` (extended `money.ts`, built on `parseAmountText` :45). The result is integer kobo. **No money number travels in either intent.**
- **References.** `canonicaliseInvoiceRef` (extended `numbering.ts`): exact forms, and year-less forms become a candidate set.
- **Bounds.** Every limit is clamped. A missing period for a metric question gets the existing "which period?" clarification with continuation (`whichPeriod`, `replies.ts:1590`).
- **Output.** `output: 'pdf'` is honoured only under the PDF policy (OD-22) and the metering rules (OD-23).

### 5.3 Router fast paths (no model, no AI unit)

| Phrase                                                                                | Router intent                                 |
| ------------------------------------------------------------------------------------- | --------------------------------------------- |
| "send/show/find/resend INV-…", "summary of INV-…"                                     | `invoice_ref`                                 |
| "my invoices", "unpaid invoices", "overdue invoices"                                  | `invoice_list{payment}` (whole-message only)  |
| "sales yesterday", "sales today vs yesterday", "compare this month", "how am I doing" | `analyse_preset{preset}`, a small fixed table |
| "PDF", "send the PDF", "full report"                                                  | Only when a books continuation is open (§9)   |

Pinned router tests keep the existing model cases routing to the model.

### 5.4 Anthropic schema impact

**Strict mode is unchanged.** The schema is already over the union limit and will stay non-strict, and the strict-schema check keeps refusing it. That is correct, because a strict over-limit schema is a 400 (G-134 row).

**Must be measured in Stage B, never assumed:**

1. The exact union and optional counts, pinned in `strict-schema.test.ts`.
2. Tool-definition tokens per call. The schema grows for **every** message, including sales, payments and photos, so the cost per call by model must be reported.
3. Eval accuracy on all existing intents before and after (`apps/api/src/ai/eval/`). Any regression blocks the PR.
4. The owner-run production-shaped probe (`apps/api/src/ai/eval/probe-tool-choice.ts --send`) on Sonnet 5.5, Opus 5.5 and Haiku 5.5. This is live spend, so it is the owner's action.

**Fallback if accuracy or cost suffers (OD-35):** route through the existing classifier (`apps/api/src/ai/classifier.ts`) to a narrow, strict-eligible "books question" tool. That adds a call per books question but keeps the main schema unchanged.

---

## 6. Time-comparison semantics

All boundaries are in Lagos time: a fixed UTC+1 (`periods.ts:14`). There is no business timezone column, so "the merchant's timezone" is Lagos for every business (NG-only launch). If non-Nigerian merchants ever exist, a migration and a decision are needed; that is out of scope.

### 6.1 Period vocabulary (`parsePeriodPhrase`)

| Phrase                                                                                              | Window                                                                            |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| today, yesterday, "the day before yesterday", a named weekday ("this Monday", "last Monday")        | Whole Lagos days                                                                  |
| this week, last week                                                                                | Calendar week, Monday start (OD-19). "Past 7 days" and "last 7 days" are rolling. |
| this month, last month, a named month ("October", "October 2026")                                   | A bare month name means its most recent occurrence that is not in the future.     |
| this quarter, last quarter, "Q3", "Q3 2026"                                                         | Calendar quarters Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec (OD-19).                     |
| this year, last year, "2025"                                                                        | Calendar year.                                                                    |
| "past N days/weeks/months"                                                                          | Rolling, ending now.                                                              |
| "since January", "from 1 Sep to 15 Oct", "between Monday and Friday", "before 5 Nov", "after 5 Nov" | Custom range, bounded by the earliest data (§6.4) and by today.                   |
| An explicit date such as "12/11", "12 Nov", "12 November 2026"                                      | dd/mm by default. Ask only when both readings are valid and differ (OD-19).       |

- **Limits:** a single window spans at most 366 days (`MAX_CUSTOM_RANGE_DAYS`). A **series** may span up to 24 months or 8 quarters (OD-31).
- **Ambiguity** ("Monday" said on a Monday, "05/06") gets one question, through the existing `expects:'period'` continuation.

### 6.2 Complete versus partial periods

A window is **complete** when its end is in the past. It is **partial** when it contains now.

| Request                                            | Primary window            | Comparison window                                              | Label                                                                                                                                                          |
| -------------------------------------------------- | ------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Am I doing better today than yesterday?" at 14:05 | Today 00:00–14:05         | **Yesterday 00:00–14:05** (like-for-like)                      | "So far today vs yesterday by this time". Yesterday's full day is shown as a second line, labelled.                                                            |
| "Sales today vs yesterday"                         | Same                      | Same                                                           | Same                                                                                                                                                           |
| "This week vs last week" on Thursday               | Mon 00:00 to now          | Last Mon 00:00 to the same weekday and time                    | "Week to date vs the same point last week", plus last week in full.                                                                                            |
| "This month vs last month" on 20 Nov               | 1 Nov to now              | **1 Oct to 20 Oct, same time**                                 | "Month to date vs the same days of October", plus October in full. The day is clamped to the shorter month: 31 Mar compares with 28 or 29 Feb.                 |
| "This quarter vs last quarter"                     | Quarter to date           | The same elapsed days of the previous quarter                  | As above.                                                                                                                                                      |
| "This year vs last year"                           | Year to date              | The same elapsed period last year                              | As above.                                                                                                                                                      |
| "October vs September"                             | Complete                  | Complete                                                       | "Full months".                                                                                                                                                 |
| "Last 30 days vs the 30 before"                    | Rolling                   | The equal span before                                          | Rolling.                                                                                                                                                       |
| "Same month last year"                             | Month, to date if current | The same month a year earlier, clamped to the same elapsed day | YoY.                                                                                                                                                           |
| Two custom ranges of different lengths             | As given                  | As given                                                       | **Both lengths are stated, and the daily average is compared** as well as the totals. A percentage on totals is shown only when the lengths are equal (OD-18). |

**This replaces `previousWindow`'s behaviour for partial windows.** Today a partial month compares with the equal-length span before: 1–20 Nov against 12–31 Oct (`period-compare.ts:113-140`). That also changes `GET /v1/reports/compare`, which has no web caller (§2.2). The changed behaviour is pinned by tests.

**Clamp semantics.** `resolveCustomRange` clamps a range to the end of today (`periods.ts:142-161`), which includes hours that have not happened yet. Like-for-like comparisons use **now**, not the end of today.

### 6.3 Arithmetic

The existing `changeOf` (`period-compare.ts:73-77`) is reused unchanged, and its semantics are adopted:

- **Absolute change:** `current − previous`, in kobo. −0 becomes 0.
- **Percentage:** `previous > 0` gives `round(abs × 1000 / previous) / 10`, one decimal place. Otherwise **null**, shown as "not applicable".
- **Direction:** the sign of the absolute change, rendered as words ("up", "down", "no change"), never colour alone.

Additions, all in core:

- **Average sale** = `salesK ÷ invoices`, rounded half-up to the kobo. Null when the count is 0.
- **Count change:** absolute only.

**Zero rules.** These templates are fixed in core:

- **Previous period zero, current positive:** "₦X this period; nothing was recorded in the comparison period, so there is no percentage."
- **Current zero:** "No sales were recorded so far today." This is not "you sold nothing", because the books only hold what was recorded.
- **Both zero:** "No recorded sales in either period."

### 6.4 Missing data versus recorded zero

A window that **ends before the business's first record** is "no records yet", not zero. The first record is the earliest of `businesses.created_at`, the opening-balance `asAt` and the first ledger posting. A partially covered window ("since January" for a business that started in March) is labelled "records start on 4 March".

Year-over-year comparisons with no prior-year data say so instead of showing 100% growth.

### 6.5 Posting-date semantics

The ledger dates a figure by **when it was posted** (`summaryFor`, G-118):

- A void posted in November reduces November's sales, not October's. This matches the statements and is stated in the methodology section.
- Backdated postings land in their stated date while the month is open.
- Closed months cannot change (`0034` triggers).

**Report reproducibility.** A report for a closed period is reproducible. A report covering an open period records its as-of timestamp, and its stored JSON (§13) is the evidence of what it said.

---

## 7. Financial metric definitions

Every metric reads the source named here. Words used to the merchant follow OWN-44 and spec §5.1: invoiced sales, cash collected, expenses and profit are never interchangeable.

| Metric (merchant wording)                  | Definition                                                                                                                                                                                                                                                                                                                                                                             | Source                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Sales (invoiced)**                       | Revenue plus VAT posted in the window; voids netted; credit notes reported alongside, not netted                                                                                                                                                                                                                                                                                       | `summaryFor.salesK` (G-118)                                                                                                               |
| **Net sales**                              | Sales minus credit notes                                                                                                                                                                                                                                                                                                                                                               | `salesK − creditedK`                                                                                                                      |
| **Number of sales**                        | Sale-shaped postings minus reversals                                                                                                                                                                                                                                                                                                                                                   | `summaryFor.invoices`                                                                                                                     |
| **Average sale**                           | Net sales ÷ number of sales                                                                                                                                                                                                                                                                                                                                                            | core                                                                                                                                      |
| **Cash collected**                         | Cash that arrived from customers, net of reversals and chargebacks; refunds alongside                                                                                                                                                                                                                                                                                                  | `summaryFor.moneyInK`, `refundedK`                                                                                                        |
| **Collection rate (period)**               | Collected ÷ net sales for the same window. It can exceed 100% (collections on older invoices) and is labelled as such.                                                                                                                                                                                                                                                                 | OD-34                                                                                                                                     |
| **Paid share of this period's invoices**   | Σ `paid_k` ÷ Σ (`total_k − credited_k`) for invoices issued in the window and not voided, as of now                                                                                                                                                                                                                                                                                    | `invoices` projection (OD-34)                                                                                                             |
| **Unpaid invoices (%)**                    | By count and by value, open statuses, over the same set                                                                                                                                                                                                                                                                                                                                | `invoices`                                                                                                                                |
| **Outstanding receivables**                | Σ `balance_due_k`, open statuses, as of now                                                                                                                                                                                                                                                                                                                                            | `overviewFor.owedToYouK`, `debtorsFor`                                                                                                    |
| **Overdue and ageing**                     | Buckets as `ageingFor`                                                                                                                                                                                                                                                                                                                                                                 | `ageingFor` (OD-9)                                                                                                                        |
| **Days to get paid**                       | For invoices fully paid in the window: median of (last allocation date − issue date)                                                                                                                                                                                                                                                                                                   | N, `payment_allocations` (OD-34)                                                                                                          |
| **Expenses (recorded spend)**              | Operating expenses plus fees, plus stock bought at full value                                                                                                                                                                                                                                                                                                                          | `summaryFor.moneyOutK`. Labelled "spending, including stock bought".                                                                      |
| **Expenses excluding stock**               | Expense-account movement only                                                                                                                                                                                                                                                                                                                                                          | `expenseScheduleFor` generalised to windows                                                                                               |
| **By expense category**                    | Fixed ten categories. **NULL is shown as "not categorised"**, a fix to `reports.ts:564`.                                                                                                                                                                                                                                                                                               | Same                                                                                                                                      |
| **Expense-to-sales ratio**                 | Expenses excluding stock ÷ net sales. Only when net sales > 0.                                                                                                                                                                                                                                                                                                                         | core                                                                                                                                      |
| **Cost of goods sold**                     | COGS-role movement in the window                                                                                                                                                                                                                                                                                                                                                       | `accountSumsFor` generalised to windows                                                                                                   |
| **Gross profit / margin**                  | Net sales excluding VAT, minus COGS. **Always shown with cost coverage:** "₦X of sales (N sales) had no recorded cost, so gross profit is overstated by up to that amount". **Per BA-OD-21, withheld whenever costs are incomplete**, showing verified sales, recorded costs and a completeness warning, until the owner approves exact cost-coverage rules (no threshold is adopted). | `buildProfitAndLoss` (`statements.ts:141-176`). Coverage = revenue of sales with no COGS posting whose `source_id` is the invoice number. |
| **Profit (books)**                         | Income − expenses from the P&L builder. Labelled "profit in your books, from recorded costs and expenses". Same BA-OD-21 rule: withheld whenever costs are incomplete.                                                                                                                                                                                                                 | `buildProfitAndLoss` (OD-21)                                                                                                              |
| **Cash in / cash out / net cash movement** | Cash-account movement **excluding transfers between the merchant's own cash accounts and opening balances**                                                                                                                                                                                                                                                                            | OD-17. `cashflowFor` and `summaryFor.cashIn/Out` today include both.                                                                      |
| **Opening and closing cash**               | Cash-account cumulative balance at the window's ends                                                                                                                                                                                                                                                                                                                                   | `accountSumsFor` cumulative (statements' direct cash flow, `statements.ts:269-280`)                                                       |
| **Sales by channel**                       | `revenueScheduleFor` generalised to windows; NULL shown as "channel not stated"                                                                                                                                                                                                                                                                                                        | `reports.ts:621-688`                                                                                                                      |
| **Sales by customer**                      | Σ (`total_k − credited_k`) for non-void invoices issued in the window, by customer token (`customer_id` token, or snapshot token)                                                                                                                                                                                                                                                      | `invoices`. Names come from `ReplyService` and the report renderer (OD-24).                                                               |
| **Repeat customers**                       | Customers with 2 or more non-void invoices in the window                                                                                                                                                                                                                                                                                                                               | `invoices`                                                                                                                                |
| **Sales by product**                       | Per OD-20: verified product totals from sale stock movements joined to products, plus optional folded free-text names, labelled "as typed"                                                                                                                                                                                                                                             | `stock_movements`, `invoice_items`                                                                                                        |

**Reconciliation rule.** Ledger windows (`summaryFor`) and invoice-row aggregates (customer and product breakdowns) can differ: for example, when a credit note was posted in a later window, or for hand-posted revenue (`handPostedK`). A breakdown's total is therefore printed with "breakdown total ₦X of ₦Y sales", and an "other or unattributed" line closes the gap. That line is never hidden. A test pins equality when no credit, hand posting or backdating is involved.

**`overviewFor` inconsistency (OD-16).** `overviewFor.salesK` is not net of voids (§2.2). The `records` reply and the dashboard use it, so a merchant can see two different "sales this month" numbers. Recommendation: point `overviewFor.salesK` at the `summaryFor` definition. That is a pre-existing defect fix with a RED test; it changes a figure merchants see.

---

## 8. Advanced invoice search design

Revision 1's design is kept, with migrations re-assessed.

### 8.1 Query strategy

A new `packages/db/src/repos/invoice-search.ts` (§18) holds three functions:

- `invoiceSearch(tx, businessId, filter, page)` builds **one parameterised SQL statement** from a typed filter. Every user pattern is bound, with `%` and `_` escaped. The predicate covers:
  - the customer token: `c.token = ANY($t) OR snapshot_json->>'customerToken' = ANY($t)`, which covers historical NULL-`customer_id` invoices;
  - issue or due date range;
  - status set;
  - amount bound on `total_k`, `balance_due_k` or `paid_k`;
  - item name: `EXISTS` on `invoice_items` with `lower(name) LIKE $p` and an optional quantity;
  - keyset on `(sortKey, id)`, `LIMIT page + 1`.
- `invoiceAggregate(tx, businessId, filter)` runs over the same predicate: `COUNT`, the sums, `COUNT FILTER` by status, overdue sum, top 3 by balance, latest activity, and an optional `GROUP BY` token or Lagos month. **Counts come from SQL** (CLAUDE.md §5).
- `invoiceByReference(tx, businessId, ref)` does an exact match on canonical upper case, which uses the existing unique index.

### 8.2 Ranking tiers (core `analytics.ts`)

| Tier | Rule                                                           | Auto-select                                                    |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| T1   | Exact reference                                                | Yes                                                            |
| T2   | One resolved customer plus filters                             | Only if the count is 1, or the request says "last" or "latest" |
| T3   | Exact structured filters (amount `eq`, quantity, date, status) | Only if the count is 1                                         |
| T4   | All item words match line-name words or word prefixes          | Never                                                          |
| T5   | Some item words match ("closest matches")                      | Never                                                          |
| T6   | Fuzzy customer-name candidates (OD-1)                          | Never; the customer is chosen first                            |

**No embeddings, vector store, search engine or `pg_trgm` in the plan.** Every searchable fact is structured, or is a short merchant-typed item name. A semantic layer would duplicate tenant data, add a processor (spec Appendix C) and still need SQL verification. Revisit only with measured misses from staging.

### 8.3 Indexes (re-assessed for minimal migrations)

Revision 1 proposed four indexes. Per the follow-up's migration rule, **none is proposed up front**:

- every predicate is business-scoped;
- `(business_id, status)` and `(business_id, customer_id)` already exist;
- a business with thousands of invoices is a small, sequential range.

**Stage H gate:** an integration test seeds 20,000 invoices and 60,000 ledger lines for one business, with a second business of the same size, and asserts p95 query time against budget (§15) with `EXPLAIN`. Only a failing budget justifies an index migration (candidates M1–M3, §19).

### 8.4 Customer identity

Unchanged from revision 1:

- **Exact name and phone through the vault HMAC.** Partial or fuzzy matching per OD-1.
- **Lookup-only resolution for reads** (OD-3). Implemented as a new method on the existing `PrivacyGateway` (`gateway.service.ts`) rather than a new service file.
- **Business names treated as names** (OD-2).
- **The sender's own number is never the customer filter.**
- Display names are rehydrated only in the output layers (§16).

### 8.5 Document outcomes

Kept from revision 1. Each outcome has its own template:

- not found, which is also the reply for another tenant's number;
- paid at recording, so a receipt exists instead and is offered (OD-4);
- no PDF ever made;
- object missing, checked **before** replying "Sending…", which fixes today's silent 5 retries;
- storage down;
- unauthorised;
- removed by retention.

**Never re-render or renumber** (OD-5). Delivery goes to the requesting member (OD-7).

### 8.6 Summaries

Kept from revision 1. "As issued" comes from the snapshot, including `paidK` at issue. "Today" comes from the projection plus allocations and credits. The two sections are never blended, a negative balance is never shown, and overpayment appears as credit held.

**The same summary feeds the report PDF's invoice tables**, so there is no second balance calculation (follow-up §11).

---

## 9. Conversational context design

### 9.1 Reusing `conversation_continuations`

The existing table already provides:

- member and business scoping;
- one open row per member;
- the 600 s TTL;
- supersession when a new row opens;
- the `options` invoice choice list, validated by the database, with up to 9 entries.

That covers ordinal selection ("the second one") with **no schema change**: `kind='clarification', expects='choice'`.

What it cannot hold is the **analysis context** needed to apply "what about expenses?", "now the previous three months" or "generate the PDF" to the prior answer. Its columns are closed CHECK lists (§2.6).

**OD-33 recommendation:** one migration adds a nullable jsonb `context` to `conversation_continuations`, together with:

- a database validation function in the style of `conversation_continuation_options_valid`;
- a new `kind='books'`;
- a CHECK widening.

The context holds **only resolved, typed values**:

- intent;
- metric and breakdown enums;
- the resolved windows as ISO timestamps;
- comparison mode;
- customer token;
- invoice filter enums and kobo bounds;
- the keyset cursor;
- the `BooksResult` reference (the job or document ID of a generated report).

Following 0154's rule, **no typed words are stored**. The one casualty is free-text item words, so "only the unpaid ones" after an item search needs the item words repeated. Option (c) in OD-33 changes that rule.

The rejected alternative reads the context from the last read-only `command_drafts` row (zero migration). It couples the write-confirmation table (CG3 authority) to analytics.

### 9.2 Follow-up resolution

| Merchant says (books continuation open)                  | Resolution                                                                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "2", "the second one", "number 2"                        | Router ordinal → `options` → re-read by invoice number under `withBusiness`                                                                                                         |
| "send it", "send the PDF"                                | Invoice context: deliver the selected or only invoice's stored PDF. Analysis context: generate the report PDF from the **stored context**, re-run deterministically (OD-22, OD-23). |
| "what about expenses?", "and collections?"               | Router phrase table (topic words plus lead words) → swap the metric, keep the windows. Otherwise the model returns a partial `Analyse`, which is **merged over** the context.       |
| "now the previous three months", "what about last week?" | Extended `periodAnswer` → swap the windows and keep the metrics.                                                                                                                    |
| "show the top products", "which customers?"              | Add a breakdown and keep the windows.                                                                                                                                               |
| "only the unpaid ones", "sort by amount"                 | Invoice context: merge the filter or sort.                                                                                                                                          |
| "send it again"                                          | Re-deliver the last document **delivered to this member**, invoice or report (OD-26). Free.                                                                                         |
| "show the previous report"                               | List this member's recent `report_pdf` documents (newest 5) as choices (OD-32).                                                                                                     |

**Merge rules** (core, pure):

- the model's partial intent may only **change** fields it set;
- unset fields inherit from the context;
- a merge that changes intent type (invoice ↔ analysis) starts fresh;
- every merged plan is re-validated as if it were new.

**Expiry:** after 600 s, or when the context is superseded, "what about expenses?" is answered as a new question with no carried period, so the existing "which period?" question is asked. It never silently reuses stale context. When a member's authorisation has changed since the context was written (role or plan), the context is discarded.

---

## 10. Insights engine

The engine is deterministic: rules over `BooksResult`, in core `analytics.ts`. Each rule has a precondition, a threshold and a fixed template. No model is involved in the MVP (OD-27).

| ID  | Finding                                                               | Precondition and threshold (proposed, OD-31)                                        |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| I1  | Sales up or down X% vs the comparison                                 | Comparison valid (§6.2); \|% \| ≥ 5 or \|Δ\| ≥ ₦10,000                              |
| I2  | Collections did not keep pace with sales                              | Sales up, and collection rate down ≥ 10 points                                      |
| I3  | Receivable concentration: "3 customers hold 65% of what you are owed" | ≥ 5 debtors; top-3 share ≥ 50%                                                      |
| I4  | Strongest day, week or month in the range                             | ≥ 3 buckets with activity                                                           |
| I5  | Expenses grew faster than sales                                       | Both periods have sales > 0 and expenses > 0                                        |
| I6  | Overdue amount rose                                                   | Ageing at both ends of the window                                                   |
| I7  | Largest expense category share                                        | ≥ 3 categorised expenses; "not categorised" is reported, never ranked as a category |
| I8  | Sustained trend: "sales rose for 4 months in a row"                   | ≥ 4 consecutive buckets in one direction                                            |
| I9  | Product or customer concentration in sales                            | OD-20 and OD-24 apply                                                               |

**Data-confidence labels**, attached to the result and printed in the PDF methodology section:

| Label                | Example                                                        |
| -------------------- | -------------------------------------------------------------- |
| verified             | A ledger figure                                                |
| derived              | A ratio                                                        |
| partial              | An incomplete period                                           |
| coverage-limited     | Uncosted sales, uncategorised expenses, free-text products     |
| unavailable          | A metric the data cannot support, with the missing input named |
| insufficient history | Fewer buckets than a rule needs                                |

**Recommendations** are a fixed, whitelisted set. Each is tied to a finding and to an existing Rekoda action, for example:

- I2 or I6: "Consider reviewing unpaid invoices: send _who owes me_."
- I7: "Your largest spending was rent."

There are no causal claims, no forecasts and no intent inference. The engine has no rule type that could express those, which makes it safe by construction.

---

## 11. PDF rendering architecture

### 11.1 What exists and what is missing

`renderBlocksPdf` (`pdf.ts:163-329`) already provides:

- embedded Unicode fonts;
- A4 pages;
- pagination with keep-together logic;
- a "Page N of M" footer.

It lacks colour, tables, KPI cards and charts. pdfkit itself provides every primitive needed for those: `rect` and `roundedRect` with `fill` and `stroke`, `moveTo`, `lineTo` and `bezierCurveTo`, `fillColor` and `strokeColor`, `opacity`, measured text width (`widthOfString`) and `heightOfString`, and clipping. The gap is in Rekoda's renderer, not in the library.

### 11.2 Options compared

| Option                                                             | Charts and layout                                                             | Image and runtime impact                                                                                          | Security and ops                         | Verdict                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| **A. Extend pdfkit renderer (recommended)**                        | Vector bars and lines, KPI cards, tables drawn natively; exact, deterministic | **None** (already installed, pure JS)                                                                             | No new attack surface; same fonts        | Chosen                                         |
| B. HTML → PDF via headless Chromium (puppeteer or playwright-core) | Rich CSS, reuse of web components                                             | **+~300–400 MB image, 150–400 MB RAM per render**, on a 4 GB host already under memory pressure (`deploy.md:179`) | Browser sandbox, Chromium CVE cadence    | Rejected                                       |
| C. Chart library server-side (Chart.js or Vega + node-canvas)      | Ready charts, embedded as raster PNG                                          | Native cairo and pango → `apt-get` in the Dockerfile                                                              | Native-module CVEs; raster blur on print | Rejected                                       |
| D. `svg-to-pdfkit` (MIT, pure JS) + SVG charts                     | Reuse of the `CashflowChart.tsx` approach                                     | Small dependency                                                                                                  | Low                                      | Fallback only, if A's chart code proves costly |

### 11.3 Design within option A

**Core: new `packages/core/src/report-layout.ts`.** It holds pure layout functions, `layoutReport(result: BooksResult, opts) → ReportPage[]`, which make every content decision:

- which sections appear, given the data;
- section order and adaptive depth (§12);
- KPI selection;
- chart type per question (§12.4);
- **chart geometry**: scales with zero baselines, nice tick values, bar positions, label strings via `formatKobo`;
- table rows, column alignment, and header repetition on page breaks.

Because geometry is computed in core, it is unit-testable without a PDF. Tests can assert that the zero baseline exists, bars are proportional, no labels overlap and no text box exceeds its column.

**API: `apps/api/src/documents/pdf.ts`.** Add `renderReportPdf(pages)` beside the existing renderers. It reuses:

- font registration;
- `FontsMissing`;
- A4 constants;
- the footer and pagination code.

It adds ink only: filled rectangles, polylines, table cells and colour tokens. `LayoutBlock` stays for invoices, receipts and statements; reports get their own typed element union in `report-layout.ts`. This avoids widening `LayoutBlock`'s string-only shape for every existing document.

**No HTML, CSS or chart configuration ever comes from a model** (follow-up §15). The renderer accepts only `report-layout`'s typed elements.

**Fonts.** Noto Sans Regular and SemiBold are reused; they carry ₦. **Brand display type, Calistoga, needs a TTF asset** (OFL, roughly 100 KB, fetched by the existing `scripts/fetch-pdf-fonts.mjs`). That is a binary asset, not a dependency (OD-28).

---

## 12. Report design specification

### 12.1 Report design tokens

These are derived from `design-system/rekoda/MASTER.md` and recorded in `docs/REKODA_DESIGN_SYSTEM.md` as a new "Printed reports" section (Stage I).

| Token           | Value                                                                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page            | A4 portrait (OD-30). Margins 40 pt, plus a 28 pt header band and a 24 pt footer.                                                                                                                                                                                                                                       |
| Type            | Display: Calistoga 22/18 pt (OD-28; fallback Noto Sans SemiBold). Section: Noto SemiBold 13 pt. Body: Noto Regular 9.5 pt / 13 leading. Table: 8.5 pt. Note: 7.5 pt. **Tabular figures**: right-aligned money, fixed decimal positions via `formatKobo`.                                                               |
| Colour          | Text `#1c1b19`, muted `#6b6862`, rules and borders `#ddd9d0`, card fill `#f7f6f3`, accent `#0f766e`. Series "in" (sales, collections) `#0d9488`, "out" (expenses) `#9d3557`. Comparison period: the same hue at 45% tint. Status colours (`#b45309` attention) are used **only for caveat callouts**, never as series. |
| Numbers         | Full ₦ amounts in tables and KPIs. Axis labels abbreviated (₦45k, ₦1.2m) with exact values in the adjacent table. Percentages to one decimal place, from core.                                                                                                                                                         |
| Direction       | "▲ 25.0% (₦45,000)" / "▼ …" with words in the KPI caption. Colour is never the only signal.                                                                                                                                                                                                                            |
| Header          | Business name (left), report title and period (right), hairline rule.                                                                                                                                                                                                                                                  |
| Footer          | "Prepared by Rekoda from your records · <report ref> · generated <Lagos timestamp> · Page N of M"                                                                                                                                                                                                                      |
| Empty section   | One muted sentence: "No expenses were recorded in this period." Never an empty chart.                                                                                                                                                                                                                                  |
| Long tables     | Header repeated on each page; zebra rows at `#fcfcfb`; at most 40 rows in the body, then "and 112 more in the appendix" (appendix capped by OD-31).                                                                                                                                                                    |
| Confidentiality | "Confidential: prepared for <business name>" on the cover.                                                                                                                                                                                                                                                             |

### 12.2 Sections (adaptive)

1. **Cover band:** Rekoda mark, business name, title, period and comparison period, generated date, confidentiality line.
2. **Executive summary:** 3–5 sentences from the insight templates (verified findings first).
3. **KPI overview:** 2–6 cards in a 3-column grid. Each card shows label, value, comparison value and direction. Only metrics the data supports appear (`unavailable` metrics appear in methodology, not as empty cards).
4. **Comparative performance:** a table of metric, current, comparison, change ₦ and change %, with the like-for-like note.
5. **Trends:** a chart per §12.4.
6. **Sales breakdown:** channel, top customers and top products, per OD-20 and OD-24.
7. **Collections and receivables:** collected vs invoiced, ageing bars, top balances.
8. **Spending:** category bars and expense-to-sales ratio.
9. **Profitability:** only per OD-21, always with coverage.
10. **Findings and suggested actions:** grouped as "What the figures show" and "Things you could do".
11. **Methodology and notes:** windows with exact Lagos timestamps, complete or partial status, definitions from the metric registry, exclusions (VAT inclusion, stock at full value, posting-date rule), confidence labels, as-of time.

### 12.3 Example layouts

- **Daily comparison** ("today vs yesterday, PDF"), 1–2 pages:
  - Page 1: cover band, 3 KPI cards (sales so far, collected so far, number of sales; each against yesterday by this time), a grouped bar chart by hour block (morning, afternoon, evening) when there are 5 or more postings, otherwise none, the comparison table and 2 findings.
  - Page 2, only if needed: methodology.
- **Monthly** ("this month vs last month, detailed"), 3–5 pages:
  - Page 1: summary and 4–6 KPIs.
  - Page 2: the comparison table, plus a daily-sales line chart with last month as a tinted line on the same axis.
  - Page 3: channel, customer and product breakdowns.
  - Page 4: collections and ageing, then spending.
  - Page 5: profitability (per OD-21), findings and methodology.
- **Quarterly comprehensive**, 6–10 pages: everything in the monthly layout, plus a 3-month grouped bar chart (sales, collections, expenses), a quarter vs previous quarter table, top-10 tables, and an appendix with a paged invoice list for the quarter (capped).

### 12.4 Chart selection (core, deterministic)

| Question shape                    | Chart                                            |
| --------------------------------- | ------------------------------------------------ |
| Two windows, 1–3 metrics          | KPI cards plus horizontal paired bars            |
| Series of ≥ 4 buckets             | Line (one metric) or grouped bars (2–3 metrics)  |
| Series of < 4 buckets             | Grouped bars only                                |
| Ranking                           | Horizontal ranked bars, ≤ 10, with value labels  |
| Ageing                            | Five-bucket bars                                 |
| Share (categories, concentration) | Ranked bars with percentages. **No pie charts.** |

Every chart rule:

- axes start at zero;
- currency labels on the axis;
- exact values in an adjacent table;
- no dual axes;
- no 3D;
- no chart when fewer than 2 non-zero values exist.

### 12.5 Visual verification (OD-29)

Three layers:

1. **Core geometry tests.** Bars are proportional, there is a zero baseline, no element boxes overlap, no text exceeds its box (using fontkit metrics passed in), and pagination is correct for 0, 1, 40 and 400 rows.
2. **PDF content tests.** pdfjs-dist is added as a **devDependency** only (Apache-2.0). It extracts text from the rendered PDF, and the tests assert that every figure printed equals the `BooksResult` figure, with no ₦ glyph missing. This also lifts the existing limitation that "text cannot be asserted because strings are glyph ids" (`pdf.integration.test.ts:194-202`).
3. **Visual regression.** pdf.js renders each page to a canvas inside the existing Playwright (1.64.1) browser, and `toHaveScreenshot` compares it against committed baselines for daily, monthly and quarterly reports, plus empty and huge fixtures. No production dependency is added.

---

## 13. Generation and delivery lifecycle

```
inbound (Analyse with output:'pdf', or "PDF" in a books continuation)
  1  authenticate, attribute, role, entitlement           (existing, handler)
  2  plan = resolve(intent)                               (core)
  3  result = BooksResult via withBusiness(tx) queries    (db, read-only)
  4  reply = chat summary from result                     (replies.ts)
  5  reserve REPORT_EXPORTS unit (OD-23)                  (existing reserveUnit; refund on terminal failure)
  6  enqueue document.render {report: result, requestedBy}   singletonKey report:<inboundEventId>
  7  send reply "Here's the summary. Your PDF report is being prepared."    (same transaction as 5, 6)
worker:
  8  layoutReport(result) → renderReportPdf → bytes      (deterministic)
  9  storage.put(PDF) and storage.put(JSON of result)     key documents/<biz>/report_pdf/<rand>.{pdf,json}
 10  recordDocument(kind 'report_pdf', ref 'RPT-YYYYMMDD-<6 hex>')   (no doc_counters; not a financial number)
 11  enqueue document.deliver {documentId, recipientUserId}   singletonKey deliver:<docId>
 12  deliver: upload, send, caption "Your Rekoda report for <period>", outbound row, usage row (existing)
```

**Single source of truth.** The result computed in step 3 is the only data used in steps 4, 8 and 9. The job payload carries it: jsonb, a few KB to roughly 50 KB for quarterly reports with capped appendices _(inference; to be measured in Stage F)_. Nothing re-queries.

**Idempotency.**

- A redelivered webhook hits `messages_provider_ux` and returns early (handler :497-505).
- A retried inbound job sees `holdsUnit` and the singleton key `report:<eventId>`.
- A render retry overwrites nothing: a new random key, and the document row is written only after the put succeeds.
- A crash between put and record leaves an orphan object. It is acceptable and recorded _(inference; the same as invoices today)_.
- Deliver is singleton per document.
- "Send it again" is an explicit new delivery (OD-26).

**Failures.** Each has a distinct outcome, and none loses the computed result:

| Failure                                   | Outcome                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Query failed                              | Error reply, nothing reserved                                                                                                                                            |
| Metric unavailable                        | The answer omits it and says why. A PDF section becomes a methodology note.                                                                                              |
| Render failed (terminal after 5 attempts) | Unit refunded. The dead job raises an ops exception. The merchant gets "I couldn't make the PDF; your figures above are correct". The chat summary already reached them. |
| Storage failed                            | Retried by the job; then as for a render failure                                                                                                                         |
| Delivery failed                           | Existing deliver retries and dead-letter. Window closed → the existing document-notice template.                                                                         |
| Report expired (OD-25)                    | "That report has expired; ask again for a fresh one"                                                                                                                     |
| Authorisation failed                      | Existing replies                                                                                                                                                         |

**Retention (OD-25).**

- With customer names in the PDF (OD-24 A), the stored report is PII and is derivable from the books. The recommendation is to expire report objects after 90 days through a sweep that feeds `pending_object_deletions`. That needs migration M5 (a new reason value, and either a `documents` row deletion grant or a tombstone).
- With no names (OD-24 B), reports can be kept like other documents, with zero migrations.
- Two-ask erasure must also purge report objects that hold names (OD-24).

**Size.** The quarterly target is under 1.5 MB. Charts are vectors; there are no images except the mark. That is well under Meta's limit, but Stage F adds an outbound size check: there is none today (§2.3).

---

## 14. Voice integration

There is no new pipeline. Transcripts enter the same router, continuation and interpreter path (handler :447-454). Metering:

- `VOICE_MINUTES` for every note;
- `AI_ACTIONS` only if the transcript reaches the model;
- a router-matched spoken phrase ("sales today") costs voice seconds only.

Voice-specific rules:

1. **Invoice references from speech.** Spoken-form canonicalisation. Summaries may be immediate; **PDF delivery of an invoice waits for a one-tap confirmation** that quotes the number, amount and date. Partial references become candidate lists. There is no near-miss substitution. This is needed because whisper gives no confidence signal (`stt.openai.ts:79`).
2. **Analytics from speech.** The answer is given directly, because it is read-only and the windows are echoed in the reply ("1–20 November vs 1–20 October"), so a mishearing is visible. **A report PDF requested by voice is confirmed first:** "I'll prepare a PDF report for October to December 2026. Reply _yes_." This applies only when the PDF consumes a unit (OD-22, OD-23).
3. **Configuration.** `VOICE_TRANSCRIPTION_ENABLED` is off by default, and staging's value is unknown to me. Voice acceptance needs the owner to confirm it is on (with `OPENAI_API_KEY` and `AI_TRANSCRIPTION_PRICES`). No configuration is changed by this work.
4. **Lapsed plans** are refused voice before fetch (handler :1314-1322), consistent with OD-13.

---

## 15. Performance and cost assessment

| Area             | Assessment                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window queries   | `summaryFor` scans `ledger_entries` by `(business_id, created_at)`, which is indexed. A comparison is 2 calls.                                                                                                                                                |
| Series           | Generalise the same SQL to `GROUP BY` bucket. One query per series, not one per bucket.                                                                                                                                                                       |
| Quarterly report | About 10–14 queries in total _(inference)_. Budget: p95 ≤ 1.5 s on the 20,000-invoice / 60,000-line fixture (to be measured).                                                                                                                                 |
| Invoice search   | Budget p95 ≤ 50 ms. Measured in Stage H. Indexes only if the budget fails (§8.3).                                                                                                                                                                             |
| Rendering        | pdfkit in the worker, roughly tens of MB per render _(inference; to be measured)_. Worker concurrency is unchanged. Reports are rare compared with messages.                                                                                                  |
| Caching          | **None.** Figures change with every posting, and invalidation would add risk for little gain at SME volumes. Repeat requests within the continuation reuse the stored context. "Send it again" reuses the stored PDF for free.                                |
| Storage          | Roughly 50–300 KB per report _(inference)_. Negligible at R2 pricing. Retention per OD-25.                                                                                                                                                                    |
| AI cost          | Unchanged per call class: one primary call and at most one escalation. **The schema growth adds input tokens to every model call; measure and report in Stage B (§5.4).** Router presets avoid the model for common questions. Results never go to the model. |
| Voice            | Existing per-second cost and ceilings.                                                                                                                                                                                                                        |
| Report cost      | Render CPU, storage, and one Meta service message, recorded as today. A `REPORT_EXPORTS` unit per PDF produced (OD-23).                                                                                                                                       |
| Latency fields   | Add `latencyMs` to the `usage_events` meta for model calls, and timings for report jobs (none are recorded today, §2.5 of revision 1).                                                                                                                        |

---

## 16. Security and financial integrity review

**Tenancy.** Every query runs under `withBusiness()`, and RLS is forced on every table read (`0001_rls.sql:31-55`). Report jobs carry a `business_id` and run their writes under it. The R2 key is prefixed by business. The same reply is given for "not yours" and "does not exist".

**Authorisation.**

- Every member may read: search, analytics and summaries (OWN-25). That matches the web reports, which are `@AllMembers()`.
- Delivery goes to the **requesting member's own phone** (OD-7).
- Report PDFs follow the same rule.
- Deactivated members: verify `roleOfPhone` (§2.5) with a test.

**Forged or stale identifiers.**

- Members only ever send ordinals or references. Ordinals resolve through their own continuation row.
- Report and document IDs never come from the model or from text.
- Contexts expire after 600 s and are discarded when the member's role or plan changes.

**Privacy.**

- Results and invoice data never enter a model, so item names and customer names cannot carry prompt injection.
- Names are rehydrated in `ReplyService` and in the report renderer. The worker already holds the vault key, because the API and worker load the same environment (CLAUDE.md §3).
- Logging follows `redactForLog`, and the log-capture test is extended to the new paths.
- PII in stored report PDFs: OD-24 and OD-25.

**Financial non-mutation.**

- There is no command bus on these paths.
- The only writes are: messages, continuations, usage events, usage counters (`AI_ACTIONS`, `VOICE_MINUTES`, `REPORT_EXPORTS`), jobs, `documents` rows and R2 objects for reports, and an optional `audit_events` "report generated" or "document retrieved" event with references only.
- **Stage H proof test.** Run every operation, including repeats, duplicate webhooks, retried jobs and 10 concurrent requests. Before and after, compare counts and checksums of `invoices`, `invoice_items`, `payments`, `payment_allocations`, `receipts`, `credit_notes`, `customer_credits`, `ledger_entries`, `ledger_transactions`, `stock_movements`, `products.on_hand`, `doc_counters`, `customers`, `customer_identities` and `businesses` plan fields. All must be equal.
- **Reconciliation tests:**
  - every analytics figure equals the existing functions for the same window (`summaryFor`, `accountSumsFor` + `buildProfitAndLoss`, `ageingFor`);
  - summaries equal `rebuildInvoiceProjection` across partial, full, reversed, refunded, credited, voided and overpaid histories.

---

## 17. Existing files to modify

| File                                            | Change                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/business-command.ts`    | `InvoiceQuery`, `Analyse`; union branch; tool schema                                                                                                                                                                                                                                     |
| `packages/core/src/router.ts`                   | `invoice_ref`, `invoice_list`, `analyse_preset`, ordinal phrases, topic-switch and "PDF" follow-ups, extended `periodAnswer`                                                                                                                                                             |
| `packages/core/src/periods.ts`                  | `parsePeriodPhrase`; yesterday, weekday, calendar week, quarter, year, rolling-N, named month, ranges; like-for-like windows; first-record bounding                                                                                                                                      |
| `packages/core/src/period-compare.ts`           | Comparison planner (default comparisons, elapsed matching, different-length rule); more `WindowFigures` measures; series compare. `changeOf` unchanged.                                                                                                                                  |
| `packages/core/src/money.ts`                    | `parseAmountBound`                                                                                                                                                                                                                                                                       |
| `packages/core/src/numbering.ts`                | `canonicaliseInvoiceRef` (typed and spoken)                                                                                                                                                                                                                                              |
| `packages/core/src/continuation.ts`             | `books` context type, merge rules, resume                                                                                                                                                                                                                                                |
| `packages/core/src/replies.ts`                  | Templates: lists, summaries, comparisons, zero and partial wording, insights, report status, failure outcomes; `help()` and `notYet()` updated                                                                                                                                           |
| `packages/core/src/request-kind.ts`             | New READ phrasings, with tests (part of G-100)                                                                                                                                                                                                                                           |
| `packages/core/src/command-persistence.ts`      | Persisted-field entries for the new intents                                                                                                                                                                                                                                              |
| `packages/db/src/repos/reports.ts`              | `summaryFor` generalised to buckets (series) with the **same** definitions; `accountSumsFor`, `expenseScheduleFor` and `revenueScheduleFor` taking windows; customer, product and transaction rankings; cash measures per OD-17; `overviewFor.salesK` per OD-16; NULL-category label fix |
| `packages/db/src/repos/continuations.ts`        | `books` kind and `context` read and write (OD-33)                                                                                                                                                                                                                                        |
| `packages/db/src/repos/issue.ts`                | `documentsForInvoice`; `latestDocumentFor` → last delivered to the member (OD-26)                                                                                                                                                                                                        |
| `apps/api/src/privacy/gateway.service.ts`       | Lookup-only resolution (OD-3); bounded name matching (OD-1)                                                                                                                                                                                                                              |
| `apps/api/src/jobs/inbound-message.handler.ts`  | Wiring only: route new intents and router intents to `books-answer.ts`; skip `resolveMention` for reads                                                                                                                                                                                  |
| `apps/api/src/ai/prompt.ts`                     | Books-question section; remove "cannot send" for retrieval                                                                                                                                                                                                                               |
| `apps/api/src/ai/eval/dataset.ts`               | Cases for every example in both specifications                                                                                                                                                                                                                                           |
| `apps/api/src/jobs/render-document.handler.ts`  | `report` payload branch                                                                                                                                                                                                                                                                  |
| `apps/api/src/jobs/deliver-document.handler.ts` | `recipientUserId`; report caption and label; pre-send size check                                                                                                                                                                                                                         |
| `apps/api/src/documents/pdf.ts`                 | `renderReportPdf` (cards, tables, charts, colour) reusing fonts and pagination                                                                                                                                                                                                           |
| `apps/api/src/config.ts`, `.env.example`        | `BOOKS_ASSISTANT_ENABLED` (fail-closed parse, default off)                                                                                                                                                                                                                               |
| `apps/api/src/reports/reports.controller.ts`    | `compare` uses the new planner (behaviour pinned)                                                                                                                                                                                                                                        |
| Docs                                            | Design system "Printed reports", CURRENT_STATE, READINESS (G-118 and new rows), user journeys, metering-v1, pricing-model correction, spec or OWN ruling (OD-15)                                                                                                                         |

---

## 18. Justified new files

Production files: **four**.

| File                                      | Responsibility                                                                                                              | Why not an existing file                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/analytics.ts`          | Metric registry, analysis plan validation, invoice ranking tiers, insight rules, confidence labels, PDF policy              | A distinct pure domain. `period-compare.ts` is arithmetic only, and `replies.ts` is wording.                                              |
| `packages/core/src/report-layout.ts`      | Report sections, KPI selection, chart choice and geometry, table pagination                                                 | Parallels `statement-layout.ts`, `invoice-layout.ts` and `receipt-layout.ts`; the same convention                                         |
| `packages/db/src/repos/invoice-search.ts` | `invoiceSearch`, `invoiceAggregate`, `invoiceByReference`, `documentsForInvoice` (or kept in `issue.ts`)                    | `issue.ts` is the write-side issuance repo, and `reports.ts` is ledger windows. A read model over invoice rows is its own responsibility. |
| `apps/api/src/jobs/books-answer.ts`       | One orchestration entry for router, interpreter and continuation paths: plan → query → result → reply → optional report job | The inbound handler is about 5,800 lines. Putting this there would repeat the orchestration across three call sites.                      |

Test files, required by `check-test-layout`:

- `analytics.test.ts`, `report-layout.test.ts` and additions to the existing core tests;
- `packages/db/src/invoices/invoice-search.integration.test.ts`;
- `packages/db/src/ledger/analytics-series.integration.test.ts`;
- `apps/api/src/channels/meta-books-*.integration.test.ts`, split by concern per the layout rules;
- `apps/api/src/documents/report-pdf.integration.test.ts`;
- `apps/web/e2e/report-visual.spec.ts` (OD-29).

**Assets:** `apps/api/assets/fonts/Calistoga-Regular.ttf`, if OD-28 = A.

**Explicitly not created:**

- no analytics service class hierarchy, factories or per-metric files;
- no separate continuation store;
- no separate PDF module;
- no customer-lookup service: it becomes a gateway method.

---

## 19. Database migration assessment

**Can the feature ship with zero migrations? Yes**, if OD-33 = B (context from drafts), OD-24 = B (no names in stored PDFs) and the Stage H performance budget passes without indexes. **That is not my recommendation**, because the cost is the coupling and privacy trade-offs in those decisions.

| #                   | Migration                                                                                                                       | Needed when                        | Why existing schema cannot serve                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| M4 (recommended)    | `conversation_continuations`: kind `books`, nullable `context jsonb` with a validation function, CHECK widening                 | OD-33 = A                          | The CHECK lists are closed (§2.6). The `options` validator admits only invoice lists.                            |
| M5 (conditional)    | `pending_object_deletions` reason `report_expired`, plus a `documents` deletion path or tombstone column                        | OD-25 = expiry (follows OD-24 = A) | The reason CHECK is fixed (`0129:27-28`), and no per-document deletion exists.                                   |
| M1–M3 (conditional) | `invoices (business_id, created_at, id)`; `(business_id, (snapshot_json->>'customerToken'))`; partial `(business_id, due_date)` | Only if the Stage H budget fails   | Revision 1 proposed them up front; withdrawn under the follow-up's migration rule.                               |
| M6 (conditional)    | `customer_identities` facet `name_word` plus a backfill job                                                                     | OD-1 = B only                      | Exact HMAC only                                                                                                  |
| M7 (conditional)    | Product link on chat sale lines                                                                                                 | OD-20 = C only                     | `invoice_items` has no `product_id`                                                                              |
| — withdrawn         | `documents.invoice_id` (revision 1, M5)                                                                                         | —                                  | The `(business_id, ref_number, kind)` join is sufficient at SME volumes. Revision 1's OD-11 changes accordingly. |

**Not needed:**

- **`report_pdf` kind:** `documents.kind` has no CHECK.
- **Report job kind:** `jobs.kind` has no CHECK.
- **Report metadata:** it goes in the R2 JSON beside the PDF.
- **Report reference:** text in `ref_number`; no counter.
- **Metering:** `REPORT_EXPORTS` exists.

---

## 20. Dependency assessment

**Production dependencies: none added.**

- pdfkit (installed) covers vector charts, cards, tables and colour (§11.2).
- Option B (Chromium), option C (canvas) and option D (`svg-to-pdfkit`) are rejected or held in reserve, with reasons.

**Development dependency: one** (OD-29). `pdfjs-dist` (Apache-2.0, Mozilla, pure JavaScript, actively maintained):

| Aspect         | Detail                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Purpose        | Text extraction in the API integration tests, and page rasterisation inside the existing Playwright browser for visual baselines |
| Runtime impact | None: not in the production image, which installs production dependencies only (`Dockerfile`)                                    |
| CI impact      | One devDependency install; screenshot baselines committed under `apps/web/e2e/`                                                  |
| Alternative    | Geometry tests only, with no PDF-level verification. Weaker: it cannot catch missing glyphs or renderer bugs.                    |

**Font asset:** Calistoga TTF (SIL OFL 1.1) if OD-28 = A. It is fetched by the existing script and is not a package.

---

## 21. Development stages and PR boundaries

The PRs are serial (single-flight). Each ships behind `BOOKS_ASSISTANT_ENABLED` (default off) and has its own RED tests first. The owner approves these boundaries before any code.

| PR  | Stage                     | Contents                                                                                                                                                                                                                                                                                                                     | Depends on         |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| P0  | Prerequisite fixes        | Each with a RED test: (1) reads never create customers (OD-3); (2) `overviewFor.salesK` definition (OD-16); (3) NULL expense category is shown as "not categorised"; (4) cash measures exclude own-account transfers and opening balances (OD-17). Pre-existing defects, fixed first so analytics builds on correct figures. | OD-3, OD-16, OD-17 |
| 1   | A + B: contract and core  | `InvoiceQuery` and `Analyse`, prompt, persistence, view-only phrasings, strict-schema measurement, eval cases. Core: period phrases, comparison planner, amount bounds, reference canonicalisation, metric registry, ranking tiers. All pure. Router intents and presets. Flag added.                                        | —                  |
| 2   | C: invoice discovery      | `invoice-search.ts`, gateway lookup (OD-1), `books-answer.ts` (find, summarise brief, aggregate count), invoice choice lists via the existing `options`                                                                                                                                                                      | 1, P0              |
| 3   | D: analytics core         | `reports.ts`: series, windowed schedules and P&L, rankings (OD-20, OD-21, OD-24 for chat), comparisons in chat, insights I1–I9 with templates                                                                                                                                                                                | 1, P0              |
| 4   | D: conversation           | M4 continuation context (OD-33); follow-up merge rules for invoices and analytics; "more" paging; topic and period switches                                                                                                                                                                                                  | 2, 3               |
| 5   | E: retrieval and delivery | `documentsForInvoice`, the outcome matrix, missing-object check, `recipientUserId` (OD-7), receipt offer (OD-4), "send it again" semantics (OD-26)                                                                                                                                                                           | 2                  |
| 6   | F: report PDF             | `report-layout.ts`, `renderReportPdf`, render branch, R2 JSON snapshot, `REPORT_EXPORTS` reserve and refund (OD-23), PDF policy (OD-22), report history (OD-32), retention (OD-25, M5 if chosen), design-system section, pdf.js tests (OD-29)                                                                                | 3, 4, 5            |
| 7   | G: voice                  | Spoken references, voice confirmations, voice integration tests through the STT stub                                                                                                                                                                                                                                         | 5, 6               |
| 8   | H: hardening              | Non-mutation suite, concurrency and duplicates, log capture, rate limit (OD-14), 20,000-invoice performance budget (M1–M3 only if it fails)                                                                                                                                                                                  | 2–7                |
| 9   | I: docs and acceptance    | Spec amendment or OWN ruling (OD-15), CURRENT_STATE and READINESS (including the G-118 correction), pricing-model correction, user journeys, owner acceptance checklist and evidence register, owner-run full-schema probe                                                                                                   | 8                  |

**Deferred only by owner decision:** customer-directed delivery (OD-8) and certified-copy recovery (OD-5).

**Not deferred:** advanced search, aggregates, comparisons, trends, insights, report PDFs and voice.

---

## 22. Testing and staging acceptance matrix

### 22.1 Automated tests

**Core (unit):**

- **Periods:** every phrase, Lagos midnight, Monday weeks, quarters, named months across a year boundary, dd/mm ambiguity, 31 Mar vs Feb clamp, leap years, first-record bounding.
- **Comparisons:**
  - like-for-like at 00:00, 14:05 and 23:59;
  - MTD vs the same days;
  - different lengths;
  - zero rules (previous zero, current zero, both zero);
  - very large values near the ₦10bn cap, with no overflow because the values are integer kobo below 2^53;
  - percentage rounding;
  - direction.
- **Metric registry:** unsupported pairs are refused honestly.
- **Insights:** every rule, at the threshold and below it, plus "insufficient history".
- **Ranking tiers:** exact beats fuzzy.
- **Reference and amount parsing**, including spoken forms.
- **Summary assembly:** the full history matrix from revision 1.
- **Report layout:** geometry, adaptive sections, empty data, 400-row pagination, no overlap, zero baselines.
- **Templates:** no negative amounts, and no figure absent from the result.

**Database (integration):**

- **Search:** every filter and combination, NULL-`customer_id` historical invoices, keyset stability.
- **Isolation:** RLS with a second tenant holding identical numbers, names and phones.
- **Aggregates:** equal hand-computed kobo.
- **Series:** equal the sum of the per-bucket `summaryFor` results.
- **Windowed P&L:** equals `accountSumsFor` monthly where windows coincide.
- **Rankings:** totals reconcile with an "other or unattributed" line.
- **Cash measures:** exclude own transfers and opening balances.
- **Accounting edge cases:**
  - voided later;
  - payment allocated after issue;
  - reversed, refunded and charged back;
  - credit notes;
  - backdated postings;
  - closed periods;
  - year-boundary ranges.
- **Performance budget** at 20,000 invoices.

**API and WhatsApp (integration):**

- **Questions:** each example question from both specifications, typed, through the router or the model stub.
- **Follow-up chains:**
  - "how am I doing" → "compared to yesterday?" → "what about last week?" → "and expenses?" → "show the top products" → "generate the PDF" → "send it again" → "show the previous report";
  - expired, superseded and ambiguous contexts;
  - another member's ordinal.
- **Invoice retrieval:** every case from revision 1 §15.
- **Report jobs:**
  - render, then store (PDF and JSON), then deliver to the requester;
  - storage failure and delivery failure;
  - window closed, so the template is used;
  - render dead, so the unit is refunded;
  - duplicate webhook, so there is one report and one unit;
  - retried job, so there is one PDF.
- **Plans:** lapsed, Integrate-only and exhausted `REPORT_EXPORTS`.
- **Roles:** accountant and delegate.
- **Voice:** voice-note equivalents through the STT stub.

**PDF:**

- extracted text equals the result's figures;
- every page has its footer;
- fonts are embedded and the ₦ glyph is present;
- the empty report;
- a huge appendix;
- visual baselines (OD-29);
- no customer name when OD-24 = B, names present when A.

**AI:**

- schema validation of both intents;
- no prose, two tool calls and refusal handling;
- timeout and `max_tokens`;
- escalation on `Unclear` only;
- the pinned strict-schema count;
- prompt-injection messages still yield criteria only;
- eval accuracy on existing intents does not fall.

**Financial non-mutation:** §16.

### 22.2 Staging acceptance

These cases are owner-run. Each one records:

- the exact message, the reply text, the outbound and job rows, the R2 key and the stored JSON;
- before-and-after financial checksums;
- screenshots;
- the PDF file.

| #    | Case                                                                                                                                                                                                                           | Mode                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 1–16 | Revision 1 invoice cases (reference, name, phone, business name, amount and date, compound, ambiguity, summaries, aggregates, original vs current, resend, voice, unavailable PDF, wrong tenant, duplicate webhook, checksums) | Staging                               |
| 17   | "How much did I sell yesterday?" equals the dashboard compare for the same window                                                                                                                                              | Staging                               |
| 18   | "Am I doing better today than yesterday?" at a recorded time: like-for-like windows are stated                                                                                                                                 | Staging                               |
| 19   | Week vs week, month vs month (MTD), quarter vs quarter, custom vs custom, YoY with no prior data                                                                                                                               | Staging                               |
| 20   | Six-month trend plus strongest month                                                                                                                                                                                           | Staging                               |
| 21   | Top products: label per OD-20                                                                                                                                                                                                  | Staging                               |
| 22   | Top customers: names per OD-24                                                                                                                                                                                                 | Staging                               |
| 23   | Invoiced vs collected; unpaid % (definitions per OD-34)                                                                                                                                                                        | Staging                               |
| 24   | Expenses vs sales; categories, including uncategorised                                                                                                                                                                         | Staging                               |
| 25   | Profit with complete costs is shown with its definition; with incomplete costs it is withheld, and the reply shows verified sales, recorded costs and a completeness warning (BA-OD-21)                                        | Staging                               |
| 26   | Cash flow September vs October, excluding own transfers                                                                                                                                                                        | Staging                               |
| 27   | Follow-up chain §22.1                                                                                                                                                                                                          | Staging                               |
| 28   | Daily, monthly and quarterly PDF: owner visual review against §12, on phone and print                                                                                                                                          | Staging                               |
| 29   | PDF figures equal the chat summary                                                                                                                                                                                             | Staging                               |
| 30   | Voice: "compare this month with last month and send me the PDF"                                                                                                                                                                | Staging (voice enabled)               |
| 31   | Report idempotency on a replayed webhook                                                                                                                                                                                       | Staging tools                         |
| 32   | Full-schema Anthropic probe on 3 models                                                                                                                                                                                        | **Live provider (owner-run, spends)** |

---

## 23. Owner decision register (consolidated)

The original decisions OD-1 to OD-15 keep their numbers and are reassessed against the expanded scope. New decisions start at OD-16. Each entry gives:

- options and trade-offs;
- a **recommendation**;
- the implementation implication: what changes in the plan.

### Reassessed (original 15)

**OD-1 Partial and fuzzy customer-name matching.**

- **Options:**
  - **A. Exact HMAC only.** Safe, but "Ada" misses "Ada Obi".
  - **B. Word-level blind index.** Needs migration M6 and a backfill; leaks word equality to anyone with database access; supports neither prefixes nor typos.
  - **C. Bounded in-process match.** Decrypt up to 5,000 trusted names in the API and match on prefix and similarity. This is a new vault use and stores nothing new.
- **Expanded scope:** customer _analytics_ ("Ada's sales this month", top customers) needs only token grouping plus rehydration, not matching. So OD-1 affects search input only. Unchanged.
- **Recommendation: C**, with the cap and no auto-select.
- **Implication:** gateway method, privacy ruling, no migration.

**OD-2 Customer business name.**

- **Options:** A, a name facet with no change; B, a new `business_name` facet with input paths.
- **Expanded scope:** unchanged. "Sales by customer business" groups by customer, which is the same thing.
- **Recommendation: A**, limitation recorded.
- **Implication:** none.

**OD-3 Reads currently create customers.**

- **Options:** A, lookup-only reads plus provisional phone tokens (prerequisite); B, accept and document.
- **Expanded scope:** applies equally to "Ada's sales" analytics. More important now.
- **Recommendation: A** (PR P0), plus a gap ID for the pre-existing `Query` behaviour.
- **Implication:** P0 touches write paths for phones (customers are materialised at confirmation).

**OD-4 Invoice request for a sale paid at recording (no invoice PDF exists).**

- **Options:** A, explain and offer the receipt; B, send the receipt directly; C, render an invoice (forbidden).
- **Recommendation: A.**
- **Implication:** template plus choice list.

**OD-5 Missing PDF recovery.**

- **Options:** A, report it and raise an exception; B, a gated "certified copy" re-render from the snapshot, marked COPY and audited, with no number.
- **Expanded scope:** report PDFs can always be regenerated from the books, so they need no recovery. Unchanged for invoices.
- **Recommendation: A now; B as a separately approved stage.**

**OD-6 Date semantics.**

- **Superseded by OD-19**, which now also covers quarters, years and like-for-like windows. OD-6's question (calendar week vs rolling 7 days; dd/mm) is carried in full into OD-19.

**OD-7 Who may retrieve and where it goes.**

- **Options:** A, any member may read, and delivery goes to the **requester's own phone**; B, owner and delegate only, delivery to the owner.
- **Expanded scope:** the same rule for report PDFs. It matches web reports (`@AllMembers()`), so accountants can request their own reports.
- **Recommendation: A** (closes G-67 residual 2).
- **Implication:** `recipientUserId` on deliver; `resend` role check relaxed to any member for its own deliveries.

**OD-8 Sending an invoice or report to the customer or a third party.**

- **Options:** A, out of scope (the merchant forwards it); B, build it on Integrate WABA with recipient confirmation, customer window, STOP and units.
- **Expanded scope:** "share with accountants or partners" is covered by forwarding or by the accountant requesting their own copy (OD-7). There is no third-party send.
- **Recommendation: A.**

**OD-9 Overdue definition.**

- **Options:** A, due date earlier than today (Lagos) and status open, with no due date meaning never overdue; B, `ageingFor`'s buckets.
- **Expanded scope:** reports show ageing too, so one definition must serve both.
- **Recommendation: A, which equals `ageingFor`'s rule** ("current" includes no due date, `reports.ts:306-326`). One definition, reused.

**OD-10 "The ₦45,000 invoice".**

- **Options:** A, exact total; B, ±1% tolerance.
- **Recommendation: A**; "around 45k" asks for a range.

**OD-11 Invoice to document link.**

- **Options:** A, a `documents.invoice_id` column plus backfill (migration); B, join on `(business_id, ref_number, kind)`.
- **Expanded scope:** the migration-minimisation rule.
- **Recommendation changes to B.**
- **Implication:** migration withdrawn; tests pin the join; add the column only if integrity issues appear.

**OD-12 Basis of "invoiced vs collected".**

- **Options:** A, invoice-based (issue date); B, ledger-based (`summaryFor`).
- **Expanded scope:** spec §5.1 says "read the ledger", and every period figure in analytics is ledger-based (§7). Invoice-row aggregates remain for invoice _lists_ ("these 12 invoices: ₦X invoiced, ₦Y paid").
- **Recommendation changes:** **B for every period question**; A only for summaries of an invoice list, labelled.
- **Implication:** consistency with the dashboard compare.

**OD-13 Lapsed and Integrate-only merchants.**

- **Options:** A, router retrieval and presets free on any plan, while model-path search, analytics and voice are refused on lapse (as today); B, allow model-path on lapse with no unit.
- **Expanded scope:** report PDFs need a `REPORT_EXPORTS` unit, and expired plans have 0. Integrate has 100 `REPORT_EXPORTS` units but no Chat.
- **Recommendation: A**, plus: lapsed merchants can still "send it again" for an existing report (OWN-60), but cannot produce new ones. **Integrate-only merchants keep the existing `chat_kept_on_lapse` reads** and the web reports.
- **Implication:** entitlement rows in `chat-access.ts`.

**OD-14 Read abuse limit.**

- **Options:** A, 60 lookups per member per hour; B, none.
- **Expanded scope:** add 10 report PDFs per member per day, beyond plan units.
- **Recommendation: A.**

**OD-15 Spec authority.**

- **Options:** A, a spec amendment adding "Books questions, document retrieval and reports"; B, an OWN-99 ruling now, absorbed later.
- **Expanded scope:** OWN-44 already rules analytics into scope. OD-15 now covers retrieval, the report PDF policy and the `Query`/`Analyse` overlap.
- **Recommendation: B, then A.**

### New decisions

**OD-16 One definition of "sales this month" everywhere.**

- **Options:** A, point `overviewFor.salesK` (the `records` reply, dashboard) at `summaryFor`'s definition; B, leave it and label both.
- **Trade-off:** A changes a figure merchants already see; B leaves two numbers.
- **Recommendation: A** (P0, RED test).

**OD-17 Cash-flow figures.**

- **Options:** A, exclude transfers between the merchant's own cash accounts and opening balances from cash in and out (analytics, `cashflowFor`, `summaryFor.cashIn/Out`); B, keep them and label.
- **Trade-off:** A changes the dashboard cash chart for affected merchants; B misstates movement.
- **Recommendation: A** (P0).

**OD-18 Like-for-like comparisons for partial periods.**

- **Options:** A, compare against the same elapsed portion and also show the full previous period, labelled; B, compare partial against full, labelled.
- **Implication:** A changes `/v1/reports/compare` for partial windows, which has no web caller today.
- **Recommendation: A.** Different-length custom ranges compare daily averages; a percentage on totals is shown only for equal lengths.

**OD-19 Calendar rules (absorbs OD-6).**

- **Recommendation:** Monday-start calendar weeks for "this/last week"; "past 7 days" rolling; calendar quarters; calendar years; dd/mm dates, asking only when ambiguous.
- **Trade-off:** the existing chat "week" (rolling 7 days, `periods.ts:51-56`) would change meaning. **Option B** keeps "week" rolling everywhere and adds "this calendar week".
- **Recommendation: A**, applied to both new and existing chat phrases, with the reply naming the exact dates.

**OD-20 Product rankings (the open N2 decision).**

- **Options:**
  - **A.** Catalogue products only: verified through sale stock movements joined to products. Free-text sales are excluded and the reply says so.
  - **B.** A, plus free-text names folded for case, whitespace and simple plural, labelled "as typed, approximate".
  - **C.** Add a product link to chat sale lines first (migration M7 plus a Chat flow change).
- **Trade-off:** A is accurate but may omit most chat sales; B is useful but approximate; C is correct but is a write-path change.
- **Recommendation: B for this feature** (verified and approximate sections kept separate, never merged). **C as the real fix later.**

**OD-21 Gross profit and profit reporting.**

- **Options:**
  - **A.** Show gross profit and books profit with a coverage statement; withhold when uncosted sales exceed 20% of net sales, showing COGS coverage instead.
  - **B.** Never show profit in chat or reports; statements only.
  - **C.** Show without threshold, always labelled.
- **Trade-off:** profit is the question merchants most want answered, and the most misleadable.
- **Recommendation: A** (20% threshold, owner may adjust).

**OD-22 When a PDF is produced.**

- **Options:**
  - **A.** Only on explicit request ("PDF", "report", "document", "send me the full…"). For multi-section answers, offer "Reply _PDF_ for a full report".
  - **B.** Automatically for multi-section or "detailed" answers.
  - **C.** Automatically for every analytics answer.
- **Trade-off:** B and C spend `REPORT_EXPORTS` units and messages without consent.
- **Recommendation: A**, with a voice confirmation (§14).

**OD-23 Metering report PDFs.**

- **Options:**
  - **A.** One `REPORT_EXPORTS` unit per PDF _produced_ (consistent with `metering-v1.md:33` and OWN-4), reserved at enqueue and refunded if rendering fails; re-delivery of an existing report is free (OWN-60 analogue).
  - **B.** Free.
  - **C.** Use `DOCUMENT_GENERATION`.
- **Recommendation: A.** Chat answers stay on `AI_ACTIONS` (model path) or free (router).
- **Implication:** no new billing rule; existing units.

**OD-24 Customer names in stored report PDFs.**

- **Options:**
  - **A.** Names rehydrated into the PDF (useful; the PDF becomes PII at rest and on the merchant's phone).
  - **B.** No customer identities in PDFs: aggregate customer sections show counts and shares only, and names appear only in the chat reply.
  - **C.** Initials ("A. O.").
- **Trade-off:** A requires expiry and erasure handling (OD-25, M5); B is zero-migration but the top-customers section is far less useful.
- **Precedent:** invoice PDFs print the token today (`render-document.handler.ts:68`). That should be confirmed as intentional or as a gap (G-new).
- **Recommendation: A**, with OD-25 expiry and erasure.

**OD-25 Report retention.**

- **Options:** A, report objects expire after 90 days (sweep plus M5), and two-ask erasure purges them; B, keep indefinitely like other documents.
- **Recommendation: A if OD-24 = A; B if OD-24 = B.**

**OD-26 "Resend" and "send it again" semantics.**

- **Options:** A, the last document _delivered to this member_ (invoice, receipt, quote or report); B, keep "newest document of any kind in the business"; C, financial documents only.
- **Trade-off:** B means a report would become what "resend" sends, and a delegate could get the owner's latest. C breaks "send it again" after a report.
- **Recommendation: A** (also fixes the G-67 residual for this path).

**OD-27 AI wording for insights.**

- **Options:**
  - **A.** Templates only for the MVP.
  - **B.** The model rewrites template output for readability, under a figure lock: every number and name in the output must appear verbatim in the input set, otherwise the template is used. This adds about one model call per insight-bearing answer.
  - **C.** The model writes the narrative from the structured result.
- **Context:** OWN-44 permits the model to "explain and summarise" but not to invent values. The prompt today forbids prose (`prompt.ts:23`).
- **Recommendation: A**, revisiting B with evidence. C is not recommended.

**OD-28 Report typography.**

- **Options:** A, add the Calistoga TTF for display headings only (brand match; one OFL asset); B, Noto Sans only.
- **Recommendation: A.**

**OD-29 PDF verification tooling.**

- **Options:** A, `pdfjs-dist` devDependency for text extraction and Playwright-rendered visual baselines; B, geometry tests only.
- **Recommendation: A** (development only).

**OD-30 Page format.**

- **Options:** A, A4 portrait (print, accountants; matches statements); B, a phone-first narrow page.
- **Trade-off:** A4 reads acceptably on phones when the type is at least 9.5 pt with a single main column.
- **Recommendation: A.**

**OD-31 Insight thresholds and report bounds.**

- **Recommendation:** approve the §10 thresholds (5% or ₦10,000; ≥ 3 buckets; ≥ 4-bucket trends; ≥ 5 debtors), plus:
  - series of at most 24 months or 8 quarters or 92 days;
  - tables of at most 40 rows in the body;
  - appendix capped at 500 rows, with "export the full list on your dashboard" beyond that.

**OD-32 Report history.**

- **Options:** A, "show my previous reports" lists this member's last 5 report PDFs (free re-delivery); B, no history, regenerate instead.
- **Recommendation: A.**

**OD-33 Analytical context storage.**

- **Options:**
  - **A.** Migration M4: a `books` continuation kind with a validated `context` jsonb holding typed values only.
  - **B.** Zero migration: read the last read-only `command_drafts` row as context (couples analytics to the write-confirmation authority).
  - **C.** As A, and also store the scrubbed item words, which changes 0154's "no typed words" rule.
- **Recommendation: A.**

**OD-34 Collection metrics.**

- **Options:** A, "collection rate" = collected ÷ net sales for the window (cash lens, may exceed 100%, labelled), plus "paid share of this period's invoices" as a second metric, plus median days to full payment; B, only the invoice-based paid share.
- **Recommendation: A**, both labelled with their denominators.

**OD-35 Contract fallback if the schema grows too costly.**

- **Options:** A, main schema with two new intents (§5.1); B, a classifier-routed narrow strict tool for books questions (one extra call per books question; main schema unchanged).
- **Recommendation: A, switching to B only if the Stage B measurements show an accuracy drop or a cost per call increase above an owner-set limit.**
- **Owner input needed:** that limit, for example +15% input tokens.

**OD-36 Feature flag.**

- **Options:** A, one `BOOKS_ASSISTANT_ENABLED` flag (default off) for staged rollout and instant rollback; B, no flag.
- **Recommendation: A.**

### Decisions that most shape the build

Resolve these first: OD-1, OD-3, OD-20, OD-21, OD-22, OD-23, OD-24 / OD-25, OD-33.

---

## 24. Final architecture recommendation

**The smallest safe design that delivers the complete approved scope:**

1. **Two validated intents** (`InvoiceQuery`, `Analyse`), plus router presets and follow-up phrases. The model returns criteria only; core resolves every period, amount, reference and comparison.
2. **One orchestration path** (`books-answer.ts`) shared by typed text, voice and follow-ups. It produces **one immutable `BooksResult`** that feeds the chat reply, the follow-up context and the PDF.
3. **Figures from the ledger** through the existing `summaryFor` definitions, generalised to buckets and windows inside `reports.ts`. Arithmetic comes from the existing `changeOf` and `comparePeriods`, extended with like-for-like windows, quarters, years and a metric registry. Invoice facts come from the existing projection and snapshot, through one new read repo.
4. **Deterministic insights and templates.** No model narrative in the MVP, no causal or forecast claims, and explicit confidence labels.
5. **Professional PDFs on the existing pdfkit stack.** A new pure `report-layout.ts` makes content and geometry decisions, and an extended `pdf.ts` draws them in Rekoda's tokens. Reports are rendered by the existing `document.render` job, stored privately in R2 with their JSON snapshot, and delivered by the existing `document.deliver` to the requesting member. They are metered with the existing `REPORT_EXPORTS` unit.
6. **Reuse of the existing continuation table**, with one justified migration for typed analysis context. Zero up-front indexes; a performance gate decides.
7. **No new production dependency, service, database or search engine.** One dev-only dependency (`pdfjs-dist`) for real PDF verification. One font asset.
8. **Prerequisite correctness fixes first (P0).** Reads stop creating customers; one "sales" definition; honest expense categories; honest cash flow. The new analytics would otherwise inherit those defects.

**Footprint:**

- 4 new production files;
- 1 recommended migration (plus 1 conditional on OD-24 and OD-25);
- 0 new production dependencies;
- 10 PRs (P0 and 1–9) behind one flag.

**Every requirement in both specifications maps to a stage in §21.** None is dropped, and none is deferred without an owner decision.
