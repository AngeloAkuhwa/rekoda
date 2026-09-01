import { Inject, Injectable, Logger } from '@nestjs/common';
import { InvalidPhoneError, normalisePhone } from '@rekoda/core/identity';
import { redactForLog } from '@rekoda/core/privacy';
import type { InboundEvent } from '@rekoda/contracts';
import { events, identity, jobsRepo, wabaRepo, withBusiness, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB, WORKER_DB } from '../db/db.module.js';
import { JobKind } from '../jobs/queue.service.js';
import { sealPayload } from '../privacy/payload-vault.js';

/**
 * Turns an inbound Meta event into a durable, de-duplicated row.
 *
 * Everything here is cheap because the handler that calls it owes Meta
 * an answer within seconds, so this resolves the tenant, writes one row, and
 * stops — the actual understanding of the message belongs to a worker reading
 * the same table.
 */
@Injectable()
export class MetaIngressService {
  private readonly log = new Logger(MetaIngressService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WORKER_DB) private readonly workerDb: Db | null,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  async accept(event: InboundEvent, payload: unknown): Promise<{ isNew: boolean }> {
    /**
     * WHICH NUMBER the event arrived on decides everything (spec §24,
     * F.5): a message on a merchant's own WABA is a CUSTOMER of that
     * merchant, routed by `phoneNumberId → BusinessId` and nothing else.
     * The sender-based resolution below is for Rekoda's own Chat number,
     * where the sender IS the merchant.
     */
    if (event.kind === 'message' && event.phoneNumberId) {
      const routed = await this.routeMerchantWaba(event.phoneNumberId);
      if (routed) return this.acceptCustomerMessage(routed, event, payload);

      if (this.config.metaPhoneNumberId && event.phoneNumberId !== this.config.metaPhoneNumberId) {
        /**
         * An unknown phoneNumberId is REFUSED, never guessed (spec §24).
         * The tempting fallback — resolve by sender — is exactly the
         * guess: a customer of an unconnected WABA who happens to be a
         * Rekoda merchant themselves would have their message filed as
         * their own bookkeeping. Stored unattributed instead, durably,
         * where an operator can see the number nobody claimed.
         */
        return this.storeUnattributed(event, payload);
      }
      /* Rekoda's own number — or a deployment that has not pinned one
       * (dev, simulator), where the Chat path below remains the law. */
    }

    const businessId = await this.resolveBusiness(event.from);

    /**
     * Stored and queued in ONE transaction when there is work to queue.
     *
     * These used to be two commits, and the gap between them was a message
     * that could never be answered: recorded (so Meta's retry deduplicates
     * to nothing) with no job (so no handler ever opens it). A crash between
     * two statements in one transaction leaves nothing instead.
     */
    if (businessId && event.kind !== 'status') {
      return withBusiness(this.db, businessId, async (tx) => {
        const recorded = await events.recordEvent(tx, {
          provider: 'meta',
          eventType: `message.${event.messageType}`,
          externalId: event.externalId,
          payload: sealPayload(payload, this.config.vaultKey, 'meta', event.externalId),
          businessId,
        });
        if (!recorded.isNew) {
          this.log.debug(`ignored a duplicate Meta event ${redactForLog(event.externalId)}`);
          return { isNew: false };
        }
        await jobsRepo.enqueue(tx, {
          businessId,
          kind: JobKind.InboundMessage,
          payload: { eventId: recorded.id },
          singletonKey: recorded.id,
        });
        return { isNew: true };
      });
    }

    const recorded = await events.recordEvent(this.db, {
      provider: 'meta',
      eventType:
        event.kind === 'status' ? `status.${event.status}` : `message.${event.messageType}`,
      externalId: event.externalId,
      /**
       * Sealed, not stored raw.
       *
       * A Meta webhook body carries the merchant's message text and the
       * sender's number. Content like that belongs in the vault whatever
       * else guards the row, and `external_events` is a table an operator
       * reads across tenants by design. One AES-256-GCM encrypt costs
       * microseconds on a path that owes Meta an answer in seconds.
       */
      payload: sealPayload(payload, this.config.vaultKey, 'meta', event.externalId),
      businessId,
    });

    if (!recorded.isNew) {
      // Meta retries; this is the normal path, not an anomaly worth alarming on.
      this.log.debug(`ignored a duplicate Meta event ${redactForLog(event.externalId)}`);
      return { isNew: false };
    }

    /* Nothing to queue, deliberately. A delivery receipt has nothing to
     * understand, and a message from a stranger has no tenant to run under:
     * `jobs.business_id` is NOT NULL precisely so that "run this for nobody"
     * cannot be expressed. Both are durably stored; the reply layer picks up
     * the second when it exists. */
    return { isNew: true };
  }

