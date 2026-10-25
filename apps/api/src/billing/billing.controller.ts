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
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  billingCheckoutRequest,
  billingEmailConfirmRequest,
  billingEmailVerifyRequest,
  billingIntervalRequest,
  billingPackPurchaseRequest,
  billingPlanChangeRequest,
  type BillingCancelResponse,
  type BillingCheckoutResponse,
  type BillingEmailConfirmResponse,
  type BillingEmailStatusResponse,
  type BillingEmailVerifyResponse,
  type BillingIntervalResponse,
  type BillingOverviewResponse,
  type BillingPaymentRecord,
  type BillingPlanChangeResponse,
  type BillingQuoteResponse,
} from '@rekoda/contracts';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import { BillingEmailService } from './billing-email.service.js';
import { BillingCheckoutService } from './billing-checkout.service.js';
import { BillingService } from './billing.service.js';

@Controller('v1/billing')
@UseGuards(SessionGuard, RolesGuard)
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(BillingCheckoutService) private readonly checkouts: BillingCheckoutService,
    @Inject(BillingEmailService) private readonly emails: BillingEmailService,
  ) {}

  @Get()
  async overview(@Req() request: AuthedRequest): Promise<BillingOverviewResponse> {
    return this.billing.overview(request.auth!.businessId);
  }

  /**
   * One payment in full, for the record page (billing Slice A). The reference must be one of this
   * business's own; anyone else's, and one that never existed, are both 404 so the route cannot
   * be used to learn whether another merchant holds a reference. Same readers as the overview.
   */
  @Get('payments/:reference')
  async paymentRecord(
    @Req() request: AuthedRequest,
    @Param('reference') reference: string,
  ): Promise<BillingPaymentRecord> {
    const record = await this.billing.paymentRecord(request.auth!.businessId, reference);
    if (!record) throw new NotFoundException('payment_not_found');
    return record;
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
    return this.billing.quote(
      request.auth!.businessId,
      parsed.data.plan,
      new Date(),
      parsed.data.interval ?? 'monthly',
    );
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
    return this.billing.changePlan(
      request.auth!.businessId,
      parsed.data.plan,
      new Date(),
      parsed.data.interval ?? 'monthly',
    );
  }

  /**
   * Switch between monthly and annual billing (OWN-40). Owner-only like every
   * plan decision; it always waits for the next renewal and never refunds or
   * prorates, because the merchant keeps the cycle they paid for.
   */
  @Post('interval')
  @HttpCode(200)
  @Roles('owner')
  async switchInterval(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<BillingIntervalResponse> {
    const parsed = billingIntervalRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('interval must be monthly or annual');
    return this.billing.switchInterval(request.auth!.businessId, parsed.data.interval);
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

  /**
   * Pay a pending charge (G-102, OWN-39): hands back the Paystack checkout for
   * it, asking for a billing email the first time. Owner-only, like every
   * decision that spends the owner's money. The charge must belong to the
   * session's business; a reference from another tenant reads as unknown.
   */
  @Post('checkout')
  @HttpCode(200)
  @Roles('owner')
  async checkout(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<BillingCheckoutResponse> {
    const parsed = billingCheckoutRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        'reference must be a non-empty string of at most 64 characters; billingEmail, if given, must be a string of at most 320 characters; restart, if given, must be true or false',
      );
    }
    return this.checkouts.checkout(
      request.auth!.businessId,
      parsed.data.reference,
      parsed.data.billingEmail,
      { restart: parsed.data.restart === true },
    );
  }

  /** The billing email as the merchant may see it: masked, and whether its mailbox is proven. */
  @Get('email')
  @Roles('owner')
  async emailStatus(@Req() request: AuthedRequest): Promise<BillingEmailStatusResponse> {
    return this.emails.status(request.auth!.businessId);
  }

  /** Mail the confirmation link (OWN-51), saving a new address first when one is given. */
  @Post('email/verify')
  @HttpCode(200)
  @Roles('owner')
  async emailVerify(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<BillingEmailVerifyResponse> {
    const parsed = billingEmailVerifyRequest.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(
        'billingEmail, if given, must be a string of at most 320 characters',
      );
    }
    return this.emails.requestVerification(request.auth!.businessId, parsed.data.billingEmail);
  }

  /** Spend a mailed link. The token travels in the body, never in a URL. */
  @Post('email/confirm')
  @HttpCode(200)
  @Roles('owner')
  async emailConfirm(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<BillingEmailConfirmResponse> {
    const parsed = billingEmailConfirmRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('token is required');
    return this.emails.confirm(request.auth!.businessId, parsed.data.token);
  }
}
