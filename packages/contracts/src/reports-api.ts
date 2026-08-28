/**
 * The dashboard's numbers, on the wire (MASTER-PLAN §5.3.7, ADR 0015).
 *
 * Every figure here was computed by SQL in the reports repo; these schemas
 * are the border checkpoint that keeps the web tier honest about what it
 * received. Amounts are integer KOBO end to end — the web renders them with
 * formatKobo and nothing else.
 */
import { z } from 'zod';

const kobo = z.number().int().finite().nonnegative();

export const reportsOverviewResponse = z.object({
  /** Lagos month this overview covers, YYYY-MM. */
  period: z.string().regex(/^\d{4}-\d{2}$/),
  moneyInK: kobo,
  /** Provider-confirmed portion of moneyInK (ADR 0014). */
  verifiedInK: kobo,
  moneyOutK: kobo,
  salesK: kobo,
  owedToYouK: kobo,
  youOweK: kobo,
  exceptionsOpen: z.number().int().nonnegative(),
  /**
   * Receivable ageing — what an accountant looks at before anything else.
   * `current` holds money not yet due AND money with no agreed date: neither
   * is late, and ageing an undated debt invents a deadline nobody set.
   */
  ageing: z.object({
    currentK: kobo,
    d1_30K: kobo,
    d31_60K: kobo,
    d61_90K: kobo,
    d90PlusK: kobo,
    totalK: kobo,
    overdueK: kobo,
  }),
});
export type ReportsOverviewResponse = z.infer<typeof reportsOverviewResponse>;

export const reportsCashflowResponse = z.object({
  months: z
    .array(
      z.object({
        period: z.string().regex(/^\d{4}-\d{2}$/),
        inK: kobo,
        outK: kobo,
      }),
    )
    .max(24),
});
export type ReportsCashflowResponse = z.infer<typeof reportsCashflowResponse>;

export const reportsDebtorsResponse = z.object({
  rows: z
    .array(
      z.object({
        invoiceNumber: z.string(),
        balanceDueK: kobo,
        /** When the merchant said it was expected. Null when they did not. */
        dueDate: z.string().nullable(),
        /** Whole Lagos days past that day. Zero when not late, or undated. */
        daysOverdue: z.number().int().nonnegative(),
        issuedAt: z.string(), // ISO
      }),
    )
    .max(50),
  totalK: kobo,
  count: z.number().int().nonnegative(),
});
export type ReportsDebtorsResponse = z.infer<typeof reportsDebtorsResponse>;

/** GET /v1/payments/usage — the month's meter, for the dashboard. */
export const usageMeterResponse = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  plan: z.string(),
  units: z.array(
    z.object({
      unit: z.string(),
      used: z.number().int().nonnegative(),
      bonus: z.number().int().nonnegative(),
    }),
  ),
});
export type UsageMeterResponse = z.infer<typeof usageMeterResponse>;

export const reportsActivityResponse = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(['sale', 'payment', 'expense', 'purchase']),
        label: z.string(),
        amountK: kobo,
        at: z.string(), // ISO
      }),
    )
    .max(50),
});
export type ReportsActivityResponse = z.infer<typeof reportsActivityResponse>;

/* ── the four statements (ADR 0015) ─────────────────────────────────────── */

/* Statements v2 (D1, PR-095): lines carry the account's own chart code and
 * name; the fixed key vocabulary is gone with the fixed chart. */
const statementLine = z.object({
  code: z.string(),
  name: z.string(),
  amountK: z.number().int().finite(),
});

export const reportsStatementsResponse = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  trialBalance: z.object({
    rows: z.array(
      z.object({
        code: z.string(),
        name: z.string(),
        debitK: kobo,
        creditK: kobo,
      }),
    ),
    totalDebitK: kobo,
    totalCreditK: kobo,
    balanced: z.boolean(),
  }),
  profitAndLoss: z.object({
    income: z.array(statementLine),
    /** Every expense account, cost of sales included. */
    expenses: z.array(statementLine),
    /**
     * The same rows without cost of sales.
     *
     * What the "Running costs" block lists once gross profit is shown above
     * it. Listing cost of sales again under its own subtotal is how a reader
     * ends up counting it twice.
     */
    operatingExpenses: z.array(statementLine),
    totalIncomeK: z.number().int().finite(),
    totalExpensesK: z.number().int().finite(),
    /**
     * What the goods sold cost, and what is left after it.
     *
     * The first thing an accountant looks for, because revenue less the cost
     * of what was sold is the only figure that says whether the trade itself
     * works. Zero until a product has a cost recorded against it, which is
     * honest rather than flattering: nothing has been assumed about goods
     * nobody has priced.
     */
    costOfSalesK: z.number().int().finite(),
    grossProfitK: z.number().int().finite(),
    operatingExpensesK: z.number().int().finite(),
    netProfitK: z.number().int().finite(),
  }),
  balanceSheet: z.object({
    assets: z.array(statementLine),
    liabilities: z.array(statementLine),
    equity: z.array(statementLine),
    totalAssetsK: z.number().int().finite(),
    totalLiabilitiesK: z.number().int().finite(),
    totalEquityK: z.number().int().finite(),
    balanced: z.boolean(),
  }),
  cashflow: z.object({
    openingK: z.number().int().finite(),
    inK: kobo,
    outK: kobo,
    closingK: z.number().int().finite(),
  }),
  /**
   * Where the operating expenses went.
   *
   * The supporting schedule under the profit and loss statement's single
   * "Operating Expenses" line. `totalK` equals that line, because both come
   * from the same ledger movement rather than from two different tables.
   *
   * Carries the label as well as the key so the wire says what it means: the
   * words on a statement are part of the statement, and a client deriving
   * them from a key is a client that can disagree with the PDF.
   */
  expenseSchedule: z.object({
    lines: z.array(
      z.object({
        category: z.string(),
        label: z.string(),
        amountK: z.number().int().finite(),
      }),
    ),
    totalK: z.number().int().finite(),
  }),
  /**
   * What the business was holding before it started with Rekoda, or null.
   *
   * On the statements response rather than its own endpoint because the
   * balance sheet is where its absence shows: a merchant spending from money
   * Rekoda never knew they had reads "Cash on Hand: minus ₦93,500", and the
   * control belongs beside the figure that is wrong.
   */
  openingBalances: z
    .object({
      asAt: z.string(),
      cashK: kobo,
      bankK: kobo,
      stockK: kobo,
      /** What customers already owed, read off the opening entry's AR lines. */
      receivablesK: kobo,
    })
    .nullable(),
  /**
   * What the shelf is worth, beside what the books say it is worth.
   *
   * Deliberately as at today rather than as at the end of the period being
   * read: a count is a fact about now, and one taken today cannot say what
   * was on the shelf in March. Which is why the page shows it beside the
   * current month alone: against a past one the two Inventory figures would
   * differ for a reason no merchant could see.
   *
   * `uncosted` is why the two figures may differ for an innocent reason, so
   * it travels with them rather than being fetched separately.
   */
  /**
   * The Lagos month through which the books are closed, or null.
   *
   * On the statements response because this is where a merchant reads the
   * figures a close protects, and where the control belongs. A closed month
   * is not a different statement: it is the same one, with a promise that it
   * will still say this tomorrow.
   */
  booksClosedThrough: z.string().nullable(),
  stockValuation: z.object({
    /**
     * Signed, and it has to be. A product whose cost was typed rather than
     * delivered can be sold before anything ever debited stock, and the cost
     * of that sale credits INVENTORY straight through zero. A schema that
     * refused the negative would take the whole reports page down over a
     * figure the page exists to show.
     */
    ledgerK: z.number().int().finite(),
    countedK: kobo,
    differenceK: z.number().int().finite(),
    uncosted: z.number().int().nonnegative(),
  }),
  /**
   * Where the sales came from.
   *
   * The mirror of `expenseSchedule`, under the income line rather than the
   * expenses one, and its `totalK` equals that line for the same reason: both
   * come from the same ledger movement.
   *
   * `source` is null for revenue nobody attributed to a channel, which is the
   * ordinary case rather than a gap. Rekoda never asks which channel a sale
   * came through and never guesses one.
   */
  revenueSchedule: z.object({
    lines: z.array(
      z.object({
        source: z.string().nullable(),
        label: z.string(),
        amountK: z.number().int().finite(),
      }),
    ),
    totalK: z.number().int().finite(),
  }),
  /**
   * The month before, for the column every accounting package puts beside a
   * profit and loss. "₦150,000 of sales" is a figure; "₦150,000, up from
   * ₦92,000" is the thing a merchant actually wanted to know.
   *
   * Totals plus a per-account lookup rather than a second full statement:
   * the comparison is read line by line against the current one, and shipping
   * two shapes that must be kept in step is how they stop being in step.
   *
   * Always present, and zero when the business was not trading. The column is
   * labelled with its month, so a zero under "July 2026" says what it is.
   */
  comparison: z.object({
    period: z.string().regex(/^\d{4}-\d{2}$/),
    totalIncomeK: z.number().int().finite(),
    totalExpensesK: z.number().int().finite(),
    netProfitK: z.number().int().finite(),
    /** Prior amount by account key, for the lines that had one. */
    lines: z.record(z.string(), z.number().int().finite()),
  }),
});
export type ReportsStatementsResponse = z.infer<typeof reportsStatementsResponse>;

