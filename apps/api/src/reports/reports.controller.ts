/**
 * The dashboard's numbers (MASTER-PLAN §5.3.7, ADR 0015).
 *
 * Thin by design: every figure is computed in SQL by the reports repo, and
 * this controller only decides WHO may read it. `businessId` comes from the
 * session, never from a body or query — same rule as the payments surface.
 * No model is anywhere in this path, and there is no arithmetic in this file
 * beyond none at all.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';

/**
 * The two methods a CSV response needs, and nothing else.
 *
 * Structural rather than `FastifyReply`, because `fastify` is a transitive
 * dependency here and importing a type from one is how a transitive
 * dependency quietly becomes a direct one nobody chose.
 */
interface CsvReply {
  header(name: string, value: string): CsvReply;
  send(payload: string): unknown;
}

/** The same, for bytes. A PDF is not a string and must not be sent as one. */
interface FileReply {
  header(name: string, value: string): FileReply;
  send(payload: Buffer): unknown;
}
import {
  buildBalanceSheet,
  buildCashflowStatement,
  buildProfitAndLoss,
  buildTrialBalance,
  csvDate,
  csvKobo,
  daysOverdue,
  buildXlsx,
  describeActor,
  EXPENSE_CATEGORY_LABELS,
  isExpenseCategory,
  SALE_SOURCE_LABELS,
  STOCK_CATEGORY,
  UNATTRIBUTED_SALE_LABEL,
  describeAuditEvent,
  isAccountKey,
  lagosDay,
  lagosNoon,
  nextDueAfter,
  periodBefore,
  statementSheets,
  toCsv,
  usagePeriod,
  type AccountSums,
} from '@rekoda/core';
import { FontsMissing, renderStatementsPdf } from '../documents/pdf.js';
import type {
  ReportsActivityResponse,
  ReportsAuditResponse,
  ReportsCashflowResponse,
  ReportsDebtorsResponse,
  ReportsExpensesResponse,
  ReportsInvoicesResponse,
  ReportsOverviewResponse,
  ReportsReceiptsResponse,
  ReportsStockResponse,
  CreateRecurringResponse,
  OpeningBalancesResponse,
  StockCountResponse,
  CloseBooksResponse,
  JournalEntryResponse,
  ReopenBooksResponse,
  CreditInvoiceResponse,
  ReportsStatementsResponse,
  StopRecurringResponse,
  VoidExpenseResponse,
  VoidInvoiceResponse,
} from '@rekoda/contracts';
import {
  createRecurringRequest,
  openingBalancesRequest,
  stockCountRequest,
  closeBooksRequest,
  journalEntryRequest,
  reopenBooksRequest,
  creditInvoiceRequest,
  stopRecurringRequest,
  voidExpenseRequest,
  voidInvoiceRequest,
} from '@rekoda/contracts';
import {
  identity,
  issueRepo,
  ordersRepo,
  openingRepo,
  stocktakeRepo,
  closeRepo,
  journalRepo,
  recurringRepo,
  reportsRepo,
  spendRepo,
  stockRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { DB } from '../db/db.module.js';

const CASHFLOW_MONTHS = 6;
const DEBTOR_ROWS = 6;
const ACTIVITY_ROWS = 8;
const REGISTER_ROWS = 50;
const STOCK_ROWS = 200;
/** A year of an active shop's changes is well inside this. */
const AUDIT_ROWS = 100;
/** What a spreadsheet is, to a browser and to every mail client. */
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/**
 * The export ceiling, and it is not the register's.
 *
 * A register shows a page because a screen has a size; an export that
 * silently gave somebody the latest fifty of their four hundred invoices
 * would be worse than no export at all, because they would not know. Ten
 * thousand rows is roughly a decade of a busy shop and about a megabyte.
 */
const EXPORT_ROWS = 10_000;

@Controller('v1/reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('overview')
  async overview(@Req() request: AuthedRequest): Promise<ReportsOverviewResponse> {
    const businessId = request.auth!.businessId;
    const { overview, ageing } = await withBusiness(this.db, businessId, async (tx) => ({
      overview: await reportsRepo.overviewFor(tx, businessId),
      ageing: await reportsRepo.ageingFor(tx, businessId),
    }));
    return { period: usagePeriod(new Date()), ...overview, ageing };
  }

  @Get('cashflow')
  async cashflow(@Req() request: AuthedRequest): Promise<ReportsCashflowResponse> {
    const businessId = request.auth!.businessId;
    const months = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.cashflowFor(tx, businessId, CASHFLOW_MONTHS),
    );
    return { months };
  }

  @Get('debtors')
  async debtors(@Req() request: AuthedRequest): Promise<ReportsDebtorsResponse> {
    const businessId = request.auth!.businessId;
    const now = new Date();
    const debtors = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.debtorsFor(tx, businessId, DEBTOR_ROWS),
    );
    return {
      rows: debtors.rows.map((r) => ({
        invoiceNumber: r.invoiceNumber,
        balanceDueK: r.balanceDueK,
        issuedAt: r.issuedAt.toISOString(),
        dueDate: r.dueDate?.toISOString() ?? null,
        /* Derived at read time, never stored: a stored flag is a second
         * source of truth that is wrong between sweeps, and the moment it
         * matters is the moment a merchant looks. */
        daysOverdue: daysOverdue(r.dueDate, r.balanceDueK, now),
      })),
      totalK: debtors.totalK,
      count: debtors.count,
    };
  }

  /**
   * The four statements for one Lagos month, assembled by the pure builders
   * in @rekoda/core from a single per-account sums query. An unknown account
   * string in storage would mean a write path bypassed the posting builders;
   * it is dropped here and the trial balance's own `balanced` flag is what
   * would expose the damage.
   */
  @Get('statements')
  async statements(
    @Req() request: AuthedRequest,
    @Query('period') periodParam?: string,
  ): Promise<ReportsStatementsResponse> {
    const period = requirePeriod(periodParam);
    const businessId = request.auth!.businessId;
    const before = periodBefore(period);

    /* Two grouped scans over one tenant's ledger, in parallel. The prior
     * column is what every accounting package puts beside a profit and loss,
     * and a merchant reading this page always wants it: gating it behind a
     * flag would mean a second round trip for the thing they came for. */
    const [sums, priorSums, schedule, revenue, opening, stockValuation, booksClosedThrough] =
      await Promise.all([
        this.sumsFor(businessId, period),
        this.sumsFor(businessId, before),
        this.expenseScheduleFor(businessId, period),
        this.revenueScheduleFor(businessId, period),
        withBusiness(this.db, businessId, (tx) => openingRepo.openingBalancesFor(tx, businessId)),
        withBusiness(this.db, businessId, (tx) => stocktakeRepo.stockValuationFor(tx, businessId)),
        withBusiness(this.db, businessId, (tx) => closeRepo.booksClosedThroughFor(tx, businessId)),
      ]);

    const prior = buildProfitAndLoss(priorSums);
    return {
      period,
      ...buildAll(sums),
      expenseSchedule: schedule,
      revenueSchedule: revenue,
      openingBalances: opening,
      stockValuation,
      booksClosedThrough,
      comparison: {
        period: before,
        totalIncomeK: prior.totalIncomeK,
        totalExpensesK: prior.totalExpensesK,
        netProfitK: prior.netProfitK,
        lines: Object.fromEntries(
          [...prior.income, ...prior.expenses].map((line) => [line.account, line.amountK]),
        ),
      },
    };
  }

  /**
   * The same four statements, as a file somebody can send to a bank.
   *
   * A dashboard is not a deliverable. A merchant asked for a loan, a grant or
   * a landlord's reference needs something with a date on it that they can
   * forward, and "log in and look at my screen" is not that. This is also the
   * file the chat assistant has been pointing at the dashboard INSTEAD of,
   * because it did not exist.
   *
   * Not metered. It costs compute and no provider a naira, and locking a
   * merchant out of their own accounts to protect a report allowance would
   * be the wrong trade in both directions.
   */
  @Get('statements.pdf')
  async statementsPdf(
    @Req() request: AuthedRequest,
    @Res() reply: FileReply,
    @Query('period') periodParam?: string,
  ): Promise<void> {
    const period = requirePeriod(periodParam);
    const auth = request.auth!;
    const [sums, schedule, revenue] = await Promise.all([
      this.sumsFor(auth.businessId, period),
      this.expenseScheduleFor(auth.businessId, period),
      this.revenueScheduleFor(auth.businessId, period),
    ]);

    let pdf: Buffer;
    try {
      pdf = await renderStatementsPdf({
        businessName: auth.businessName,
        period,
        generatedAt: new Date(),
        ...buildAll(sums),
        expenseSchedule: schedule,
        revenueSchedule: revenue,
      });
    } catch (error) {
      /* The naira sign needs a font that carries it, and a deployment
       * missing one should say so rather than hand over a document with a
       * box where every amount used to be. */
      if (error instanceof FontsMissing) {
        throw new ServiceUnavailableException('document fonts are not installed on this server');
      }
      throw error;
    }

    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="rekoda-statements-${period}.pdf"`)
      .header('cache-control', 'no-store')
      .send(pdf);
  }

  /**
   * The same four statements as a workbook, one sheet each.
   *
   * The PDF is for somebody who will read it; this is for somebody who will
   * work with it. Every figure is a real number in a real cell, which is the
   * whole difference between a spreadsheet and a picture of one, and four
   * tabs in one file is what a CSV per statement cannot be.
   */
  @Get('statements.xlsx')
  async statementsXlsx(
    @Req() request: AuthedRequest,
    @Res() reply: FileReply,
    @Query('period') periodParam?: string,
  ): Promise<void> {
    const period = requirePeriod(periodParam);
    const auth = request.auth!;
    const [sums, schedule, revenue] = await Promise.all([
      this.sumsFor(auth.businessId, period),
      this.expenseScheduleFor(auth.businessId, period),
      this.revenueScheduleFor(auth.businessId, period),
    ]);

    const book = buildXlsx(
      statementSheets({
        businessName: auth.businessName,
        period,
        generatedAt: new Date(),
        expenseSchedule: schedule,
        revenueSchedule: revenue,
        ...buildAll(sums),
      }),
    );

    void reply
      .header('content-type', XLSX_TYPE)
      .header('content-disposition', `attachment; filename="rekoda-statements-${period}.xlsx"`)
      .header('cache-control', 'no-store')
      .send(Buffer.from(book));
  }

  /**
   * The operating expense breakdown, already labelled.
   *
   * Shared by the JSON, the PDF and the workbook so all three carry the same
   * schedule: three call sites assembling it separately is how the file a
   * merchant sends their bank stops agreeing with the page they read it on.
   */
  private async revenueScheduleFor(businessId: string, period: string) {
    const schedule = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.revenueScheduleFor(tx, businessId, period),
    );
    return {
      lines: schedule.lines.map((line) => ({
        source: line.source,
        label: line.source === null ? UNATTRIBUTED_SALE_LABEL : SALE_SOURCE_LABELS[line.source],
        amountK: line.amountK,
      })),
      totalK: schedule.totalK,
    };
  }

  private async expenseScheduleFor(businessId: string, period: string) {
    const schedule = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.expenseScheduleFor(tx, businessId, period),
    );
    return {
      lines: schedule.lines.map((line) => ({
        category: line.category,
        label: EXPENSE_CATEGORY_LABELS[line.category],
        amountK: line.amountK,
      })),
      totalK: schedule.totalK,
    };
  }

  /** Per-account sums for one month, with any account the chart does not know
   * dropped. An unknown key means a write path bypassed the posting builders,
   * and the trial balance's own `balanced` flag is what exposes the damage. */
  private async sumsFor(businessId: string, period: string): Promise<AccountSums[]> {
    const rows = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.accountSumsFor(tx, businessId, period),
    );
    return rows
      .filter((r) => isAccountKey(r.account))
      .map((r) => ({
        account: r.account as AccountSums['account'],
        periodDebitK: r.periodDebitK,
        periodCreditK: r.periodCreditK,
        cumulativeDebitK: r.cumulativeDebitK,
        cumulativeCreditK: r.cumulativeCreditK,
      }));
  }

  /** The invoice register — numbers and figures only, never a customer name. */
  /**
   * Withdraw an invoice that was issued and should not have been.
   *
   * A POST on the reports surface because this is where the register lives,
   * and the register is where a merchant is looking when they notice. The
   * write itself is `voidInvoice`, which reverses the posting rather than
   * editing anything: this controller decides who may ask, as every other
   * method here does, and decides nothing else.
   */
  @Post('invoices/void')
  @HttpCode(200)
  async voidInvoice(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<VoidInvoiceResponse> {
    const parsed = voidInvoiceRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('invoiceNumber and a reason of at least 4 characters');
    }
    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      issueRepo.voidInvoice(
        tx,
        businessId,
        parsed.data.invoiceNumber,
        parsed.data.reason,
        `user:${request.auth!.userId}`,
      ),
    );
  }

  /**
   * Credit an invoice money has already arrived against.
   *
   * The other half of the pair the void opens. A merchant refused by the void
   * because a customer has paid is sent here, and a merchant refused here
   * because nothing was paid is sent back to the void. Neither refusal is a
   * dead end any more, which is the whole reason this exists.
   */
  @Post('invoices/credit')
  @HttpCode(200)
  async creditInvoice(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<CreditInvoiceResponse> {
    const parsed = creditInvoiceRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        'invoiceNumber, a positive amount in kobo, and a reason of at least 4 characters',
      );
    }
    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      issueRepo.issueCreditNote(tx, {
        businessId,
        invoiceNumber: parsed.data.invoiceNumber,
        amountK: parsed.data.amountK,
        reason: parsed.data.reason,
        actor: `user:${request.auth!.userId}`,
      }),
    );
  }

  @Get('invoices')
  async invoices(@Req() request: AuthedRequest): Promise<ReportsInvoicesResponse> {
    const businessId = request.auth!.businessId;
    const now = new Date();
    const { list, orders } = await withBusiness(this.db, businessId, async (tx) => ({
      list: await reportsRepo.invoicesFor(tx, businessId, REGISTER_ROWS),
      orders: await ordersRepo.ordersFor(tx, businessId, REGISTER_ROWS),
    }));
    return {
      invoices: list.rows.map((r) => ({
        invoiceNumber: r.invoiceNumber,
        status: r.status,
        dueDate: r.dueDate?.toISOString() ?? null,
        daysOverdue: daysOverdue(r.dueDate, r.balanceDueK, now),
        totalK: r.totalK,
        paidK: r.paidK,
        balanceDueK: r.balanceDueK,
        creditedK: r.creditedK,
        issuedAt: r.issuedAt.toISOString(),
      })),
      count: list.count,
      outstandingK: list.outstandingK,
      orders: orders.map((order) => ({
        orderNumber: order.orderNumber,
        status: order.status,
        totalK: order.totalK,
        itemCount: order.itemCount,
        invoiceNumber: order.invoiceNumber,
        placedAt: order.placedAt.toISOString(),
      })),
    };
  }

  /** The receipt register. Every row exists because real money was recorded. */
  @Get('receipts')
  async receipts(@Req() request: AuthedRequest): Promise<ReportsReceiptsResponse> {
    const businessId = request.auth!.businessId;
    const list = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.receiptsFor(tx, businessId, REGISTER_ROWS),
    );
    return {
      receipts: list.rows.map((r) => ({
        receiptNumber: r.receiptNumber,
        amountK: r.amountK,
        issuedAt: r.issuedAt.toISOString(),
        invoiceNumber: r.invoiceNumber,
        verified: r.verified === 1 ? (1 as const) : (0 as const),
      })),
      count: list.count,
    };
  }

  /**
   * The audit trail: every recorded change, and who made it.
   *
   * `audit_events` has been written since M1 by five repos and read by
   * nothing. This is the surface an accountant or a tax officer asks for by
   * name, and QuickBooks calls it the Audit Log for the same reason: it is a
   * record of CHANGES, not a feed of business events. The overview's activity
   * strip answers "what happened to my money"; this answers "who did that,
   * and why".
   *
   * Actors are resolved to a role and a phone tail rather than left as
   * `user:<uuid>`. Rekoda stores no names, and two accountants both rendered
   * "Accountant" would defeat the one question the page exists to answer.
   * A member who has since been removed keeps their raw actor, because an id
   * support can look up beats "somebody".
   */
  @Get('audit')
  async audit(@Req() request: AuthedRequest): Promise<ReportsAuditResponse> {
    const businessId = request.auth!.businessId;
    const { list, members } = await withBusiness(this.db, businessId, async (tx) => ({
      list: await reportsRepo.auditFor(tx, businessId, AUDIT_ROWS),
      members: await identity.membersOf(tx, businessId),
    }));

    const label = new Map(
      members.map((m) => [m.userId, `${roleWord(m.role)} ${m.phone.slice(-4)}`]),
    );
    return {
      events: list.rows.map((row) => {
        const { summary, amountK } = describeAuditEvent(row);
        return {
          id: row.id,
          at: row.at.toISOString(),
          actor: describeActor(row.actor, (userId) => label.get(userId)),
          entity: row.entity,
          action: row.action,
          summary,
          amountK,
          reason: row.reason,
          source: row.sourceType,
        };
      }),
      count: list.count,
    };
  }

  /**
   * The spend register.
   *
   * Money in has had two registers since M2 and money out had none, which is
   * half a set of books. Expenses and stock purchases share the page because
   * they share the merchant's question — where did it go — and stay labelled
   * apart because they do not share an answer.
   */
  /**
   * Withdraw a spend entry that should not have been recorded.
   *
   * On the reports surface for the same reason the invoice void is: the
   * register is where a merchant is looking when they notice. `voidExpense`
   * reverses the posting that was written rather than editing anything, and
   * this controller decides who may ask and nothing else.
   */
  @Post('expenses/void')
  @HttpCode(200)
  async voidExpense(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<VoidExpenseResponse> {
    const parsed = voidExpenseRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('expenseId and a reason of at least 4 characters');
    }
    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      spendRepo.voidExpense(
        tx,
        businessId,
        parsed.data.expenseId,
        parsed.data.reason,
        `user:${request.auth!.userId}`,
      ),
    );
  }

  @Get('expenses')
  async expenses(@Req() request: AuthedRequest): Promise<ReportsExpensesResponse> {
    const businessId = request.auth!.businessId;
    const now = new Date();
    const { list, payableAgeing, recurring } = await withBusiness(
      this.db,
      businessId,
      async (tx) => ({
        list: await spendRepo.spendFor(tx, businessId, REGISTER_ROWS),
        payableAgeing: await spendRepo.payableAgeingFor(tx, businessId, now),
        recurring: await recurringRepo.schedulesFor(tx, businessId),
      }),
    );
    return {
      entries: list.rows.map((r) => ({
        description: r.description,
        category: r.category,
        amountK: r.amountK,
        method: r.method,
        kind: r.kind,
        status: r.status,
        sourceType: r.sourceType,
        id: r.id,
        recordedAt: r.recordedAt.toISOString(),
      })),
      count: list.count,
      expensesK: list.expensesK,
      purchasesK: list.purchasesK,
      payableK: list.payableK,
      payableAgeing,
      recurring,
    };
  }

  /**
   * Open the books: what the business was already holding.
   *
   * The only write on this surface that records something which was already
   * true rather than something that happened, and the reason it exists is
   * visible on the balance sheet directly above the control. Owner's equity
   * has been in the chart since ADR 0004 with nothing ever posted to it, so a
   * merchant who joined with money in the till and spent from it reads a
   * negative cash balance: arithmetic that balances and describes a business
   * that has never existed.
   *
   * Once only, and the database is what says so. Two requests arriving
   * together both read no opening entry and both post; only the partial
   * unique index decides, and the outcome here is a classification of its
   * refusal rather than a check this method is trusted to make.
   */
  @Post('opening-balances')
  @HttpCode(200)
  async openBooks(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<OpeningBalancesResponse> {
    const parsed = openingBalancesRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('a day, and what was in cash, in the bank and on the shelf');
    }
    const { asAt, cashK, bankK, stockK } = parsed.data;
    if (cashK + bankK + stockK === 0) return { outcome: 'nothing_to_open' };
    /* A balance dated tomorrow is a typo, and one accepted would sit outside
     * every period the merchant can look at until the day arrives. */
    if (asAt > lagosDay(new Date())) return { outcome: 'not_yet' };

    const businessId = request.auth!.businessId;
    try {
      const recorded = await withBusiness(this.db, businessId, (tx) =>
        openingRepo.recordOpeningBalances(tx, {
          businessId,
          asAt,
          cashK,
          bankK,
          stockK,
          actor: `user:${request.auth!.userId}`,
        }),
      );
      return { outcome: 'recorded', asAt, equityK: recorded.equityK };
    } catch (error) {
      /* Classified OUTSIDE the transaction, which is the point of the throw:
       * a unique violation aborts the transaction, so returning an outcome
       * from inside it would fail at the commit with no context left. */
      if (error instanceof openingRepo.OpeningBalancesAlreadySet) {
        return { outcome: 'already_set' };
      }
      /* Nothing was written before this threw, so the transaction rolled back
       * clean and the outcome can be returned rather than raised. */
      if (error instanceof closeRepo.PeriodClosed) {
        return { outcome: 'period_closed', closedThrough: error.closedThrough };
      }
      throw error;
    }
  }

  /**
   * Count the shelf, and settle the difference.
   *
   * The instrument for the one drift the books cannot correct on their own.
   * Stock bought in prose — "restocked, 50k" — debits INVENTORY against no
   * product, and nothing credits it back when those goods sell, because cost
   * of sale only reaches the ledger through a product carrying a cost. So the
   * figure climbs and never comes down.
   *
   * Nothing here is computed from what the browser sent. The request carries
   * a day; the count and the ledger balance are both read inside the writing
   * transaction, because an adjustment derived from a figure rendered minutes
   * ago is the same quiet misstatement in a new place.
   *
   * Refused outright while any product holds stock with no cost recorded. The
   * count would be short by an unknown amount, and posting it would write off
   * goods the business still has.
   */
  @Post('stock-count')
  @HttpCode(200)
  async countStock(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<StockCountResponse> {
    const parsed = stockCountRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the day you counted');
    const { countedOn } = parsed.data;
    /* A count dated tomorrow has not happened. */
    if (countedOn > lagosDay(new Date())) return { outcome: 'not_yet' };

    const businessId = request.auth!.businessId;
    const result = await withBusiness(this.db, businessId, (tx) =>
      stocktakeRepo.recordStockCount(tx, {
        businessId,
        countedOn,
        actor: `user:${request.auth!.userId}`,
      }),
    );
    if (result.outcome === 'adjusted') {
      return {
        outcome: 'adjusted',
        differenceK: result.differenceK,
        countedK: result.countedK,
      };
    }
    return result;
  }

  /**
   * A correction written by hand.
   *
   * Every other posting on this surface is derived from a business event, and
   * that is why the books have stayed right without the merchant having to be
   * an accountant. This is the escape hatch for what no write path produces:
   * money carried from the till to the bank, an amount that went to the wrong
   * account, an owner putting their own money in.
   *
   * One amount between two of the fixed ten, so there is no arrangement of
   * the request that fails to balance. A genuine multi-line journal is not
   * expressible here, deliberately: a free journal is a loaded gun pointed at
   * the one property this product sells.
   */
  @Post('journal')
  @HttpCode(200)
  async recordJournal(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<JournalEntryResponse> {
    const parsed = journalEntryRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('an amount, two accounts and a reason');
    }
    const { memo, amountK, intoAccount, outOfAccount, occurredOn } = parsed.data;
    if (intoAccount === outOfAccount) return { outcome: 'same_account' };
    /* A correction dated tomorrow is a plan, and one accepted would sit
     * outside every period the merchant can look at until the day arrives. */
    if (occurredOn !== undefined && occurredOn > lagosDay(new Date())) {
      return { outcome: 'not_yet' };
    }

    const businessId = request.auth!.businessId;
    try {
      const recorded = await withBusiness(this.db, businessId, (tx) =>
        journalRepo.recordJournal(tx, {
          businessId,
          memo,
          amountK,
          intoAccount,
          outOfAccount,
          ...(occurredOn === undefined ? {} : { occurredAt: lagosNoon(occurredOn) }),
          actor: `user:${request.auth!.userId}`,
        }),
      );
      return { outcome: 'recorded', journalNumber: recorded.journalNumber };
    } catch (error) {
      /* Nothing was written before this threw, so the transaction rolled back
       * clean and the refusal can be returned rather than raised. */
      if (error instanceof closeRepo.PeriodClosed) {
        return { outcome: 'period_closed', closedThrough: error.closedThrough };
      }
      throw error;
    }
  }

  /**
   * Close a month, so a statement somebody already sent cannot change.
   *
   * The four statements are a file a merchant hands to a bank or a landlord.
   * Until this existed, a posting could land in a month that had already been
   * reported: an expense carries the day it was paid, a recurring entry the
   * day it fell due, and opening balances the merchant's own date. September
   * could change in October and neither copy would say so.
   *
   * The refusal itself is a trigger on the ledger (migration 0034) rather
   * than a check any writer is trusted to make. This endpoint only moves the
   * watermark; nothing downstream has to remember it exists.
   */
  @Post('close')
  @HttpCode(200)
  async closeBooks(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<CloseBooksResponse> {
    const parsed = closeBooksRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the month to close through');

    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      closeRepo.closeBooks(tx, {
        businessId,
        through: parsed.data.through,
        actor: `user:${request.auth!.userId}`,
      }),
    );
  }

  /**
   * Open a closed month back up, and record that it happened.
   *
   * Never refused. A merchant who has to correct a filed month must be able
   * to, and a lock with no key is a support ticket rather than a control.
   * What it is not is quiet: this lands in the audit trail beside the close
   * it undoes, which is the honest version of the trade.
   */
  @Post('reopen')
  @HttpCode(200)
  async reopenBooks(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ReopenBooksResponse> {
    const parsed = reopenBooksRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the month to reopen from');

    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      closeRepo.reopenBooks(tx, {
        businessId,
        from: parsed.data.from,
        actor: `user:${request.auth!.userId}`,
      }),
    );
  }

  /**
   * Tell Rekoda about a cost that arrives every month.
   *
   * The first entry is the NEXT time the anchor comes round, never today.
   * A merchant setting up "rent, the 1st" on the 1st has almost certainly
   * already paid this month's and may well have dictated it, and a schedule
   * whose first act is to record a cost twice is a schedule nobody sets up
   * a second time.
   */
  @Post('expenses/recurring')
  @HttpCode(200)
  async createRecurring(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<CreateRecurringResponse> {
    const parsed = createRecurringRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('a description, an amount, a method and a day of the month');
    }
    /* `stock` is the marker `recordPurchase` writes and the register splits
     * on. A schedule wearing it would put a monthly figure into the stock
     * total with no delivery behind it, and the shelf count would disagree
     * with the books every month forever. */
    if (parsed.data.category?.toLowerCase() === 'stock') {
      return { outcome: 'not_stock' };
    }

    const businessId = request.auth!.businessId;
    const firstDueOn = nextDueAfter(lagosDay(new Date()), parsed.data.anchorDay);
    const id = await withBusiness(this.db, businessId, (tx) =>
      recurringRepo.createSchedule(tx, {
        businessId,
        description: parsed.data.description,
        category: parsed.data.category,
        amountK: parsed.data.amountK,
        method: parsed.data.method,
        anchorDay: parsed.data.anchorDay,
        firstDueOn,
      }),
    );
    return { outcome: 'created', id, firstDueOn };
  }

  /** Stop a schedule. Never a delete: what it already raised is real. */
  @Post('expenses/recurring/stop')
  @HttpCode(200)
  async stopRecurring(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<StopRecurringResponse> {
    const parsed = stopRecurringRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the schedule to stop');
    const businessId = request.auth!.businessId;
    const outcome = await withBusiness(this.db, businessId, (tx) =>
      recurringRepo.stopSchedule(tx, businessId, parsed.data.id),
    );
    return { outcome };
  }

  /**
   * The books, as a file a spreadsheet opens.
   *
   * This is the answer to "what happens to my records if I leave", which
   * Nigerian merchants learned to ask the hard way. A product that cannot be
   * left has to be trusted blindly, and asking for that is worse than
   * earning it. Everything, not the page: see EXPORT_ROWS.
   */
  @Get('invoices.csv')
  async invoicesCsv(@Req() request: AuthedRequest, @Res() reply: CsvReply): Promise<void> {
    const businessId = request.auth!.businessId;
    const now = new Date();
    const list = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.invoicesFor(tx, businessId, EXPORT_ROWS),
    );
    const csv = toCsv(
      ['Invoice', 'Issued', 'Due', 'Status', 'Days late', 'Total', 'Paid', 'Credited', 'Balance'],
      list.rows.map((r) => [
        r.invoiceNumber,
        csvDate(r.issuedAt),
        csvDate(r.dueDate),
        r.status,
        daysOverdue(r.dueDate, r.balanceDueK, now),
        csvKobo(r.totalK),
        csvKobo(r.paidK),
        /* Without this column a spreadsheet reads a credited invoice as a
         * sale the merchant simply never collected. */
        csvKobo(r.creditedK),
        csvKobo(r.balanceDueK),
      ]),
    );
    sendCsv(reply, `rekoda-invoices-${csvDate(now)}.csv`, csv);
  }

  @Get('expenses.csv')
  async expensesCsv(@Req() request: AuthedRequest, @Res() reply: CsvReply): Promise<void> {
    const businessId = request.auth!.businessId;
    const list = await withBusiness(this.db, businessId, (tx) =>
      spendRepo.spendFor(tx, businessId, EXPORT_ROWS),
    );
    const csv = toCsv(
      ['Date', 'Type', 'Description', 'Category', 'Method', 'Source', 'Status', 'Amount'],
      list.rows.map((r) => [
        csvDate(r.recordedAt),
        /* The column that stops a spreadsheet totalling stock as cost. */
        r.kind === 'purchase' ? 'Stock purchase' : 'Expense',
        r.description,
        /* The label the statements print, not the key stored beside it. An
         * accountant pivoting this against the profit and loss should be
         * matching the same words in both, not learning our vocabulary. */
        categoryLabel(r.category),
        r.method,
        /* How it reached the books. An accountant reconciling a month wants
         * to know which lines nobody typed. */
        r.sourceType,
        /* And the column that stops it totalling what was withdrawn. */
        r.status,
        csvKobo(r.amountK),
      ]),
    );
    sendCsv(reply, `rekoda-expenses-${csvDate(new Date())}.csv`, csv);
  }

  @Get('receipts.csv')
  async receiptsCsv(@Req() request: AuthedRequest, @Res() reply: CsvReply): Promise<void> {
    const businessId = request.auth!.businessId;
    const list = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.receiptsFor(tx, businessId, EXPORT_ROWS),
    );
    const csv = toCsv(
      ['Receipt', 'Date', 'Invoice', 'Amount', 'Basis'],
      list.rows.map((r) => [
        r.receiptNumber,
        csvDate(r.issuedAt),
        r.invoiceNumber,
        csvKobo(r.amountK),
        /* ADR 0014 travels into the export too. A row that did not say which
         * of the two it was would let a spreadsheet total them as one thing. */
        r.verified === 1 ? 'verified' : 'recorded',
      ]),
    );
    sendCsv(reply, `rekoda-receipts-${csvDate(new Date())}.csv`, csv);
  }

  /**
   * The stock register.
   *
   * Lowest count first, same as the chat answer and for the same reason: the
   * row that needs the merchant is the one about to run out, and a list
   * sorted by name is a list somebody has to read all of.
   */
  @Get('stock')
  async stock(@Req() request: AuthedRequest): Promise<ReportsStockResponse> {
    const businessId = request.auth!.businessId;
    const products = await withBusiness(this.db, businessId, (tx) =>
      stockRepo.stockList(tx, businessId, STOCK_ROWS),
    );
    return {
      products: products.map((p) => ({
        name: p.name,
        onHand: p.onHand,
        unitCostK: p.unitCostK,
      })),
      outOfStock: products.filter((p) => p.onHand <= 0).length,
      /* The count that explains a profit and loss with no cost of sales on
       * it, rather than leaving a merchant to work out why. */
      withoutCost: products.filter((p) => p.unitCostK === null).length,
    };
  }

  @Get('activity')
  async activity(@Req() request: AuthedRequest): Promise<ReportsActivityResponse> {
    const businessId = request.auth!.businessId;
    const items = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.activityFor(tx, businessId, ACTIVITY_ROWS),
    );
    return {
      items: items.map((i) => ({
        kind: i.kind,
        label: i.label,
        amountK: i.amountK,
        at: i.at.toISOString(),
      })),
    };
  }
}

/**
 * Hand a file over, with the header that makes a browser save it.
 *
 * `attachment` and an explicit filename rather than letting the browser guess
 * from a URL: a merchant opening this on a phone should end up with something
 * named for what it is and when they took it, not `invoices.csv` for the
 * fourth time this month.
 */
function requirePeriod(period: string | undefined): string {
  const wanted = period ?? usagePeriod(new Date());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(wanted)) {
    throw new BadRequestException('period must look like 2026-08');
  }
  return wanted;
}

/** All four, from one set of sums, so the JSON and the PDF cannot disagree. */
function buildAll(sums: AccountSums[]) {
  return {
    trialBalance: buildTrialBalance(sums),
    profitAndLoss: buildProfitAndLoss(sums),
    balanceSheet: buildBalanceSheet(sums),
    cashflow: buildCashflowStatement(sums),
  };
}

function sendCsv(reply: CsvReply, filename: string, csv: string): void {
  void reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`)
    /* Never cached. This is a merchant's whole book, and a shared cache
     * holding it is a cross-tenant leak with a friendly name. */
    .header('cache-control', 'no-store')
    .send(csv);
}

/**
 * An expense category as a statement names it.
 *
 * Blank rather than "Uncategorised" when there is none: a CSV cell is data
 * somebody will group on, and a word invented here becomes a category in
 * their pivot table that does not exist in ours.
 */
function categoryLabel(category: string | null): string {
  if (category === null) return '';
  if (category === STOCK_CATEGORY) return 'Stock';
  return isExpenseCategory(category) ? EXPENSE_CATEGORY_LABELS[category] : category;
}

/** Roles in the words the team page already uses. */
function roleWord(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'accountant') return 'Accountant';
  if (role === 'delegate') return 'Delegate';
  return role;
}
