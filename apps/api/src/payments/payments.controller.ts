/**
 * The Payment Hub's authenticated surface (docs/payments-v1.md §3–5, §35).
 *
 * Every route runs behind the session guard, and `businessId` comes from the
 * SESSION, never from a body or query — a caller-supplied tenant id is a
 * cross-tenant read waiting for a forgotten check. Submitting settlement
 * details is owner-only: an accountant can read the books they were invited
 * to; they cannot redirect where the money settles.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { usagePeriod } from '@rekoda/core';
import { submitConnectionRequest } from '@rekoda/contracts';
import type {
  PaymentConnectionResponse,
  PaymentExceptionsResponse,
  PaymentsListResponse,
} from '@rekoda/contracts';
import { settleRepo, usageRepo, withBusiness, type Db } from '@rekoda/db';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { DB } from '../db/db.module.js';
import { PaymentConnectionsService } from './connections.service.js';

@Controller('v1/payments')
@UseGuards(SessionGuard)
export class PaymentsController {
  constructor(
    @Inject(PaymentConnectionsService) private readonly connections: PaymentConnectionsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get('connection')
  async connection(@Req() request: AuthedRequest): Promise<PaymentConnectionResponse> {
    return this.connections.view(request.auth!.businessId);
  }

  @Post('connection')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('owner')
  async submitConnection(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<PaymentConnectionResponse & { held?: string }> {
    const parsed = submitConnectionRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        'bank code, a 10-digit account number and the account name are required',
      );
    }

    const outcome = await this.connections.submit(request.auth!.businessId, parsed.data);
    if (outcome.state === 'unavailable') {
      // 503, not 500: the deployment is missing its CONNECTION_KEY and the
      // owner's account number was deliberately NOT stored.
      throw new ServiceUnavailableException('payment onboarding is not configured yet');
    }
    return outcome.held ? { ...outcome.connection, held: outcome.held } : outcome.connection;
  }

  @Get('list')
  async list(@Req() request: AuthedRequest): Promise<PaymentsListResponse> {
    const businessId = request.auth!.businessId;
    const payments = await withBusiness(this.db, businessId, (tx) => settleRepo.paymentsFor(tx));
    return {
      /* From SQL over the whole table, so the page can say what it left out.
       * The rows are newest first now: this page answers "has my money
       * arrived", which is a question about this week, and oldest-first with
       * a cap showed a busy merchant only the payments they stopped caring
       * about. */
      paymentsTotal: payments.count,
      payments: payments.rows.map((p) => ({
        rekodaReference: p.rekodaReference,
        status: p.status,
        verified: p.verified,
        method: p.method,
        amountK: p.amountK,
        grossAmountK: p.grossAmountK,
        providerFeeK: p.providerFeeK,
        settlementAmountK: p.settlementAmountK,
        // NULL means merchant-recorded: there is no provider settlement to track.
        settlementStatus: p.settlementStatus ?? 'not_applicable',
        settledAt: p.settledAt ? p.settledAt.toISOString() : null,
      })),
    };
  }

  @Get('exceptions')
  async exceptions(@Req() request: AuthedRequest): Promise<PaymentExceptionsResponse> {
    const businessId = request.auth!.businessId;
    const rows = await withBusiness(this.db, businessId, (tx) => settleRepo.reconciliationsFor(tx));
    return {
      exceptions: rows
        .filter((r) => r.status === 'EXCEPTION')
        .map((r) => ({
          id: r.id,
          status: r.status,
          reason: r.reason,
          amountK: r.amountK,
          outstandingK: r.outstandingK,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        })),
    };
  }

  /**
   * Mark one exception reviewed. Owner-only: deciding that odd money has been
   * looked at is the same class of act as deciding where money settles. The
   * update is conditional (unresolved EXCEPTION rows only), so a stale or
   * foreign id is a 404, never a silent success.
   */
  @Post('exceptions/:id/resolve')
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles('owner')
  async resolveException(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ resolved: true }> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException('not an exception id');
    const businessId = request.auth!.businessId;
    const actor = `user:${request.auth!.userId}`;
    const resolved = await withBusiness(this.db, businessId, (tx) =>
      settleRepo.resolveException(tx, businessId, id, actor),
    );
    if (!resolved) throw new NotFoundException('no unresolved exception with that id');
    return { resolved: true };
  }

  /** This month's meter, so the dashboard can show usage without guessing. */
  @Get('usage')
  async usage(@Req() request: AuthedRequest): Promise<{
    period: string;
    plan: string;
    units: Array<{ unit: string; used: number; bonus: number }>;
  }> {
    const businessId = request.auth!.businessId;
    const period = usagePeriod(new Date());
    return withBusiness(this.db, businessId, async (tx) => ({
      period,
      plan: await usageRepo.planFor(tx, businessId),
      units: await usageRepo.usageFor(tx, businessId, period),
    }));
  }
}
