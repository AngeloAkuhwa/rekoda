/**
 * Ordered, bounded ingress across separate webhooks (OWN-74, PR #428).
 *
 * Meta sends each webhook as its own request, so a merchant's "cancel" and the "yes" after it can
 * be in flight at once. Each test holds the business's database ingress lock from outside (as a
 * stalled ingress, or another process, would) and observes where the webhooks wait:
 *
 *  - only the message at the head of the business's lane holds a pool connection and waits on the
 *    lock; the rest wait in memory, so a burst for one business cannot take the shared pool from
 *    another business;
 *  - a later message is never stored ahead of an earlier one, whether the earlier one is still
 *    waiting, has timed out, or is redelivered by Meta later.
 *
 * Every wait is observed (pg_stat_activity, the lane's depth), never assumed from a delay.
 */
import { describe, expect, it } from 'vitest';
import { identity, jobsRepo, withBusiness, sql } from '@rekoda/db';
import { IngressSequencer } from './ingress-sequencer.js';
import { app, db, messagePayload, post, useMetaWebhookHarness } from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';
const DELEGATE = '2348039990002';

async function seedMerchant(phone: string, name: string) {
  const user = await identity.upsertUserByPhone(db, `+${phone}`);
  return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
}

async function stored(businessId: string): Promise<string[]> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ external_id: string }>(sql`
      SELECT e.external_id FROM external_events e
        JOIN jobs j ON j.business_id = e.business_id AND j.payload->>'eventId' = e.id::text
       WHERE e.business_id = ${businessId}::uuid
       ORDER BY e.created_at, j.created_at`),
  );
  return [...rows].map((r) => r.external_id);
}

/** Connections waiting on an advisory lock right now (the ingress lock is the only one held). */
async function lockWaiters(businessId: string): Promise<number> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND pid <> pg_backend_pid()`),
  );
  return [...rows][0]!.n;
}

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Hold the business's ingress lock from outside until `release` is called. */
async function holdIngressLock(businessId: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holder = withBusiness(db, businessId, async (tx) => {
    await jobsRepo.serializeBusiness(tx, businessId, 'ingress');
    locked();
    await held;
  });
  await isLocked;
  return {
    release: async () => {
      release();
      await holder;
    },
  };
}

const lane = () => app.get(IngressSequencer);

describe('ordered ingress across separate webhooks (OWN-74)', () => {
  it('a later webhook waits behind an earlier one holding its turn, in memory, and is stored after it', async () => {
    const business = await seedMerchant(OWNER, 'Ada Fashion');
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const lock = await holdIngressLock(business.id);
    try {
      const cancel = post(messagePayload(OWNER, 'wamid.LANE.cancel', 'cancel'));
      await until(
        'the cancel waits on the ingress lock',
        async () => (await lockWaiters(business.id)) === 1,
      );
      const yes = post(messagePayload(DELEGATE, 'wamid.LANE.yes', 'yes'));
      await until(
        'the yes is waiting too',
        async () => lane().depth(business.id) === 2 || (await lockWaiters(business.id)) === 2,
      );
      /* The yes waits in memory: still only one connection is waiting on the lock. */
      expect(await lockWaiters(business.id)).toBe(1);
      expect(await stored(business.id)).toEqual([]);

      await lock.release();
      expect((await cancel).statusCode).toBe(200);
      expect((await yes).statusCode).toBe(200);
    } finally {
      await lock.release();
    }
    expect(await stored(business.id)).toEqual(['wamid.LANE.cancel', 'wamid.LANE.yes']);
  });

  it('an earlier webhook that times out takes the later ones with it, and a redelivery stores them in order', async () => {
    const business = await seedMerchant(OWNER, 'Ada Fashion');
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const cancelBody = messagePayload(OWNER, 'wamid.TO.cancel', 'cancel');
    const yesBody = messagePayload(DELEGATE, 'wamid.TO.yes', 'yes');
    const laterBody = messagePayload(OWNER, 'wamid.TO.later', 'yes');
    const lock = await holdIngressLock(business.id);
    try {
      const cancel = post(cancelBody);
      await until(
        'the cancel waits on the ingress lock',
        async () => (await lockWaiters(business.id)) === 1,
      );
      const yes = post(yesBody);
      await until(
        'the yes is waiting too',
        async () => lane().depth(business.id) === 2 || (await lockWaiters(business.id)) === 2,
      );

      /* The cancel cannot get the lock within its bound; the yes waiting behind it is refused. */
      expect((await cancel).statusCode).toBe(503);
      expect((await yes).statusCode).toBe(503);
      expect(await stored(business.id)).toEqual([]);

      /* A "yes" in a separate, later webhook, with the lock now free, is refused as well: the
       * cancel it may follow has not been stored. */
      await lock.release();
      expect((await post(laterBody)).statusCode).toBe(503);
      expect((await post(yesBody)).statusCode).toBe(503);
      expect(await stored(business.id)).toEqual([]);
    } finally {
      await lock.release();
    }

    /* Meta redelivers the cancel: it goes first, and the rest follow in their turn. */
    expect((await post(cancelBody)).statusCode).toBe(200);
    expect((await post(laterBody)).statusCode).toBe(200);
    expect((await post(yesBody)).statusCode).toBe(200);
    expect(await stored(business.id)).toEqual([
      'wamid.TO.cancel',
      'wamid.TO.later',
      'wamid.TO.yes',
    ]);
  });

  it('a burst for one business waits without taking the shared pool: another business is answered at once', async () => {
    const busy = await seedMerchant(OWNER, 'Ada Fashion');
    const other = await seedMerchant('2348035550001', 'Bola Foods');
    const lock = await holdIngressLock(busy.id);
    const burst: ReturnType<typeof post>[] = [];
    try {
      /* More waiting webhooks than the application pool has connections (10). */
      for (let i = 0; i < 25; i++) {
        burst.push(
          post(messagePayload(OWNER, `wamid.BURST.${String(i).padStart(2, '0')}`, `sold ${i}`)),
        );
      }
      await until('the burst is waiting', async () => (await lockWaiters(busy.id)) >= 1);
      expect(await lockWaiters(busy.id)).toBe(1);

      const started = Date.now();
      const answered = await post(messagePayload('2348035550001', 'wamid.OTHER.1', 'sold 1 bag'));
      expect(answered.statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await stored(other.id)).toEqual(['wamid.OTHER.1']);
      expect(await lockWaiters(busy.id)).toBe(1);

      const codes = (await Promise.all(burst)).map((r) => r.statusCode);
      expect(new Set(codes)).toEqual(new Set([503]));
      expect(await stored(busy.id)).toEqual([]);
    } finally {
      await lock.release();
      await Promise.allSettled(burst);
    }
    /* Concurrent webhooks reach the lane in no fixed order, so which one the fence names is not
     * known here. Meta redelivers every refused one until it is taken: the fenced one lands first,
     * then the rest, and nothing is lost or stored twice. */
    const waiting = new Set(Array.from({ length: 25 }, (_, i) => i));
    for (let round = 0; round < 3 && waiting.size > 0; round++) {
      for (const i of [...waiting]) {
        const wamid = `wamid.BURST.${String(i).padStart(2, '0')}`;
        const code = (await post(messagePayload(OWNER, wamid, `sold ${i}`))).statusCode;
        if (code === 200) waiting.delete(i);
        else expect(code).toBe(503);
      }
    }
    expect(waiting.size).toBe(0);
    expect([...(await stored(busy.id))].sort()).toEqual(
      Array.from({ length: 25 }, (_, i) => `wamid.BURST.${String(i).padStart(2, '0')}`),
    );
  });
});
