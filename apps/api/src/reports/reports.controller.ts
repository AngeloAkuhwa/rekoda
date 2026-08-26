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
  postCostOfSale,
  allowanceFor,
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
  type CancelPurchaseOrderResponse,
  type CancelQuoteResponse,
  type ConvertQuoteResponse,
  type CreatePurchaseOrderResponse,
  type CreateQuoteResponse,
  type ReceivePurchaseOrderResponse,
  cancelPurchaseOrderRequest,
  cancelQuoteRequest,
  convertQuoteRequest,
  createPurchaseOrderRequest,
  createQuoteRequest,
  receivePurchaseOrderRequest,
  createRecurringRequest,
  openingBalancesRequest,
  stockCountRequest,
  closeBooksRequest,
  journalEntryRequest,
  paySupplierRequest,
  disposeAssetRequest,
  recordAssetRequest,
  withdrawAssetRequest,
  type DisposeAssetResponse,
  type RecordAssetResponse,
  type WithdrawAssetResponse,
  recordPaymentRequest,
  type RecordPaymentResponse,
  type PaySupplierResponse,
  reopenBooksRequest,
  creditInvoiceRequest,
  stopRecurringRequest,
  voidExpenseRequest,
  voidInvoiceRequest,
} from '@rekoda/contracts';
import {
  usageRepo,
  identity,
  assetsRepo,
  issueRepo,
  jobsRepo,
  ordersRepo,
  openingRepo,
  stocktakeRepo,
  closeRepo,
  journalRepo,
  recurringRepo,
  reportsRepo,
  settleRepo,
  spendRepo,
  stockRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { CONFIG, type ApiConfig } from '../config.js';
import { CommandBus } from '../commands/command-bus.service.js';
import {
  issueInvoiceWork,
  QuoteAlreadyTaken,
  type IssueInvoiceInput,
  type IssuedInvoice,
} from '../commands/sale-commands.js';
import { recordPaymentWork, type RecordPaymentInput } from '../commands/payment-commands.js';
import { recordPurchaseWork, type RecordPurchaseCmdInput } from '../commands/spend-commands.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import { DB } from '../db/db.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';

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

/**
 * A page number from a query string. One-based because merchants count from
 * one; anything unparseable is page one, because a mangled link should show
 * the register, not an error.
 */
function pageOffset(raw: string | undefined): { page: number; offset: number } {
  const parsed = Number.parseInt(raw ?? '1', 10);
  const page = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 10_000) : 1;
  return { page, offset: (page - 1) * REGISTER_ROWS };
}

/**
 * A 23505 on the named one-shot-key constraint: this clientRef already
 * booked. Every write a dashboard form can repeat carries such a key, and
 * the database is the only judge; this merely classifies its refusal.
 */
function isDuplicateOn(error: unknown, constraint: string): boolean {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const pg = cause as { code?: string; constraint_name?: string; constraint?: string };
  return pg?.code === '23505' && (pg.constraint_name ?? pg.constraint ?? '').includes(constraint);
}

function isDuplicateClientRef(error: unknown): boolean {
  return isDuplicateOn(error, 'payments_rekoda_reference');
}

