import { createHash } from 'node:crypto';
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
import { verifyPaystackSignature } from '@rekoda/core/webhooks';
import { redactForLog } from '@rekoda/core/privacy';
import { paystackWebhookBody, summarisePaystackEvent } from '@rekoda/contracts';
import { events, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { sealPayload } from '../privacy/payload-vault.js';

interface RawBodyRequest {
  rawBody?: Buffer;
}

/**
 * Paystack ingress (docs/payments-v1.md §18–20) — the same fixed order the
 * Meta endpoint earned slice by slice, because the reasons are identical:
 *
 *   signature → parse → fingerprint → idempotency → sealed persist → 200
 *
 * Nothing is processed inline. Understanding the event — resolving the
 * intent, server-side verification, creating the Payment — belongs to a
 * worker reading the same table; this endpoint's whole job is to get the
 * event durably recorded and answer fast.
 *
 * Differences from Meta worth naming rather than discovering:
 *  - the signature is HMAC-SHA512 under the SECRET KEY, bare hex, in
 *    `x-paystack-signature`;
 *  - Paystack events carry no event id, so idempotency keys on
 *    `<transaction id>:<event type>` (a transaction legitimately produces
 *    `charge.success` and later `refund.processed`), falling back to a hash
 *    of the raw bytes when there is no transaction id;
 *  - the event lands UNATTRIBUTED. Attribution means resolving the payment
 *    reference to an intent, which is a cross-tenant read that only the
 *    worker role may perform (`worker_resolve`, migration 0010) — the API
 *    role deliberately cannot.
 */
@Controller('webhooks/paystack')
export class PaystackWebhookController {
  private readonly log = new Logger(PaystackWebhookController.name);

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest,
    @Headers('x-paystack-signature') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<{ received: true }> {
    const raw = request.rawBody;
    if (!raw || !verifyPaystackSignature(raw, signature, this.config.paystackSecretKey)) {
      /**
       * Rejected BEFORE persistence, for the same reason as Meta: this
       * endpoint is world-reachable, and "store it for forensics" hands
       * anyone an unbounded write into the database. The signature is the
       * admission check — and with no secret configured, everything is
       * rejected, which is the safe direction for a deployment that has not
       * turned payments on.
       */
      this.log.warn('rejected a Paystack webhook with an invalid signature');
      throw new UnauthorizedException('invalid signature');
    }

    const parsed = paystackWebhookBody.safeParse(body);
    if (!parsed.success) {
      // Still 200 — a signed body we cannot read will not parse on the retry
      // either, and providers escalate on anything else.
      this.log.warn('accepted a Paystack webhook whose shape we do not recognise');
      return { received: true };
    }

    const summary = summarisePaystackEvent(parsed.data);
    /**
     * No transaction id → hash the raw bytes. That still collapses
     * byte-identical redeliveries, and two DIFFERENT bodies without ids are
     * two events by any honest definition.
     */
    const externalId =
      summary.fingerprint ?? `sha256:${createHash('sha256').update(raw).digest('hex')}`;

    const recorded = await events.recordEvent(this.db, {
      provider: 'paystack',
      eventType: summary.eventType,
      externalId,
      // Sealed like every provider payload: Paystack bodies carry the payer's
      // email and name, and this is the one table outside row-level security.
      payload: sealPayload(parsed.data, this.config.vaultKey),
      businessId: null,
    });

    if (!recorded.isNew) {
      this.log.debug(`ignored a duplicate Paystack event ${redactForLog(externalId)}`);
    }

    return { received: true };
  }
}