export const reportsInvoicesResponse = z.object({
  invoices: z.array(
    z.object({
      invoiceNumber: z.string(),
      /** issued | partially_paid | paid | voided */
      status: z.string(),
      /**
       * Appendix E.3's derived dimensions (PR-084), beside the blended
       * status rather than replacing it: what has settled, and what is
       * being done about the rest. Both computed at read from the same
       * figures the rebuild path proves against the subledgers — never
       * stored.
       */
      paymentStatus: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']),
      collectionStatus: z.enum(['CURRENT', 'DUE', 'OVERDUE']),
      /** When the money was agreed to arrive. Null when nobody said. */
      dueDate: z.string().nullable(),
      /** Whole Lagos days past that day. Zero when not late, or undated. */
      daysOverdue: z.number().int().nonnegative(),
      totalK: kobo,
      paidK: kobo,
      balanceDueK: kobo,
      /** Already credited. The register offers only what is left. */
      creditedK: kobo,
      issuedAt: z.string(),
    }),
  ),
  count: z.number().int().nonnegative(),
  outstandingK: kobo,
  /**
   * Orders a customer placed, which the merchant forwarded.
   *
   * On the invoice register's response because an order is what an invoice
   * comes FROM, and "did that order ever become an invoice" is a question a
   * merchant asks while looking at this page. An order is not a financial
   * document: nothing is owed until the merchant agrees to it, which is why
   * it is a separate list rather than another row in the register.
   */
  /**
   * Every order this shop has taken, which is not `orders.length`.
   *
   * The invoice register on this same response has carried its own `count`
   * since it was built, and the page says "showing the latest N". This list
   * said nothing, so a merchant with more orders than the page carries was
   * shown a page with no reason to think there was more.
   */
  ordersTotal: z.number().int().nonnegative(),
  orders: z.array(
    z.object({
      orderNumber: z.string(),
      /** placed | confirmed | cancelled */
      status: z.string(),
      totalK: kobo,
      itemCount: z.number().int().nonnegative(),
      /**
       * The invoice this order became, or null while it is still a request.
       *
       * By number rather than by id, because the number is what the merchant
       * reads on the row below and what a customer sees on the document.
       */
      invoiceNumber: z.string().nullable(),
      placedAt: z.string(),
    }),
  ),
  /**
   * Quotes: order-shaped OFFERS, on their own QUO counter (fix-plan 4, G3).
   *
   * On this response for the same reason orders are: a quote is what an
   * invoice comes from when the merchant, not the customer, opened the
   * conversation, and "did Ada ever take that quote" is asked while looking
   * at this page.
   */
  quotesTotal: z.number().int().nonnegative(),
  quotes: z.array(
    z.object({
      quoteNumber: z.string(),
      /** quoted | confirmed | cancelled */
      status: z.string(),
      totalK: kobo,
      itemCount: z.number().int().nonnegative(),
      /** The last Lagos day the offer stands, or null for no expiry. */
      validUntil: z.string().nullable(),
      /** The invoice it converted into, or null while it is still an offer. */
      invoiceNumber: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type ReportsInvoicesResponse = z.infer<typeof reportsInvoicesResponse>;

/**
 * Creating a quote from the dashboard.
 *
 * Prices are INTEGER KOBO from the client, like every money figure on this
 * surface. The customer is a NAME the merchant typed; it takes the same
 * road a chat mention takes (vault + token), so a quote never becomes the
 * place customer names leak around the gateway.
 */
export const createQuoteRequest = z.object({
  customerName: z.string().trim().min(2).max(80).optional(),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        quantity: z.number().int().positive().max(10_000),
        unitPriceK: z.number().int().finite().positive(),
      }),
    )
    .min(1)
    .max(20),
  /** `YYYY-MM-DD`, the last Lagos day the offer stands. */
  validUntil: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'a day like 2026-09-30')
    .optional(),
  /**
   * One-shot key the form mints when it renders. A resubmission of the same
   * form carries the same key and creates NOTHING twice.
   */
  clientRef: z.string().uuid().optional(),
});

export const createQuoteResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('created'),
    quoteNumber: z.string(),
    totalK: kobo,
    validUntil: z.string().nullable(),
  }),
  /** The same clientRef arrived twice: the first submission already created. */
  z.object({ outcome: z.literal('duplicate') }),
]);

export const convertQuoteRequest = z.object({
  quoteNumber: z.string().trim().min(1),
});

/**
 * Converting is issuing the invoice the quote promised. Double-converts are
 * impossible by construction — the status machine, not a client key, is the
 * guard — so `already_converted` carries the invoice the first click made.
 */
export const convertQuoteResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('converted'),
    quoteNumber: z.string(),
    invoiceNumber: z.string(),
    totalK: kobo,
  }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('already_converted'), invoiceNumber: z.string().nullable() }),
  z.object({ outcome: z.literal('cancelled') }),
  /** Past its own validUntil: honour it or issue a fresh quote. */
  z.object({ outcome: z.literal('expired'), validUntil: z.string() }),
  /** The month's document allowance is spent; nothing was issued. */
  z.object({ outcome: z.literal('exhausted'), allowance: z.number().int().nonnegative() }),
]);

export const cancelQuoteRequest = z.object({
  quoteNumber: z.string().trim().min(1),
});

export const cancelQuoteResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('cancelled') }),
  z.object({ outcome: z.literal('not_found') }),
  /** Converted or already withdrawn: nothing left to cancel. */
  z.object({ outcome: z.literal('already'), status: z.string() }),
]);

export type CreateQuoteRequest = z.infer<typeof createQuoteRequest>;
export type CreateQuoteResponse = z.infer<typeof createQuoteResponse>;
export type ConvertQuoteRequest = z.infer<typeof convertQuoteRequest>;
export type ConvertQuoteResponse = z.infer<typeof convertQuoteResponse>;
export type CancelQuoteRequest = z.infer<typeof cancelQuoteRequest>;
export type CancelQuoteResponse = z.infer<typeof cancelQuoteResponse>;

