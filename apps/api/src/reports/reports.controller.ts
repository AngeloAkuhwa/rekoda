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
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
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
import {
  buildBalanceSheet,
  buildCashflowStatement,
  buildProfitAndLoss,
  buildTrialBalance,
  csvDate,
  csvKobo,
  daysOverdue,
  isAccountKey,
  toCsv,
  usagePeriod,
  type AccountSums,
} from '@rekoda/core';
import type {
  ReportsActivityResponse,
  ReportsCashflowResponse,
  ReportsDebtorsResponse,
  ReportsInvoicesResponse,
  ReportsOverviewResponse,
  ReportsReceiptsResponse,
  ReportsStatementsResponse,
} from '@rekoda/contracts';
import { reportsRepo, withBusiness, type Db } from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { DB } from '../db/db.module.js';

const CASHFLOW_MONTHS = 6;
const DEBTOR_ROWS = 6;
const ACTIVITY_ROWS = 8;
const REGISTER_ROWS = 50;
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
    const period = periodParam ?? usagePeriod(new Date());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new BadRequestException('period must look like 2026-08');
    }

    const businessId = request.auth!.businessId;
    const rows = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.accountSumsFor(tx, businessId, period),
    );
    const sums: AccountSums[] = rows
      .filter((r) => isAccountKey(r.account))
      .map((r) => ({
        account: r.account as AccountSums['account'],
        periodDebitK: r.periodDebitK,
        periodCreditK: r.periodCreditK,
        cumulativeDebitK: r.cumulativeDebitK,
        cumulativeCreditK: r.cumulativeCreditK,
      }));

    return {
      period,
      trialBalance: buildTrialBalance(sums),
      profitAndLoss: buildProfitAndLoss(sums),
      balanceSheet: buildBalanceSheet(sums),
      cashflow: buildCashflowStatement(sums),
    };
  }

  /** The invoice register — numbers and figures only, never a customer name. */
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
function sendCsv(reply: CsvReply, filename: string, csv: string): void {
  void reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}"`)
    /* Never cached. This is a merchant's whole book, and a shared cache
     * holding it is a cross-tenant leak with a friendly name. */
    .header('cache-control', 'no-store')
    .send(csv);
}
