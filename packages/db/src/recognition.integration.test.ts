/**
 * The five golden cases, against the real database (spec §12.4; PR-046):
 * policy from rows, balances from dimensioned journal lines, roles through
 * the chart, postings atomic, refusals kept and replayable. The engine is
 * still never told which case it is in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  identity,
  ordersRepo,
  recognitionEventsRepo,
  recognitionPolicyRepo,
  recognitionRepo,
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
async function seedBusiness(policy?: 'ON_FULFILMENT' | 'NONE'): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481840${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  if (policy) {
    await withBusiness(db, business.id, (tx) =>
      recognitionPolicyRepo.setReceivablePolicy(tx, {
        businessId: business.id,
        policy,
        actor: 'user:ada',
      }),
    );
  }
  return business.id;
}

async function seedOrder(businessId: string): Promise<string> {
  const order = await withBusiness(db, businessId, (tx) =>
    ordersRepo.placeOrder(tx, {
      businessId,
      customerId: null,
      lines: [
        { productId: null, name: 'wig', quantity: 1, unitPriceK: 100_000, lineTotalK: 100_000 },
      ],
      totalK: 100_000,
      sourceType: 'chat',
      sourceId: `ord-${seq}`,
    }),
  );
  return order.id;
}

const apply = (
  businessId: string,
  orderId: string,
  sourceId: string,
  event: Parameters<typeof recognitionRepo.applyRecognition>[1]['event'],
  extra: Partial<Parameters<typeof recognitionRepo.applyRecognition>[1]> = {},
) =>
  withBusiness(db, businessId, (tx) =>
    recognitionRepo.applyRecognition(tx, {
      businessId,
      orderId,
      sourceType: 'recognition-test',
      sourceId,
      event,
      actor: 'user:ada',
      ...extra,
    }),
  );

const state = (businessId: string, orderId: string) =>
  withBusiness(db, businessId, (tx) => recognitionRepo.orderLedgerState(tx, businessId, orderId));

describe('the five cases, in the database (§12.4)', () => {
  it('(a) unconditional receivable, then payment, then fulfilment', async () => {
    const businessId = await seedBusiness();
    const orderId = await seedOrder(businessId);

    const invoice = await apply(businessId, orderId, 'inv-1', {
      kind: 'RECEIVABLE_RAISED',
      amountMinor: 100_000,
    });
    expect(invoice.outcome).toBe('posted');
    expect(await state(businessId, orderId)).toEqual({
      contractLiabilityMinor: 100_000,
      receivableMinor: 100_000,
      revenueRecognisedToDateMinor: 0,
    });

    const payment = await apply(businessId, orderId, 'pay-1', {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 100_000,
      moneyRole: 'BANK',
    });
    expect(payment.outcome).toBe('posted');
    /* Contract liability UNCHANGED: the superseded formula's exact bug,
     * now checked against real rows. */
    expect(await state(businessId, orderId)).toEqual({
      contractLiabilityMinor: 100_000,
      receivableMinor: 0,
      revenueRecognisedToDateMinor: 0,
    });

    const fulfilment = await apply(businessId, orderId, 'ful-1', {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
      costMinor: 60_000,
    });
    expect(fulfilment).toMatchObject({ outcome: 'posted', revenueDeltaMinor: 100_000 });
    expect(await state(businessId, orderId)).toEqual({
      contractLiabilityMinor: 0,
      receivableMinor: 0,
      revenueRecognisedToDateMinor: 100_000,
    });
  });

  it('(b) advance payment then fulfilment', async () => {
    const businessId = await seedBusiness('NONE');
    const orderId = await seedOrder(businessId);
    await apply(businessId, orderId, 'pay-adv', {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 100_000,
      moneyRole: 'BANK',
    });
    expect((await state(businessId, orderId)).contractLiabilityMinor).toBe(100_000);
    const out = await apply(businessId, orderId, 'ful-adv', {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
    });
    expect(out.outcome).toBe('posted');
    expect(await state(businessId, orderId)).toEqual({
      contractLiabilityMinor: 0,
      receivableMinor: 0,
      revenueRecognisedToDateMinor: 100_000,
    });
  });

  it('(c) trade credit: the conditional invoice posts nothing; fulfilment raises the receivable', async () => {
    const businessId = await seedBusiness('ON_FULFILMENT');
    const orderId = await seedOrder(businessId);
    expect(
      await apply(businessId, orderId, 'inv-c', {
        kind: 'RECEIVABLE_RAISED',
        amountMinor: 100_000,
      }),
    ).toEqual({ outcome: 'nothing_to_post' });

    const fulfilment = await apply(businessId, orderId, 'ful-c', {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
      costMinor: 60_000,
    });
    expect(fulfilment.outcome).toBe('posted');
    expect(await state(businessId, orderId)).toEqual({
      contractLiabilityMinor: 0,
      receivableMinor: 100_000,
      revenueRecognisedToDateMinor: 100_000,
    });

    await apply(businessId, orderId, 'pay-c', {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 100_000,
      moneyRole: 'BANK',
    });
    expect((await state(businessId, orderId)).receivableMinor).toBe(0);
  });

  it('(d) partial deposit, fulfilment, balance', async () => {
    const businessId = await seedBusiness('ON_FULFILMENT');
    const orderId = await seedOrder(businessId);
    await apply(businessId, orderId, 'dep-d', {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 30_000,
      moneyRole: 'BANK',
    });
    const fulfilment = await apply(businessId, orderId, 'ful-d', {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
      costMinor: 60_000,
    });
    expect(fulfilment.outcome).toBe('posted');
    expect(await state(businessId, orderId)).toEqual({
      contractLiabilityMinor: 0,
      receivableMinor: 70_000,
      revenueRecognisedToDateMinor: 100_000,
    });
    await apply(businessId, orderId, 'bal-d', {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 70_000,
      moneyRole: 'BANK',
    });
    expect((await state(businessId, orderId)).receivableMinor).toBe(0);
  });

  it('(e) cash and carry: one posting, no transient contract liability', async () => {
    const businessId = await seedBusiness('NONE');
    const orderId = await seedOrder(businessId);
    const out = await apply(businessId, orderId, 'ful-e', {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
      costMinor: 60_000,
      collectedNowMinor: 100_000,
      moneyRole: 'CASH',
    });
    expect(out.outcome).toBe('posted');
    if (out.outcome !== 'posted') return;
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ role: string | null; debit_k: string; credit_k: string }>(sql`
        SELECT a.system_role AS role, e.debit_k::bigint AS debit_k, e.credit_k::bigint AS credit_k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.transaction_id = ${out.ledgerTransactionId}::uuid
      `),
    );
    const roles = [...rows].map((r) => r.role).sort();
    expect(roles).toEqual(['CASH', 'COGS', 'INVENTORY_ASSET', 'SALES_REVENUE']);
  });
});