export const reportsReceiptsResponse = z.object({
  receipts: z.array(
    z.object({
      receiptNumber: z.string(),
      amountK: kobo,
      issuedAt: z.string(),
      invoiceNumber: z.string().nullable(),
      /** 1 provider-confirmed, 0 merchant-reported (ADR 0014). */
      verified: z.union([z.literal(0), z.literal(1)]),
    }),
  ),
  count: z.number().int().nonnegative(),
});
export type ReportsReceiptsResponse = z.infer<typeof reportsReceiptsResponse>;

/**
 * Money out.
 *
 * Two totals rather than one, because they are not the same kind of fact: an
 * operating expense is spent, a stock purchase is still on the shelf. Adding
 * them would overstate the cost of trading by the value of the inventory, and
 * a merchant reading a single "spent" figure would never know it.
 *
 * No supplier column. Supplier names are not stored anywhere in Rekoda.
 */
export const reportsExpensesResponse = z.object({
  entries: z.array(
    z.object({
      description: z.string(),
      /** What the merchant called it. Null when they did not say. */
      category: z.string().nullable(),
      amountK: kobo,
      /** cash | transfer */
      method: z.string(),
      /** expense | purchase, decided by what the posting debited. */
      kind: z.union([z.literal('expense'), z.literal('purchase')]),
      /** recorded | voided. A withdrawn entry stays visible and stops counting. */
      status: z.string(),
      /** Tenant-scoped and opaque. What the withdraw control posts back. */
      id: z.string(),
      /**
       * How it reached the books: `chat`, `recurring`, and so on. A cost that
       * appeared on its own has to say so, or a merchant has no way to tell
       * which of two identical rows is the one to go and correct.
       */
      sourceType: z.string(),
      recordedAt: z.string(),
    }),
  ),
  count: z.number().int().nonnegative(),
  /** Recorded entries only: a withdrawn one is reversed, not spent. */
  expensesK: kobo,
  purchasesK: kobo,
  /** Still owed to suppliers: the accounts payable balance from the ledger. */
  payableK: kobo,
  /**
   * That same debt, split by how long it has STOOD.
   *
   * Not by how late it is. An invoice carries a due date the merchant agreed;
   * a purchase carries no terms, because Rekoda stores nothing about
   * suppliers. Calling these buckets overdue would invent a deadline nobody
   * set. The buckets plus `unlinkedK` sum to `payableK` exactly.
   */
  payableAgeing: z.object({
    d0_30K: kobo,
    d31_60K: kobo,
    d61_90K: kobo,
    d90PlusK: kobo,
    /**
     * On the account, but belonging to no purchase: a manual journal against
     * ACCOUNTS_PAYABLE, which carries no date a debt could be aged from.
     *
     * SIGNED, and deliberately. Negative is the ordinary case and means a
     * settlement made without naming what it settled; positive means a debt
     * raised the same way. A nonnegative schema here would 500 the register
     * the first time a merchant paid a supplier by journal, which is the one
     * thing they could do before this shipped.
     */
    unlinkedK: z.number().int().finite(),
    totalK: kobo,
  }),
  /**
   * Things the business keeps and uses (ADR 0026).
   *
   * On the spend register's response because buying a generator is spending,
   * and the merchant deciding whether a thing is equipment or a running cost
   * is standing on this page when they decide.
   */
  assets: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      costK: kobo,
      usefulLifeMonths: z.number().int().positive(),
      monthsCharged: z.number().int().nonnegative(),
      boughtOn: z.string(),
      status: z.string(),
      /** Charged against profit so far, derived from the ledger. */
      chargedK: kobo,
      /** What is left on the balance sheet. Zero once it is gone. */
      bookValueK: kobo,
      /** What came back when it was sold. Null unless it was. */
      proceedsK: kobo.nullable(),
      soldOn: z.string().nullable(),
    }),
  ),
  /**
   * Every asset the business has recorded, which is not `assets.length`.
   *
   * `assets` is a page, and the controls on the page are built out of it: a
   * merchant sells or withdraws by picking from those rows. Counting them as
   * the register would be the same lie the stock footer used to tell, with a
   * picker attached.
   */
  assetsTotal: z.number().int().nonnegative(),
  /**
   * Purchases with something still standing against them, oldest first.
   *
   * The pool a merchant pays from. Nothing here identifies a supplier, because
   * Rekoda stores nothing about suppliers: a purchase is known by what the
   * merchant called it and the day it was made.
   */
  outstanding: z.array(
    z.object({
      expenseId: z.string(),
      description: z.string(),
      purchasedOn: z.string(),
      amountK: kobo,
      owedK: kobo,
    }),
  ),
  /**
   * Costs the merchant has told Rekoda to expect every month.
   *
   * On the register's own response rather than an endpoint of its own: a
   * schedule and the entries it raises are one thing a merchant is looking
   * at, and splitting them across two round trips would mean a page that can
   * show the entry before it can explain where the entry came from.
   */
  recurring: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      category: z.string().nullable(),
      amountK: kobo,
      /** cash | transfer, the same two the register knows. */
      method: z.string(),
      /** 1 to 31, as the merchant chose it. */
      anchorDay: z.number().int().min(1).max(31),
      /** The next day it will raise, `YYYY-MM-DD`. Lagos, like every day here. */
      nextDueOn: z.string(),
      /** The last day it raised one, or null while it has raised nothing. */
      lastRaisedOn: z.string().nullable(),
      /** False once stopped. Stopped schedules stay listed, and stay quiet. */
      active: z.boolean(),
    }),
  ),
  /** Every schedule that exists, so a cut list can say it was cut. */
  recurringTotal: z.number().int().nonnegative(),
  /**
   * Purchase orders: order-shaped stock requests to a supplier (fix-plan 4,
   * G4). On this response because they live where the money they will cost
   * lives: a merchant asking "did that delivery ever land" is standing on the
   * spend page when they ask.
   *
   * No supplier column here either, and for the same reason as everywhere
   * else on this response: Rekoda stores nothing about suppliers. A purchase
   * order is known by its number and by what it asks for.
   */
  purchaseOrdersTotal: z.number().int().nonnegative(),
  purchaseOrders: z.array(
    z.object({
      poNumber: z.string(),
      /** open | received | cancelled */
      status: z.string(),
      totalK: kobo,
      itemCount: z.number().int().nonnegative(),
      /** The day the goods are expected, or null when nobody said. */
      expectedOn: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type ReportsExpensesResponse = z.infer<typeof reportsExpensesResponse>;

/**
 * Creating a purchase order from the dashboard.
 *
 * Lines are free-typed names with quantities and unit costs in INTEGER KOBO.
 * No supplier field, deliberately: supplier names live in the identity vault
 * or nowhere, and the vault has no supplier slice yet. The merchant's own
 * message to the supplier carries the name; Rekoda carries the goods and the
 * money.
 */
export const createPurchaseOrderRequest = z.object({
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        quantity: z.number().int().positive().max(10_000),
        unitPriceK: z.number().int().finite().positive(),
      }),
    )
    .min(1)
    .max(20),
  /** `YYYY-MM-DD`, the Lagos day the goods are expected. */
  expectedOn: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'a day like 2026-09-30')
    .optional(),
  /** One-shot key from the form. A resubmission orders NOTHING twice. */
  clientRef: z.string().uuid().optional(),
});

export const createPurchaseOrderResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('created'),
    poNumber: z.string(),
    totalK: kobo,
    expectedOn: z.string().nullable(),
  }),
  /** The same clientRef arrived twice: the first submission already created. */
  z.object({ outcome: z.literal('duplicate') }),
]);

