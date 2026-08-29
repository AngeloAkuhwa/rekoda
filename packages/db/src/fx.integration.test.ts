/**
 * The FX requirement, held by the database (spec §16, Appendix A.1;
 * PR-038): a snapshot exists exactly when the transaction currency differs
 * from the functional one — REQUIRED when they differ, FORBIDDEN when
 * equal — and when present it must actually be for the pair being
 * converted. The snapshot itself is immutable market fact: an override
 * carries who and why, and nothing rewrites a written rate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, fxRepo, identity, sql, withBusiness, type Db } from './index.js';
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
  const user = await identity.upsertUserByPhone(db, `+23481795${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/**
 * One balanced two-line posting, transaction and lines in a single
 * database transaction — the deferred shape triggers (0070) hold at every
 * commit, so a probe cannot leave scaffolding behind.
 */
function postPair(businessId: string, currency: string, snapshotId: string | null) {
  seq += 1;
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
      VALUES (${businessId}::uuid, 'fx probe', 'manual', ${`fx-${seq}`})
      RETURNING id
    `);
    const txId = [...rows][0]!.id;
    const amount = currency === 'NGN' ? 100 : 15;
    await tx.execute(sql`
      INSERT INTO ledger_entries
        (business_id, transaction_id, account_id, debit_k, credit_k,
         transaction_currency, transaction_amount_minor, exchange_rate_snapshot_id)
      VALUES
        (${businessId}::uuid, ${txId}::uuid,
         (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = '1000'),
         100, 0, ${currency}, ${amount}, ${snapshotId}::uuid),
        (${businessId}::uuid, ${txId}::uuid,
         (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = '4000'),
         0, 100, ${currency}, ${amount}, ${snapshotId}::uuid)
    `);
  });
}

const usdNgn = () => ({
  baseCurrency: 'USD',
  quoteCurrency: 'NGN',
  rate: '1512.34567891234',
  effectiveAt: new Date('2026-06-15T00:00:00Z'),
  source: 'PROVIDER' as const,
  providerName: 'test-provider',
});

describe('the snapshot row (A.1)', () => {
  it('stores full precision and reads it back unrounded', async () => {
    const businessId = await seedBusiness();
    const { id } = await withBusiness(db, businessId, (tx) =>
      fxRepo.recordExchangeRateSnapshot(tx, usdNgn()),
    );
    const row = await withBusiness(db, businessId, (tx) => fxRepo.exchangeRateSnapshotById(tx, id));
    expect(row!.rate).toBe('1512.34567891234');
    expect(row!.source).toBe('PROVIDER');
  });

  it('an override without who-and-why is unrepresentable', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        fxRepo.recordExchangeRateSnapshot(tx, { ...usdNgn(), source: 'MANUAL_OVERRIDE' }),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, businessId, (tx) =>
        fxRepo.recordExchangeRateSnapshot(tx, {
          ...usdNgn(),
          source: 'MANUAL_OVERRIDE',
          actorId: 'user:ada',
          reason: 'provider outage, rate from bank statement',
        }),
      ),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('a written rate cannot be rewritten', async () => {
    const businessId = await seedBusiness();
    const { id } = await withBusiness(db, businessId, (tx) =>
      fxRepo.recordExchangeRateSnapshot(tx, usdNgn()),
    );
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE exchange_rate_snapshots SET rate = '1' WHERE id = ${id}::uuid`),
      ),
    ).rejects.toThrow();
  });
});

describe('the FX requirement (§16, §10)', () => {
  it('a cross-currency line without a snapshot is refused', async () => {
    const businessId = await seedBusiness();
    await expect(postPair(businessId, 'USD', null)).rejects.toThrow();
  });

  it('a cross-currency posting with the right pair commits', async () => {
    const businessId = await seedBusiness();
    const { id } = await withBusiness(db, businessId, (tx) =>
      fxRepo.recordExchangeRateSnapshot(tx, usdNgn()),
    );
    await expect(postPair(businessId, 'USD', id)).resolves.toBeUndefined();
  });

  it('a snapshot for the wrong pair is refused by name', async () => {
    const businessId = await seedBusiness();
    const { id } = await withBusiness(db, businessId, (tx) =>
      fxRepo.recordExchangeRateSnapshot(tx, { ...usdNgn(), baseCurrency: 'GBP' }),
    );
    const refusal = await postPair(businessId, 'USD', id).then(
      () => 'inserted',
      (error: unknown) => (error as { cause?: { message?: string } }).cause?.message ?? 'unknown',
    );
    expect(refusal).toMatch(/GBP\/NGN but the line converts USD/);
  });

  it('a same-currency line carrying a snapshot is refused: the rate is 1 by definition', async () => {
    const businessId = await seedBusiness();
    const { id } = await withBusiness(db, businessId, (tx) =>
      fxRepo.recordExchangeRateSnapshot(tx, usdNgn()),
    );
    const refusal = await postPair(businessId, 'NGN', id).then(
      () => 'inserted',
      (error: unknown) => (error as { cause?: { message?: string } }).cause?.message ?? 'unknown',
    );
    expect(refusal).toMatch(/rate is 1 by definition/);
  });
});
