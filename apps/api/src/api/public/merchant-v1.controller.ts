/**
 * The Merchant API, version one (canonical spec §25, §27).
 *
 * §27's first rule is that "APIs call the same application commands as every
 * other ingress", and this controller is where that stops being a diagram.
 * Every write here goes through `CommandBus.run` with `ingress: 'PUBLIC_API'`,
 * so the entitlement gate, the risk tier and the idempotency claim are the
 * same three gates a chat message and a dashboard click pass. There is no
 * flag around it: the per-command flags in `config` are A1's rollout seam for
 * ingresses that HAD a pre-command path to fall back to, and a surface born
 * after the command layer has no such path and must never grow one.
 *
 * Reads go through `merchantApiRepo` under the tenant the key resolved to.
 * The pin is never a parameter; `request.api.businessId` is the only source,
 * exactly as `SessionGuard` is for the dashboard.
 *
 * Money arrives as integer kobo and the arithmetic is `computeMoneyFromKobo`
 * in `@rekoda/core` — the same equation the chat gate uses, reached through
 * a door that speaks minor units. Nothing in this file adds two amounts.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { computeMoneyFromKobo } from '@rekoda/core';
import { mayWrite } from '@rekoda/core/api-keys';
import { publicApi } from '@rekoda/contracts';
import { merchantApiRepo, withBusiness, type Db } from '@rekoda/db';
import { CommandBus } from '../../commands/command-bus.service.js';
import { recordSaleWork, type RecordSaleInput } from '../../commands/sale-commands.js';
import { recordPaymentWork, type RecordPaymentInput } from '../../commands/payment-commands.js';
import { DB } from '../../db/db.module.js';
import { ApiKeyGuard, type ApiKeyedRequest } from '../api-key.guard.js';
/* The entitlement refusal shares the guard's exception, so a per-command
 * refusal and a per-surface one answer the same public code. */
import {
  NotEntitledException,
  PublicApiExceptionFilter,
  SandboxWriteException,
} from './public-api.filter.js';
import type { CommandOutcome } from '../../commands/command-bus.service.js';

