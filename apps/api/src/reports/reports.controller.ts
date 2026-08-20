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
  UseGuards,
} from '@nestjs/common';
import {
  buildBalanceSheet,
  buildCashflowStatement,
  buildProfitAndLoss,
  buildTrialBalance,
  isAccountKey,
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

@Controller('v1/reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('overview')
  async overview(@Req() request: AuthedRequest): Promise<ReportsOverviewResponse> {
    const businessId = request.auth!.businessId;
    const overview = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.overviewFor(tx, businessId),
    );
    return { period: usagePeriod(new Date()), ...overview };
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
    const debtors = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.debtorsFor(tx, businessId, DEBTOR_ROWS),
    );
    return {
      rows: debtors.rows.map((r) => ({
        invoiceNumber: r.invoiceNumber,
        balanceDueK: r.balanceDueK,
        issuedAt: r.issuedAt.toISOString(),
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
    const list = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.invoicesFor(tx, businessId, REGISTER_ROWS),
    );
    return {
      invoices: list.rows.map((r) => ({
        invoiceNumber: r.invoiceNumber,
        status: r.status,
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
      })),
      count: list.count,
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
