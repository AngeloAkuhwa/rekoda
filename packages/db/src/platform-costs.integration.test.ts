/**
 * The platform-cost subledger (BL2, PR-102), against real PostgreSQL:
 * real money becomes an immutable fact at the chokepoint every runtime
 * spend already flows through, retries record one fact, and the database
 * itself refuses the application an UPDATE, a DELETE, or (for the
 * merchant-facing role) even a read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  identity,
  platformCostsRepo,
  quotaRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let workerDb: Db;
let close: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 }));
});

afterAll(async () => {
  await close?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481930${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** Drizzle wraps the driver error; the Postgres code rides the cause chain. */
function pgCode(error: unknown): string | undefined {
  let cursor = error as { code?: string; cause?: unknown } | undefined;
  while (cursor) {
    if (cursor.code) return cursor.code;
    cursor = cursor.cause as { code?: string; cause?: unknown } | undefined;
  }
  return undefined;
}

const window = () => ({
  from: new Date(Date.now() - 3_600_000),
  to: new Date(Date.now() + 3_600_000),
});

describe('the platform-cost subledger (COST-1, PR-102)', () => {
  it('a priced spend writes telemetry AND an immutable cost fact, attributed', async () => {
    const businessId = await seedBusiness();

    /* The chokepoint: exactly the call the interpreter, the reply sender
     * and the template send already make. */
    await withBusiness(db, businessId, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider: 'anthropic',
        usageType: 'llm_call',
        quantity: 1,
        providerCostMicros: 2_000,
        nairaEquivalentK: 1_200,
        billingPeriod: '2026-08',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider: 'meta',
        usageType: 'UTILITY',
        quantity: 1,
        providerCostMicros: 6_700,
        nairaEquivalentK: 972,
        billingPeriod: '2026-08',
      }),
    );

    const { from, to } = window();
    const lines = await platformCostsRepo.costsForBusiness(workerDb, businessId, from, to);
    expect(lines).toEqual([
      {
        costType: 'AI_INFERENCE',
        provider: 'anthropic',
        actualOrEstimated: 'ESTIMATED',
        amountMinor: 1_200,
        events: 1,
      },
      {
        costType: 'MESSAGING',
        provider: 'meta',
        actualOrEstimated: 'ESTIMATED',
        amountMinor: 972,
        events: 1,
      },
    ]);
  });

  it('an unpriced call writes telemetry only: zero is not a charge', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider: 'anthropic',
        usageType: 'llm_call',
        quantity: 1,
        providerCostMicros: 0,
        nairaEquivalentK: 0,
        billingPeriod: '2026-08',
        meta: { priced: false },
      }),
    );
    const { from, to } = window();
    expect(await platformCostsRepo.costsForBusiness(workerDb, businessId, from, to)).toEqual([]);
  });

  it('a retried writer records one fact: the reference is the idempotency spine', async () => {
    const businessId = await seedBusiness();
    const event = {
      provider: 'paystack',
      providerProduct: 'subscription_collection_fee',
      businessId,
      costType: 'PAYMENT_FEE' as const,
      amountMinor: 16_750,
      currency: 'NGN',
      externalReference: 'ps_fee_0001',
      incurredAt: new Date(),
      source: 'PROVIDER_API' as const,
      actualOrEstimated: 'ACTUAL' as const,
    };
    await platformCostsRepo.recordCostEvent(workerDb, event);
    await platformCostsRepo.recordCostEvent(workerDb, event);

    const { from, to } = window();
    const lines = await platformCostsRepo.costsForBusiness(workerDb, businessId, from, to);
    expect(lines).toEqual([
      {
        costType: 'PAYMENT_FEE',
        provider: 'paystack',
        actualOrEstimated: 'ACTUAL',
        amountMinor: 16_750,
        events: 1,
      },
    ]);
  });

  it('a cost nobody carries is a real row: null business, listed as unattributed', async () => {
    await platformCostsRepo.recordCostEvent(workerDb, {
      provider: 'storage',
      providerProduct: 'r2_object_storage',
      businessId: null,
      costType: 'STORAGE',
      amountMinor: 3_500_000,
      currency: 'NGN',
      externalReference: 'r2_invoice_2026_08',
      incurredAt: new Date(),
      source: 'PROVIDER_INVOICE',
      actualOrEstimated: 'ACTUAL',
    });

    const { from, to } = window();
    const summary = await platformCostsRepo.costSummary(workerDb, from, to);
    expect(summary).toEqual([
      {
        costType: 'STORAGE',
        provider: 'storage',
        actualOrEstimated: 'ACTUAL',
        attributed: false,
        amountMinor: 3_500_000,
        events: 1,
      },
    ]);
  });

  it('a pinned tenant cannot attribute a cost to another business (PR-106)', async () => {
    const mine = await seedBusiness();
    const other = await seedBusiness();
    /* Under the app pin, an INSERT naming another tenant's business_id is
     * refused by the trigger - the row is immutable and unattributable, so
     * a cross-tenant write would poison the margin model permanently. */
    const wrong = await withBusiness(db, mine, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId: other,
        provider: 'anthropic',
        usageType: 'llm_call',
        quantity: 1,
        providerCostMicros: 2_000,
        nairaEquivalentK: 900,
        billingPeriod: '2026-08',
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(wrong).not.toBeNull();

    /* The pinned tenant's own cost still records. */
    await withBusiness(db, mine, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId: mine,
        provider: 'anthropic',
        usageType: 'llm_call',
        quantity: 1,
        providerCostMicros: 2_000,
        nairaEquivalentK: 900,
        billingPeriod: '2026-08',
      }),
    );
    const { from, to } = window();
    expect((await platformCostsRepo.costsForBusiness(workerDb, mine, from, to)).length).toBe(1);
    expect((await platformCostsRepo.costsForBusiness(workerDb, other, from, to)).length).toBe(0);
  });

  it('append-only is a database property: no UPDATE, no DELETE, and no app read', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider: 'stt',
        usageType: 'stt_seconds',
        quantity: 30,
        providerCostMicros: 3_000,
        nairaEquivalentK: 400,
        billingPeriod: '2026-08',
      }),
    );

    const attempts = [
      () => db.execute(sql`SELECT * FROM platform_cost_events`),
      () => db.execute(sql`UPDATE platform_cost_events SET amount_minor = 0`),
      () => db.execute(sql`DELETE FROM platform_cost_events`),
      () => workerDb.execute(sql`UPDATE platform_cost_events SET amount_minor = 0`),
      () => workerDb.execute(sql`DELETE FROM platform_cost_events`),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).not.toBeNull();
      expect(pgCode(error)).toBe('42501');
    }
  });
});
