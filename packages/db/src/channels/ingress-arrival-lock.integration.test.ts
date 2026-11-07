/**
 * The ingress lock that orders inbound arrival (OWN-74, PR #428). Split by concern from
 * dead-inbound-reconcile.integration.test.ts: `stampInboundArrival` serializes a business's
 * webhook ingress, bounds the wait, and stamps one arrival instant on the event and its job.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, events, identity, jobsRepo, withBusiness, type Db } from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let owner: Db;
let app: Db;
let closeOwner: () => Promise<void>;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const asOwner = createDb(urls.owner, { max: 2 });
  owner = asOwner.db;
  closeOwner = asOwner.close;
  const asApp = createDb(urls.app, { max: 4 });
  app = asApp.db;
  closeApp = asApp.close;
});

afterAll(async () => {
  await closeApp();
  await closeOwner();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481600${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('stampInboundArrival', () => {
  /** One webhook ingress as `MetaService` does it: stamp under the lock, then event and job. */
  async function ingest(
    businessId: string,
    note: string,
    hold?: Promise<void>,
    stamped?: () => void,
  ) {
    return withBusiness(app, businessId, async (tx) => {
      const arrivedAt = await jobsRepo.stampInboundArrival(tx, businessId);
      stamped?.();
      if (hold) await hold;
      const recorded = await events.recordEvent(tx, {
        provider: 'meta',
        eventType: 'message.text',
        externalId: `wamid.INGRESS.${businessId.slice(0, 8)}.${note}`,
        payload: {},
        businessId,
        arrivedAt,
      });
      if (!recorded.isNew) throw new Error('duplicate event in test');
      const job = await jobsRepo.enqueue(tx, {
        businessId,
        kind: 'inbound.message',
        payload: { eventId: recorded.id },
        singletonKey: recorded.id,
        arrivedAt,
      });
      return { jobId: job!.id, eventId: recorded.id };
    });
  }
  const earlier = (businessId: string, jobId: string) =>
    withBusiness(app, businessId, (tx) => jobsRepo.hasEarlierLiveJobByArrival(tx, jobId));
  const settled = (p: Promise<unknown>) => {
    const state = { done: false };
    void p.then(() => (state.done = true));
    return state;
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a message stamped while an earlier one is uncommitted waits for it, and orders after it', async () => {
    const businessId = await seedBusiness();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let markStamped!: () => void;
    const stamped = new Promise<void>((r) => (markStamped = r));

    /* The earlier message has its arrival instant but has not committed. */
    const first = ingest(businessId, 'first', held, markStamped);
    await stamped;
    const second = ingest(businessId, 'second');
    const secondState = settled(second);
    await pause(300);
    /* Without the lock the later message would commit here, ordered after an invisible one. */
    expect(secondState.done).toBe(false);

    release();
    const [a, b] = await Promise.all([first, second]);
    /* The later message's check sees the earlier one; the earlier one sees nothing ahead. */
    expect(await earlier(businessId, b.jobId)).toBe(true);
    expect(await earlier(businessId, a.jobId)).toBe(false);
    /* Each job carries its event's arrival instant exactly. */
    const rows = await owner.execute<{ same: boolean }>(sql`
      SELECT j.created_at = e.created_at AS same
        FROM jobs j JOIN external_events e ON e.id = (j.payload->>'eventId')::uuid
       WHERE j.business_id = ${businessId}::uuid`);
    expect([...rows].map((r) => r.same)).toEqual([true, true]);
  });

  it('an earlier ingress that fails releases the lock: the later message completes and nothing of the failed one is left', async () => {
    const businessId = await seedBusiness();
    let fail!: () => void;
    const failing = new Promise<void>(
      (_, reject) => (fail = () => reject(new Error('ingress died'))),
    );
    let markStamped!: () => void;
    const stamped = new Promise<void>((r) => (markStamped = r));

    /* The earlier message is stamped, then its transaction fails before it commits anything. */
    const first = ingest(businessId, 'first', failing, markStamped);
    const firstOutcome = first.then(
      () => 'committed',
      () => 'rolled back',
    );
    await stamped;
    const second = ingest(businessId, 'second');
    const secondState = settled(second);
    await pause(300);
    expect(secondState.done).toBe(false);

    fail();
    expect(await firstOutcome).toBe('rolled back');
    const b = await second;
    /* No deadlock, and the failed message left no event or job: Meta's retry will record it afresh. */
    expect(await earlier(businessId, b.jobId)).toBe(false);
    const rows = await owner.execute<{ jobs: number; events: number }>(sql`
      SELECT (SELECT count(*)::int FROM jobs WHERE business_id = ${businessId}::uuid) AS jobs,
             (SELECT count(*)::int FROM external_events WHERE business_id = ${businessId}::uuid) AS events`);
    expect([...rows][0]).toEqual({ jobs: 1, events: 1 });
  });

  it('bounds the wait: a message that cannot get the lock in time writes nothing and can be redelivered', async () => {
    const businessId = await seedBusiness();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let markStamped!: () => void;
    const stamped = new Promise<void>((r) => (markStamped = r));
    const first = ingest(businessId, 'first', held, markStamped);
    await stamped;

    /* A short bound so the test does not wait the production two seconds. */
    const blocked = withBusiness(app, businessId, (tx) =>
      jobsRepo.stampInboundArrival(tx, businessId, { lockTimeoutMs: 200 }),
    );
    await expect(blocked).rejects.toMatchObject({ cause: { code: '55P03' } });

    release();
    await first;
    /* Meta's redelivery is stamped normally once the lock is free, after the first message. */
    const again = await ingest(businessId, 'redelivered');
    expect(await earlier(businessId, again.jobId)).toBe(true);
    const rows = await owner.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM jobs WHERE business_id = ${businessId}::uuid`,
    );
    expect([...rows][0]!.n).toBe(2);
  });

  it('refuses a lock bound that is not a positive whole number of milliseconds', async () => {
    const businessId = await seedBusiness();
    for (const lockTimeoutMs of [0, -1, 1.5]) {
      await expect(
        withBusiness(app, businessId, (tx) =>
          jobsRepo.stampInboundArrival(tx, businessId, { lockTimeoutMs }),
        ),
      ).rejects.toThrow(/positive integer/);
    }
  });

  it('never makes another business wait', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let markStamped!: () => void;
    const stamped = new Promise<void>((r) => (markStamped = r));

    const first = ingest(a, 'a-first', held, markStamped);
    await stamped;
    /* B's ingress completes while A's is still open. */
    await ingest(b, 'b-only');
    release();
    await first;
  });
});
