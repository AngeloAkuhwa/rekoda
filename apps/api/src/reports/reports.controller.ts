/**
 * The dashboard's numbers (MASTER-PLAN §5.3.7, ADR 0015).
 *
 * Thin on purpose: every figure is computed in SQL by the reports repo, and
 * this controller only decides WHO may read it. `businessId` comes from the
 * session, never from a body or query — same rule as the payments surface.
 * No model is anywhere in this path, and there is no arithmetic in this file
 * beyond none at all.
 */
import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { usagePeriod } from '@rekoda/core';
import type {
  ReportsActivityResponse,
  ReportsCashflowResponse,
  ReportsDebtorsResponse,
  ReportsOverviewResponse,
} from '@rekoda/contracts';
import { reportsRepo, withBusiness, type Db } from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { DB } from '../db/db.module.js';

const CASHFLOW_MONTHS = 6;
const DEBTOR_ROWS = 6;
const ACTIVITY_ROWS = 8;

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