/**
 * Receiving is the delivery landing: the money posts through the same road a
 * chat purchase takes (stock in, cash out for what was paid, the rest owed to
 * the supplier) and every line becomes counted stock at its line cost.
 */
export const receivePurchaseOrderRequest = z.object({
  poNumber: z.string().trim().min(1),
  /** What was handed over on delivery. Zero is a delivery wholly on credit. */
  paidK: z.number().int().finite().nonnegative(),
});

export const receivePurchaseOrderResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('received'),
    poNumber: z.string(),
    totalK: kobo,
    /** What remains owed to the supplier after what was paid. */
    owedK: kobo,
    /** How many lines came onto the shelf as counted stock. */
    linesArrived: z.number().int().nonnegative(),
  }),
  z.object({ outcome: z.literal('not_found') }),
  /** The status machine, not a client key, is the double-receive guard. */
  z.object({ outcome: z.literal('already_received') }),
  z.object({ outcome: z.literal('cancelled') }),
  /** Paying more than the order costs is a prepayment, and this is not that. */
  z.object({ outcome: z.literal('more_than_total'), totalK: kobo }),
]);

export const cancelPurchaseOrderRequest = z.object({
  poNumber: z.string().trim().min(1),
});

export const cancelPurchaseOrderResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('cancelled') }),
  z.object({ outcome: z.literal('not_found') }),
  /** Received or already withdrawn: nothing left to cancel. */
  z.object({ outcome: z.literal('already'), status: z.string() }),
]);

export type CreatePurchaseOrderRequest = z.infer<typeof createPurchaseOrderRequest>;
export type CreatePurchaseOrderResponse = z.infer<typeof createPurchaseOrderResponse>;
export type ReceivePurchaseOrderRequest = z.infer<typeof receivePurchaseOrderRequest>;
export type ReceivePurchaseOrderResponse = z.infer<typeof receivePurchaseOrderResponse>;
export type CancelPurchaseOrderRequest = z.infer<typeof cancelPurchaseOrderRequest>;
export type CancelPurchaseOrderResponse = z.infer<typeof cancelPurchaseOrderResponse>;

/**
 * What is on the shelf, and what it cost.
 *
 * The cost is here now and was deliberately absent before, because Rekoda did
 * not hold a cost basis: a stock page showing a valuation would have been
 * asserting one it had invented. Deliveries now move a weighted average per
 * product, so the figure is real, and it is the one thing a merchant needs to
 * see to know why a sale showed no cost against it.
 *
 * A per-product unit cost, and deliberately NOT a total valuation. Inventory
 * on the balance sheet is the ledger figure and includes purchases that named
 * no product; a column summed here would be a second answer to the same
 * question, differing by exactly the purchases nobody itemised.
 */
export const reportsStockResponse = z.object({
  products: z.array(
    z.object({
      name: z.string(),
      onHand: z.number().int(),
      /** Weighted average of what it cost, or null when nobody has said. */
      unitCostK: kobo.nullable(),
    }),
  ),
  /**
   * Every product the business tracks, which is not `products.length`.
   *
   * The list is a page. A footer that counted the rows it was handed would
   * tell a merchant with two hundred and forty products that they have two
   * hundred, in their own words, and nothing on the page would contradict it.
   */
  total: z.number().int().nonnegative(),
  /** How many are at or below zero, across all of them. The number an operator acts on. */
  outOfStock: z.number().int().nonnegative(),
  /**
   * How many products have never had a cost recorded, across all of them.
   *
   * The count that explains a profit and loss with no cost of sales on it.
   * Sales of these show revenue with nothing against them, which overstates
   * profit by exactly what the goods cost.
   */
  withoutCost: z.number().int().nonnegative(),
});
export type ReportsStockResponse = z.infer<typeof reportsStockResponse>;

/**
 * The audit trail (MASTER-PLAN §42).
 *
 * The accounting-standard surface, and deliberately not a chat transcript:
 * QuickBooks calls this the Audit Log and it is what an accountant or a tax
 * officer asks for by name. Every row is a CHANGE and who made it.
 *
 * `summary` arrives already built by `describeAuditEvent` in @rekoda/core,
 * where every stored shape is pinned by a test and an unrecognised one falls
 * back to naming the entity rather than printing what it held. Raw
 * `old_value` and `new_value` never cross this boundary: a page that
 * formatted them inline would be the place a future writer's payload leaked.
 */
export const reportsAuditResponse = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      /** A role and a phone tail, or a plain statement that it was not a person. */
      actor: z.string(),
      /** invoice | payment | expense | business | subscription_charge | ... */
      entity: z.string(),
      /** issued | voided | confirmed | recorded | plan_changed | ... */
      action: z.string(),
      /** The sentence a person reads. Never carries money: see amountK. */
      summary: z.string(),
      /** The figure this change was about, when it was about one. */
      amountK: kobo.nullable(),
      /** Why, when the action required saying. Voids and refunds always do. */
      reason: z.string().nullable(),
      /** chat | dashboard | system | operator | webhook */
      source: z.string(),
    }),
  ),
  count: z.number().int().nonnegative(),
});
export type ReportsAuditResponse = z.infer<typeof reportsAuditResponse>;

/**
 * Withdrawing an invoice that should not have been issued.
 *
 * A reason is REQUIRED and is not decoration: the document sequence stays
 * dense on purpose, and a gap an auditor cannot explain is what they read as
 * a deleted invoice. The reason is what explains it.
 */
/**
 * A payment the MERCHANT is reporting, from the dashboard.
 *
 * Named by invoice number, which is what a merchant reads and what the
 * register shows. No customer is named on this surface at all.
 */
export const recordPaymentRequest = z.object({
  invoiceNumber: z.string().trim().min(1),
  amountK: z.number().int().finite().positive(),
  method: z.enum(['cash', 'transfer']),
  /**
   * One-shot key the form mints when it renders. A resubmission of the same
   * form carries the same key and books NOTHING twice; a fresh form is a
   * fresh intention and gets its own.
   */
  clientRef: z.string().uuid().optional(),
});

/**
 * RECORDED, never VERIFIED (ADR 0014).
 *
 * Nobody confirmed this with a provider. Letting merchant testimony wear the
 * verified badge would destroy the one distinction this product sells, so
 * the receipt is issued and the payment reads as reported.
 *
 * `balance_moved` carries the excess rather than a bare failure: a provider
 * payment can land while the merchant is typing, and posting the difference
 * away silently is the one thing this must not do.
 */
export const recordPaymentResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('recorded'),
    receiptNumber: z.string(),
    invoiceNumber: z.string(),
    amountK: kobo,
    balanceDueK: kobo,
  }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('already_settled'), invoiceNumber: z.string() }),
  /** The same clientRef arrived twice: the first submission already booked. */
  z.object({ outcome: z.literal('duplicate') }),
  z.object({
    outcome: z.literal('balance_moved'),
    invoiceNumber: z.string(),
    balanceDueK: kobo,
    excessK: kobo,
  }),
]);

export type RecordPaymentRequest = z.infer<typeof recordPaymentRequest>;
export type RecordPaymentResponse = z.infer<typeof recordPaymentResponse>;

export const voidInvoiceRequest = z.object({
  invoiceNumber: z.string().min(1),
  reason: z.string().trim().min(4).max(200),
  /** Second call of the HIGH_RISK two-step (Appendix D): the confirmation
   * the first call opened, agreed to. Absent on the first call. */
  confirmationId: z.string().uuid().optional(),
});

