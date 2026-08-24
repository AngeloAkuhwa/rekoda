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
  billingPackPurchaseRequest,
  billingPlanChangeRequest,
  type BillingCancelResponse,
  type BillingOverviewResponse,
  type BillingPlanChangeResponse,
  type BillingQuoteResponse,
} from '@rekoda/contracts';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import { BillingService } from './billing.service.js';

@Controller('v1/billing')
@UseGuards(SessionGuard, RolesGuard)
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

  /* Spending the owner's money is the owner's decision. An invited member
   * upgrading the plan or buying packs raises a real charge against somebody
   * else's account, which is the same reasoning that owner-gates settlement
   * details on the payments controller. The quote stays open: seeing a price
   * commits nobody to anything. */
  @Post('plan')
  @HttpCode(200)
  @Roles('owner')
  async changePlan(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<BillingPlanChangeResponse> {
    const parsed = billingPlanChangeRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('plan must be chat, integrate or complete');
    return this.billing.changePlan(request.auth!.businessId, parsed.data.plan);
  }

  /**
   * The cancel button the terms have promised since they were written.
   * Owner-only like every plan decision; the answer names the exact day the
   * plan ends, because "cancelled" without a date reads as "cut off now".
   */
  @Post('cancel')
  @HttpCode(200)
  @Roles('owner')
  async cancelPlan(@Req() request: AuthedRequest): Promise<BillingCancelResponse> {
    return this.billing.cancelPlan(request.auth!.businessId);
  }

  @Post('packs')
  @HttpCode(200)
  @Roles('owner')
  async buyPack(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ state: string; reference?: string; amountK?: number; reason?: string }> {
    const parsed = billingPackPurchaseRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('packId is required');
    return this.billing.buyPack(request.auth!.businessId, parsed.data.packId);
  }
}
