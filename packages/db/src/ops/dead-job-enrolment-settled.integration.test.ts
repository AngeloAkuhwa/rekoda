/**
 * OWN-73 cutover enrolment (PR B, #432 review): see the describe block below.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { deadJobsRepo, events, identity, jobsRepo, settleRepo } from '../index.js';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23480500100${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

let externalSeq = 0;
/** An attributed Paystack event, as the pump leaves it before its job runs. */
async function attributedEvent(businessId: string): Promise<string> {
  externalSeq += 1;
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: 'charge.success',
    externalId: `dead-${externalSeq}:charge.success`,
    payload: { sealed: 'opaque' },
    businessId: null,
  });
  const id = storedEventId(recorded);
  expect(await events.attributeEvent(workerDb, id, businessId)).toBe(true);
  return id;
}

async function enqueue(
  businessId: string,
  kind: string,
  payload: Record<string, unknown>,
  maxAttempts = 2,
): Promise<void> {
  await withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, { businessId, kind, payload, maxAttempts }),
  );
}

/** The operator records of a business: what enrolment may or may not write. */
const recordsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    tx.execute<Record<string, unknown>>(
      sql`SELECT * FROM dead_job_exceptions WHERE business_id = ${businessId}::uuid`,
    ),
  ).then((rows) => [...rows]);

const merchantExceptions = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    settleRepo.reconciliationsFor(tx, { status: 'EXCEPTION', limit: 50 }),
  );

/**
 * Enrolment of an unrecorded dead job never reopens work that is already settled (OWN-73 cutover,
 * #432 review): an event processed or resolved before the sweep picks the job, or in the window
 * between the pick and the insert, leaves no record and no merchant exception.
 */
describe('enrolment skips a settled payment', () => {
  it('enrolment skips a death whose payment was already booked (event processed): no false merchant exception', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET state = 'dead', attempts = 2`),
    );
    // Settled another way (a verify or intent sweep booked it) after the job's last attempt.
    await events.markProcessed(workerDb, eventId, null, businessId);
    expect(await jobsRepo.enrolUnrecordedDeaths(workerDb)).toBe(0);
    expect(await recordsOf(businessId)).toHaveLength(0);
    expect(await merchantExceptions(businessId)).toHaveLength(0);
  });

  it('enrolment re-reads the event at insert time: one settled after the candidate was picked is not enrolled', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET state = 'dead', attempts = 2`),
    );
    const [job] = [
      ...(await workerDb.execute<{ id: string }>(sql`SELECT id FROM jobs WHERE state = 'dead'`)),
    ];
    // The event is settled after the sweep selected the job and before the record is written.
    await events.markProcessed(workerDb, eventId, null, businessId);
    await workerDb.transaction((tx) =>
      deadJobsRepo.recordDeath(
        tx,
        {
          id: job!.id,
          businessId,
          kind: 'payment.process',
          payload: { eventId },
          attempts: 2,
          failureCategory: null,
        },
        { enrolOnly: true },
      ),
    );
    expect(await recordsOf(businessId)).toHaveLength(0);
    expect(await merchantExceptions(businessId)).toHaveLength(0);
  });

  it('enrolment skips a death whose event an operator resolved after the candidate was picked', async () => {
    const businessId = await seedBusiness();
    const eventId = await attributedEvent(businessId);
    await enqueue(businessId, 'payment.process', { eventId });
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE jobs SET state = 'dead', attempts = 2`),
    );
    const [job] = [
      ...(await workerDb.execute<{ id: string }>(sql`SELECT id FROM jobs WHERE state = 'dead'`)),
    ];
    // Closed by an operator after the sweep selected the job (resolving also marks it processed).
    expect(
      await events.resolveEvent(workerDb, eventId, 'settled by hand', 'operator:bob', 'operator'),
    ).toBe(true);
    await workerDb.transaction((tx) =>
      deadJobsRepo.recordDeath(
        tx,
        {
          id: job!.id,
          businessId,
          kind: 'payment.process',
          payload: { eventId },
          attempts: 2,
          failureCategory: null,
        },
        { enrolOnly: true },
      ),
    );
    expect(await recordsOf(businessId)).toHaveLength(0);
    expect(await merchantExceptions(businessId)).toHaveLength(0);
  });
});
