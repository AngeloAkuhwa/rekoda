/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: delivery statuses, unusable messages, records and resend. Split by concern
 * from meta.integration.test.ts; the shared app, stubs and payload helpers are in meta-
 * webhook.fixtures.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  createDb,
  events,
  identity,
  jobsRepo,
  wabaRepo,
  withBusiness,
  sql,
  type Db,
} from '@rekoda/db';
import { TRIAL_DAYS } from '@rekoda/core';
import { buildRunner } from '../jobs/jobs.module.js';
import { issueRepo, spendRepo } from '@rekoda/db';
import { StubSender } from '../channels/sender.stub.js';
import { sweepTrialNotices } from '../billing/trial-notice-sweep.js';
import {
  db,
  deps,
  messagePayload,
  post,
  statusPayload,
  stubSender,
  stubTransport,
  urls,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

describe('a trial reminder Meta later reports as failed (REM-01, G-109)', () => {
  /* Rekoda's own number sends the reminder to the OWNER, so Meta's receipt names the
   * owner as `recipient_id` on PNID: the same attribution an owner's own message gets. */
  const DAY = 86_400_000;
  const start = new Date('2026-11-02T09:00:00Z');
  const at = (days: number): Date => new Date(start.getTime() + days * DAY);
  let ownerDb: Db;
  let closeOwnerDb: () => Promise<void>;

  beforeAll(() => {
    ({ db: ownerDb, close: closeOwnerDb } = createDb(urls.owner, { max: 2 }));
  });
  afterAll(async () => {
    await closeOwnerDb?.();
  });

  async function seedTrial(phone: string, name: string): Promise<string> {
    const user = await identity.upsertUserByPhone(db, phone);
    const business = await identity.createBusinessWithOwner(db, {
      name,
      businessType: null,
      ownerUserId: user.id,
    });
    const expiry = new Date(start.getTime() + TRIAL_DAYS * DAY);
    await ownerDb.execute(
      sql`UPDATE businesses SET plan = 'trial', plan_expires_at = ${expiry.toISOString()}::timestamptz WHERE id = ${business.id}::uuid`,
    );
    return business.id;
  }

  async function noticeOf(id: string) {
    const rows = await ownerDb.execute<{
      stage: number | null;
      state: string | null;
      wamid: string | null;
      failed_at: string | null;
    }>(sql`
      SELECT last_trial_notice_stage AS stage, trial_notice_state AS state,
             trial_notice_provider_message_id AS wamid,
             trial_notice_failed_at::text AS failed_at
      FROM businesses WHERE id = ${id}::uuid
    `);
    return [...rows][0]!;
  }

  const sweep = (sender: StubSender, now: Date) =>
    sweepTrialNotices(
      { workerDb, appDb: db, sender, templateConfigured: true, fxNairaPerUsd: 1500 },
      now,
    );

  /** Run the queue dry, so a receipt's job has certainly been handled. */
  async function drain(): Promise<void> {
    const runner = buildRunner(workerDb, db, deps);
    while (await runner.runOnce()) {
      /* keep going */
    }
  }

  it('marks the reminder undelivered, and the receipt processed', async () => {
    const id = await seedTrial('+2348031230001', 'Trial Fail Ltd');
    const sender = new StubSender();
    await sweep(sender, at(7));
    const sent = await noticeOf(id);
    expect(sent).toMatchObject({ stage: 1, state: 'sent' });

    await post(statusPayload('2348031230001', sent.wamid!, 'failed'));
    await drain();

    const after = await noticeOf(id);
    expect(after).toMatchObject({ stage: 1, state: 'undelivered', wamid: sent.wamid });
    expect(after.failed_at).not.toBeNull();
    expect(await events.unprocessedEvents(workerDb, 'meta')).toHaveLength(0);
  });

  it("changes nothing for an unrelated wamid or another business's wamid", async () => {
    const a = await seedTrial('+2348031230002', 'Trial A Ltd');
    const b = await seedTrial('+2348031230003', 'Trial B Ltd');
    const sender = new StubSender();
    await sweep(sender, at(7));
    const beforeA = await noticeOf(a);
    const beforeB = await noticeOf(b);
    expect(beforeA.state).toBe('sent');
    expect(beforeB.state).toBe('sent');
    expect(beforeA.wamid).not.toBe(beforeB.wamid);

    /* Attributed to A, naming B's reminder: A's wamid does not match, and B is never
     * reached from A's tenant. */
    await post(statusPayload('2348031230002', beforeB.wamid!, 'failed'));
    await post(statusPayload('2348031230002', 'wamid.UNRELATED', 'failed'));
    await drain();

    expect(await noticeOf(a)).toEqual(beforeA);
    expect(await noticeOf(b)).toEqual(beforeB);
  });

  it('applies a duplicate failed receipt once', async () => {
    const id = await seedTrial('+2348031230004', 'Trial Dup Ltd');
    await sweep(new StubSender(), at(7));
    const { wamid } = await noticeOf(id);

    await post(statusPayload('2348031230004', wamid!, 'failed'));
    await drain();
    const first = await noticeOf(id);
    expect(first.state).toBe('undelivered');

    await post(statusPayload('2348031230004', wamid!, 'failed'));
    await drain();
    expect(await noticeOf(id)).toEqual(first);
    const jobs = await withBusiness(db, id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(jobs.filter((job) => job.kind === 'delivery.status')).toHaveLength(1);
  });

  it('does not resend the failed stage, and still sends the next one', async () => {
    const id = await seedTrial('+2348031230005', 'Trial Next Ltd');
    const sender = new StubSender();
    await sweep(sender, at(7));
    const { wamid } = await noticeOf(id);
    await post(statusPayload('2348031230005', wamid!, 'failed'));
    await drain();
    expect((await noticeOf(id)).state).toBe('undelivered');

    await sweep(sender, at(7) /* same day */);
    await sweep(sender, at(9));
    expect(sender.trialNotices).toHaveLength(1);

    await sweep(sender, at(12));
    expect(sender.trialNotices.map((n) => n.daysLeft)).toEqual(['7', '2']);
    const next = await noticeOf(id);
    expect(next).toMatchObject({ stage: 2, state: 'sent', failed_at: null });
    expect(next.wamid).not.toBe(wamid);

    /* A late receipt for the stage-1 message does not touch the stage-2 record. */
    await post(statusPayload('2348031230005', wamid!, 'failed'));
    await drain();
    expect(await noticeOf(id)).toEqual(next);
  });
});

describe('acknowledging things we cannot use', () => {
  it('answers 200 to a payload whose shape we do not recognise', async () => {
    // Meta retries anything else, escalating until it disables the webhook.
    const res = await post({ object: 'whatsapp_business_account', entry: 'not-an-array' });
    expect(res.statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(0);
  });

  it('answers 200 to an empty envelope', async () => {
    expect((await post({ entry: [] })).statusCode).toBe(200);
  });
});

describe('records, resend and messages Rekoda cannot read', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  function audioPayload(waId: string, wamid: string) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'PNID' },
                messages: [{ id: wamid, from: waId, timestamp: '1700000000', type: 'audio' }],
              },
            },
          ],
        },
      ],
    };
  }

  it('answers "records" with real month figures and no model call', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await withBusiness(db, business.id, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId: business.id,
        description: 'fuel',
        category: null,
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd-rec',
      }),
    );
    await post(messagePayload('2348031234567', 'wamid.REC', 'records'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Your books this month');
    expect(stubSender.lastText).toContain('Money out ₦12,000');
    expect(stubTransport.requests).toHaveLength(0);
  });

  it('says the books are empty rather than reciting four zeros', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.REC0', 'records'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Nothing in your books yet this month');
    expect(stubSender.lastText).not.toMatch(/₦/);
  });

  it('"resend" queues the newest document back through delivery, exactly once', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const doc = await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'invoice_pdf',
        storageKey: 'test/unguessable-1',
        refNumber: 'INV-2026-000007',
        bytes: 1234,
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.RESEND', 'resend'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Sending INV-2026-000007 again');

    const queued = await withBusiness(db, business.id, (tx) =>
      jobsRepo.jobsForBusiness(tx, 'document.deliver'),
    );
    expect(queued).toHaveLength(1);
    expect(doc.id).toBeTruthy();
  });

  it('"resend" with nothing ever issued is an honest miss', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.RESEND0', 'resend'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('no document to resend yet');
  });

  /**
   * An audio message with NO media id: nothing to fetch, so nothing to
   * transcribe. Voice notes that carry one take the transcription path (see
   * the "a voice note" suite); this is the malformed remainder, and it still
   * must never become a paid model call on silence.
   */
  it('a voice note with nothing to fetch gets an honest sentence', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(audioPayload('2348031234567', 'wamid.VOICE'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('listen to voice notes');
    // The whole point: silence never becomes a paid interpretation call.
    expect(stubTransport.requests).toHaveLength(0);

    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    // Recorded as what it was, not as empty text.
    expect(messages[0]?.body).toBe('[audio message]');
  });
});

