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
import { describe, expect, it, vi } from 'vitest';
import { identity, jobsRepo, withBusiness, sql } from '@rekoda/db';
import { IngressSequencer } from './ingress-sequencer.js';
import { MetaIngressService } from './meta.service.js';
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

/**
 * Connections waiting for this business's ingress lock right now, in this database (pg_locks;
 * the two-key advisory lock is (LOCK_CLASS.business = 2, hashtext('<business>:ingress'))).
 */
async function lockWaiters(businessId: string): Promise<number> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_locks l
       WHERE l.locktype = 'advisory' AND NOT l.granted
         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND l.classid = 2::oid
         AND l.objid = ((hashtext(${`${businessId}:ingress`})::bigint + 4294967296) % 4294967296)::text::oid
         AND l.objsubid = 2`),
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

    /* Meta redelivers the cancel: it goes first. Its retries of the other two come back reversed
     * (the later webhook first): it is refused again until the yes that came before it is stored,
     * so they are stored in the order they first reached Rekoda (independent review of d1c799a). */
    expect((await post(cancelBody)).statusCode).toBe(200);
    expect((await post(laterBody)).statusCode).toBe(503);
    expect((await post(yesBody)).statusCode).toBe(200);
    expect((await post(laterBody)).statusCode).toBe(200);
    expect(await stored(business.id)).toEqual([
      'wamid.TO.cancel',
      'wamid.TO.yes',
      'wamid.TO.later',
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
      /* Without the lane it waits for a pool connection behind the burst: at least the 2 s bound. */
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(await stored(other.id)).toEqual(['wamid.OTHER.1']);

      const codes = (await Promise.all(burst)).map((r) => r.statusCode);
      expect(new Set(codes)).toEqual(new Set([503]));
      expect(await stored(busy.id)).toEqual([]);
    } finally {
      await lock.release();
      await Promise.allSettled(burst);
    }
    /* Concurrent webhooks reach the lane in no fixed order, so which one the fence names is not
     * known here. Meta redelivers every refused one until it is taken: each round stores whichever
     * is earliest outstanding, so all land, none twice, in the order they reached the lane. */
    const waiting = new Set(Array.from({ length: 25 }, (_, i) => i));
    for (let round = 0; round < 30 && waiting.size > 0; round++) {
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

  /* A message already stored that comes back while its business is fenced (a duplicate, or a
   * redelivered body that also carries the failed one) is acknowledged, and must not stay
   * outstanding: it will never be stored again, so it would hold back every newer message until
   * the fence's life ran out (second independent review of #428). */
  it('a stored message redelivered under a fence is acknowledged and does not hold the business back', async () => {
    const business = await seedMerchant(OWNER, 'Ada Fashion');
    const sold = messagePayload(OWNER, 'wamid.DUP.sold', 'sold 3 bags');
    const cancel = messagePayload(OWNER, 'wamid.DUP.cancel', 'cancel');
    expect((await post(sold)).statusCode).toBe(200);

    const lock = await holdIngressLock(business.id);
    try {
      expect((await post(cancel)).statusCode).toBe(503);
    } finally {
      await lock.release();
    }
    /* Meta repeats the stored message while the cancel is outstanding: acknowledged, not stored twice. */
    expect((await post(sold)).statusCode).toBe(200);
    expect((await post(cancel)).statusCode).toBe(200);
    expect(lane().outstanding(business.id)).toBe(0);

    /* A fresh message is admitted at once. */
    expect((await post(messagePayload(OWNER, 'wamid.DUP.next', 'yes'))).statusCode).toBe(200);
    expect(await stored(business.id)).toEqual([
      'wamid.DUP.sold',
      'wamid.DUP.cancel',
      'wamid.DUP.next',
    ]);
  });

  it('a stored message whose redelivery cannot take the lock is acknowledged and fences nothing', async () => {
    const business = await seedMerchant(OWNER, 'Ada Fashion');
    const sold = messagePayload(OWNER, 'wamid.REDUP.sold', 'sold 3 bags');
    expect((await post(sold)).statusCode).toBe(200);

    /* Meta repeats the stored message while the ingress lock is busy: its duplicate write times
     * out on the lock. It is already stored, so it is acknowledged, not left outstanding. */
    const lock = await holdIngressLock(business.id);
    try {
      expect((await post(sold)).statusCode).toBe(200);
    } finally {
      await lock.release();
    }
    expect(lane().outstanding(business.id)).toBe(0);

    /* The merchant's next message is not held back behind a message that was never lost. */
    expect((await post(messagePayload(OWNER, 'wamid.REDUP.next', 'yes'))).statusCode).toBe(200);
    expect(await stored(business.id)).toEqual(['wamid.REDUP.sold', 'wamid.REDUP.next']);
  });
});

/**
 * The guarantee is ADMISSION order: messages of one business are stored, stamped and processed in
 * the order they reach the business's lane, after sender resolution. Rekoda cannot see Meta's send
 * order for two webhooks in flight at once (Meta does not order separate requests, and its
 * `timestamp` is whole seconds), and nothing uses that timestamp to order them. These pin that
 * guarantee and its stated limit; independent lanes per business are pinned by the burst test
 * above.
 */
describe('concurrent webhooks of one business: admission order, not send order (OWN-74)', () => {
  async function stamps(businessId: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ external_id: string; event_at: string; job_at: string }>(sql`
        SELECT e.external_id, e.created_at::text AS event_at, j.created_at::text AS job_at
          FROM external_events e
          JOIN jobs j ON j.business_id = e.business_id AND j.payload->>'eventId' = e.id::text
         WHERE e.business_id = ${businessId}::uuid
         ORDER BY e.created_at, j.created_at`),
    );
    return [...rows];
  }

  it('a webhook whose sender resolution finishes first is admitted, stamped and stored first, whatever Meta sent first', async () => {
    const business = await seedMerchant(OWNER, 'Ada Fashion');
    const delegate = await identity.upsertUserByPhone(db, `+${DELEGATE}`);
    await identity.addMembership(db, business.id, delegate.id, 'delegate');
    const service = app.get(MetaIngressService) as unknown as {
      resolveBusiness: (from: string) => Promise<string | null>;
    };
    const original = service.resolveBusiness.bind(service);
    let resolveSlow!: () => void;
    const slow = new Promise<void>((resolve) => (resolveSlow = resolve));
    let slowStarted = false;
    const spy = vi.spyOn(service, 'resolveBusiness').mockImplementation(async (from: string) => {
      if (from === OWNER) {
        slowStarted = true;
        await slow;
      }
      return original(from);
    });
    try {
      /* Same Meta timestamp on both. The owner's "cancel" reaches Rekoda first, but its sender
       * resolution is slow; the delegate's "yes" resolves first and is admitted first. */
      const cancel = post(messagePayload(OWNER, 'wamid.RACE.cancel', 'cancel'));
      await until('the cancel is resolving its sender', () => slowStarted);
      const yes = await post(messagePayload(DELEGATE, 'wamid.RACE.yes', 'yes'));
      expect(yes.statusCode).toBe(200);
      resolveSlow();
      expect((await cancel).statusCode).toBe(200);
    } finally {
      resolveSlow();
      spy.mockRestore();
    }
    /* Stored, and stamped for the worker, in admission order: Rekoda does not claim Meta's order. */
    const rows = await stamps(business.id);
    expect(rows.map((r) => r.external_id)).toEqual(['wamid.RACE.yes', 'wamid.RACE.cancel']);
    for (const row of rows) expect(row.job_at).toBe(row.event_at);
    expect(rows[0]!.event_at).not.toBe(rows[1]!.event_at);
  });

  it('simultaneous webhooks with the same Meta timestamp each get a distinct arrival stamp, one total order', async () => {
    const business = await seedMerchant(OWNER, 'Ada Fashion');
    const ids = Array.from({ length: 6 }, (_, i) => `wamid.SAME-TS.${i}`);
    const answers = await Promise.all(
      ids.map((id, i) => post(messagePayload(OWNER, id, `sold ${i} bags`))),
    );
    expect(answers.map((r) => r.statusCode)).toEqual(ids.map(() => 200));
    const rows = await stamps(business.id);
    expect(rows.map((r) => r.external_id).sort()).toEqual([...ids].sort());
    /* No two share a stamp, so the worker's order is total without the whole-second timestamp. */
    expect(new Set(rows.map((r) => r.event_at)).size).toBe(ids.length);
    for (const row of rows) expect(row.job_at).toBe(row.event_at);
  });
});
