/**
 * A dead inbound message retires the drafts that were waiting behind it (OWN-74, PR #428).
 *
 * The API suite (`apps/api/src/channels/meta-lost-message.integration.test.ts`) proves the
 * merchant-visible outcome: a later "yes" confirms nothing. These pin the two repository
 * primitives that outcome rests on, at the database:
 *
 * - `reconcileDeadInboundMessages` retires exactly the pending drafts whose message arrived
 *   before the lost one and whose window was still open at that arrival, applies each dead
 *   message once, writes only fixed text, and never reaches another business.
 * - `hasEarlierLiveJobByArrival` sees an earlier live sibling, and nothing else.
 *
 * Arrival is the webhook event's `created_at`; it is set explicitly here so every ordering is
 * exact rather than a race against the clock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  conversationsRepo,
  createDb,
  events,
  identity,
  jobsRepo,
  withBusiness,
  type Db,
  type TenantDb,
} from '../index.js';
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

/** Whole seconds an hour back, so every instant below is exact and already in the past. */
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000);
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

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

/** A webhook event that reached Rekoda at `arrivedAt`. Returns its id. */
async function eventAt(businessId: string, wamid: string, arrivedAt: Date): Promise<string> {
  const rows = await owner.execute<{ id: string }>(sql`
    INSERT INTO external_events
      (business_id, provider, event_type, external_id, payload, signature_valid, created_at)
    VALUES (${businessId}::uuid, 'meta', 'message', ${wamid}, '{}'::jsonb, 1, ${arrivedAt.toISOString()}::timestamptz)
    RETURNING id`);
  return [...rows][0]!.id;
}

/** A message that arrived at `arrivedAt` and a pending draft for it, open until `expiresAt`. */
async function draftFrom(
  businessId: string,
  note: string,
  arrivedAt: Date,
  expiresAt: Date,
): Promise<string> {
  const wamid = `wamid.DEAD.${businessId.slice(0, 8)}.${note}`;
  await eventAt(businessId, wamid, arrivedAt);
  const draft = await withBusiness(app, businessId, async (tx: TenantDb) => {
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: `msg ${note}`,
      providerMessageId: wamid,
    });
    return conversationsRepo.recordDraft(tx, {
      businessId,
      conversationMessageId: message.id,
      intent: 'RecordSale',
      command: { intent: 'RecordSale', note },
      model: null,
      previewed: true,
    });
  });
  await owner.execute(
    sql`UPDATE command_drafts SET expires_at = ${expiresAt.toISOString()}::timestamptz WHERE id = ${draft.id}::uuid`,
  );
  return draft.id;
}

/** An `inbound.message` job for the message that arrived at `arrivedAt`, in `state`. */
async function inboundJob(
  businessId: string,
  note: string,
  arrivedAt: Date,
  state: 'pending' | 'running' | 'done' | 'dead',
): Promise<{ jobId: string; eventId: string }> {
  const eventId = await eventAt(
    businessId,
    `wamid.LOST.${businessId.slice(0, 8)}.${note}`,
    arrivedAt,
  );
  const rows = await owner.execute<{ id: string }>(sql`
    INSERT INTO jobs (business_id, kind, payload, state, created_at)
    VALUES (${businessId}::uuid, 'inbound.message', ${JSON.stringify({ eventId })}::jsonb,
            ${state}, ${arrivedAt.toISOString()}::timestamptz)
    RETURNING id`);
  return { jobId: [...rows][0]!.id, eventId };
}

async function draftState(draftId: string) {
  const rows = await owner.execute<{ state: string; retired_reason: string | null }>(
    sql`SELECT state, retired_reason FROM command_drafts WHERE id = ${draftId}::uuid`,
  );
  return [...rows][0]!;
}

async function eventRow(eventId: string) {
  const rows = await owner.execute<{ processed_at: Date | null; error: string | null }>(
    sql`SELECT processed_at, error FROM external_events WHERE id = ${eventId}::uuid`,
  );
  return [...rows][0]!;
}

const reconcile = (businessId: string) =>
  withBusiness(app, businessId, (tx) =>
    conversationsRepo.reconcileDeadInboundMessages(tx, businessId),
  );

const RETIRED = { state: 'superseded', retired_reason: conversationsRepo.INBOUND_MESSAGE_FAILED };
const STILL_PENDING = { state: 'pending', retired_reason: null };

