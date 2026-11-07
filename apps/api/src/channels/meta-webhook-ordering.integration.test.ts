/**
 * Webhook ingress ordering (OWN-74, PR #428): a message of a webhook body is never stored ahead of
 * an earlier one that could not be stored. Split by concern from meta-webhook-ingress.integration
 * .test.ts; the shared app, stubs and payload helpers are in meta-webhook.fixtures.ts. The ordering
 * across separate webhooks is in meta-webhook-ingress-lane.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { InboundEvent } from '@rekoda/contracts';
import { identity, jobsRepo, withBusiness, sql } from '@rekoda/db';
import { MetaIngressService } from './meta.service.js';
import { app, db, messagePayload, post, useMetaWebhookHarness } from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

describe('ordered ingress after a failed message', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  function batch(laterFrom: string) {
    const body = messagePayload('2348031234567', 'wamid.BATCH.A', 'cancel');
    body.entry[0]!.changes[0]!.value.messages.push({
      id: 'wamid.BATCH.B',
      from: laterFrom,
      timestamp: '1700000001',
      type: 'text',
      text: { body: 'yes' },
    });
    return body;
  }

  async function stored(businessId: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ external_id: string }>(sql`
        SELECT external_id FROM external_events
         WHERE business_id = ${businessId}::uuid ORDER BY created_at`),
    );
    return [...rows].map((r) => r.external_id);
  }

  /**
   * Watch the ingress service: record which messages the controller tries to store, and run
   * `onFirstFailure` the moment the first attempt fails, before that failure reaches the
   * controller, so it is done before the controller could try the next message.
   */
  function watchAccept(onFirstFailure: () => Promise<void>, failFirst = false) {
    const service = app.get(MetaIngressService);
    const original = service.accept.bind(service);
    const attempted: string[] = [];
    let failed = false;
    const spy = vi
      .spyOn(service, 'accept')
      .mockImplementation(async (event: InboundEvent, payload) => {
        if (event.kind === 'message') attempted.push(event.externalId);
        try {
          if (failFirst && attempted.length === 1) throw new Error('could not resolve the sender');
          return await original(event, payload);
        } catch (error) {
          if (!failed) {
            failed = true;
            await onFirstFailure();
          }
          throw error;
        }
      });
    return { attempted, restore: () => spy.mockRestore() };
  }

  /* One body carrying a "cancel" then a "yes": if the first cannot get the ingress lock, the second
   * must not be stored ahead of it, whether it comes from the same member or another member of the
   * business. Meta redelivers the whole body on the non-200, and the redelivery stamps them in
   * sending order (independent review and CodeRabbit on #428). The lock is released by the first
   * message's own failure, observed, before the controller moves on to the second message, so the
   * second finds the lock free: if anything let it through, it would be stored and the test fail. */
  it.each([
    ['the same member', '2348031234567'],
    ['another member of the business', '2348039990002'],
  ])(
    'does not store a later message of a batch after an earlier one failed (%s)',
    async (_who, laterFrom) => {
      const business = await seedMerchant('+2348031234567', 'Ada Fashion');
      const delegate = await identity.upsertUserByPhone(db, '+2348039990002');
      await identity.addMembership(db, business.id, delegate.id, 'delegate');
      const body = batch(laterFrom);

      /* Hold the business's ingress lock until the first message has failed for want of it. */
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = withBusiness(db, business.id, async (tx) => {
        await jobsRepo.serializeBusiness(tx, business.id, 'ingress');
        locked();
        await held;
      });
      const watch = watchAccept(async () => {
        release();
        await holder;
      });
      try {
        await isLocked;
        const first = await post(body);
        expect(first.statusCode).toBe(503);
        /* A's failure is attributed to its business, so the controller tries B, and the business's
         * lane refuses it: with the lock already free, only the lane keeps B out. */
        expect(watch.attempted).toEqual(['wamid.BATCH.A', 'wamid.BATCH.B']);
      } finally {
        watch.restore();
        release();
        await holder;
      }
      expect(await stored(business.id)).toEqual([]);

      const second = await post(body);
      expect(second.statusCode).toBe(200);
      expect(await stored(business.id)).toEqual(['wamid.BATCH.A', 'wamid.BATCH.B']);
    },
  );

  /* A message that fails before its business is known (here, its sender cannot be resolved) has no
   * business to fence. The controller alone keeps the rest of the body behind it. */
  it('does not try a later message of a batch after an earlier one failed before it was attributed', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const body = batch('2348031234567');
    const watch = watchAccept(async () => {}, true);
    try {
      const first = await post(body);
      expect(first.statusCode).toBe(503);
      expect(watch.attempted).toEqual(['wamid.BATCH.A']);
    } finally {
      watch.restore();
    }
    expect(await stored(business.id)).toEqual([]);

    expect((await post(body)).statusCode).toBe(200);
    expect(await stored(business.id)).toEqual(['wamid.BATCH.A', 'wamid.BATCH.B']);
  });

  /* One business's refusal does not hold back another business's message in the same body
   * (independent review of d1c799a): only the refused business waits for the redelivery. */
  it("stores another business's message in a body whose first message is refused for its own business", async () => {
    const a = await seedMerchant('+2348031234567', 'Ada Fashion');
    const b = await seedMerchant('+2348035550001', 'Bola Foods');
    const body = messagePayload('2348031234567', 'wamid.MIX.A', 'cancel');
    body.entry[0]!.changes[0]!.value.messages.push({
      id: 'wamid.MIX.B',
      from: '2348035550001',
      timestamp: '1700000001',
      type: 'text',
      text: { body: 'sold 1 bag' },
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = withBusiness(db, a.id, async (tx) => {
      await jobsRepo.serializeBusiness(tx, a.id, 'ingress');
      locked();
      await held;
    });
    try {
      await isLocked;
      expect((await post(body)).statusCode).toBe(503);
      expect(await stored(a.id)).toEqual([]);
      expect(await stored(b.id)).toEqual(['wamid.MIX.B']);
    } finally {
      release();
      await holder;
    }
    expect((await post(body)).statusCode).toBe(200);
    expect(await stored(a.id)).toEqual(['wamid.MIX.A']);
    expect(await stored(b.id)).toEqual(['wamid.MIX.B']);
  });
});