export const voidInvoiceResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('voided'), invoiceNumber: z.string(), reversedK: kobo }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('already_void') }),
  /** Money arrived against it. A credit note is the right instrument, not a void. */
  z.object({ outcome: z.literal('has_payments'), paidK: kobo }),
  /** A void is HIGH_RISK: nothing happened yet — show this consequence and
   * resubmit with the confirmationId to proceed. */
  z.object({
    outcome: z.literal('confirm'),
    confirmationId: z.string().uuid(),
    consequence: z.string(),
  }),
  /** The confirmation expired or was already used. Start again. */
  z.object({ outcome: z.literal('confirmation_lapsed') }),
]);

/**
 * Withdrawing a spend entry.
 *
 * Same instrument as the invoice void and the same requirement: a reason,
 * because a reversal an auditor cannot explain is worse than the entry it
 * corrects. The entry is named by id rather than by description, because two
 * "diesel" rows in one week is the normal case and the wrong one reversed is
 * a second error on top of the first.
 */
export const voidExpenseRequest = z.object({
  expenseId: z.string().uuid(),
  reason: z.string().trim().min(4).max(200),
});

export const voidExpenseResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('voided'),
    description: z.string(),
    kind: z.union([z.literal('expense'), z.literal('purchase')]),
    reversedK: kobo,
    /**
     * The entry brought stock in and that count was NOT touched. Money is a
     * bookkeeping fact and can be mirrored; what is on the shelf is a
     * physical one, and only the merchant knows whether it arrived.
     */
    stockUnchanged: z.boolean(),
  }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('already_void') }),
  /** Recorded before entries carried their posting, so nothing safe to reverse. */
  z.object({ outcome: z.literal('no_posting') }),
]);

export type VoidExpenseRequest = z.infer<typeof voidExpenseRequest>;
export type VoidExpenseResponse = z.infer<typeof voidExpenseResponse>;

/**
 * Setting up a cost that repeats.
 *
 * No end date and no "every N months". A schedule that runs until somebody
 * stops it is the shape every one of these costs actually has: rent does not
 * come with a final month, and a merchant who guesses one wrong finds out by
 * their books going quiet. Stopping takes one click and leaves every entry it
 * already raised exactly where it is.
 */
export const createRecurringRequest = z.object({
  description: z.string().trim().min(2).max(120),
  /** What the merchant calls it. Never `stock`: a schedule is not a delivery. */
  category: z.string().trim().min(1).max(60).nullable(),
  amountK: kobo.refine((k) => k > 0, 'an amount above zero'),
  method: z.union([z.literal('cash'), z.literal('transfer')]),
  anchorDay: z.number().int().min(1).max(31),
  /**
   * One-shot key the form mints when it renders. A resubmission of the same
   * form carries the same key and books NOTHING twice; a fresh form is a
   * fresh intention and gets its own.
   */
  clientRef: z.string().uuid().optional(),
});

export const createRecurringResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('created'),
    id: z.string(),
    /** The first day it will raise. Always in the future, never today. */
    firstDueOn: z.string(),
  }),
  /** A stock purchase is a delivery somebody took, not a standing cost. */
  z.object({ outcome: z.literal('not_stock') }),
  /** The same clientRef arrived twice: the first submission already created. */
  z.object({ outcome: z.literal('duplicate') }),
]);

/**
 * What the business was already holding when it started with Rekoda.
 *
 * `asAt` is the day the figures were true, not today. Books opened "as at 31
 * July" put the entry in July, so it becomes the opening balance of August
 * rather than appearing as money that arrived in August.
 *
 * Still no BARE figure for what customers owe: an opening receivable with no
 * invoice behind it would leave the debtors page and the ledger holding two
 * different answers to the same question, and the merchant chasing neither.
 * Since PR-083 the `receivables` lines honour that rule by MINTING the
 * invoices — each line becomes a real open invoice, settleable like any
 * other, and the ledger's receivable cites it. What is owed TO suppliers
 * still waits: the settlement plane is purchase-keyed, and an opening debt
 * that could never be paid off would be a document pretending to be alive.
 *
 * The shelf comes one of two ways, never both: `stockK` for a merchant who
 * knows the value alone, or counted `stock` lines that create the products
 * and their costs so the physical and financial books open agreeing.
 */
export const openingBalancesRequest = z
  .object({
    asAt: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'a day like 2026-07-31'),
    cashK: kobo,
    bankK: kobo,
    stockK: kobo,
    stock: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(200),
          quantity: z.number().positive().finite(),
          unitCostK: kobo,
        }),
      )
      .max(200)
      .optional(),
    receivables: z
      .array(
        z.object({
          customerId: z.string().uuid(),
          amountK: kobo.refine((v) => v > 0, 'an opening receivable must be owed something'),
          dueDate: z
            .string()
            .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/)
            .nullish(),
        }),
      )
      .max(200)
      .optional(),
  })
  .refine((v) => !(v.stockK > 0 && (v.stock?.length ?? 0) > 0), {
    message: 'opening stock is a value or counted lines, never both',
  });

export const openingBalancesResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('recorded'),
    asAt: z.string(),
    /** Everything held, which is what went to owner's equity. */
    equityK: kobo,
    /** The shelf's value: stated, or derived from the counted lines. */
    stockValueK: kobo,
    /** The open invoices the opening receivables became. */
    invoices: z.array(z.object({ invoiceNumber: z.string(), amountK: kobo })),
  }),
  /** Once only. The books cannot be opened twice without saying which is true. */
  z.object({ outcome: z.literal('already_set') }),
  /** Every figure zero. An entry of nothing is not an entry. */
  z.object({ outcome: z.literal('nothing_to_open') }),
  /** Dated in the future, which is a typo rather than a balance. */
  z.object({ outcome: z.literal('not_yet') }),
  /**
   * Dated inside a month the merchant has closed.
   *
   * Rare and not impossible: opening balances are a setup act, and a business
   * that has closed months has usually opened its books long ago. Carried as
   * an outcome anyway, because the alternative to naming it is a 500.
   */
  z.object({ outcome: z.literal('period_closed'), closedThrough: z.string() }),
]);

export type OpeningBalancesRequest = z.infer<typeof openingBalancesRequest>;
export type OpeningBalancesResponse = z.infer<typeof openingBalancesResponse>;

/**
 * Act on a count of the shelf.
 *
 * Carries the day and nothing else. The figures are read from the database
 * inside the same transaction that writes the entry, because a count posted
 * back from a browser is a count from whenever that page was rendered, and an
 * adjustment computed from a stale figure is precisely the quiet misstatement
 * this instrument exists to expose.
 */
export const stockCountRequest = z.object({
  countedOn: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'a day like 2026-08-21'),
});

export const stockCountResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('adjusted'),
    /** Negative when the books held stock the shelf does not. */
    differenceK: z.number().int().finite(),
    countedK: kobo,
  }),
  /** The books already say what the shelf says. Nothing to post. */
  z.object({ outcome: z.literal('agrees'), countedK: kobo }),
  /**
   * Stock is on the shelf that nobody has said the cost of, so the count is
   * short by an unknown amount and an adjustment would write off real goods.
   */
  z.object({ outcome: z.literal('costs_missing'), uncosted: z.number().int().positive() }),
  /** Dated in the future, which is a typo rather than a count. */
  z.object({ outcome: z.literal('not_yet') }),
]);

export type StockCountRequest = z.infer<typeof stockCountRequest>;
export type StockCountResponse = z.infer<typeof stockCountResponse>;

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month like 2026-08');

/**
 * Close the books through a month.
 *
 * A watermark, not a list. Closing through August means every month up to and
 * including August is closed, which is what a merchant means when they say
 * their books are done to the end of August.
 */
export const closeBooksRequest = z.object({ through: period });

