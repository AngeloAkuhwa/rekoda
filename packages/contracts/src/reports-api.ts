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

const statementLine = z.object({
  account: z.string(),
  code: z.string(),
  name: z.string(),
  amountK: z.number().int().finite(),
});

export const reportsStatementsResponse = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  trialBalance: z.object({
    rows: z.array(
      z.object({
        account: z.string(),
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
});
export type ReportsInvoicesResponse = z.infer<typeof reportsInvoicesResponse>;

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
   * set. The buckets sum to `payableK` exactly.
   */
  payableAgeing: z.object({
    d0_30K: kobo,
    d31_60K: kobo,
    d61_90K: kobo,
    d90PlusK: kobo,
    totalK: kobo,
  }),
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
});
export type ReportsExpensesResponse = z.infer<typeof reportsExpensesResponse>;

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
  /** How many are at or below zero. The number an operator acts on. */
  outOfStock: z.number().int().nonnegative(),
  /**
   * How many products have never had a cost recorded.
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
export const voidInvoiceRequest = z.object({
  invoiceNumber: z.string().min(1),
  reason: z.string().trim().min(4).max(200),
});

export const voidInvoiceResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('voided'), invoiceNumber: z.string(), reversedK: kobo }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('already_void') }),
  /** Money arrived against it. A credit note is the right instrument, not a void. */
  z.object({ outcome: z.literal('has_payments'), paidK: kobo }),
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
]);

/**
 * What the business was already holding when it started with Rekoda.
 *
 * `asAt` is the day the figures were true, not today. Books opened "as at 31
 * July" put the entry in July, so it becomes the opening balance of August
 * rather than appearing as money that arrived in August.
 *
 * Deliberately no field for what customers owe or what is owed to suppliers.
 * An opening receivable has no invoice behind it, so the debtors page and the
 * ledger would hold two different answers to the same question and the
 * merchant could chase neither. Old unpaid invoices belong here as invoices.
 */
export const openingBalancesRequest = z.object({
  asAt: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'a day like 2026-07-31'),
  cashK: kobo,
  bankK: kobo,
  stockK: kobo,
});

export const openingBalancesResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('recorded'),
    asAt: z.string(),
    /** Everything held, which is what went to owner's equity. */
    equityK: kobo,
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
export const reopenBooksRequest = z.object({ from: period });

export const reopenBooksResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('reopened'),
    from: period,
    /** What the watermark was, so the page can say what else came open. */
    wasClosedThrough: period,
  }),
  z.object({ outcome: z.literal('already_open') }),
]);

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
});

export const creditInvoiceResponse = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('credited'),
    creditNoteNumber: z.string(),
    invoiceNumber: z.string(),
    amountK: kobo,
    /** What the customer still owes. Never below zero. */
    balanceDueK: kobo,
    /** What the merchant now owes the CUSTOMER. Zero in the ordinary case. */
    owedToCustomerK: kobo,
  }),
  z.object({ outcome: z.literal('not_found') }),
  z.object({ outcome: z.literal('voided') }),
  /** Nothing was ever paid, so the void is the right instrument. */
  z.object({ outcome: z.literal('unpaid') }),
  z.object({ outcome: z.literal('exceeds_invoice'), creditableK: kobo }),
]);

export type CreditInvoiceRequest = z.infer<typeof creditInvoiceRequest>;
export type CreditInvoiceResponse = z.infer<typeof creditInvoiceResponse>;

export type VoidInvoiceRequest = z.infer<typeof voidInvoiceRequest>;
export type VoidInvoiceResponse = z.infer<typeof voidInvoiceResponse>;