describe('reconcileDeadInboundMessages', () => {
  it('retires a draft from before the lost message and keeps one from after it', async () => {
    const businessId = await seedBusiness();
    const before = await draftFrom(businessId, 'before', at(0), at(600));
    const lost = await inboundJob(businessId, 'lost', at(10), 'dead');
    /* Arrived after the lost message (it passed it while it backed off): that message's own. */
    const after = await draftFrom(businessId, 'after', at(20), at(620));

    expect(await reconcile(businessId)).toEqual({ messages: 1, drafts: 1 });
    expect(await draftState(before)).toEqual(RETIRED);
    expect(await draftState(after)).toEqual(STILL_PENDING);
    /* The event is closed with fixed text: nothing of the job's error or the message. */
    const event = await eventRow(lost.eventId);
    expect(event.processed_at).not.toBeNull();
    expect(event.error).toBe('not processed: its job died; drafts pending then were retired');
  });

  it('applies each dead message exactly once', async () => {
    const businessId = await seedBusiness();
    await draftFrom(businessId, 'first', at(0), at(600));
    await inboundJob(businessId, 'lost', at(10), 'dead');
    expect(await reconcile(businessId)).toEqual({ messages: 1, drafts: 1 });

    /* A draft recorded afterwards from an earlier-arriving message must not be swept by a re-run. */
    const late = await draftFrom(businessId, 'late', at(5), at(605));
    expect(await reconcile(businessId)).toEqual({ messages: 0, drafts: 0 });
    expect(await draftState(late)).toEqual(STILL_PENDING);
  });

  it('judges the window at the lost message’s arrival, to the instant', async () => {
    const businessId = await seedBusiness();
    /* Closed exactly when the lost message arrived: not open then, left for expireStaleDrafts. */
    const closedThen = await draftFrom(businessId, 'closed', at(0), at(10));
    /* Open one second past the arrival, though long closed now: retired. */
    const openThen = await draftFrom(businessId, 'open', at(1), at(11));
    await inboundJob(businessId, 'lost', at(10), 'dead');

    expect(await reconcile(businessId)).toEqual({ messages: 1, drafts: 1 });
    expect(await draftState(closedThen)).toEqual(STILL_PENDING);
    expect(await draftState(openThen)).toEqual(RETIRED);
  });

  it('leaves a draft that is no longer pending alone', async () => {
    const businessId = await seedBusiness();
    const confirmed = await draftFrom(businessId, 'confirmed', at(0), at(600));
    await owner.execute(
      sql`UPDATE command_drafts SET state = 'confirmed' WHERE id = ${confirmed}::uuid`,
    );
    await inboundJob(businessId, 'lost', at(10), 'dead');

    expect(await reconcile(businessId)).toEqual({ messages: 1, drafts: 0 });
    expect(await draftState(confirmed)).toEqual({ state: 'confirmed', retired_reason: null });
  });

  it('a job that is not dead retires nothing and leaves its event open', async () => {
    const businessId = await seedBusiness();
    const draft = await draftFrom(businessId, 'waiting', at(0), at(600));
    const live = await inboundJob(businessId, 'retrying', at(10), 'pending');
    const done = await inboundJob(businessId, 'done', at(11), 'done');

    expect(await reconcile(businessId)).toEqual({ messages: 0, drafts: 0 });
    expect(await draftState(draft)).toEqual(STILL_PENDING);
    expect((await eventRow(live.eventId)).processed_at).toBeNull();
    expect((await eventRow(done.eventId)).processed_at).toBeNull();
  });

  it('never reaches another business, in either direction', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const aDraft = await draftFrom(a, 'a', at(0), at(600));
    const bDraft = await draftFrom(b, 'b', at(0), at(600));
    const bLost = await inboundJob(b, 'b-lost', at(10), 'dead');

    /* A's reconcile sees no dead message of its own, and does not close B's. */
    expect(await reconcile(a)).toEqual({ messages: 0, drafts: 0 });
    expect(await draftState(aDraft)).toEqual(STILL_PENDING);
    expect((await eventRow(bLost.eventId)).processed_at).toBeNull();

    /* B's own reconcile retires only B's draft. */
    expect(await reconcile(b)).toEqual({ messages: 1, drafts: 1 });
    expect(await draftState(bDraft)).toEqual(RETIRED);
    expect(await draftState(aDraft)).toEqual(STILL_PENDING);
  });
});

describe('hasEarlierLiveJobByArrival', () => {
  const earlier = (businessId: string, jobId: string) =>
    withBusiness(app, businessId, (tx) => jobsRepo.hasEarlierLiveJobByArrival(tx, jobId));

  it('is true while an earlier message of the same business is pending or running', async () => {
    const businessId = await seedBusiness();
    await inboundJob(businessId, 'older-pending', at(0), 'pending');
    const me = await inboundJob(businessId, 'me', at(10), 'running');
    expect(await earlier(businessId, me.jobId)).toBe(true);

    const other = await seedBusiness();
    await inboundJob(other, 'older-running', at(0), 'running');
    const them = await inboundJob(other, 'them', at(10), 'running');
    expect(await earlier(other, them.jobId)).toBe(true);
  });

  it('is false when every earlier message is finished, or only a later one is live', async () => {
    const businessId = await seedBusiness();
    await inboundJob(businessId, 'older-done', at(0), 'done');
    await inboundJob(businessId, 'older-dead', at(1), 'dead');
    const me = await inboundJob(businessId, 'me', at(10), 'running');
    await inboundJob(businessId, 'newer', at(20), 'pending');
    expect(await earlier(businessId, me.jobId)).toBe(false);
  });

  it('ignores another business and another job kind', async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    await inboundJob(b, 'b-older', at(0), 'pending');
    await owner.execute(sql`
      INSERT INTO jobs (business_id, kind, payload, state, created_at)
      VALUES (${a}::uuid, 'document.render', '{}'::jsonb, 'pending', ${at(0).toISOString()}::timestamptz)`);
    const me = await inboundJob(a, 'me', at(10), 'running');
    expect(await earlier(a, me.jobId)).toBe(false);
  });
});

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
