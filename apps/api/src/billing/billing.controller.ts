/**
 * The billing surface (ADR 0024).
 *
 * Thin, like the reports controller: every figure was computed by
 * `@rekoda/core/billing` and every state read by the subscriptions repo, and
 * this file decides only who may see it. `businessId` comes from the session
 * and never from a body.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  billingPlanChangeRequest,
  type BillingOverviewResponse,
  type BillingPlanChangeResponse,
  type BillingQuoteResponse,
} from '@rekoda/contracts';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { BillingService } from './billing.service.js';

@Controller('v1/billing')
@UseGuards(SessionGuard)
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Get()
  async overview(@Req() request: AuthedRequest): Promise<BillingOverviewResponse> {
    return this.billing.overview(request.auth!.businessId);
  }

  /**
   * What a plan change would cost, without doing it.
   *
   * A separate endpoint from the change itself so the page can show the
   * figure before the merchant commits. A confirmation screen that guesses at
   * the price is how a merchant is surprised by a charge.
   */
  @Post('quote')
  @HttpCode(200)
  async quote(@Req() request: AuthedRequest, @Body() body: unknown): Promise<BillingQuoteResponse> {
    const parsed = billingPlanChangeRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('plan must be chat, integrate or complete');
    return this.billing.quote(request.auth!.businessId, parsed.data.plan);
  }

  @Post('plan')
  @HttpCode(200)
  async changePlan(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<BillingPlanChangeResponse> {
    const parsed = billingPlanChangeRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('plan must be chat, integrate or complete');
    return this.billing.changePlan(request.auth!.businessId, parsed.data.plan);
  }

  @Post('packs')
  @HttpCode(200)
  async buyPack(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ state: string; reference?: string; amountK?: number; reason?: string }> {
    const packId = (body as { packId?: unknown } | null)?.packId;
    if (typeof packId !== 'string' || !packId) throw new BadRequestException('packId is required');
    return this.billing.buyPack(request.auth!.businessId, packId);
  }
}