export const closeBooksResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('closed'), through: period }),
  /**
   * The month has not ended. Refused rather than allowed, and the refusal is
   * what keeps the guard's blast radius honest: every live posting is stamped
   * now, so nothing a merchant does today can ever meet it.
   */
  z.object({ outcome: z.literal('not_ended') }),
  /** Already closed through that month or later. Nothing to do, said plainly. */
  z.object({ outcome: z.literal('already_closed'), through: period }),
]);

/**
 * Open a closed month, and every month after it.
 *
 * One watermark cannot express "July open, August closed", so reopening July
 * necessarily reopens August too. Saying that is better than a second way to
 * describe what is closed.
 */
export const reopenBooksRequest = z.object({
  from: period,
  /** Second call of the HIGH_RISK two-step (Appendix D). */
  confirmationId: z.string().uuid().optional(),
});

export const reopenBooksResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('reopened'),
    from: period,
    /** What the watermark was, so the page can say what else came open. */
    wasClosedThrough: period,
  }),
  /** Reopening is HIGH_RISK: reported figures become movable again. Nothing
   * happened yet — show this consequence and resubmit with the id. */
  z.object({
    outcome: z.literal('confirm'),
    confirmationId: z.string().uuid(),
    consequence: z.string(),
  }),
  z.object({ outcome: z.literal('confirmation_lapsed') }),
  z.object({ outcome: z.literal('already_open') }),
]);

/**
 * The chart (ADR 0004, extended by 0025). Mirrors `ACCOUNTS` in @rekoda/core, which cannot
 * be imported here: contracts depends on zod and nothing else, so the wire
 * shape never drags the money engine along with it. The two lists are held
 * together by a test rather than by hope
 * (apps/api/src/reports/accounts.test.ts).
 */
export const LedgerAccount = z.enum([
  'CASH',
  'BANK_PAYSTACK',
  'BANK',
  'ACCOUNTS_RECEIVABLE',
  'INVENTORY',
  'EQUIPMENT',
  'ACCUMULATED_DEPRECIATION',
  'ACCOUNTS_PAYABLE',
  'VAT_PAYABLE',
  'CUSTOMER_CREDIT',
  'OWNERS_EQUITY',
  'SALES_REVENUE',
  'COGS',
  'EXPENSES',
  'DEPRECIATION',
  'DISPOSAL_RESULT',
]);

/**
 * A correction written by hand.
 *
 * One amount between two accounts, so there is no arrangement of these fields
 * that fails to balance and the merchant is never asked to make one. A
 * genuine multi-line journal is not expressible, deliberately.
 */
/**
 * Paying a supplier back.
 *
 * `method` decides which account gave the money up, and there are only two
 * because there are only two the books model: the till and the bank.
 */
/**
 * Buying something the business keeps and uses (ADR 0026).
 *
 * `usefulLifeMonths` is asked, never inferred. A model deciding how long a
 * merchant's freezer lasts would be a model computing money, which the spec
 * forbids, and it would be wrong often enough to matter.
 *
 * No minimum value. A ₦40,000 phone a trader uses for three years is as much
 * a fixed asset as a ₦450,000 generator, and a threshold would only teach
 * merchants to route things around it.
 */
export const recordAssetRequest = z
  .object({
    description: z.string().trim().min(2).max(120),
    costK: z.number().int().finite().positive(),
    /** What was handed over now. The rest is owed to the supplier. */
    paidK: z.number().int().finite().nonnegative(),
    /* Twelve years is longer than any equipment a merchant here will buy and
     * short enough that a mistyped figure is refused rather than spreading a
     * generator over a century. */
    usefulLifeMonths: z.number().int().min(1).max(144),
    method: z.enum(['cash', 'transfer']),
    /**
     * One-shot key the form mints when it renders. A resubmission of the
     * same form carries the same key and books NOTHING twice; a fresh form
     * is a fresh intention and gets its own.
     */
    clientRef: z.string().uuid().optional(),
  })
  .refine((v) => v.paidK <= v.costK, {
    message: 'you cannot pay more than it cost',
    path: ['paidK'],
  });

export const recordAssetResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('recorded'),
    assetId: z.string(),
    /** What is still owed on it. Zero unless it was taken partly on credit. */
    owedK: kobo,
  }),
  /** The same clientRef arrived twice: the first submission already recorded. */
  z.object({ outcome: z.literal('duplicate') }),
]);

/**
 * Selling or scrapping equipment (ADR 0026, amended).
 *
 * `proceedsK` may be zero: a generator that died is scrapped for nothing, and
 * that is a real event with a real loss, not a missing field.
 */
export const disposeAssetRequest = z.object({
  assetId: z.string().uuid(),
  proceedsK: z.number().int().finite().nonnegative(),
  method: z.enum(['cash', 'transfer']),
});

export const disposeAssetResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('sold'),
    description: z.string(),
    /** What it was still worth on the books the moment before it went. */
    bookValueK: kobo,
    /** SIGNED. Positive is better off than book value, negative is worse. */
    resultK: z.number().int().finite(),
  }),
  z.object({ outcome: z.literal('not_found') }),
  /** Already sold, or withdrawn as never bought. */
  z.object({ outcome: z.literal('not_owned') }),
]);

export type DisposeAssetRequest = z.infer<typeof disposeAssetRequest>;
export type DisposeAssetResponse = z.infer<typeof disposeAssetResponse>;

export const withdrawAssetRequest = z.object({
  assetId: z.string().uuid(),
  reason: z.string().trim().min(4).max(200),
});

/**
 * NOT a disposal. Selling or scrapping equipment is a real event with a gain
 * or a loss against book value, and ADR 0026 says plainly it is not in this
 * slice. This is the mistake path.
 */
export const withdrawAssetResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('withdrawn'), description: z.string(), reversedK: kobo }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('already_withdrawn') }),
]);

export type RecordAssetRequest = z.infer<typeof recordAssetRequest>;
export type RecordAssetResponse = z.infer<typeof recordAssetResponse>;
export type WithdrawAssetRequest = z.infer<typeof withdrawAssetRequest>;
export type WithdrawAssetResponse = z.infer<typeof withdrawAssetResponse>;

export const paySupplierRequest = z.object({
  expenseId: z.string().uuid(),
  amountK: z.number().int().finite().positive(),
  method: z.enum(['cash', 'transfer']),
  /**
   * One-shot key the form mints when it renders. A resubmission of the same
   * form carries the same key and books NOTHING twice; a fresh form is a
   * fresh intention and gets its own.
   */
  clientRef: z.string().uuid().optional(),
});

/**
 * Four refusals, each one a different thing for a merchant to do next.
 *
 * `more_than_owed` carries the figure, because the useful reply to "you tried
 * to pay ₦40,001 on a ₦40,000 debt" is the ₦40,000. Overpaying a supplier is
 * a prepayment, an asset, and booking it against a liability would drive
 * ACCOUNTS_PAYABLE below zero and read as the supplier owing the merchant.
 */
export const paySupplierResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('paid'), owedK: kobo, description: z.string() }),
  z.object({
    outcome: z.literal('refused'),
    reason: z.enum(['no_such_purchase', 'withdrawn', 'nothing_owed', 'more_than_owed']),
    owedK: kobo,
  }),
  /** The same clientRef arrived twice: the first submission already paid. */
  z.object({ outcome: z.literal('duplicate') }),
]);

export type PaySupplierRequest = z.infer<typeof paySupplierRequest>;
export type PaySupplierResponse = z.infer<typeof paySupplierResponse>;

export const journalEntryRequest = z.object({
  /** Why. Required: an entry nobody can explain is the one that hurts. */
  memo: z.string().trim().min(3).max(200),
  amountK: z.number().int().finite().positive(),
  /** Debited: what gains. */
  intoAccount: LedgerAccount,
  /** Credited: what gives it up. */
  outOfAccount: LedgerAccount,
  /** The day it happened. Absent means today. */
  occurredOn: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'a day like 2026-08-21')
    .optional(),
  /**
   * One-shot key the form mints when it renders. A resubmission of the same
   * form carries the same key and books NOTHING twice; a fresh form is a
   * fresh intention and gets its own.
   */
  clientRef: z.string().uuid().optional(),
});

