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
  isAccountKey,
  periodBefore,
  statementSheets,
  toCsv,
  usagePeriod,
  type AccountSums,
} from '@rekoda/core';
import { FontsMissing, renderStatementsPdf } from '../documents/pdf.js';
import type {
  ReportsActivityResponse,
  ReportsCashflowResponse,
  ReportsDebtorsResponse,
  ReportsExpensesResponse,
  ReportsInvoicesResponse,
  ReportsOverviewResponse,
  ReportsReceiptsResponse,
  ReportsStockResponse,
  ReportsStatementsResponse,
  VoidExpenseResponse,
  VoidInvoiceResponse,
} from '@rekoda/contracts';
import { voidExpenseRequest, voidInvoiceRequest } from '@rekoda/contracts';
import { issueRepo, reportsRepo, spendRepo, stockRepo, withBusiness, type Db } from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { DB } from '../db/db.module.js';

const CASHFLOW_MONTHS = 6;
const DEBTOR_ROWS = 6;
const ACTIVITY_ROWS = 8;
const REGISTER_ROWS = 50;
const STOCK_ROWS = 200;
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
    const [sums, priorSums] = await Promise.all([
      this.sumsFor(businessId, period),
      this.sumsFor(businessId, before),
    ]);

    const prior = buildProfitAndLoss(priorSums);
    return {
      period,
      ...buildAll(sums),
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
    const sums = await this.sumsFor(auth.businessId, period);

    let pdf: Buffer;
    try {
      pdf = await renderStatementsPdf({
        businessName: auth.businessName,
        period,
        generatedAt: new Date(),
        ...buildAll(sums),
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
    const sums = await this.sumsFor(auth.businessId, period);

    const book = buildXlsx(
      statementSheets({
        businessName: auth.businessName,
        period,
        generatedAt: new Date(),
        ...buildAll(sums),
      }),
    );

    void reply
      .header('content-type', XLSX_TYPE)
      .header('content-disposition', `attachment; filename="rekoda-statements-${period}.xlsx"`)
      .header('cache-control', 'no-store')
      .send(Buffer.from(book));
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

  @Get('invoices')
  async invoices(@Req() request: AuthedRequest): Promise<ReportsInvoicesResponse> {
    const businessId = request.auth!.businessId;
    const now = new Date();
    const list = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.invoicesFor(tx, businessId, REGISTER_ROWS),
    );
    return {
      invoices: list.rows.map((r) => ({
        invoiceNumber: r.invoiceNumber,
        status: r.status,
        dueDate: r.dueDate?.toISOString() ?? null,
        daysOverdue: daysOverdue(r.dueDate, r.balanceDueK, now),
        totalK: r.totalK,
        paidK: r.paidK,
        balanceDueK: r.balanceDueK,
        issuedAt: r.issuedAt.toISOString(),
      })),
      count: list.count,
      outstandingK: list.outstandingK,
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
    const list = await withBusiness(this.db, businessId, (tx) =>
      spendRepo.spendFor(tx, businessId, REGISTER_ROWS),
    );
    return {
      entries: list.rows.map((r) => ({
        description: r.description,
        category: r.category,
        amountK: r.amountK,
        method: r.method,
        kind: r.kind,
        status: r.status,
        id: r.id,
        recordedAt: r.recordedAt.toISOString(),
      })),
      count: list.count,
      expensesK: list.expensesK,
      purchasesK: list.purchasesK,
      payableK: list.payableK,
    };
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
      ['Invoice', 'Issued', 'Due', 'Status', 'Days late', 'Total', 'Paid', 'Balance'],
      list.rows.map((r) => [
        r.invoiceNumber,
        csvDate(r.issuedAt),
        csvDate(r.dueDate),
        r.status,
        daysOverdue(r.dueDate, r.balanceDueK, now),
        csvKobo(r.totalK),
        csvKobo(r.paidK),
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
      ['Date', 'Type', 'Description', 'Category', 'Method', 'Status', 'Amount'],
      list.rows.map((r) => [
        csvDate(r.recordedAt),
        /* The column that stops a spreadsheet totalling stock as cost. */
        r.kind === 'purchase' ? 'Stock purchase' : 'Expense',
        r.description,
        r.category ?? '',
        r.method,
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
      products: products.map((p) => ({ name: p.name, onHand: p.onHand })),
      outOfStock: products.filter((p) => p.onHand <= 0).length,
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