describe('delivery statuses are read, not just stored (G-20)', () => {
  async function seedMerchantWaba(phone: string, phoneNumberId: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await withBusiness(db, business.id, (tx) =>
      wabaRepo.connectWaba(tx, {
        businessId: business.id,
        wabaId: `waba-${phoneNumberId}`,
        phoneNumberId,
        accessTokenCipher: 'cipher-for-tests',
        tokenTail: '4821',
      }),
    );
    return business.id;
  }

  const statusOn = (phoneNumberId: string, recipientId: string, wamid: string, status: string) => {
    const payload = statusPayload(recipientId, wamid, status);
    payload.entry[0]!.changes[0]!.value.metadata.phone_number_id = phoneNumberId;
    return payload;
  };

  it('counts a failed delivery on the ops health surface', async () => {
    await post(statusPayload('2348031230001', 'wamid.F1', 'failed'));
    await post(statusPayload('2348031230001', 'wamid.F1', 'delivered'));

    const health = await events.eventHealth(db, 'meta');
    expect(health.deliveryFailures).toBe(1);
  });

  it('does not leave receipts as an unprocessed backlog', async () => {
    await post(statusPayload('2348031230002', 'wamid.F2', 'sent'));
    await post(statusPayload('2348031230002', 'wamid.F2', 'failed'));

    const health = await events.eventHealth(db, 'meta');
    expect(health.unprocessed).toBe(0);
  });

  it('files a merchant-WABA status under the number’s owner, never the recipient', async () => {
    const owner = await seedMerchantWaba('+2348030009001', 'PN-STATUS-A');
    /* The CUSTOMER being messaged happens to be another Rekoda merchant. */
    const other = await identity.upsertUserByPhone(db, '+2348030009002');
    const otherBusiness = await identity.createBusinessWithOwner(db, {
      name: 'Other Shop',
      businessType: null,
      ownerUserId: other.id,
    });

    await post(statusOn('PN-STATUS-A', '2348030009002', 'wamid.CROSS', 'failed'));

    const countFor = (businessId: string) =>
      withBusiness(db, businessId, async (tx) => {
        const rows = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM external_events
               WHERE external_id = 'wamid.CROSS:failed'`,
        );
        return [...rows][0]?.n ?? 0;
      });
    expect(await countFor(owner)).toBe(1);
    expect(await countFor(otherBusiness.id)).toBe(0);
  });

  it('leaves a status with a missing or unclaimed phoneNumberId unattributed', async () => {
    /* A Rekoda merchant who is only the RECIPIENT of someone else's message. */
    const user = await identity.upsertUserByPhone(db, '+2348030009101');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Recipient Shop',
      businessType: null,
      ownerUserId: user.id,
    });

    const noNumber = statusPayload('2348030009101', 'wamid.NONUM', 'failed');
    delete (noNumber.entry[0]!.changes[0]!.value as { metadata?: unknown }).metadata;
    await post(noNumber);
    await post(statusOn('PN-UNCLAIMED', '2348030009101', 'wamid.UNCLAIMED', 'failed'));

    const attributed = await withBusiness(db, business.id, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM external_events WHERE external_id LIKE 'wamid.%:failed'
                 AND business_id = ${business.id}::uuid`,
      );
      return [...rows][0]?.n ?? 0;
    });
    expect(attributed).toBe(0);
    expect((await events.eventHealth(db, 'meta')).deliveryFailures).toBe(2);
  });

  it('attributes a status on Rekoda’s own number to the merchant it was sent to', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348030009201');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Own Number Shop',
      businessType: null,
      ownerUserId: user.id,
    });

    /* statusPayload's default number is the harness's configured own number. */
    await post(statusPayload('2348030009201', 'wamid.OWN', 'failed'));

    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM external_events
             WHERE external_id = 'wamid.OWN:failed' AND business_id = ${business.id}::uuid`,
      ),
    );
    expect([...rows][0]?.n).toBe(1);
  });
});
