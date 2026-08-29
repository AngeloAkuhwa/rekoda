/**
 * Ledger-level idempotency (spec §9.3, §9.4; PR-040): the reversal that can
 * only happen once, the financial event that cannot post twice, and the
 * postingKey for writers whose identity is not (sourceType, sourceId)
 * shaped. Every probe bypasses the application layer on purpose — this is
 * the layer that holds when everything above it fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, withBusiness, type Db } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481799${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** A balanced raw posting with whatever ledger-level identity the test needs. */
function post(
  businessId: string,
  opts: {
    sourceId: string;
    purpose?: string | null;
    key?: string | null;
    reversesId?: string | null;
  },
): Promise<string> {
  seq += 1;
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO ledger_transactions
        (business_id, memo, source_type, source_id, posting_purpose, posting_key, reverses_id)
      VALUES (${businessId}::uuid, 'idempotency probe', 'webhook', ${opts.sourceId},
              ${opts.purpose ?? null}, ${opts.key ?? null}, ${opts.reversesId ?? null}::uuid)
      RETURNING id
    `);
    const txId = [...rows][0]!.id;
    await tx.execute(sql`
      INSERT INTO ledger_entries
        (business_id, transaction_id, account_id, debit_k, credit_k, transaction_amount_minor)
      VALUES
        (${businessId}::uuid, ${txId}::uuid,
         (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = '1000'),
         100, 0, 100),
        (${businessId}::uuid, ${txId}::uuid,
         (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = '4000'),
         0, 100, 100)
    `);
    return txId;
  });
}

describe('financial-event idempotency (§9.4)', () => {
  it('a retried webhook cannot produce a second balanced journal', async () => {
    const businessId = await seedBusiness();
    await post(businessId, { sourceId: 'evt-1', purpose: 'PAYMENT_CONFIRMATION' });
    await expect(
      post(businessId, { sourceId: 'evt-1', purpose: 'PAYMENT_CONFIRMATION' }),
    ).rejects.toThrow();
  });

  it('the same source under a different purpose is a different event', async () => {
    const businessId = await seedBusiness();
    await post(businessId, { sourceId: 'evt-2', purpose: 'PAYMENT_CONFIRMATION' });
    await expect(
      post(businessId, { sourceId: 'evt-2', purpose: 'SETTLEMENT' }),
    ).resolves.toBeTruthy();
  });

  it('history without a purpose stays unguarded, on purpose', async () => {
    const businessId = await seedBusiness();
    await post(businessId, { sourceId: 'evt-3' });
    await expect(post(businessId, { sourceId: 'evt-3' })).resolves.toBeTruthy();
  });

  it('an unknown purpose is unrepresentable', async () => {
    const businessId = await seedBusiness();
    await expect(post(businessId, { sourceId: 'evt-4', purpose: 'VIBES' })).rejects.toThrow();
  });
});

describe('a full reversal may occur only once (§9.3)', () => {
  it('the second reversal of one original is refused', async () => {
    const businessId = await seedBusiness();
    const original = await post(businessId, { sourceId: 'orig-1' });
    await post(businessId, { sourceId: 'rev-1', reversesId: original });
    await expect(post(businessId, { sourceId: 'rev-2', reversesId: original })).rejects.toThrow();
  });
});

describe('postingKey', () => {
  it('two postings cannot share a key', async () => {
    const businessId = await seedBusiness();
    await post(businessId, { sourceId: 'k-1', key: 'depreciation:asset-9:2026-06' });
    await expect(
      post(businessId, { sourceId: 'k-2', key: 'depreciation:asset-9:2026-06' }),
    ).rejects.toThrow();
  });

  it('but tenants never collide', async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    await post(ada, { sourceId: 'k-3', key: 'shared-key' });
    await expect(post(bola, { sourceId: 'k-3', key: 'shared-key' })).resolves.toBeTruthy();
  });
});
