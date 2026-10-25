import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { resendWebhookEvent } from '@rekoda/contracts';
import { emailSuppressionKey } from '@rekoda/core';
import { verifySvixSignature } from '@rekoda/core/webhooks';
import { emailSuppressionsRepo, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { SecurityMetrics } from '../channels/security-metrics.service.js';

interface RawBodyRequest {
  rawBody?: Buffer;
}

/**
 * Resend ingress (N7). Only a permanent bounce and a spam complaint mean "stop mailing this
 * address"; a transient or undetermined bounce may deliver next time. Signature first (Svix scheme, over the raw body), then parse, then
 * act. Recording a suppression is one idempotent insert keyed by an address hash, so a
 * replayed delivery changes nothing and no queue is needed. The address is never logged or
 * stored. With no secret configured every delivery is rejected.
 */
@Controller('webhooks/resend')
export class ResendWebhookController {
  private readonly log = new Logger(ResendWebhookController.name);

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(SecurityMetrics) private readonly security: SecurityMetrics,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest,
    @Headers('svix-id') id: string | undefined,
    @Headers('svix-timestamp') timestamp: string | undefined,
    @Headers('svix-signature') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<{ received: true }> {
    const raw = request.rawBody;
    if (
      !raw ||
      !verifySvixSignature(
        raw,
        { id, timestamp, signature },
        this.config.resendWebhookSecret,
        Date.now(),
      )
    ) {
      this.security.rejectedSignature('resend');
      this.log.warn('rejected a Resend webhook with an invalid signature');
      throw new UnauthorizedException('invalid signature');
    }

    const parsed = resendWebhookEvent.safeParse(body);
    if (!parsed.success) {
      this.log.warn('accepted a Resend webhook whose shape we do not recognise');
      return { received: true };
    }
    const { type, data } = parsed.data;
    const reason =
      type === 'email.complained'
        ? 'complained'
        : type === 'email.bounced' && data?.bounce?.type === 'Permanent'
          ? 'bounced'
          : null;
    if (!reason) return { received: true };

    for (const address of data?.to ?? []) {
      await emailSuppressionsRepo.suppress(this.db, {
        addressHash: emailSuppressionKey(address),
        reason,
        providerEventId: id ?? null,
      });
    }
    return { received: true };
  }
}