@Controller('v1/reports')
@UseGuards(SessionGuard, RolesGuard)
export class ReportsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
    private readonly gateway: PrivacyGateway,
    private readonly commandBus: CommandBus,
  ) {}

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
  async debtors(
    @Req() request: AuthedRequest,
    @Query('full') full?: string,
  ): Promise<ReportsDebtorsResponse> {
    const businessId = request.auth!.businessId;
    const now = new Date();
    /* Six rows is the overview's strip; the debtors PAGE asks for the whole
     * register, capped where the contract caps it. */
    const debtors = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.debtorsFor(tx, businessId, full === '1' ? REGISTER_ROWS : DEBTOR_ROWS),
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
  /* The write matrix (spec §35): owners do everything; delegates record
   day-to-day trade (payments, supplier settlements, stock counts);
   accountants read and export only. Voids, credits, capital moves,
   opening balances, journals, closes and standing orders are the
   owner's alone, because each one rewrites the story the books tell. */
  @Post('invoices/void')
  @Roles('owner')
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
  @Roles('owner')
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
    try {
      return await withBusiness(this.db, businessId, (tx) =>
        issueRepo.issueCreditNote(tx, {
          businessId,
          invoiceNumber: parsed.data.invoiceNumber,
          amountK: parsed.data.amountK,
          reason: parsed.data.reason,
          actor: `user:${request.auth!.userId}`,
          clientRef: parsed.data.clientRef ?? null,
        }),
      );
    } catch (error) {
      /* Caught OUT here because the unique violation aborted the transaction
       * it happened in — same shape as every one-shot key on this surface. */
      if (isDuplicateOn(error, 'credit_notes_client_ref')) return { outcome: 'duplicate' };
      throw error;
    }
  }

  /**
   * A payment the merchant is reporting, from the dashboard.
   *
   * This existed only on WhatsApp: a merchant looking at their own bank
   * statement on the Bank page, at a transfer their books do not explain,
   * had to open WhatsApp and type a message to record it. The books were
   * reachable from the dashboard in every direction except the one that
   * mattered most.
   *
   * RECORDED, never VERIFIED (ADR 0014). Nobody confirmed this with a
   * provider, and letting merchant testimony wear the verified badge would
   * destroy the one distinction this product sells.
   */
  @Post('payments/record')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async recordPayment(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<RecordPaymentResponse> {
    const parsed = recordPaymentRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('invoiceNumber, a positive amount in kobo, and a method');
    }
    const businessId = request.auth!.businessId;
    const input: RecordPaymentInput = {
      businessId,
      invoice: { number: parsed.data.invoiceNumber },
      amountK: parsed.data.amountK,
      method: parsed.data.method,
      sourceType: 'dashboard',
      sourceId: parsed.data.invoiceNumber,
      actor: `user:${request.auth!.userId}`,
      clientRef: parsed.data.clientRef ?? null,
      /* A form, not a message (spec E.7). */
      evidenceBasis: 'NOT_A_MESSAGE',
    };
    let outcome: Awaited<ReturnType<typeof recordPaymentWork>>;
    try {
      outcome = await withBusiness(this.db, businessId, async (tx) => {
        /* The A1 rollout seam (spec §25): the work books the payment,
         * enqueues the receipt's paper and announces it; the flag decides
         * whether the bus's gates wrap the call. */
        if (this.config.commandRecordPayment) {
          const run = await this.commandBus.run(
            tx,
            {
              businessId,
              command: 'RecordPayment',
              payload: input,
              actor: input.actor,
              ingress: 'DASHBOARD',
              /* The form's one-shot key, when the form brought one. Absent
               * means the caller accepts a retry may run again — the same
               * honesty the clientRef-less path always had. */
              idempotencyKey: input.clientRef ? `payrec:${input.clientRef}` : null,
            },
            () => recordPaymentWork(tx, input),
          );
          if (run.outcome !== 'done') {
            throw new Error(`RecordPayment refused unexpectedly: ${run.outcome}`);
          }
          return run.result;
        }
        return recordPaymentWork(tx, input);
      });
    } catch (error) {
      /* The clientRef met payments_rekoda_reference_ux: this exact form was
       * submitted before and its payment is already booked. Caught OUT here
       * because the unique violation aborted the transaction it happened in. */
      if (isDuplicateClientRef(error)) return { outcome: 'duplicate' };
      throw error;
    }

    /* `receiptId` is an internal handle and stays here: the merchant is
     * given the receipt NUMBER, which is what a receipt is known by. */
    return outcome.outcome === 'recorded'
      ? {
          outcome: 'recorded',
          receiptNumber: outcome.receiptNumber,
          invoiceNumber: outcome.invoiceNumber,
          amountK: outcome.amountK,
          balanceDueK: outcome.balanceDueK,
        }
      : outcome;
  }

  @Get('invoices')
  async invoices(
    @Req() request: AuthedRequest,
    @Query('page') pageParam?: string,
  ): Promise<ReportsInvoicesResponse> {
    const businessId = request.auth!.businessId;
    const now = new Date();
    /* Only the invoice register pages; the orders and quotes beside it are
     * small and stay whole. */
    const { offset } = pageOffset(pageParam);
    const { list, orders, quotes } = await withBusiness(this.db, businessId, async (tx) => ({
      list: await reportsRepo.invoicesFor(tx, businessId, REGISTER_ROWS, offset),
      orders: await ordersRepo.ordersFor(tx, businessId, REGISTER_ROWS),
      quotes: await ordersRepo.quotesFor(tx, businessId, REGISTER_ROWS),
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
      /* From SQL over the whole table. The invoice register above says what
       * it left out; this list said nothing at all. */
      ordersTotal: orders.count,
      orders: orders.rows.map((order) => ({
        orderNumber: order.orderNumber,
        status: order.status,
        totalK: order.totalK,
        itemCount: order.itemCount,
        invoiceNumber: order.invoiceNumber,
        placedAt: order.placedAt.toISOString(),
      })),
      quotesTotal: quotes.count,
      quotes: quotes.rows.map((q) => ({
        quoteNumber: q.quoteNumber,
        status: q.status,
        totalK: q.totalK,
        itemCount: q.itemCount,
        validUntil: q.validUntil,
        invoiceNumber: q.invoiceNumber,
        createdAt: q.createdAt.toISOString(),
      })),
    };
  }

  /**
   * A quote: an order-shaped OFFER the merchant sends first (fix-plan 4, G3).
   *
   * Nothing posts and no stock moves — an offer is not an obligation, which
   * is why creating one costs no document unit either. The customer name,
   * when given, takes the same road a chat mention takes (vault + token), so
   * quotes never become the door around the privacy gateway.
   */
  @Post('quotes')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async createQuote(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<CreateQuoteResponse> {
    const parsed = createQuoteRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('one to twenty lines, each with a name, quantity and price');
    }
    const businessId = request.auth!.businessId;

    /* Token AND id: the id anchors the quote row, the token becomes the
     * "Prepared for" line on the PDF — the same non-identity label invoices
     * print, carried in the render payload because quotes keep no snapshot. */
    const mention = parsed.data.customerName
      ? await this.gateway.resolveMention(businessId, parsed.data.customerName)
      : null;
    const customerId = mention?.customerId ?? null;

    const lines = parsed.data.items.map((item) => ({
      productId: null,
      name: item.name,
      quantity: item.quantity,
      unitPriceK: item.unitPriceK,
      lineTotalK: item.quantity * item.unitPriceK,
    }));
    const totalK = lines.reduce((n, line) => n + line.lineTotalK, 0);

    try {
      const created = await withBusiness(this.db, businessId, async (tx) => {
        const quote = await ordersRepo.createQuote(tx, {
          businessId,
          customerId,
          lines,
          totalK,
          validUntil: parsed.data.validUntil ?? null,
          clientRef: parsed.data.clientRef ?? null,
          sourceId: `user:${request.auth!.userId}`,
        });
        /* The paper, on the same render → deliver chain invoices ride, and
         * enqueued INSIDE this transaction so a quote and "someone will send
         * its PDF" are one fact. Free like the quote itself: an offer costs
         * no document unit (ADR 0024). */
        await jobsRepo.enqueue(tx, {
          businessId,
          kind: 'document.render',
          payload: { quoteId: quote.id, ...(mention ? { customerToken: mention.token } : {}) },
          singletonKey: `render:quote:${quote.id}`,
        });
        return quote;
      });
      return {
        outcome: 'created',
        quoteNumber: created.orderNumber,
        totalK,
        validUntil: parsed.data.validUntil ?? null,
      };
    } catch (error) {
      if (isDuplicateOn(error, 'orders_external')) return { outcome: 'duplicate' };
      throw error;
    }
  }

  /**
   * Accepting a quote is issuing the invoice it promised, on the exact path
   * a confirmed chat order takes: invoice, stock movements, cost of goods,
   * render, payable link. The status machine is the idempotency: a second
   * click meets `quoted -> confirmed` already taken and is handed the
   * invoice the first click made.
   */
  @Post('quotes/convert')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async convertQuote(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ConvertQuoteResponse> {
    const parsed = convertQuoteRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the quote number');
    const businessId = request.auth!.businessId;
    const quoteNumber = parsed.data.quoteNumber.toUpperCase();

    const quote = await withBusiness(this.db, businessId, (tx) =>
      ordersRepo.quoteByNumber(tx, businessId, quoteNumber),
    );
    if (!quote || !quoteNumber.startsWith('QUO-')) return { outcome: 'not_found' };
    if (quote.status === 'confirmed') {
      return { outcome: 'already_converted', invoiceNumber: quote.invoiceNumber };
    }
    if (quote.status !== 'quoted') return { outcome: 'cancelled' };
    if (quote.validUntil && quote.validUntil < lagosDay(new Date())) {
      return { outcome: 'expired', validUntil: quote.validUntil };
    }

    /* The invoice costs a document unit, exactly as the chat "yes" pays it.
     * Its own short transaction, refunded on every path that issues nothing. */
    const period = usagePeriod(new Date());
    const plan = await withBusiness(this.db, businessId, (tx) => usageRepo.planFor(tx, businessId));
    const allowance = allowanceFor(plan, 'DOCUMENT_GENERATION');
    const granted = await withBusiness(this.db, businessId, (own) =>
      usageRepo.consumeUnit(own, businessId, period, 'DOCUMENT_GENERATION', allowance),
    );
    if (!granted) return { outcome: 'exhausted', allowance };

    try {
      return await withBusiness(this.db, businessId, async (tx) => {
        const input: IssueInvoiceInput = {
          businessId,
          quoteId: quote.id,
          customerId: quote.customerId,
          items: quote.lines.map((line) => ({
            name: line.name,
            quantity: line.quantity,
            unitPriceK: line.unitPriceK,
          })),
          totalK: quote.totalK,
          dueDate: quote.validUntil ? lagosNoon(quote.validUntil) : null,
          actor: `user:${request.auth!.userId}`,
        };

        /* The A1 rollout seam (spec §25). Same work function either way —
         * the flag decides whether the command bus's gates run around it,
         * and off is exactly the path this endpoint always took. */
        let issued: IssuedInvoice;
        if (this.config.commandIssueInvoice) {
          const run = await this.commandBus.run(
            tx,
            {
              businessId,
              command: 'IssueInvoice',
              payload: input,
              actor: input.actor,
              ingress: 'DASHBOARD',
              /* One quote, one invoice: a retry that lost its response is
               * handed the first answer instead of a second conversion. */
              idempotencyKey: `quote-convert:${quote.id}`,
            },
            () => issueInvoiceWork(tx, input),
          );
          if (run.outcome !== 'done') {
            /* Unreachable by construction — IssueInvoice is STANDARD and
             * ungated — so reaching it is a bug worth a loud error rather
             * than a quiet wrong answer. */
            throw new Error(`IssueInvoice refused unexpectedly: ${run.outcome}`);
          }
          issued = run.result;
        } else {
          issued = await issueInvoiceWork(tx, input);
        }

        return {
          outcome: 'converted' as const,
          quoteNumber,
          invoiceNumber: issued.invoiceNumber,
          totalK: quote.totalK,
        };
      });
    } catch (error) {
      await withBusiness(this.db, businessId, (own) =>
        usageRepo.refundUnit(own, businessId, period, 'DOCUMENT_GENERATION'),
      );
      if (error instanceof QuoteAlreadyTaken) {
        const taken = await withBusiness(this.db, businessId, (tx) =>
          ordersRepo.quoteByNumber(tx, businessId, quoteNumber),
        );
        return { outcome: 'already_converted', invoiceNumber: taken?.invoiceNumber ?? null };
      }
      throw error;
    }
  }

  /** Withdraw an open quote. Never a delete: an offer made is a fact. */
  @Post('quotes/cancel')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async cancelQuote(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<CancelQuoteResponse> {
    const parsed = cancelQuoteRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the quote number');
    const businessId = request.auth!.businessId;
    const quoteNumber = parsed.data.quoteNumber.toUpperCase();

    return withBusiness(this.db, businessId, async (tx) => {
      const quote = await ordersRepo.quoteByNumber(tx, businessId, quoteNumber);
      if (!quote || !quoteNumber.startsWith('QUO-')) return { outcome: 'not_found' };
      if (quote.status !== 'quoted') return { outcome: 'already', status: quote.status };
      await ordersRepo.markOrder(tx, businessId, quote.id, 'quoted', 'cancelled');
      return { outcome: 'cancelled' };
    });
  }

  /**
   * A purchase order: the quote's mirror, pointing at a supplier (fix-plan
   * 4, G4). Creating one posts nothing, moves nothing and costs no unit: a
   * request for goods is not the goods. No supplier field anywhere on this
   * road, because Rekoda stores nothing about suppliers; the merchant's own
   * message carries the name, Rekoda carries the goods and the money.
   */
  @Post('purchase-orders')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async createPurchaseOrder(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<CreatePurchaseOrderResponse> {
    const parsed = createPurchaseOrderRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('one to twenty lines, each with a name, quantity and cost');
    }
    const businessId = request.auth!.businessId;

    const lines = parsed.data.items.map((item) => ({
      productId: null,
      name: item.name,
      quantity: item.quantity,
      unitPriceK: item.unitPriceK,
      lineTotalK: item.quantity * item.unitPriceK,
    }));
    const totalK = lines.reduce((n, line) => n + line.lineTotalK, 0);

    try {
      const created = await withBusiness(this.db, businessId, (tx) =>
        ordersRepo.createPurchaseOrder(tx, {
          businessId,
          lines,
          totalK,
          expectedOn: parsed.data.expectedOn ?? null,
          clientRef: parsed.data.clientRef ?? null,
          sourceId: `user:${request.auth!.userId}`,
        }),
      );
      return {
        outcome: 'created',
        poNumber: created.orderNumber,
        totalK,
        expectedOn: parsed.data.expectedOn ?? null,
      };
    } catch (error) {
      if (isDuplicateOn(error, 'orders_external')) return { outcome: 'duplicate' };
      throw error;
    }
  }

  /**
   * The delivery landed: the money posts through the exact road a chat
   * purchase takes (stock in, cash out for what was handed over, the rest
   * onto ACCOUNTS_PAYABLE), and every line becomes counted stock at its line
   * cost, moving each product's weighted average the way any delivery does.
   *
   * The status machine is the idempotency: the `open -> received` claim is
   * taken FIRST, so a second click writes nothing and is told what happened.
   * A line naming something the shop has never counted creates the product,
   * which is what the chat flow does when a merchant buys something new —
   * a thing deliberately ordered by the crate is a thing the shop counts.
   */
  @Post('purchase-orders/receive')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async receivePurchaseOrder(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ReceivePurchaseOrderResponse> {
    const parsed = receivePurchaseOrderRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the PO number and what was paid');
    const businessId = request.auth!.businessId;
    const poNumber = parsed.data.poNumber.toUpperCase();

    const po = await withBusiness(this.db, businessId, (tx) =>
      ordersRepo.purchaseOrderByNumber(tx, businessId, poNumber),
    );
    if (!po || !poNumber.startsWith('PO-')) return { outcome: 'not_found' };
    if (po.status === 'received') return { outcome: 'already_received' };
    if (po.status !== 'open') return { outcome: 'cancelled' };
    /* More than the order costs is a prepayment, and this posting cannot say
     * that: it would drive ACCOUNTS_PAYABLE negative. Same refusal as the
     * supplier settlement, with the figure to pay instead. */
    if (parsed.data.paidK > po.totalK) {
      return { outcome: 'more_than_total', totalK: po.totalK };
    }

    return withBusiness(this.db, businessId, async (tx) => {
      const marked = await ordersRepo.markOrder(tx, businessId, po.id, 'open', 'received');
      if (marked !== 'marked') {
        /* A racing receive or cancel got here first; nothing was written.
         * Re-read so the answer says which of the two it was. */
        const taken = await ordersRepo.purchaseOrderByNumber(tx, businessId, poNumber);
        return taken?.status === 'cancelled'
          ? { outcome: 'cancelled' as const }
          : { outcome: 'already_received' as const };
      }

      const input: RecordPurchaseCmdInput = {
        businessId,
        description: `Purchase order ${poNumber}`,
        amountK: po.totalK,
        paidK: parsed.data.paidK,
        sourceType: 'purchase_order',
        sourceId: po.id,
        /* Every line arrives with the money: receiving a PO is exactly the
         * counted delivery the chat purchase describes, line by line. */
        arrivals: po.lines.map((line) => ({
          product: line.name,
          quantity: line.quantity,
          costK: line.lineTotalK,
        })),
      };

      /* The A1 rollout seam (spec §25). */
      let recorded: Awaited<ReturnType<typeof recordPurchaseWork>>;
      if (this.config.commandRecordPurchase) {
        const run = await this.commandBus.run(
          tx,
          {
            businessId,
            command: 'RecordPurchase',
            payload: input,
            actor: `user:${request.auth!.userId}`,
            ingress: 'DASHBOARD',
            /* One PO, one receipt of goods: the status machine above is the
             * first net, this key is the second. */
            idempotencyKey: `po-receive:${po.id}`,
          },
          () => recordPurchaseWork(tx, input),
        );
        if (run.outcome !== 'done') {
          throw new Error(`RecordPurchase refused unexpectedly: ${run.outcome}`);
        }
        recorded = run.result;
      } else {
        recorded = await recordPurchaseWork(tx, input);
      }

      return {
        outcome: 'received' as const,
        poNumber,
        totalK: po.totalK,
        owedK: recorded.owedK,
        linesArrived: recorded.arrived.length,
      };
    });
  }

  /** Withdraw an open purchase order. Never a delete: an ask made is a fact. */
  @Post('purchase-orders/cancel')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async cancelPurchaseOrder(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<CancelPurchaseOrderResponse> {
    const parsed = cancelPurchaseOrderRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the PO number');
    const businessId = request.auth!.businessId;
    const poNumber = parsed.data.poNumber.toUpperCase();

    return withBusiness(this.db, businessId, async (tx) => {
      const po = await ordersRepo.purchaseOrderByNumber(tx, businessId, poNumber);
      if (!po || !poNumber.startsWith('PO-')) return { outcome: 'not_found' };
      if (po.status !== 'open') return { outcome: 'already', status: po.status };
      await ordersRepo.markOrder(tx, businessId, po.id, 'open', 'cancelled');
      return { outcome: 'cancelled' };
    });
  }

  /** The receipt register. Every row exists because real money was recorded. */
  @Get('receipts')
  async receipts(
    @Req() request: AuthedRequest,
    @Query('page') pageParam?: string,
  ): Promise<ReportsReceiptsResponse> {
    const businessId = request.auth!.businessId;
    const { offset } = pageOffset(pageParam);
    const list = await withBusiness(this.db, businessId, (tx) =>
      reportsRepo.receiptsFor(tx, businessId, REGISTER_ROWS, offset),
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
  @Roles('owner')
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
  async expenses(
    @Req() request: AuthedRequest,
    @Query('page') pageParam?: string,
  ): Promise<ReportsExpensesResponse> {
    const businessId = request.auth!.businessId;
    const now = new Date();
    const { offset } = pageOffset(pageParam);
    const { list, payableAgeing, recurringList, outstanding, assetRegister, purchaseOrderList } =
      await withBusiness(this.db, businessId, async (tx) => ({
        list: await spendRepo.spendFor(tx, businessId, REGISTER_ROWS, offset),
        payableAgeing: await spendRepo.payableAgeingFor(tx, businessId, now),
        recurringList: await recurringRepo.schedulesFor(tx, businessId),
        /* What a merchant can actually pay, on the same response as the debt
         * it belongs to: a page that fetched these apart could show a total
         * from one moment and a list from another. */
        outstanding: await spendRepo.outstandingPurchases(tx, businessId),
        assetRegister: await assetsRepo.assetsFor(tx, businessId),
        purchaseOrderList: await ordersRepo.purchaseOrdersFor(tx, businessId, REGISTER_ROWS),
      }));
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
      recurring: recurringList.rows,
      recurringTotal: recurringList.total,
      outstanding,
      assets: assetRegister.rows,
      /* From SQL over the whole table. The pickers on this page are built out
       * of `assets`, so counting that array would tell a merchant with more
       * equipment than the cap that the register holds exactly what fitted. */
      assetsTotal: assetRegister.count,
      purchaseOrdersTotal: purchaseOrderList.count,
      purchaseOrders: purchaseOrderList.rows.map((po) => ({
        poNumber: po.poNumber,
        status: po.status,
        totalK: po.totalK,
        itemCount: po.itemCount,
        expectedOn: po.expectedOn,
        createdAt: po.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Buying something the business keeps and uses (ADR 0026).
   *
   * A ₦450,000 generator recorded as an expense reports a loss the business
   * did not make, hides an asset it owns, and flatters every month afterwards
   * by charging nothing for using it. This puts it on the balance sheet.
   *
   * The useful life is taken from the merchant and never inferred: a model
   * deciding how long a freezer lasts would be a model computing money.
   */
  @Post('assets')
  @Roles('owner')
  @HttpCode(200)
  async recordAsset(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<RecordAssetResponse> {
    const parsed = recordAssetRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        'a description, what it cost, what you paid, and how many months it will last',
      );
    }
    const businessId = request.auth!.businessId;
    try {
      const recorded = await withBusiness(this.db, businessId, (tx) =>
        assetsRepo.recordAsset(tx, {
          businessId,
          description: parsed.data.description,
          costK: parsed.data.costK,
          paidK: parsed.data.paidK,
          usefulLifeMonths: parsed.data.usefulLifeMonths,
          method: parsed.data.method,
          actor: `user:${request.auth!.userId}`,
          clientRef: parsed.data.clientRef ?? null,
        }),
      );
      return { outcome: 'recorded', assetId: recorded.assetId, owedK: recorded.owedK };
    } catch (error) {
      if (isDuplicateOn(error, 'fixed_assets_client_ref')) return { outcome: 'duplicate' };
      throw error;
    }
  }

  /**
   * Selling or scrapping something the business owned (ADR 0026, amended).
   *
   * Not a withdrawal. A withdrawal mirrors the purchase because it should
   * never have been recorded; this does not, because the business really did
   * own the thing and really did use it. Reversing the purchase would erase
   * months of depreciation that genuinely reached the profit and loss.
   *
   * The gain or loss is measured against BOOK VALUE, not the price paid, so
   * the depreciation already charged is never counted twice.
   */
  @Post('assets/dispose')
  @Roles('owner')
  @HttpCode(200)
  async disposeAsset(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<DisposeAssetResponse> {
    const parsed = disposeAssetRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('the item, what came back for it, and how it was paid');
    }
    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      assetsRepo.disposeAsset(tx, {
        businessId,
        assetId: parsed.data.assetId,
        proceedsK: parsed.data.proceedsK,
        method: parsed.data.method,
        actor: `user:${request.auth!.userId}`,
      }),
    );
  }

  /**
   * Take back something that should not have been recorded.
   *
   * Not a disposal: selling equipment is a real event with a gain or a loss
   * against book value and ADR 0026 leaves it out of this slice deliberately.
   */
  @Post('assets/withdraw')
  @Roles('owner')
  @HttpCode(200)
  async withdrawAsset(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<WithdrawAssetResponse> {
    const parsed = withdrawAssetRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('the item to withdraw and a reason of at least 4 characters');
    }
    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      assetsRepo.withdrawAsset(tx, {
        businessId,
        assetId: parsed.data.assetId,
        reason: parsed.data.reason,
        actor: `user:${request.auth!.userId}`,
      }),
    );
  }

  /**
   * Money going back to a supplier.
   *
   * A purchase on credit could be raised and never settled: clearing
   * ACCOUNTS_PAYABLE meant a manual journal, and a journal names no purchase,
   * so the ageing went on reporting a debt the register said was gone. This
   * settlement knows what it settles, which is what lets both figures move.
   */
  @Post('suppliers/pay')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async paySupplier(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<PaySupplierResponse> {
    const parsed = paySupplierRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the purchase and what you paid on it');

    const businessId = request.auth!.businessId;
    try {
      return await withBusiness(this.db, businessId, (tx) =>
        spendRepo.paySupplier(tx, {
          businessId,
          expenseId: parsed.data.expenseId,
          amountK: parsed.data.amountK,
          method: parsed.data.method,
          actor: `user:${request.auth!.userId}`,
          clientRef: parsed.data.clientRef ?? null,
        }),
      );
    } catch (error) {
      if (isDuplicateOn(error, 'supplier_payments_client_ref')) return { outcome: 'duplicate' };
      throw error;
    }
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
  @Roles('owner')
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
  @Roles('owner', 'delegate')
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
  @Roles('owner')
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
          clientRef: parsed.data.clientRef ?? null,
        }),
      );
      return { outcome: 'recorded', journalNumber: recorded.journalNumber };
    } catch (error) {
      /* Nothing was written before this threw, so the transaction rolled back
       * clean and the refusal can be returned rather than raised. */
      if (error instanceof closeRepo.PeriodClosed) {
        return { outcome: 'period_closed', closedThrough: error.closedThrough };
      }
      if (isDuplicateOn(error, 'ledger_tx_client_ref')) return { outcome: 'duplicate' };
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
  @Roles('owner')
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
  @Roles('owner')
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
  @Roles('owner')
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
    try {
      const id = await withBusiness(this.db, businessId, (tx) =>
        recurringRepo.createSchedule(tx, {
          businessId,
          description: parsed.data.description,
          category: parsed.data.category,
          amountK: parsed.data.amountK,
          method: parsed.data.method,
          anchorDay: parsed.data.anchorDay,
          firstDueOn,
          clientRef: parsed.data.clientRef ?? null,
        }),
      );
      return { outcome: 'created', id, firstDueOn };
    } catch (error) {
      if (isDuplicateOn(error, 'recurring_client_ref')) return { outcome: 'duplicate' };
      throw error;
    }
  }

  /** Stop a schedule. Never a delete: what it already raised is real. */
  @Post('expenses/recurring/stop')
  @Roles('owner')
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
   * The audit trail as a file (fix-plan 5, H2b). The page calls itself "the
   * record an accountant or a tax officer asks for", and a record that can
   * only be read a hundred rows at a time on a screen is not one they can
   * take away. Actors resolve exactly as the page resolves them.
   */
  @Get('audit.csv')
  async auditCsv(@Req() request: AuthedRequest, @Res() reply: CsvReply): Promise<void> {
    const businessId = request.auth!.businessId;
    const { list, members } = await withBusiness(this.db, businessId, async (tx) => ({
      list: await reportsRepo.auditFor(tx, businessId, EXPORT_ROWS),
      members: await identity.membersOf(tx, businessId),
    }));
    const label = new Map(
      members.map((m) => [m.userId, `${roleWord(m.role)} ${m.phone.slice(-4)}`]),
    );
    const csv = toCsv(
      ['When', 'Who', 'What happened', 'Where', 'Why', 'Amount'],
      list.rows.map((row) => {
        const { summary, amountK } = describeAuditEvent(row);
        return [
          row.at.toISOString(),
          describeActor(row.actor, (userId) => label.get(userId)),
          summary,
          row.sourceType,
          row.reason ?? '',
          amountK === null ? '' : csvKobo(amountK),
        ];
      }),
    );
    sendCsv(reply, `rekoda-audit-${csvDate(new Date())}.csv`, csv);
  }

  /**
   * The stock register as a file (fix-plan 5, H2b): what is counted, what it
   * costs and what it sells for, which is a stock take's starting sheet.
   */
  @Get('stock.csv')
  async stockCsv(@Req() request: AuthedRequest, @Res() reply: CsvReply): Promise<void> {
    const businessId = request.auth!.businessId;
    const list = await withBusiness(this.db, businessId, (tx) =>
      stockRepo.stockList(tx, businessId, EXPORT_ROWS),
    );
    const csv = toCsv(
      ['Product', 'On hand', 'Unit price', 'Unit cost', 'Listed'],
      list.rows.map((r) => [
        r.name,
        r.onHand,
        r.unitPriceK === null ? '' : csvKobo(r.unitPriceK),
        /* Blank, not zero: a cost nobody has recorded is unknown, and a
         * spreadsheet totalling zeros would value the shelf at nothing. */
        r.unitCostK === null ? '' : csvKobo(r.unitCostK),
        r.active ? 'yes' : 'no',
      ]),
    );
    sendCsv(reply, `rekoda-stock-${csvDate(new Date())}.csv`, csv);
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
    const register = await withBusiness(this.db, businessId, (tx) =>
      stockRepo.stockList(tx, businessId, STOCK_ROWS),
    );
    return {
      products: register.rows.map((p) => ({
        name: p.name,
        onHand: p.onHand,
        unitCostK: p.unitCostK,
      })),
      /* All three counts come from SQL over the whole table, never from the
       * page. Counting `rows` would report a shop the size of the cap to
       * every merchant who has more products than that. */
      total: register.count,
      outOfStock: register.outOfStock,
      /* The count that explains a profit and loss with no cost of sales on
       * it, rather than leaving a merchant to work out why. */
      withoutCost: register.withoutCost,
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
