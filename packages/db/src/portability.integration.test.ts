/**
 * The record behind the right (PR-118, migration 0114).
 *
 * A data-portability request is never refused on commercial grounds, so
 * nothing here asks about plans or allowances. What these rows do is keep
 * one right from becoming a denial of service, and leave an answer to "who
 * took a complete copy of this business's books".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, portabilityRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const GAP = 600;

async function seedBusiness(phone: string, name: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('one at a time', () => {
  it('refuses a second while the first is in flight, and allows it once finished', async () => {
    const businessId = await seedBusiness('+2348193000001', 'Flighty Co');

    const first = await withBusiness(db, businessId, (tx) =>
      portabilityRepo.begin(tx, businessId, 'user:one', GAP),
    );
    expect(first).toMatchObject({ id: expect.any(String) });

    /* The index decides, not a prior read: two simultaneous requests would
     * both see "none in flight". */
    expect(
      await withBusiness(db, businessId, (tx) =>
        portabilityRepo.begin(tx, businessId, 'user:one', GAP),
      ),
    ).toEqual({ refused: 'in_flight' });

    await withBusiness(db, businessId, (tx) =>
      portabilityRepo.complete(tx, businessId, (first as { id: string }).id, 4096),
    );

    /* Finished, so nothing is in flight - but the throttle now applies,
     * which is the OTHER limit and says so distinctly. */
    const next = await withBusiness(db, businessId, (tx) =>
      portabilityRepo.begin(tx, businessId, 'user:one', GAP),
    );
    expect(next).toMatchObject({ refused: 'too_soon', retryAt: expect.any(Date) });
  });

  it('frees the slot when an export fails, rather than locking the merchant out', async () => {
    const businessId = await seedBusiness('+2348193000002', 'Unlucky Co');
    const started = (await withBusiness(db, businessId, (tx) =>
      portabilityRepo.begin(tx, businessId, 'user:one', GAP),
    )) as { id: string };

    await withBusiness(db, businessId, (tx) => portabilityRepo.abandon(tx, businessId, started.id));

    /* The failed attempt is kept as a fact - "they asked and it did not
     * work" - with zero bytes rather than erased. */
    const history = await withBusiness(db, businessId, (tx) =>
      portabilityRepo.historyFor(tx, businessId),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ bytes: 0, actor: 'user:one' });
    expect(history[0]!.completedAt).toBeInstanceOf(Date);
  });

  it('lets a request through once the gap has passed', async () => {
    const businessId = await seedBusiness('+2348193000003', 'Patient Co');
    const started = (await withBusiness(db, businessId, (tx) =>
      portabilityRepo.begin(tx, businessId, 'user:one', GAP),
    )) as { id: string };
    await withBusiness(db, businessId, (tx) =>
      portabilityRepo.complete(tx, businessId, started.id, 10),
    );

    const later = new Date(Date.now() + (GAP + 60) * 1000);
    expect(
      await withBusiness(db, businessId, (tx) =>
        portabilityRepo.begin(tx, businessId, 'user:one', GAP, later),
      ),
    ).toMatchObject({ id: expect.any(String) });
  });
});

describe('the trail cannot be tidied away', () => {
  it('refuses the application a DELETE', async () => {
    const businessId = await seedBusiness('+2348193000010', 'Tidy Co');
    await withBusiness(db, businessId, (tx) =>
      portabilityRepo.begin(tx, businessId, 'user:one', GAP),
    );

    const refused = await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`DELETE FROM portability_exports WHERE business_id = ${businessId}`),
    ).then(
      () => 'the delete was accepted',
      (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
    );
    expect(refused).toMatch(/permission denied/i);
  });

  it('shows one business nothing of another', async () => {
    const mine = await seedBusiness('+2348193000020', 'Mine Co');
    const theirs = await seedBusiness('+2348193000021', 'Theirs Co');
    await withBusiness(db, theirs, (tx) => portabilityRepo.begin(tx, theirs, 'user:them', GAP));

    expect(await withBusiness(db, mine, (tx) => portabilityRepo.historyFor(tx, mine))).toHaveLength(
      0,
    );

    /* And the in-flight rule is per business: one merchant exporting does
     * not block another. */
    expect(
      await withBusiness(db, mine, (tx) => portabilityRepo.begin(tx, mine, 'user:me', GAP)),
    ).toMatchObject({ id: expect.any(String) });
  });
});