  /**
   * `phoneNumberId → BusinessId`, answered pre-tenant on the worker
   * credential (the `worker_resolve` policy): a webhook names a number and
   * which business owns it is the ANSWER, not the input. Null means
   * refused — no credential to ask with, no row, or a connection in a
   * state that must not receive traffic.
   */
  private async routeMerchantWaba(
    phoneNumberId: string,
  ): Promise<{ businessId: string; connectionId: string } | null> {
    if (!this.workerDb) return null;
    const route = await wabaRepo.routeByPhoneNumberId(this.workerDb, phoneNumberId);
    if (!route) return null;
    /**
     * CONNECTED routes; UNHEALTHY still routes, because unhealthy is a
     * health-check verdict and the customer's message genuinely arrived.
     * PENDING_SIGNUP has no finished connection and REVOKED is a number
     * that is no longer this business's to receive on — both refuse, the
     * same refusal as an unknown number.
     */
    if (route.status !== 'CONNECTED' && route.status !== 'UNHEALTHY') return null;
    return { businessId: route.businessId, connectionId: route.connectionId };
  }

  /**
   * A customer message on a merchant's WABA: stored under the merchant's
   * tenant and queued for its OWN handler — never the interpreter's path,
   * which treats text as the merchant's bookkeeping instructions.
   */
  private async acceptCustomerMessage(
    routed: { businessId: string; connectionId: string },
    event: InboundEvent,
    payload: unknown,
  ): Promise<{ isNew: boolean }> {
    return withBusiness(this.db, routed.businessId, async (tx) => {
      const recorded = await events.recordEvent(tx, {
        provider: 'meta',
        eventType: `message.${event.messageType}`,
        externalId: event.externalId,
        payload: sealPayload(payload, this.config.vaultKey, 'meta', event.externalId),
        businessId: routed.businessId,
      });
      if (!recorded.isNew) {
        this.log.debug(`ignored a duplicate Meta event ${redactForLog(event.externalId)}`);
        return { isNew: false };
      }
      await jobsRepo.enqueue(tx, {
        businessId: routed.businessId,
        kind: JobKind.CustomerMessage,
        /* The channel asset and connection, never the sender's number —
         * the handler re-reads the sealed payload for that (F.3). */
        payload: {
          eventId: recorded.id,
          connectionId: routed.connectionId,
          phoneNumberId: event.phoneNumberId,
        },
        singletonKey: recorded.id,
      });
      return { isNew: true };
    });
  }

  /** Durably stored, attributed to nobody, and no job: refused, not lost. */
  private async storeUnattributed(
    event: InboundEvent,
    payload: unknown,
  ): Promise<{ isNew: boolean }> {
    const recorded = await events.recordEvent(this.db, {
      provider: 'meta',
      eventType: `message.${event.messageType}`,
      externalId: event.externalId,
      payload: sealPayload(payload, this.config.vaultKey, 'meta', event.externalId),
      businessId: null,
    });
    if (!recorded.isNew) {
      this.log.debug(`ignored a duplicate Meta event ${redactForLog(event.externalId)}`);
    }
    return { isNew: recorded.isNew };
  }

  /**
   * Sender phone → user → membership → business.
   *
   * Returns null rather than throwing when the number belongs to nobody. A
   * stranger messaging Rekoda's number is an ordinary event — the message is
   * still stored, unattributed, so the reply layer can offer to sign them up
   * rather than dropping them silently.
   *
   * A user in more than one business is ambiguous and is NOT guessed at: the
   * first membership would be a coin toss that could file a sale in the wrong
   * set of books. The event lands unattributed and a human is asked which.
   */
  private async resolveBusiness(from: string): Promise<string | null> {
    let phone: string;
    try {
      phone = normalisePhone(from);
    } catch (error) {
      if (error instanceof InvalidPhoneError) return null;
      throw error;
    }

    const user = await identity.findUserByPhone(this.db, phone);
    if (!user) return null;

    const memberships = await identity.membershipsForUser(this.db, user.id);
    if (memberships.length !== 1) return null;
    return memberships[0]!.businessId;
  }
}
