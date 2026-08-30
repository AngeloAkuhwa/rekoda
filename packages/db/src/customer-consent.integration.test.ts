/**
 * A customer's STOP, against a real database (PR-135).
 *
 * The properties here are the ones a regulator would ask about and the ones
 * a compromised process could break: the fact is per shop and per WhatsApp
 * number rather than per person, another tenant cannot read or clear it, a
 * repeat STOP does not move the moment the person first asked, and no
 * application role can delete the record at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  customerConsentRepo,
  identity,
  sql,
  withBusiness,
  type Db,
  type TenantDb,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let ownerDb: Db;
let close: () => Promise<void>;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await close?.();
  await closeOwner?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481990${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** The shape the handler and the send door both build. */
const keyFor = (
  businessId: string,
  overrides: Partial<customerConsentRepo.CustomerConsentKey> = {},
) => ({
  businessId,
  channelAccountId: 'pn-100',
  customerHash: 'blind-index-aaa',
  indexKeyVersion: 'V1',
  ...overrides,
});

const asTenant = <T>(businessId: string, work: (tx: TenantDb) => Promise<T>): Promise<T> =>
  withBusiness(db, businessId, work);

describe('a customer who has never said anything', () => {
  it('may be messaged', async () => {
    const ada = await seedBusiness();
    expect(await asTenant(ada, (tx) => customerConsentRepo.customerOptedOut(tx, keyFor(ada)))).toBe(
      false,
    );
  });
});

describe('STOP and START', () => {
  it('STOP suppresses and START restores, keeping the row either way', async () => {
    const ada = await seedBusiness();

    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), new Date()));
    expect(await asTenant(ada, (tx) => customerConsentRepo.customerOptedOut(tx, keyFor(ada)))).toBe(
      true,
    );

    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), null));
    expect(await asTenant(ada, (tx) => customerConsentRepo.customerOptedOut(tx, keyFor(ada)))).toBe(
      false,
    );

    /* START clears the timestamp; it does not erase that they once asked.
     * One row throughout, which is also what makes the repeat below a
     * question about an UPDATE rather than about a second insert. */
    const rows = await ownerDb.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM customer_message_optouts`,
    );
    expect([...rows][0]?.n).toBe('1');
  });

  it('a second STOP keeps the moment they FIRST asked', async () => {
    const ada = await seedBusiness();
    const first = new Date('2026-03-01T09:00:00.000Z');
    const later = new Date('2026-06-01T09:00:00.000Z');

    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), first));
    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), later));

    /* "When did they ask us to stop" has one honest answer, and repeating
     * the request is not a new request. `updated_at` records the repeat. */
    const rows = await ownerDb.execute<{ opted_out_at: Date; updated_at: Date }>(
      sql`SELECT opted_out_at, updated_at FROM customer_message_optouts`,
    );
    const row = [...rows][0];
    expect(new Date(row!.opted_out_at).toISOString()).toBe(first.toISOString());
    expect(new Date(row!.updated_at).getTime()).toBeGreaterThan(first.getTime());
  });

  it('STOP then START then STOP records the SECOND refusal, not the first', async () => {
    const ada = await seedBusiness();
    const first = new Date('2026-03-01T09:00:00.000Z');
    const again = new Date('2026-09-01T09:00:00.000Z');

    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), first));
    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), null));
    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), again));

    /* The state genuinely moved in between, so the timestamp moves with it.
     * Only a repeat of the state already held is preserved. */
    const rows = await ownerDb.execute<{ opted_out_at: Date }>(
      sql`SELECT opted_out_at FROM customer_message_optouts`,
    );
    expect(new Date([...rows][0]!.opted_out_at).toISOString()).toBe(again.toISOString());
  });
});

describe('the scope of a refusal', () => {
  it('is one shop on one number, never the person everywhere', async () => {
    const ada = await seedBusiness();

    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), new Date()));

    /* The SAME hash on a different WABA number is a different conversation.
     * In production it would not even be the same hash, because the index is
     * scoped by channel account; asserting on an identical one is stricter. */
    expect(
      await asTenant(ada, (tx) =>
        customerConsentRepo.customerOptedOut(tx, keyFor(ada, { channelAccountId: 'pn-200' })),
      ),
    ).toBe(false);

    /* A different customer on the same number is untouched. */
    expect(
      await asTenant(ada, (tx) =>
        customerConsentRepo.customerOptedOut(tx, keyFor(ada, { customerHash: 'blind-index-bbb' })),
      ),
    ).toBe(false);

    /* And a future index key version is a different key, so it must not
     * inherit an answer computed under the old one. */
    expect(
      await asTenant(ada, (tx) =>
        customerConsentRepo.customerOptedOut(tx, keyFor(ada, { indexKeyVersion: 'V2' })),
      ),
    ).toBe(false);
  });

  it('does not cross tenants, even on an identical hash', async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();

    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), new Date()));

    /* Bola's shop sees nothing of Ada's customer, and RLS is what says so:
     * the read is scoped by the GUC, not by the WHERE clause alone. */
    expect(
      await asTenant(bola, (tx) =>
        customerConsentRepo.customerOptedOut(tx, keyFor(bola, { customerHash: 'blind-index-aaa' })),
      ),
    ).toBe(false);

    const seen = await asTenant(bola, (tx) =>
      tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM customer_message_optouts`),
    );
    expect([...seen][0]?.n).toBe('0');
  });

  it('one tenant cannot clear a refusal that belongs to another', async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();

    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), new Date()));

    /* Bola writing the same hash writes Bola's OWN row - the tenant column
     * comes from the session, never from the caller's argument - so Ada's
     * customer stays refused. */
    await asTenant(bola, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(bola), null));

    expect(await asTenant(ada, (tx) => customerConsentRepo.customerOptedOut(tx, keyFor(ada)))).toBe(
      true,
    );
  });
});

describe('what the application role may not do', () => {
  it('cannot delete a consent record', async () => {
    const ada = await seedBusiness();
    await asTenant(ada, (tx) => customerConsentRepo.setCustomerOptOut(tx, keyFor(ada), new Date()));

    /* Migration 0121 revokes DELETE from both application roles: forgetting
     * that somebody asked to be left alone is not an application-level act.
     * Drizzle wraps the Postgres refusal, so assert the refusal and then
     * that the row is still there and still a refusal. */
    await expect(
      asTenant(ada, (tx) => tx.execute(sql`DELETE FROM customer_message_optouts`)),
    ).rejects.toThrow();

    expect(await asTenant(ada, (tx) => customerConsentRepo.customerOptedOut(tx, keyFor(ada)))).toBe(
      true,
    );
  });
});
