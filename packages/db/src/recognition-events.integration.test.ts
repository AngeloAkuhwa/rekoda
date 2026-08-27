/**
 * RevenueRecognitionEvent idempotency and the review queue (spec §12.2,
 * §12.5; PR-045): a replayed fulfilment is not a second recognition, the
 * recognised-to-date sum is live and per order, and an atomic refusal
 * leaves exactly one open item carrying everything the engine saw.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  identity,
  journalRepo,
  ordersRepo,
  recognitionEventsRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
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
  const user = await identity.upsertUserByPhone(db, `+23481830${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** An order plus one balanced journal to hang recognitions off. */
async function fixture(businessId: string) {
  return withBusiness(db, businessId, async (tx) => {
    const order = await ordersRepo.placeOrder(tx, {
      businessId,
      customerId: null,
      lines: [
        { productId: null, name: 'wig', quantity: 1, unitPriceK: 100_000, lineTotalK: 100_000 },
      ],
      totalK: 100_000,
      sourceType: 'chat',
      sourceId: `ord-${seq}`,
    });
    const journal = await journalRepo.recordJournal(tx, {
      businessId,
      memo: 'recognition carrier',
      amountK: 100_000,
      intoAccount: 'BANK',
      outOfAccount: 'CASH',
      actor: 'system',
    });
    return { orderId: order.id, ledgerTransactionId: journal.ledgerTransactionId };
  });
}

describe('idempotency (§12.5)', () => {
  it('the same quadruple recognises once; the sum never doubles', async () => {
    const businessId = await seedBusiness();
    const { orderId, ledgerTransactionId } = await fixture(businessId);

    const first = await withBusiness(db, businessId, (tx) =>
      recognitionEventsRepo.recordRevenueRecognition(tx, {
        businessId,
        orderId,
        sourceType: 'fulfilment',
        sourceId: 'ful-1',
        amountMinor: 100_000,
        ledgerTransactionId,
      }),
    );
    expect(first.outcome).toBe('recorded');

    const replay = await withBusiness(db, businessId, (tx) =>
      recognitionEventsRepo.recordRevenueRecognition(tx, {
        businessId,
        orderId,
        sourceType: 'fulfilment',
        sourceId: 'ful-1',
        amountMinor: 100_000,
        ledgerTransactionId,
      }),
    );
    expect(replay).toEqual({ outcome: 'already_recorded' });

    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionEventsRepo.revenueRecognisedToDate(tx, businessId, orderId),
      ),
    ).toBe(100_000);
  });

  it('different order lines under one fulfilment are distinct recognitions', async () => {
    const businessId = await seedBusiness();
    const { orderId, ledgerTransactionId } = await fixture(businessId);
    const lineA = '11111111-1111-4111-8111-111111111111';
    const lineB = '22222222-2222-4222-8222-222222222222';
    for (const orderLineId of [lineA, lineB]) {
      const out = await withBusiness(db, businessId, (tx) =>
        recognitionEventsRepo.recordRevenueRecognition(tx, {
          businessId,
          orderId,
          orderLineId,
          sourceType: 'fulfilment',
          sourceId: 'ful-2',
          amountMinor: 40_000,
          ledgerTransactionId,
        }),
      );
      expect(out.outcome).toBe('recorded');
    }
    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionEventsRepo.revenueRecognisedToDate(tx, businessId, orderId),
      ),
    ).toBe(80_000);
  });

  it('what has been recognised is history: no update, no delete', async () => {
    const businessId = await seedBusiness();
    const { orderId, ledgerTransactionId } = await fixture(businessId);
    await withBusiness(db, businessId, (tx) =>
      recognitionEventsRepo.recordRevenueRecognition(tx, {
        businessId,
        orderId,
        sourceType: 'fulfilment',
        sourceId: 'ful-3',
        amountMinor: 10_000,
        ledgerTransactionId,
      }),
    );
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE revenue_recognition_events SET amount_minor = 1 WHERE business_id = ${businessId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`DELETE FROM revenue_recognition_events WHERE business_id = ${businessId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("an event cannot cite another tenant's order", async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    const adaFixture = await fixture(ada);
    const bolaFixture = await fixture(bola);
    await expect(
      withBusiness(db, ada, (tx) =>
        recognitionEventsRepo.recordRevenueRecognition(tx, {
          businessId: ada,
          orderId: bolaFixture.orderId,
          sourceType: 'fulfilment',
          sourceId: 'ful-x',
          amountMinor: 1,
          ledgerTransactionId: adaFixture.ledgerTransactionId,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('the review queue (§12.2)', () => {
  it('opens once per refused event, keeps the context, and resolves by hand', async () => {
    const businessId = await seedBusiness();
    const { orderId } = await fixture(businessId);
    const context = {
      recogniseDeltaMinor: 100_000,
      contractLiabilityMinor: 30_000,
      receivableMinor: 0,
      collectedNowMinor: 0,
    };
    const opened = await withBusiness(db, businessId, (tx) =>
      recognitionEventsRepo.openReviewItem(tx, {
        businessId,
        orderId,
        reviewReason: 'UNSUPPORTED_CONTRACT_ASSET',
        sourceType: 'fulfilment',
        sourceId: 'ful-9',
        context,
      }),
    );
    expect(opened.outcome).toBe('opened');

    /* The replayed refusal is not a second thing for a human to look at. */
    const again = await withBusiness(db, businessId, (tx) =>
      recognitionEventsRepo.openReviewItem(tx, {
        businessId,
        orderId,
        reviewReason: 'UNSUPPORTED_CONTRACT_ASSET',
        sourceType: 'fulfilment',
        sourceId: 'ful-9',
        context,
      }),
    );
    expect(again).toEqual({ outcome: 'already_open' });

    const open = await withBusiness(db, businessId, (tx) =>
      recognitionEventsRepo.openReviewItemsFor(tx, businessId),
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.context).toEqual(context);

    if (opened.outcome !== 'opened') return;
    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionEventsRepo.resolveReviewItem(tx, {
          businessId,
          itemId: opened.id,
          actor: 'user:ada',
        }),
      ),
    ).toBe('resolved');
    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionEventsRepo.openReviewItemsFor(tx, businessId),
      ),
    ).toHaveLength(0);
  });

  it('an unknown review reason is unrepresentable', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO recognition_review_items (business_id, review_reason, source_type, source_id, context)
          VALUES (${businessId}::uuid, 'JUST_FEELS_OFF', 'fulfilment', 'x', '{}'::jsonb)
        `),
      ),
    ).rejects.toThrow();
  });
});
