import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { answerVerificationChallenge, verifyMetaSignature } from '@rekoda/core/webhooks';
import { redactForLog } from '@rekoda/core/privacy';
import { extractInboundEvents, metaWebhookBody } from '@rekoda/contracts';
import { CONFIG, type ApiConfig } from '../config.js';
import { MetaIngressService } from './meta.service.js';
import { SecurityMetrics } from './security-metrics.service.js';

/** Fastify hands us the raw body via the hook registered in main.ts. */
interface RawBodyRequest {
  rawBody?: Buffer;
}

@Controller('webhooks/meta')
export class MetaWebhookController {
  private readonly log = new Logger(MetaWebhookController.name);

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(MetaIngressService) private readonly ingress: MetaIngressService,
    @Inject(SecurityMetrics) private readonly security: SecurityMetrics,
  ) {}

  /**
   * Meta's subscription handshake. Echoes `hub.challenge` when the token
   * matches, and says nothing useful when it does not.
   */
  @Get()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    // Spread rather than passing `undefined` explicitly — under
    // exactOptionalPropertyTypes an absent property and one set to undefined
    // are different types.
    const answer = answerVerificationChallenge(
      {
        ...(mode === undefined ? {} : { mode }),
        ...(token === undefined ? {} : { token }),
        ...(challenge === undefined ? {} : { challenge }),
      },
      this.config.metaVerifyToken,
    );
    if (!answer) throw new UnauthorizedException('verification failed');
    return answer;
  }

  /**
   * Ingress. The order is fixed and each step exists for a reason:
   *
   *   signature → parse → idempotency → tenant → persist → 200
   *
   * Nothing is processed inline. Meta expects an acknowledgement within
   * seconds and retries anything slower, so the handler's entire job is to
   * get the event durably recorded and answer — the work happens after.
   */
  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<{ received: true }> {
    /**
     * Verified against the RAW bytes, before anything re-serialises them.
     * `JSON.parse` then `JSON.stringify` is not the identity function — key
     * order, whitespace and unicode escaping all shift — so hashing the parsed
     * object would fail for every legitimate request.
     */
    const raw = request.rawBody;
    if (!raw || !verifyMetaSignature(raw, signature, this.config.metaAppSecret)) {
      /**
       * Rejected before persistence.
       *
       * Storing unsigned payloads for forensics sounds prudent and is not:
       * this endpoint is unauthenticated and world-reachable, so it would hand
       * anyone an unbounded write into our database. The signature IS the
       * admission check.
       */
      this.security.rejectedSignature('meta');
      this.log.warn('rejected a Meta webhook with an invalid signature');
      throw new UnauthorizedException('invalid signature');
    }

    const parsed = metaWebhookBody.safeParse(body);
    if (!parsed.success) {
      // Still 200. Meta retries anything else, escalating until it disables
      // the webhook — and a payload we cannot read will not parse next time
      // either, so a retry storm buys nobody anything.
      this.log.warn('accepted a Meta webhook whose shape we do not recognise');
      return { received: true };
    }

    const events = extractInboundEvents(parsed.data);
    let failed = 0;
    for (const event of events) {
      try {
        await this.ingress.accept(event, parsed.data);
      } catch (error) {
        failed += 1;
        this.log.error(
          `failed to accept a Meta event: ${redactForLog(String((error as Error)?.message ?? error))}`,
        );
      }
    }

    /**
     * A failure here answers NON-200, deliberately. This used to swallow the
     * error and acknowledge, which told Meta never to redeliver a message
     * that was never stored — a merchant's sale, gone because the database
     * blinked for one request. Meta retries the whole batch on a failure,
     * and the events that DID land deduplicate to nothing on the way back
     * in, so the only thing a retry can do is save the ones that did not.
     */
    if (failed > 0) {
      throw new ServiceUnavailableException(`${failed} of ${events.length} events not stored`);
    }
    return { received: true };
  }
}