export const journalEntryResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('recorded'),
    /** JNL-2026-000001. What an accountant writes down when they ask which. */
    journalNumber: z.string(),
  }),
  /** Into and out of the same account moves nothing. */
  z.object({ outcome: z.literal('same_account') }),
  /** Dated in the future, which is a plan rather than a correction. */
  z.object({ outcome: z.literal('not_yet') }),
  /** Dated into a month the merchant closed. */
  z.object({ outcome: z.literal('period_closed'), closedThrough: z.string() }),
  /** The same clientRef arrived twice: the first submission already posted. */
  z.object({ outcome: z.literal('duplicate') }),
]);

export type LedgerAccountKey = z.infer<typeof LedgerAccount>;
export type JournalEntryRequest = z.infer<typeof journalEntryRequest>;
export type JournalEntryResponse = z.infer<typeof journalEntryResponse>;

/**
 * A statement a merchant downloaded from their own bank.
 *
 * The file arrives as text rather than as a multipart upload. The web tier
 * already has the bytes when a merchant picks a file, and converting them
 * once there keeps the API a JSON surface: no multipart parser, no temporary
 * files, and no second way for a body to reach this service.
 *
 * Capped because a statement is a statement. A year of a busy account is a
 * few hundred kilobytes; anything past two megabytes is somebody uploading
 * the wrong thing, and refusing early beats parsing it to find out.
 */
export const importStatementRequest = z.object({
  csv: z.string().min(1).max(2_000_000),
});

export const importStatementResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('imported'),
    /** Lines the merchant did not already have. */
    imported: z.number().int().nonnegative(),
    /** Already present. The ordinary result of a re-upload, not a failure. */
    duplicates: z.number().int().nonnegative(),
    /** Rows the file had that carried no movement, so a merchant can check. */
    skipped: z.number().int().nonnegative(),
  }),
  /**
   * The file could not be read. `reason` is the parser's own word for it, so
   * the page can say which of the several different problems this was.
   */
  z.object({
    outcome: z.literal('unreadable'),
    reason: z.enum([
      'empty',
      'no_header',
      'no_date_column',
      'no_amount_column',
      'mixed_date_order',
      'no_rows',
    ]),
  }),
]);

/** What the books say against what the bank says. */
export const bankPositionResponse = z.object({
  /**
   * Read without committing, so opening the page never decides anything.
   * Pairing is a write, and a page load must not write.
   */
  reconciliation: z.object({
    matched: z.number().int().nonnegative(),
    /** What the rule would pair if asked. The read never asks. */
    pairable: z.number().int().nonnegative(),
    /** Tier-3 proposals (§22.1): shown to a person, never applied. */
    suggested: z.number().int().nonnegative(),
    /** The proposals themselves, for the review cards. */
    proposals: z.array(
      z.object({
        lineId: z.string(),
        transactionId: z.string(),
        why: z.enum(['reference_found_amount_differs']),
        movementAmountK: z.number().int(),
        movementOccurredOn: z.string(),
        movementMemo: z.string(),
      }),
    ),
    ambiguous: z.number().int().nonnegative(),
    unmatchedLines: z.number().int().nonnegative(),
    unmatchedMovements: z.number().int().nonnegative(),
    undecidedMovements: z.number().int().nonnegative(),
    unmatchedLinesK: z.number().int().finite(),
    unmatchedMovementsK: z.number().int().finite(),
  }),
  position: z.object({
    ledgerK: z.number().int().finite(),
    statementK: z.number().int().finite(),
    differenceK: z.number().int().finite(),
    lines: z.number().int().nonnegative(),
    latestOn: z.string().nullable(),
  }),
  lines: z.array(
    z.object({
      id: z.string(),
      postedOn: z.string(),
      amountK: z.number().int().finite(),
      /**
       * The bank's own words, which carry counterparty names.
       *
       * Crosses to the merchant who downloaded the statement and to nobody
       * else. Never sent to a model, and never rendered into a WhatsApp
       * message, which is plaintext on somebody's phone.
       */
      narration: z.string(),
      bankRef: z.string().nullable(),
      /**
       * What this line was paired with, if anything.
       *
       * The memo rather than the id, because a merchant checking a
       * reconciliation reads "Sale INV-2026-000012", not a uuid. It is the
       * merchant's own words about their own books; no counterparty name
       * reaches a ledger memo, and none may be put in one.
       */
      matchedTo: z
        .object({
          transactionId: z.string(),
          memo: z.string(),
          /** Whether Rekoda decided this or the merchant did. */
          decidedBy: z.enum(['auto', 'manual']),
          /** Which §22.1 tier decided it: 1 exact reference, 2 strong
           * deterministic, 4 manual. */
          tier: z.number().int(),
          /** The person's sentence on a tier-4 match; null on auto tiers. */
          reason: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  /**
   * Postings the statement has not explained, offered as the pool a merchant
   * picks from when the rule refused to choose.
   */
  openMovements: z.array(
    z.object({
      transactionId: z.string(),
      occurredOn: z.string(),
      amountK: z.number().int().finite(),
      memo: z.string(),
    }),
  ),
});

/**
 * What pairing the two sides found.
 *
 * `ambiguous` is not a failure. It is the count of lines where more than one
 * posting fits, which is exactly where a confident matcher invents a
 * reconciliation, so they are left for a person.
 */
export const reconcileResponse = z.object({
  matched: z.number().int().nonnegative(),
  /** Left over after this pass, which outside a race is zero. */
  pairable: z.number().int().nonnegative(),
  /** Tier-3 proposals (§22.1): shown to a person, never applied. */
  suggested: z.number().int().nonnegative(),
  /** The proposals themselves, for the review cards. */
  proposals: z.array(
    z.object({
      lineId: z.string(),
      transactionId: z.string(),
      why: z.enum(['reference_found_amount_differs']),
      movementAmountK: z.number().int(),
      movementOccurredOn: z.string(),
      movementMemo: z.string(),
    }),
  ),
  ambiguous: z.number().int().nonnegative(),
  /** Lines nothing in the books explains: money nobody recorded. */
  unmatchedLines: z.number().int().nonnegative(),
  /** Postings nothing on the statement explains: money the bank never saw. */
  unmatchedMovements: z.number().int().nonnegative(),
  /** Candidates for a line with more than one, waiting on a person. */
  undecidedMovements: z.number().int().nonnegative(),
  unmatchedLinesK: z.number().int().finite(),
  unmatchedMovementsK: z.number().int().finite(),
});

export type ReconcileResponse = z.infer<typeof reconcileResponse>;

export const matchLineRequest = z.object({
  lineId: z.string().uuid(),
  transactionId: z.string().uuid(),
  /** §22.1 tier 4: the person's own words for why these two are the same
   * money. Optional on the wire until the screen grows the field
   * (PR-076); the stored reason then names the door instead. */
  reason: z.string().trim().max(300).optional(),
});

/**
 * Five ways a hand-made match is refused, and a merchant needs to know
 * which. `amounts_differ` is the one that carries a lesson: it means there
 * is a second fact, usually a bank charge, that needs its own entry.
 */
export const matchLineResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('matched') }),
  z.object({
    outcome: z.literal('refused'),
    reason: z.enum([
      'no_such_line',
      'no_such_movement',
      'amounts_differ',
      'line_already_matched',
      'movement_already_matched',
    ]),
  }),
]);

export const unmatchLineRequest = z.object({ lineId: z.string().uuid() });
export const unmatchLineResponse = z.object({
  released: z.number().int().nonnegative(),
});

/**
 * §22.2's WHEN, as a door: the merchant classifies an unmatched line, and
 * ONE transaction posts the journal that judgement implies and pairs it.
 * LOAN is absent until F2 brings a borrowings account (ADR 0004's chart
 * is fixed at V1); anything else stays the journal-plus-pair flow.
 */
export const classifyLineRequest = z.object({
  lineId: z.string().uuid(),
  classification: z.enum(['OWNER_CAPITAL', 'SUPPLIER_REFUND', 'INTERNAL_TRANSFER']),
  /** The merchant's own words, riding into the memo and the reason. */
  note: z.string().trim().max(300).optional(),
});

export const classifyLineResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('classified'), journalNumber: z.string() }),
  z.object({
    outcome: z.literal('refused'),
    reason: z.enum(['no_such_line', 'line_already_matched']),
  }),
]);