@Controller('api/v1')
@UseGuards(ApiKeyGuard)
@UseFilters(PublicApiExceptionFilter)
export class MerchantV1Controller {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CommandBus) private readonly commandBus: CommandBus,
  ) {}

  @Get('customers')
  async customers(
    @Req() request: ApiKeyedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<MerchantPage<publicApi.v1.MerchantCustomer>> {
    const businessId = request.api!.businessId;
    const page = await withBusiness(this.db, businessId, (tx) =>
      merchantApiRepo.customersPage(tx, businessId, {
        after: readCursor(cursor),
        limit: readLimit(limit),
      }),
    );
    return CUSTOMER_PAGE.parse({
      items: page.rows.map((row) => ({
        id: row.id,
        token: row.token,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: writeCursor(page.next),
    });
  }

  @Get('products')
  async products(
    @Req() request: ApiKeyedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<MerchantPage<publicApi.v1.MerchantProduct>> {
    const businessId = request.api!.businessId;
    const page = await withBusiness(this.db, businessId, (tx) =>
      merchantApiRepo.productsPage(tx, businessId, {
        after: readCursor(cursor),
        limit: readLimit(limit),
      }),
    );
    return PRODUCT_PAGE.parse({
      items: page.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        unitPriceK: row.unitPriceK,
        active: row.active,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: writeCursor(page.next),
    });
  }

  @Get('invoices')
  async invoices(
    @Req() request: ApiKeyedRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ): Promise<MerchantPage<publicApi.v1.MerchantInvoice>> {
    if (status !== undefined && !isInvoiceStatus(status)) {
      throw new BadRequestException(
        `status must be one of ${publicApi.v1.INVOICE_STATUSES.join(', ')}`,
      );
    }
    const businessId = request.api!.businessId;
    const page = await withBusiness(this.db, businessId, (tx) =>
      merchantApiRepo.invoicesPage(tx, businessId, {
        after: readCursor(cursor),
        limit: readLimit(limit),
        status: status ?? null,
      }),
    );
    return INVOICE_PAGE.parse({
      items: page.rows.map(invoiceView),
      nextCursor: writeCursor(page.next),
    });
  }

  @Get('invoices/:invoiceNumber')
  async invoice(
    @Req() request: ApiKeyedRequest,
    @Param('invoiceNumber') invoiceNumber: string,
  ): Promise<publicApi.v1.MerchantInvoice> {
    const businessId = request.api!.businessId;
    const found = await withBusiness(this.db, businessId, (tx) =>
      merchantApiRepo.invoiceByNumber(tx, businessId, invoiceNumber),
    );
    if (!found) throw new NotFoundException('no invoice with that number');
    return publicApi.v1.merchantInvoice.parse(invoiceView(found));
  }

  /**
   * Record a sale that happened somewhere else.
   *
   * The totals are computed here from the caller's lines rather than taken
   * from them: a program that sends a total is a program that can send one
   * that does not match its own items, and the merchant's books would carry
   * whichever the caller preferred.
   */
  @Post('sales')
  @HttpCode(200)
  async recordSale(
    @Req() request: ApiKeyedRequest,
    @Body() body: unknown,
    @Headers(publicApi.v1.IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<publicApi.v1.RecordSaleResponse> {
    const parsed = publicApi.v1.recordSaleRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException(firstIssue(parsed.error));
    refuseSandboxWrite(request);

    const businessId = request.api!.businessId;
    const money = computeMoneyFromKobo({
      items: parsed.data.items,
      discountK: parsed.data.discountK ?? 0,
      deliveryFeeK: parsed.data.deliveryFeeK ?? 0,
      vatK: parsed.data.vatK ?? 0,
      amountPaidK: parsed.data.amountPaidK ?? 0,
    });

    const input: RecordSaleInput = {
      businessId,
      customerId: parsed.data.customerId ?? null,
      /* No pseudonym minted here. A token names a customer the merchant's
       * own channels met; an API caller naming one it invented would put a
       * stranger in the merchant's customer list. */
      customerToken: null,
      items: parsed.data.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unitPriceK: item.unitPriceK,
      })),
      subtotalK: money.subtotalK,
      discountK: money.discountK,
      deliveryFeeK: money.deliveryFeeK,
      vatK: money.vatK,
      totalK: money.totalK,
      paidK: money.amountPaidK,
      balanceDueK: money.balanceDueK,
      method: parsed.data.method ?? 'transfer',
      sourceType: 'api',
      sourceId: request.api!.applicationId,
      saleSource: null,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
      actor: `api:${request.api!.keyPrefix}`,
    };

    return withBusiness(this.db, businessId, async (tx) => {
      const run = await this.commandBus.run(
        tx,
        {
          businessId,
          command: 'RecordSale',
          payload: input,
          actor: input.actor,
          ingress: 'PUBLIC_API',
          idempotencyKey: idempotencyKey ?? null,
        },
        () => recordSaleWork(tx, input),
      );
      const done = this.requireDone(run, 'RecordSale');
      return publicApi.v1.recordSaleResponse.parse({
        invoiceId: done.invoiceId,
        invoiceNumber: done.invoiceNumber,
        totalK: done.totalK,
        balanceDueK: done.balanceDueK,
      });
    });
  }

  /** Record money against an invoice the merchant already issued. */
  @Post('payments')
  @HttpCode(200)
  async recordPayment(
    @Req() request: ApiKeyedRequest,
    @Body() body: unknown,
    @Headers(publicApi.v1.IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<publicApi.v1.RecordPaymentResponse> {
    const parsed = publicApi.v1.recordPaymentRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException(firstIssue(parsed.error));
    refuseSandboxWrite(request);

    const businessId = request.api!.businessId;
    const input: RecordPaymentInput = {
      businessId,
      invoice: { number: parsed.data.invoiceNumber },
      amountK: parsed.data.amountK,
      method: parsed.data.method ?? 'transfer',
      sourceType: 'api',
      sourceId: request.api!.applicationId,
      actor: `api:${request.api!.keyPrefix}`,
      clientRef: parsed.data.reference ?? null,
      /* Spec E.7's basis, honestly: nobody typed this and nobody saw an
       * image. A program asserted it, and the record says so. */
      evidenceBasis: 'NOT_A_MESSAGE',
    };

    return withBusiness(this.db, businessId, async (tx) => {
      const run = await this.commandBus.run(
        tx,
        {
          businessId,
          command: 'RecordPayment',
          payload: input,
          actor: input.actor,
          ingress: 'PUBLIC_API',
          subject: `invoice:${parsed.data.invoiceNumber}`,
          idempotencyKey: idempotencyKey ?? null,
        },
        () => recordPaymentWork(tx, input),
      );
      const done = this.requireDone(run, 'RecordPayment');
      return publicApi.v1.recordPaymentResponse.parse(
        done.outcome === 'recorded'
          ? {
              outcome: 'recorded',
              receiptNumber: done.receiptNumber,
              invoiceNumber: done.invoiceNumber,
              amountK: done.amountK,
              balanceDueK: done.balanceDueK,
              invoiceStatus: done.invoiceStatus,
            }
          : done,
      );
    });
  }

  /**
   * The bus's answer, or the right refusal.
   *
   * `not_entitled` is the API entitlement's cousin, refused per COMMAND
   * rather than per surface, and it keeps the same public code. Everything
   * else here is a gate this ingress cannot legitimately trip: both commands
   * are STANDARD and neither is entitlement-gated, so reaching one is a bug
   * that must be loud rather than a 200 with a shrug.
   */
  private requireDone<R>(run: CommandOutcome<R>, command: string): R {
    if (run.outcome === 'done') return run.result;
    if (run.outcome === 'not_entitled') {
      throw new NotEntitledException(`this business cannot ${command} on its plan`);
    }
    if (run.outcome === 'in_progress') {
      throw new BadRequestException(
        'a request with this Idempotency-Key is still running, retry shortly',
      );
    }
    if (run.outcome === 'key_reused') {
      throw new BadRequestException('this Idempotency-Key already answered a different request');
    }
    throw new Error(`${command} refused unexpectedly: ${run.outcome}`);
  }
}

/**
 * The sandbox's one rule, in one place (PR-114).
 *
 * A test key resolves to the merchant's real business and reads their real
 * books, which is what makes it useful: an integrator proves their paging,
 * their signature handling and their error handling against real shapes.
 * What it may never do is write, and the refusal lives here rather than in
 * each handler so "the sandbox is read-only" stays a property of the mode
 * instead of a habit of whoever adds the next route.
 *
 * The body is validated FIRST, deliberately: a developer testing against
 * the sandbox should learn that their payload is wrong before they learn
 * that their key cannot write, because the first is the thing they can fix
 * without changing anything else.
 */
function refuseSandboxWrite(request: ApiKeyedRequest): void {
  if (!mayWrite(request.api!.mode)) {
    throw new SandboxWriteException(
      'this is a test key: it reads the books and writes nothing. Use a live key to record.',
    );
  }
}

/**
 * The page envelope PR-110 defined, applied.
 *
 * Parsed on the way OUT as well as in. A response that has drifted from the
 * frozen shape is a broken promise to every client already written against
 * it, and the cheapest place to catch that is before it leaves the process.
 */
interface MerchantPage<T> {
  items: T[];
  nextCursor: string | null;
}

const CUSTOMER_PAGE = publicApi.v1.publicPage(publicApi.v1.merchantCustomer);
const PRODUCT_PAGE = publicApi.v1.publicPage(publicApi.v1.merchantProduct);
const INVOICE_PAGE = publicApi.v1.publicPage(publicApi.v1.merchantInvoice);

function invoiceView(row: merchantApiRepo.InvoiceRow): publicApi.v1.MerchantInvoice {
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    customerId: row.customerId,
    status: row.status as publicApi.v1.MerchantInvoice['status'],
    totalK: row.totalK,
    paidK: row.paidK,
    balanceDueK: row.balanceDueK,
    currency: row.currency,
    dueDate: row.dueDate?.toISOString() ?? null,
    issuedAt: row.issuedAt.toISOString(),
  };
}

function isInvoiceStatus(value: string): boolean {
  return (publicApi.v1.INVOICE_STATUSES as readonly string[]).includes(value);
}

/**
 * The cursor, opaque on the wire.
 *
 * base64url of `<iso>|<uuid>`, so it is one string a client copies rather
 * than two query parameters they can mismatch, and so nothing about the
 * keyset's columns leaks into the contract. An unreadable cursor is refused
 * rather than silently treated as "start again", which would send a client
 * quietly back to page one forever.
 */
function readCursor(raw: string | undefined): merchantApiRepo.Cursor | null {
  if (!raw) return null;
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const [iso, id] = decoded.split('|');
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime()) || !id || !UUID.test(id)) {
    throw new BadRequestException('cursor is not one this API issued');
  }
  return { createdAt: at, id };
}

function writeCursor(cursor: merchantApiRepo.Cursor | null): string | null {
  if (!cursor) return null;
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

function readLimit(raw: string | undefined): number {
  if (raw === undefined) return merchantApiRepo.DEFAULT_PAGE_SIZE;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > merchantApiRepo.MAX_PAGE_SIZE) {
    throw new BadRequestException(`limit must be between 1 and ${merchantApiRepo.MAX_PAGE_SIZE}`);
  }
  return parsed;
}

/** The first thing wrong, in the caller's own field names. */
function firstIssue(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return 'the request body is not valid';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
