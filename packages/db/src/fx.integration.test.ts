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

async function bareTransaction(businessId: string): Promise<string> {
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
      VALUES (${businessId}::uuid, 'fx probe', 'manual', ${`fx-${seq}-${Math.floor(Math.random() * 1e9)}`})
      RETURNING id
    `);
    return [...rows][0]!.id;
  });
}

function insertLine(businessId: string, txId: string, currency: string, snapshotId: string | null) {
  return withBusiness(db, businessId, (tx) =>
    tx.execute(sql`
      INSERT INTO ledger_entries
        (business_id, transaction_id, account_id, debit_k, credit_k,
         transaction_currency, transaction_amount_minor, exchange_rate_snapshot_id)
      VALUES (${businessId}::uuid, ${txId}::uuid,
              (SELECT id FROM accounts WHERE business_id = ${businessId}::uuid AND code = '1000'),
              100, 0, ${currency}, 100, ${snapshotId}::uuid)
    `),
  );
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
    const txId = await bareTransaction(businessId);
    await expect(insertLine(businessId, txId, 'USD', null)).rejects.toThrow();
  });

  it('a cross-currency line with the right pair posts', async () => {
    const businessId = await seedBusiness();
    const { id } = await withBusiness(db, businessId, (tx) =>
      fxRepo.recordExchangeRateSnapshot(tx, usdNgn()),
    );
    const txId = await bareTransaction(businessId);
    await expect(insertLine(businessId, txId, 'USD', id)).resolves.toBeTruthy();
  });

  it('a snapshot for the wrong pair is refused by name', async () => {
    const businessId = await seedBusiness();
    const { id } = await withBusiness(db, businessId, (tx) =>
      fxRepo.recordExchangeRateSnapshot(tx, { ...usdNgn(), baseCurrency: 'GBP' }),
    );
    const txId = await bareTransaction(businessId);
    const refusal = await insertLine(businessId, txId, 'USD', id).then(
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
    const txId = await bareTransaction(businessId);
    const refusal = await insertLine(businessId, txId, 'NGN', id).then(
      () => 'inserted',
      (error: unknown) => (error as { cause?: { message?: string } }).cause?.message ?? 'unknown',
    );
    expect(refusal).toMatch(/rate is 1 by definition/);
  });
});