export type ClassifyLineRequest = z.infer<typeof classifyLineRequest>;
export type ClassifyLineResponse = z.infer<typeof classifyLineResponse>;

export type MatchLineRequest = z.infer<typeof matchLineRequest>;
export type MatchLineResponse = z.infer<typeof matchLineResponse>;
export type UnmatchLineRequest = z.infer<typeof unmatchLineRequest>;
export type UnmatchLineResponse = z.infer<typeof unmatchLineResponse>;

export const forgetStatementDayRequest = z.object({
  postedOn: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'a day like 2026-08-21'),
});

export const forgetStatementDayResponse = z.object({
  removed: z.number().int().nonnegative(),
});

/**
 * The live bank feed (fix-plan 4, G5; MASTER-PLAN B0, ADR 0012).
 *
 * The feed is a second door into the SAME `bank_statement_lines` the CSV
 * upload fills: fetched transactions go through the same fingerprint, the
 * same dedupe and the same reconciliation, so nothing downstream knows or
 * cares which door a line used.
 *
 * `not_configured` is a deployment fact, not an error: a deployment without
 * aggregator credentials simply does not have this door, and the page says
 * so instead of showing a button that cannot work.
 */
export const bankFeedStateResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_configured') }),
  z.object({ state: z.literal('not_linked') }),
  /**
   * Linked once, and access lapsed provider-side. Its own state because
   * "authorise it again" is a different sentence from "link your bank",
   * and the card should still name the account it is about.
   */
  z.object({
    state: z.literal('lapsed'),
    bankName: z.string(),
    accountLast4: z.string(),
  }),
  z.object({
    state: z.literal('linked'),
    bankName: z.string(),
    accountLast4: z.string(),
    /** The last Lagos day a sync ran, or null before the first. */
    lastSyncedOn: z.string().nullable(),
  }),
]);

/**
 * The one-time code the aggregator's consent widget hands the merchant
 * after THEY authorise access to their own account. Rekoda never sees
 * credentials: the code is exchanged server-side for an account reference.
 */
export const connectBankFeedRequest = z.object({
  exchangeCode: z.string().trim().min(4).max(200),
});

export const connectBankFeedResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('linked'),
    bankName: z.string(),
    accountLast4: z.string(),
  }),
  /** The aggregator said no: a stale or already-used code, usually. */
  z.object({ outcome: z.literal('rejected'), reason: z.string() }),
  z.object({ outcome: z.literal('not_configured') }),
]);

export const syncBankFeedResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('synced'),
    /** Lines the merchant did not already have. Same words as the upload. */
    imported: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    /** The first day the fetch covered, `YYYY-MM-DD`. */
    since: z.string(),
  }),
  z.object({ outcome: z.literal('not_configured') }),
  z.object({ outcome: z.literal('not_linked') }),
  /** The aggregator no longer has access: the merchant must link again. */
  z.object({ outcome: z.literal('unlinked') }),
]);

export type BankFeedStateResponse = z.infer<typeof bankFeedStateResponse>;
export type ConnectBankFeedRequest = z.infer<typeof connectBankFeedRequest>;
export type ConnectBankFeedResponse = z.infer<typeof connectBankFeedResponse>;
export type SyncBankFeedResponse = z.infer<typeof syncBankFeedResponse>;

export type ImportStatementRequest = z.infer<typeof importStatementRequest>;
export type ImportStatementResponse = z.infer<typeof importStatementResponse>;
export type BankPositionResponse = z.infer<typeof bankPositionResponse>;
export type ForgetStatementDayRequest = z.infer<typeof forgetStatementDayRequest>;
export type ForgetStatementDayResponse = z.infer<typeof forgetStatementDayResponse>;

export type CloseBooksRequest = z.infer<typeof closeBooksRequest>;
export type CloseBooksResponse = z.infer<typeof closeBooksResponse>;
export type ReopenBooksRequest = z.infer<typeof reopenBooksRequest>;
export type ReopenBooksResponse = z.infer<typeof reopenBooksResponse>;

export const stopRecurringRequest = z.object({ id: z.string().uuid() });

export const stopRecurringResponse = z.object({
  outcome: z.union([z.literal('stopped'), z.literal('already_stopped'), z.literal('not_found')]),
});

export type CreateRecurringRequest = z.infer<typeof createRecurringRequest>;
export type CreateRecurringResponse = z.infer<typeof createRecurringResponse>;
export type StopRecurringRequest = z.infer<typeof stopRecurringRequest>;
export type StopRecurringResponse = z.infer<typeof stopRecurringResponse>;

/**
 * Crediting an invoice money has already arrived against.
 *
 * The instrument the void refuses to be, and the reason is the same one the
 * void's own refusal gives: reversing a paid sale would describe a payment
 * that is still in the merchant's account. This reduces the sale and leaves
 * the cash where it is.
 */
export const creditInvoiceRequest = z.object({
  invoiceNumber: z.string().min(1),
  /** Integer kobo, positive. A credit of nothing is not a credit. */
  amountK: z.number().int().positive(),
  reason: z.string().trim().min(4).max(200),
  /**
   * One-shot key the form mints when it renders. A resubmission of the same
   * form carries the same key and books NOTHING twice; a fresh form is a
   * fresh intention and gets its own.
   */
  clientRef: z.string().uuid().optional(),
});

export const creditInvoiceResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('credited'),
    creditNoteNumber: z.string(),
    invoiceNumber: z.string(),
    amountK: kobo,
    /** What the customer still owes on the INVOICE — unchanged (§14.1):
     * an unapplied credit reduces no invoice. */
    balanceDueK: kobo,
    /** What the merchant now owes the CUSTOMER: the whole credit, until
     * it is explicitly applied or paid out. */
    owedToCustomerK: kobo,
    /** The CustomerCredit the note created (§14.1). */
    customerCreditId: z.string(),
  }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('voided') }),
  /** Nothing was ever paid, so the void is the right instrument. */
  z.object({ outcome: z.literal('unpaid') }),
  /** §14.1 owes value TO a customer; this invoice names nobody. */
  z.object({ outcome: z.literal('no_customer') }),
  z.object({ outcome: z.literal('exceeds_invoice'), creditableK: kobo }),
  /** The same clientRef arrived twice: the first submission already credited. */
  z.object({ outcome: z.literal('duplicate') }),
]);

export type CreditInvoiceRequest = z.infer<typeof creditInvoiceRequest>;
export type CreditInvoiceResponse = z.infer<typeof creditInvoiceResponse>;

export type VoidInvoiceRequest = z.infer<typeof voidInvoiceRequest>;
export type VoidInvoiceResponse = z.infer<typeof voidInvoiceResponse>;