describe('the refusal, kept and replayable (§12.2)', () => {
  it('earned beyond the right posts nothing, opens one item, and replays clean after the fix', async () => {
    const businessId = await seedBusiness();
    const orderId = await seedOrder(businessId);
    await apply(businessId, orderId, 'dep-r', {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 30_000,
      moneyRole: 'BANK',
    });

    const refused = await apply(businessId, orderId, 'ful-r', {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
    });
    expect(refused).toEqual({
      outcome: 'requires_review',
      reviewReason: 'UNSUPPORTED_CONTRACT_ASSET',
    });
    /* Nothing posted, everything kept. */
    expect((await state(businessId, orderId)).revenueRecognisedToDateMinor).toBe(0);
    const open = await withBusiness(db, businessId, (tx) =>
      recognitionEventsRepo.openReviewItemsFor(tx, businessId),
    );
    expect(open).toHaveLength(1);

    /* The replayed refusal is not a second item. */
    await apply(businessId, orderId, 'ful-r', { kind: 'FULFILMENT', earnedToDateMinor: 100_000 });
    expect(
      await withBusiness(db, businessId, (tx) =>
        recognitionEventsRepo.openReviewItemsFor(tx, businessId),
      ),
    ).toHaveLength(1);

    /* The human establishes the right: the missing 70k is invoiced.
     * The identical fulfilment event now posts. */
    await apply(businessId, orderId, 'inv-r', { kind: 'RECEIVABLE_RAISED', amountMinor: 70_000 });
    const replay = await apply(businessId, orderId, 'ful-r', {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
    });
    expect(replay).toMatchObject({ outcome: 'posted', revenueDeltaMinor: 100_000 });
    expect(await state(businessId, orderId)).toMatchObject({
      contractLiabilityMinor: 0,
      revenueRecognisedToDateMinor: 100_000,
    });
  });

  it('a recognised fulfilment replays as nothing_to_post: idempotent end to end', async () => {
    const businessId = await seedBusiness('NONE');
    const orderId = await seedOrder(businessId);
    await apply(businessId, orderId, 'pay-i', {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 100_000,
      moneyRole: 'BANK',
    });
    await apply(businessId, orderId, 'ful-i', { kind: 'FULFILMENT', earnedToDateMinor: 100_000 });
    expect(
      await apply(businessId, orderId, 'ful-i', { kind: 'FULFILMENT', earnedToDateMinor: 100_000 }),
    ).toEqual({ outcome: 'nothing_to_post' });
  });
});
