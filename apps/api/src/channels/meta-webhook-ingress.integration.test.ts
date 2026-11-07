/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: webhook ingress: the body ceiling, the handshake, signatures, idempotency,
 * routing and storage. Split by concern from meta.integration.test.ts; the shared app, stubs and
 * payload helpers are in meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  events,
  identity,
  jobsRepo,
  schema,
  wabaRepo,
  withBusiness,
  sql,
} from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import { participantIndexFor, PARTICIPANT_INDEX_KEY_VERSION } from '@rekoda/core/vault';
import { SecurityMetrics } from './security-metrics.service.js';
import {
  VERIFY_TOKEN,
  app,
  db,
  deps,
  messagePayload,
  post,
  statusPayload,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

describe('webhook body ceiling', () => {
  /**
   * The webhooks are exempt from the per-IP limiter, so an oversized body
   * must be refused before it is parsed or an HMAC is computed. A body past
   * the 128 KB cap comes back 413, whatever it carries.
   */
  it('refuses a body larger than the cap with 413, before parsing', async () => {
    const huge = 'x'.repeat(200 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      payload: huge,
      headers: { 'content-type': 'application/json', 'content-length': String(huge.length) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('still accepts a normal signed payload', async () => {
    const res = await post({ object: 'whatsapp_business_account', entry: [] });
    expect(res.statusCode).toBe(200);
  });

  /**
   * The cap is only real if it cannot be sidestepped by dropping the header.
   * A chunked request with no Content-Length would otherwise reach the 2 MB
   * global bodyLimit - sixteen times the webhook cap - on the one
   * unauthenticated surface. Real providers always declare a length; a
   * webhook that does not is refused with 411 before the body is read.
   */
  it('refuses a webhook with no Content-Length with 411, before parsing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    });
    expect(res.statusCode).toBe(411);
  });
});

describe('the subscription handshake', () => {
  it('echoes the challenge for the right token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
  });

  it('refuses the wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('signature verification', () => {
  it('accepts a correctly signed payload', async () => {
    const res = await post(messagePayload('2348031234567', 'wamid.A1'));
    expect(res.statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('rejects an unsigned payload and stores nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      payload: JSON.stringify(messagePayload('2348031234567', 'wamid.A2')),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
    // The endpoint is unauthenticated and world-reachable. Persisting
    // unsigned payloads "for forensics" would be an unbounded write for
    // anyone who finds the URL.
    expect(await events.eventCount(db)).toBe(0);
  });

  it('rejects a payload signed with someone else key', async () => {
    const res = await post(messagePayload('2348031234567', 'wamid.A3'), { secret: 'not-ours' });
    expect(res.statusCode).toBe(401);
    expect(await events.eventCount(db)).toBe(0);
  });

  it('rejects a body altered in flight, even by one byte', async () => {
    const res = await post(messagePayload('2348031234567', 'wamid.A4'), { corrupt: true });
    expect(res.statusCode).toBe(401);
    expect(await events.eventCount(db)).toBe(0);
  });

  it('counts a rejected signature so the ops alarm can fire (PR-108)', async () => {
    // The DB `badSignatures` is a structural zero (rejection is pre-persist);
    // the live counter is what an operator polling /v1/ops/health reads.
    const security = app.get(SecurityMetrics);
    const before = security.rejectedSignatures('meta');
    const res = await post(messagePayload('2348031234567', 'wamid.A5'), { secret: 'not-ours' });
    expect(res.statusCode).toBe(401);
    expect(security.rejectedSignatures('meta')).toBe(before + 1);
  });
});

describe('idempotency', () => {
  it('stores one row however many times Meta retries', async () => {
    const payload = messagePayload('2348031234567', 'wamid.RETRY');
    for (let i = 0; i < 4; i++) expect((await post(payload)).statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('holds under CONCURRENT delivery of the same message', async () => {
    // Meta retries in parallel. A select-then-insert loses this race and
    // records the same sale twice — the failure the unique constraint exists
    // to make impossible.
    const payload = messagePayload('2348031234567', 'wamid.PARALLEL');
    const results = await Promise.all(Array.from({ length: 8 }, () => post(payload)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('keeps sent, delivered and read apart', async () => {
    await post({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.S', status: 'sent' },
                  { id: 'wamid.S', status: 'delivered' },
                  { id: 'wamid.S', status: 'read' },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(await events.eventCount(db)).toBe(3);
  });
});

describe('phoneNumberId → BusinessId routing (spec §24; PR-059)', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  async function connectWabaFor(businessId: string, phoneNumberId: string) {
    return withBusiness(db, businessId, (tx) =>
      wabaRepo.connectWaba(tx, {
        businessId,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: 'cipher-for-tests',
        tokenTail: '4821',
      }),
    );
  }

  it("routes a customer's message to the WABA's owner and onto the customer's own thread", async () => {
    const merchant = await seedMerchant('+2348030001111', 'Ada Fashion');
    await connectWabaFor(merchant.id, 'PN-ADA-1');

    const res = await post(
      messagePayload('2349097775555', 'wamid.CUST.1', 'do you have the bone straight?', 'PN-ADA-1'),
    );
    expect(res.statusCode).toBe(200);

    /* The job is the customer handler's, never the interpreter's. */
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubTransport.requests).toHaveLength(0);

    const expectedIndex = participantIndexFor(deps.config.matchKey, {
      businessId: merchant.id,
      channelAccountId: 'PN-ADA-1',
      keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      normalisedParticipant: '+2349097775555',
    });
    const thread = await withBusiness(db, merchant.id, (tx) =>
      conversationsRepo.messagesForThread(tx, {
        kind: 'CUSTOMER',
        businessId: merchant.id,
        channel: 'meta',
        channelAccountId: 'PN-ADA-1',
        participantBlindIndex: expectedIndex,
        participantIndexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      }),
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.body).toBe('do you have the bone straight?');

    /* The raw number never landed in the conversation index (F.3/F.4). */
    const raw = await withBusiness(db, merchant.id, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM conversations
        WHERE participant_blind_index LIKE '%2349097775555%'
      `),
    );
    expect([...raw][0]!.n).toBe(0);

    /* And the merchant's own Chat thread heard nothing. */
    const merchantThread = await withBusiness(db, merchant.id, (tx) =>
      conversationsRepo.messagesForThread(tx, {
        kind: 'MERCHANT',
        businessId: merchant.id,
        channel: 'meta',
      }),
    );
    expect(merchantThread).toHaveLength(0);
  });

  it("a customer's message OPENS their 24-hour window (§24; PR-061)", async () => {
    const merchant = await seedMerchant('+2348030005555', 'Efe Fabrics');
    await connectWabaFor(merchant.id, 'PN-EFE-1');

    await post(messagePayload('2349097778888', 'wamid.WIN.1', 'good evening', 'PN-EFE-1'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /* Keyed by the SAME F.4-scoped blind index the thread routes by, and
     * expiring 24 hours out by its own clock. */
    const hash = participantIndexFor(deps.config.matchKey, {
      businessId: merchant.id,
      channelAccountId: 'PN-EFE-1',
      keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      normalisedParticipant: '+2349097778888',
    });
    const open = await withBusiness(db, merchant.id, async (tx) => {
      const connection = await wabaRepo.wabaConnectionFor(tx, merchant.id);
      return wabaRepo.serviceWindowOpen(tx, {
        businessId: merchant.id,
        wabaConnectionId: connection!.id,
        customerHash: hash,
      });
    });
    expect(open).toBe(true);
  });

  it('an unknown phoneNumberId is refused, never guessed by the sender (§24, pinned)', async () => {
    /* The sender IS a merchant — the exact person a sender-based fallback
     * would misfile. Their customer-of-somebody message must not become
     * their own bookkeeping. */
    const merchant = await seedMerchant('+2348030002222', 'Bola Threads');

    const res = await post(
      messagePayload('2348030002222', 'wamid.UNROUTED.1', 'sold 3 wigs', 'PN-NOBODY'),
    );
    expect(res.statusCode).toBe(200);

    /* Stored, durably, attributed to nobody; no job to run. */
    expect(await events.unattributedEvents(workerDb, 'meta')).toHaveLength(1);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
    const heard = await withBusiness(db, merchant.id, (tx) =>
      conversationsRepo.messagesFor(tx, merchant.id),
    );
    expect(heard).toHaveLength(0);
  });

  it('a revoked connection refuses like an unknown number', async () => {
    const merchant = await seedMerchant('+2348030003333', 'Chidi Stores');
    await connectWabaFor(merchant.id, 'PN-CHIDI-1');
    await withBusiness(db, merchant.id, async (tx) => {
      const connection = await wabaRepo.wabaConnectionFor(tx, merchant.id);
      await wabaRepo.markWabaStatus(tx, {
        businessId: merchant.id,
        connectionId: connection!.id,
        status: 'REVOKED',
      });
    });

    await post(messagePayload('2349097776666', 'wamid.REVOKED.1', 'hello', 'PN-CHIDI-1'));

    expect(await events.unattributedEvents(workerDb, 'meta')).toHaveLength(1);
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
  });

  it('two customers on one WABA get two threads; the same customer returns to theirs', async () => {
    const merchant = await seedMerchant('+2348030004444', 'Ngozi Beauty');
    await connectWabaFor(merchant.id, 'PN-NGOZI-1');

    await post(
      messagePayload('2349091110001', 'wamid.TWO.1', 'price of the 22 inch?', 'PN-NGOZI-1'),
    );
    await post(messagePayload('2349091110002', 'wamid.TWO.2', 'is the shop open?', 'PN-NGOZI-1'));
    await post(messagePayload('2349091110001', 'wamid.TWO.3', 'and in brown?', 'PN-NGOZI-1'));
    const runner = buildRunner(workerDb, db, deps);
    while (await runner.runOnce()) {
      /* drain the queue */
    }

    const threads = await withBusiness(db, merchant.id, (tx) =>
      tx.execute<{ id: string; n: number }>(sql`
        SELECT c.id, count(m.id)::int AS n
        FROM conversations c LEFT JOIN conversation_messages m ON m.conversation_id = c.id
        WHERE c.conversation_kind = 'CUSTOMER'
        GROUP BY c.id ORDER BY n DESC
      `),
    );
    const counts = [...threads].map((t) => t.n);
    expect(counts).toEqual([2, 1]);
  });
});

describe('tenant resolution', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('attributes a message to the sender business', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.OWNED'));

    const [row] = await events.unprocessedEvents(workerDb, 'meta');
    expect(row?.businessId).toBe(business.id);
  });

  it('stores a stranger message unattributed rather than dropping it', async () => {
    // Someone messaging Rekoda who has no account is an ordinary event, and
    // the reply layer should be able to offer them a signup.
    await post(messagePayload('2349099999999', 'wamid.STRANGER'));
    const [row] = await events.unprocessedEvents(workerDb, 'meta');
    expect(row).toBeDefined();
    expect(row?.businessId).toBeNull();
  });

  it('refuses to guess when a user has more than one business', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
    await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await identity.createBusinessWithOwner(db, {
      name: 'Ada Logistics',
      businessType: null,
      ownerUserId: user.id,
    });

    await post(messagePayload('2348031234567', 'wamid.AMBIGUOUS'));

    // Picking the first membership is a coin toss that could file a sale into
    // the wrong set of books. Unattributed, for a human to resolve.
    const [row] = await events.unprocessedEvents(workerDb, 'meta');
    expect(row?.businessId).toBeNull();
  });
});

describe('what happens after the 200', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('queues the message for a worker rather than processing it inline', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.QUEUED'));

    const queued = await withBusiness(db, business.id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'inbound.message', state: 'pending' });
  });

  /* `hasEarlierLiveJobByArrival` orders answers by the job's `created_at` and is described as
   * webhook arrival order (OWN-74). That holds because this, the only producer of
   * `inbound.message` jobs, stamps the event and the job with one `stampInboundArrival` reading
   * in the transaction that writes them: the two instants are the same value. */
  it('stamps the queued job with its webhook event’s arrival instant', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ARRIVAL.1'));
    await post(messagePayload('2348031234567', 'wamid.ARRIVAL.2'));

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ same: boolean }>(sql`
        SELECT j.created_at = e.created_at AS same
          FROM jobs j JOIN external_events e ON e.id = (j.payload->>'eventId')::uuid
         WHERE j.kind = 'inbound.message'`),
    );
    expect([...rows].map((r) => r.same)).toEqual([true, true]);
  });

  /* One body carrying a "cancel" then a "yes": if the first cannot get the ingress lock, the second
   * must not be stored ahead of it, whether it comes from the same member or another member of the
   * business. Meta redelivers the whole body on the non-200, and the redelivery stamps them in
   * sending order (independent review and CodeRabbit on #428). */
  it.each([
    ['the same member', '2348031234567'],
    ['another member of the business', '2348039990002'],
  ])(
    'does not store a later message of a batch after an earlier one failed (%s)',
    async (_who, laterFrom) => {
      const business = await seedMerchant('+2348031234567', 'Ada Fashion');
      const delegate = await identity.upsertUserByPhone(db, '+2348039990002');
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      const body = messagePayload('2348031234567', 'wamid.BATCH.A', 'cancel');
      body.entry[0]!.changes[0]!.value.messages.push({
        id: 'wamid.BATCH.B',
        from: laterFrom,
        timestamp: '1700000001',
        type: 'text',
        text: { body: 'yes' },
      });
      const stored = async () => {
        const rows = await withBusiness(db, business.id, (tx) =>
          tx.execute<{ external_id: string }>(sql`
          SELECT external_id FROM external_events
           WHERE business_id = ${business.id}::uuid ORDER BY created_at`),
        );
        return [...rows].map((r) => r.external_id);
      };

      /* Hold the business's ingress lock past the 2 s bound while the batch arrives. */
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = withBusiness(db, business.id, async (tx) => {
        await jobsRepo.serializeBusiness(tx, business.id, 'ingress');
        locked();
        await held;
      });
      try {
        await isLocked;
        /* Freed shortly after the first message's 2 s bound runs out, so a later message that is
         * (wrongly) attempted would get the lock. */
        const timer = setTimeout(release, 2_400);
        const first = await post(body);
        clearTimeout(timer);
        expect(first.statusCode).toBe(503);
      } finally {
        release();
        await holder;
      }
      expect(await stored()).toEqual([]);

      const second = await post(body);
      expect(second.statusCode).toBe(200);
      expect(await stored()).toEqual(['wamid.BATCH.A', 'wamid.BATCH.B']);
    },
  );

  it('runs that job and closes the event out', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.QUEUED'));

    // The registry the deploy uses, not a test-local one.
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // `unprocessedEvents` is the backlog. Empty means the loop closed.
    expect(await events.unprocessedEvents(workerDb, 'meta')).toHaveLength(0);
    const [job] = await withBusiness(db, business.id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(job).toMatchObject({ state: 'done' });
  });

  it('queues nothing for a stranger — there is no tenant to run as', async () => {
    await post(messagePayload('2349099999999', 'wamid.STRANGER'));
    // `jobs.business_id` is NOT NULL, so "run this for nobody" is not
    // expressible. The event is still stored for the reply layer.
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
  });

  it('queues nothing for a delivery receipt — there is nothing to understand', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(statusPayload('2348031234567', 'wamid.SENT', 'delivered'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
  });

  it('queues ONE job when Meta delivers the same message eight times', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await Promise.all(
      Array.from({ length: 8 }, () => post(messagePayload('2348031234567', 'wamid.RETRIED'))),
    );

    // Two independent guards have to hold at once here: the unique index on
    // (provider, external_id), and the singleton key on the job. Recording a
    // sale twice is the failure this whole path exists to prevent.
    const queued = await withBusiness(db, business.id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(queued).toHaveLength(1);
  });
});

describe('nothing raw is stored', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('seals the webhook payload — the message text never lands in plaintext', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(
      messagePayload('2348031234567', 'wamid.SEALED', 'Ada 08039998888 bought 3 wigs for 150k'),
    );

    const [row] = await events.unprocessedEvents(workerDb, 'meta');
    const stored = JSON.stringify(row?.payload);

    /**
     * Storing a Meta body verbatim put the merchant's message AND the
     * sender's number in plaintext — while the table's own comment claimed
     * PII was redacted at write time. The seal is what makes that true. It is
     * not a substitute for the tenant policy 0130 added, nor made redundant
     * by it: the worker reads this table across every tenant by design.
     */
    expect(stored).not.toContain('bought 3 wigs');
    expect(stored).not.toContain('08039998888');
    expect(stored).not.toContain('2348031234567');
    expect(stored).toContain('sealed');
  });

  it('records a DETERMINISTIC message as its classification, not its words', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes please'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    // Inbound plus the reply it earned. The inbound one is what this asserts.
    expect(messages[0]).toMatchObject({ direction: 'inbound', body: '[affirm]' });

    // And the gateway never ran: no customer, no vault write, nothing left.
    const customers = await withBusiness(db, business.id, (tx) =>
      tx.select().from(schema.customers),
    );
    expect(customers).toHaveLength(0);
  });

  it('records everything else TOKENISED', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.SALE', 'Ada 08039998888 bought 3 wigs'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const [message] = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(message!.body).not.toContain('08039998888');
    expect(message!.body).toMatch(/CUSTOMER_[0-9A-Z]{3}/);
    // The goods and the count survive — they are the whole point of the message.
    expect(message!.body).toContain('3 wigs');
  });

  it('writes one conversation row when the same message is delivered twice', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ONCE', 'yes'));

    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);
    // A reclaimed lock or a re-enqueued job must not double the history.
    await withBusiness(db, business.id, (tx) =>
      conversationsRepo.recordInbound(tx, {
        businessId: business.id,
        channel: 'meta',
        kind: 'text',
        body: '[affirm]',
        providerMessageId: 'wamid.ONCE',
      }),
    );

    const inbound = (
      await withBusiness(db, business.id, (tx) => conversationsRepo.messagesFor(tx, business.id))
    ).filter((m) => m.direction === 'inbound');
    expect(inbound).toHaveLength(1);
  });
});
