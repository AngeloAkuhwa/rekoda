import { Inject, Injectable, Logger } from '@nestjs/common';
import { InvalidPhoneError, normalisePhone } from '@rekoda/core/identity';
import { redactForLog } from '@rekoda/core/privacy';
import type { InboundEvent } from '@rekoda/contracts';
import { events, identity, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { JobKind, JobQueue } from '../jobs/queue.service.js';
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
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  async accept(event: InboundEvent, payload: unknown): Promise<{ isNew: boolean }> {
    const businessId = await this.resolveBusiness(event.from);

    const recorded = await events.recordEvent(this.db, {
      provider: 'meta',
      eventType:
        event.kind === 'status' ? `status.${event.status}` : `message.${event.messageType}`,
      externalId: event.externalId,
      /**
       * Sealed, not stored raw.
       *
       * `external_events` is the one table with row-level security
       * deliberately off — an event arrives before its tenant is known. A Meta
       * webhook body carries the merchant's message text and the sender's
       * number, so storing it verbatim would put both in plaintext in the
       * least protected table we have. One AES-256-GCM encrypt costs
       * microseconds on a path that owes Meta an answer in seconds.
       */
      payload: sealPayload(payload, this.config.vaultKey),
      businessId,
    });

    if (!recorded.isNew) {
      // Meta retries; this is the normal path, not an anomaly worth alarming on.
      this.log.debug(`ignored a duplicate Meta event ${redactForLog(event.externalId)}`);
      return { isNew: false };
    }

    /**
     * Queue the work, and only for a message we can attribute.
     *
     * Two silences here are deliberate. A delivery receipt has nothing to
     * understand, and a message from a stranger has no tenant to run under —
     * `jobs.business_id` is NOT NULL precisely so that "run this for nobody"
     * cannot be expressed. Both are already durably stored; the reply layer
     * picks up the second when it exists.
     *
     * The singleton key is the event id, so a retry that races past the
     * `external_events` unique index still cannot produce two jobs.
     */
    if (businessId && event.kind !== 'status') {
      await this.queue.enqueue({
        businessId,
        kind: JobKind.InboundMessage,
        payload: { eventId: recorded.id },
        singletonKey: recorded.id,
      });
    }

    return { isNew: true };
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
