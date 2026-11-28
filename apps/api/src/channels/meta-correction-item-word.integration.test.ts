/**
 * CG5, an item word in a correction (OD-63(a) Option B, owner ruling OWN-102(3), 22 Nov 2026). Split
 * from `meta-correction-kind.integration.test.ts` by concern; the same fixtures. Also holds the
 * corrections made while an earlier message retries, and an anonymous sale corrected with another
 * sale beside it.
 */
import { describe, expect, it } from 'vitest';
import { replies } from '@rekoda/core';
import { identity, sql, withBusiness } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import {
  db,
  deps,
  knownCustomer,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';
import { bringDue, failOnceAndBackOff, queueOnly } from './meta-lost-message.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';
const MEMBER = '2348035550000';

const SALE = {
  intent: 'RecordSale',
  customer: { kind: 'token', token: 'CUSTOMER_7K2' },
  items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
  statedTotal: 150_000,
  reportedPayment: 0,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
};
const expense = (amount: number) => ({
  intent: 'RecordExpense',
  description: 'fuel for generator',
  amount,
  category: 'utilities',
  paymentMethod: 'cash',
});
const purchase = (amount: number) => ({
  intent: 'RecordPurchase',
  supplierMention: 'Mama Nkechi',
  description: 'ankara fabric',
  amount,
  reportedPayment: amount,
  paymentMethod: 'cash',
  productMention: null,
  quantity: null,
});

async function run() {
  const runner = buildRunner(workerDb, db, deps);
  while (await runner.runOnce()) {
    /* keep going */
  }
}

async function send(text: string, wamid: string, reading?: unknown, from = OWNER) {
  if (reading) stubTransport.replyWith(reading);
  await post(messagePayload(from, wamid, text));
  await run();
}

async function seedOwner() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return { business, ada: await knownCustomer(business.id) };
}

/** Every record draft, oldest first, as "<intent>:<state>". */
const drafts = async (businessId: string) =>
  [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<{ intent: string; state: string }>(sql`
        SELECT intent, state FROM command_drafts
         WHERE business_id = ${businessId}::uuid AND intent NOT IN ('Query', 'Unclear')
         ORDER BY insertion_seq`),
    )),
  ].map((r) => `${r.intent}:${r.state}`);

/** What the books hold: invoices with their customer, and expenses by amount. */
const books = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => ({
    invoices: [
      ...(await tx.execute<{ customer_id: string | null; total_k: number }>(sql`
        SELECT customer_id, total_k::int AS total_k FROM invoices
         WHERE business_id = ${businessId}::uuid ORDER BY created_at`)),
    ],
    expenses: [
      ...(await tx.execute<{ amount_k: number }>(sql`
        SELECT amount_k::int AS amount_k FROM expenses
         WHERE business_id = ${businessId}::uuid ORDER BY created_at`)),
    ].map((r) => r.amount_k),
  }));

/**
 * OD-63(a) Option B (owner ruling 22 Nov 2026): the bare item word never explains a correction,
 * because an item may be named like a person nobody recorded. "4 Tunde not 3" for a Tunde item is
 * asked about and never keeps Ada; a plural ("make it 4 wigs") still does. Every confirmed invoice's
 * own customer is checked.
 */
describe('CG5: an item word in a correction (OD-63(a) Option B)', () => {
  const TUNDE_ITEM = { ...SALE, items: [{ name: 'Tunde', quantity: 3, unitPrice: 50_000 }] };

  it('"4 Tunde not 3" with nobody recorded as Tunde is asked about; Ada keeps only her sale', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 Tunde for 150k', 'wamid.TB1-SALE', TUNDE_ITEM);

    await send('4 Tunde not 3', 'wamid.TB1-FIX', {
      ...TUNDE_ITEM,
      customer: { kind: 'none' },
      items: [{ name: 'Tunde', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionCustomerNotClear().text);
    expect(stubSender.lastText).not.toContain('The same customer as before');
    expect(await drafts(business.id)).toEqual(['RecordSale:pending']);

    await send('yes', 'wamid.TB1-YES1');
    /* The first yes answers the refusal and books nothing (CodeRabbit on #437 at 88258dc). */
    expect((await books(business.id)).invoices).toEqual([]);
    await send('yes', 'wamid.TB1-YES2');
    expect(await books(business.id)).toEqual({
      invoices: [{ customer_id: ada.id, total_k: 15_000_000 }],
      expenses: [],
    });
  });

  it('"make it 4 wig" names only the bare item word, so it is asked about', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.TB2-SALE', SALE);

    await send('make it 4 wig', 'wamid.TB2-FIX', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionCustomerNotClear().text);
    await send('yes', 'wamid.TB2-YES1');
    /* The first yes answers the refusal and books nothing (CodeRabbit on #437 at 88258dc). */
    expect((await books(business.id)).invoices).toEqual([]);
    await send('yes', 'wamid.TB2-YES2');
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: ada.id, total_k: 15_000_000 },
    ]);
  });

  it('"make it 4 wigs" keeps Ada, and the corrected invoice is hers', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.TB3-SALE', SALE);

    await send('make it 4 wigs', 'wamid.TB3-FIX', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toContain('The same customer as before');
    await send('yes', 'wamid.TB3-YES');
    await send('yes', 'wamid.TB3-YES2');
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: ada.id, total_k: 20_000_000 },
    ]);
  });

  /* "to" in "ready to wear" is grammar in the correction, not the item word (CodeRabbit, #437 9c587bd). */
  it('"change the price to 60k" for a ready to wear sale keeps Ada', async () => {
    const { business, ada } = await seedOwner();
    const RTW = { ...SALE, items: [{ name: 'ready to wear', quantity: 3, unitPrice: 50_000 }] };
    await send('Ada bought 3 ready to wear for 150k', 'wamid.TB5-SALE', RTW);

    await send('change the price to 60k', 'wamid.TB5-FIX', {
      ...RTW,
      customer: { kind: 'none' },
      items: [{ name: 'ready to wear', quantity: 3, unitPrice: 60_000 }],
      statedTotal: 180_000,
    });
    expect(stubSender.lastText).toContain('The same customer as before');
    await send('yes', 'wamid.TB5-YES');
    await send('yes', 'wamid.TB5-YES2');
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: ada.id, total_k: 18_000_000 },
    ]);
  });

  it("a correction carrying another customer's token is refused and books nothing new", async () => {
    const { business, ada } = await seedOwner();
    await knownCustomer(business.id, 'Bola', 'CUSTOMER_9BL');
    await send('Ada bought 3 wigs for 150k', 'wamid.TB4-SALE', SALE);

    await send('make it 4 wigs', 'wamid.TB4-FIX', {
      ...SALE,
      customer: { kind: 'token', token: 'CUSTOMER_9BL' },
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toContain('could not tell which customer');
    await send('yes', 'wamid.TB4-YES1');
    /* The first yes answers the refusal and books nothing (CodeRabbit on #437 at 88258dc). */
    expect((await books(business.id)).invoices).toEqual([]);
    await send('yes', 'wamid.TB4-YES2');
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: ada.id, total_k: 15_000_000 },
    ]);
  });
});

/* A figure in seconds is a time, never a correction of the waiting expense (CodeRabbit on #437 at
 * cf96697): the preview stays, and nothing is booked. */
describe('a seconds-only message beside a waiting expense', () => {
  it('never replaces the shown preview', async () => {
    const { business } = await seedOwner();
    await send('fuel 6k', 'wamid.SEC-EXP', expense(6_000));
    /* The same draft holding the same ₦6,000 command afterwards, and nothing posted (CodeRabbit on
     * #437 at 156621f): a state check alone passes an overwritten amount. */
    const expenseDraft = (businessId: string) =>
      withBusiness(db, businessId, (tx) =>
        tx.execute<{ id: string; state: string; command: unknown }>(sql`
          SELECT id, state, command FROM command_drafts
           WHERE business_id = ${businessId}::uuid AND intent = 'RecordExpense'
           ORDER BY insertion_seq`),
      ).then((rows) => [...rows]);
    const before = await expenseDraft(business.id);
    expect(before.map((r) => r.state)).toEqual(['pending']);

    await send('make it 5 seconds', 'wamid.SEC-FIX', expense(5_000));
    expect(stubSender.lastText).not.toContain(replies.correctionTaken().text);
    expect(await expenseDraft(business.id)).toEqual(before);
    expect((await books(business.id)).expenses).toEqual([]);
  });
});

/* OD-67 Option B (owner ruling OWN-103(3)): "4 not 3" says nothing about a ₦5,000 expense, so it is
 * asked about, the shown expense stays, and only it is booked. */
describe('a replaced figure a waiting expense does not hold', () => {
  it('"4 not 3" changes nothing, and the expense is booked as shown', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k cash', 'wamid.FX-EXP', expense(5_000));

    await send('4 not 3', 'wamid.FX-FIX', expense(4));
    expect(stubSender.lastText).toBe(replies.correctionFigureNotInDraft().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending']);
    await send('yes', 'wamid.FX-YES1');
    await send('yes', 'wamid.FX-YES2');
    expect((await books(business.id)).expenses).toEqual([500_000]);
  });
});

/* A filler between "not" and the figure still names it: ₦5,000 is not in a ₦7,000 expense, so the
 * preview stays (CodeRabbit on #437 at 4a5fd80). */
describe('a replaced figure behind "the"', () => {
  it('"No, it was 6k, not the 5k" beside ₦7,000 changes nothing', async () => {
    const { business } = await seedOwner();
    await send('fuel 7k cash', 'wamid.FT-EXP', expense(7_000));

    await send('No, it was 6k, not the 5k', 'wamid.FT-FIX', expense(6_000));
    expect(stubSender.lastText).toBe(replies.correctionFigureNotInDraft().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending']);
    await send('yes', 'wamid.FT-YES1');
    await send('yes', 'wamid.FT-YES2');
    expect((await books(business.id)).expenses).toEqual([700_000]);
  });
});

/* An apology opener on the same expense with a new amount is a correction (owner disposition of
 * #437, 22 Nov 2026): one preview replaces the other, so one tank of fuel is booked once. With an
 * adding word it is asked about, and a record of another kind is never taken for it. */
describe('an apology opener beside a waiting expense', () => {
  it('"Sorry, bought fuel for 6k cash" replaces the ₦5,000 preview and books ₦6,000 once', async () => {
    const { business } = await seedOwner();
    await send('Bought fuel for 5k', 'wamid.AP1-EXP', expense(5_000));

    await send('Sorry, bought fuel for 6k cash', 'wamid.AP1-FIX', expense(6_000));
    expect(stubSender.lastText).toContain(replies.correctionTaken().text);
    expect(await drafts(business.id)).toEqual([
      'RecordExpense:superseded',
      'RecordExpense:pending',
    ]);
    await send('yes', 'wamid.AP1-YES');
    await send('yes', 'wamid.AP1-YES2');
    expect((await books(business.id)).expenses).toEqual([600_000]);
  });

  it('"Sorry, I also bought fuel for 6k" is asked about and replaces nothing', async () => {
    const { business } = await seedOwner();
    await send('Bought fuel for 5k', 'wamid.AP2-EXP', expense(5_000));

    await send('Sorry, I also bought fuel for 6k', 'wamid.AP2-ADD', expense(6_000));
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending']);
  });

  it('"Sorry, sold 2 bags for 20k" is another kind: asked about, the expense stays', async () => {
    const { business } = await seedOwner();
    await send('Bought fuel for 5k', 'wamid.AP3-EXP', expense(5_000));

    await send('Sorry, sold 2 bags for 20k', 'wamid.AP3-SALE', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'bag', quantity: 2, unitPrice: 10_000 }],
      statedTotal: 20_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending']);
  });

  it('a new expense with no correction cue is previewed on its own beside it', async () => {
    const { business } = await seedOwner();
    await send('Bought fuel for 5k', 'wamid.AP4-EXP', expense(5_000));

    await send('Bought diesel for 6k', 'wamid.AP4-NEW', {
      ...expense(6_000),
      description: 'diesel',
    });
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending', 'RecordExpense:pending']);
  });
});

it('a decimal million price correction replaces the earlier sale preview exactly once', async () => {
  const { business, ada } = await seedOwner();
  await send('Ada bought 3 wigs at 50k each', 'wamid.CM-sale', SALE);
  await send('change the price to 1.6m', 'wamid.CM-change', {
    ...SALE,
    customer: { kind: 'none' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 1_600_000 }],
    statedTotal: 4_800_000,
  });
  expect(await drafts(business.id)).toEqual(['RecordSale:superseded', 'RecordSale:pending']);
  await send('yes', 'wamid.CM-yes');
  await send('yes', 'wamid.CM-yes-again');
  expect((await books(business.id)).invoices).toEqual([
    { customer_id: ada.id, total_k: 480_000_000 },
  ]);
});

it('corrects the whole stock count shown for a fractional purchase quantity', async () => {
  const { business } = await seedOwner();
  const original = { ...purchase(50_000), productMention: 'ankara fabric', quantity: 3.5 };
  await send('bought 3.5 pcs of ankara fabric for 50k cash', 'wamid.CQ-buy', original);
  expect(stubSender.lastText).toContain('Adding to stock: 3 ankara fabric');

  await send('No, 4 pcs not 3', 'wamid.CQ-correct', { ...original, quantity: 4 });
  expect(stubSender.lastText).toContain('Adding to stock: 4 ankara fabric');
  expect(await drafts(business.id)).toEqual([
    'RecordPurchase:superseded',
    'RecordPurchase:pending',
  ]);
  /* The stock that moved, not only the draft states (CodeRabbit on #437 at 600a155). */
  const arrived = async () =>
    [
      ...(await withBusiness(db, business.id, (tx) =>
        tx.execute<{ delta: number }>(sql`
          SELECT delta FROM inventory_movements
           WHERE business_id = ${business.id}::uuid ORDER BY created_at`),
      )),
    ].map((r) => r.delta);
  await send('yes', 'wamid.CQ-confirm');
  expect(await arrived()).toEqual([4]);
  await send('yes', 'wamid.CQ-repeat');
  expect(await arrived()).toEqual([4]);
  expect(await drafts(business.id)).toEqual([
    'RecordPurchase:superseded',
    'RecordPurchase:confirmed',
  ]);
});

/* OD-76 Option A (owner ruling OWN-107): a correction changes only the figures the merchant names.
 * "No, 4 not 3" read with a different payment, price or delivery fee is asked about and changes
 * nothing; read with only the named figure (and the total that follows from it) it corrects. */
const waitingCommand = async (businessId: string) => [
  ...(await withBusiness(db, businessId, (tx) =>
    tx.execute<{ id: string; command: unknown }>(sql`
      SELECT id, command FROM command_drafts
       WHERE business_id = ${businessId}::uuid AND state = 'pending' AND intent = 'RecordSale'`),
  )),
];

describe('a correction whose reading changes a figure the merchant did not name', () => {
  const PAID = { ...SALE, reportedPayment: 100_000 };
  const FOUR = {
    ...PAID,
    items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
    statedTotal: 200_000,
  };

  it.each([
    ['the amount paid', { ...FOUR, reportedPayment: 0 }],
    [
      'the price',
      { ...FOUR, items: [{ name: 'wig', quantity: 4, unitPrice: 40_000 }], statedTotal: 160_000 },
    ],
    ['a delivery fee', { ...FOUR, deliveryFee: 5_000 }],
  ])('%s: asked about, the waiting sale unchanged, nothing booked', async (_, reading) => {
    const { business } = await seedOwner();
    await send('sold Ada 3 wigs for 150k, paid 100k', 'wamid.UF1', PAID);
    const waiting = await waitingCommand(business.id);
    await send('No, 4 not 3', 'wamid.UF2', reading);

    expect(stubSender.lastText).toBe(replies.correctionChangedUnnamedFigure().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:pending']);
    /* The same draft, its command untouched (CodeRabbit on #437 at c5392f0). */
    expect(await waitingCommand(business.id)).toEqual(waiting);
    expect((await books(business.id)).invoices).toEqual([]);
  });

  it('a reading that changes only the named figure still corrects the sale', async () => {
    const { business } = await seedOwner();
    await send('sold Ada 3 wigs for 150k, paid 100k', 'wamid.UF3', PAID);
    await send('No, 4 not 3', 'wamid.UF4', { ...FOUR, customer: { kind: 'none' } });

    expect(stubSender.lastText).toContain('4 × wig');
    expect(await drafts(business.id)).toEqual(['RecordSale:superseded', 'RecordSale:pending']);
  });
});

/**
 * CG5 while an earlier message of the same business is still retrying: a clear correction of an
 * expense still replaces it, and a yes retried after the correction books nothing; a nameless
 * correction of a customer's sale withdraws that sale (OD-60, owner review of #437 at 49f2586).
 * Each retried job is checked to have finished before the books are read, so an empty book is the
 * retry's answer, never a job still waiting (CodeRabbit on #437 at 156621f). Moved from
 * `meta-correction-kind.integration.test.ts`, which is at the layout limit.
 */
/** A job's state, read in its own business. */
const jobState = (businessId: string, jobId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ state: string }>(sql`
      SELECT state FROM jobs WHERE business_id = ${businessId}::uuid AND id = ${jobId}::uuid`),
  ).then((rows) => rows[0]?.state ?? null);

describe('CG5: a correction while an earlier message is retrying', () => {
  it('an earlier question still retrying does not stop the correction', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k cash', 'wamid.K7-EXP', expense(5_000));
    await queueOnly('wamid.K7-Q', 'how much did I sell this month?');
    await failOnceAndBackOff(business.id);

    await send('no, 6k not 5k', 'wamid.K7-FIX', expense(6_000));
    expect(stubSender.lastText).toContain(replies.correctionTaken().text);
    expect(await drafts(business.id)).toEqual([
      'RecordExpense:superseded',
      'RecordExpense:pending',
    ]);
  });

  it('a yes retried after the correction books nothing; the corrected expense is booked once', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k cash', 'wamid.K8-EXP', expense(5_000));
    await queueOnly('wamid.K8-YES', 'yes');
    const retried = await failOnceAndBackOff(business.id);

    await send('no, 6k not 5k', 'wamid.K8-FIX', expense(6_000));
    expect(await drafts(business.id)).toEqual([
      'RecordExpense:superseded',
      'RecordExpense:pending',
    ]);
    await bringDue(business.id);
    await run();
    /* The retried yes ran to the end, so the empty books are its answer (CodeRabbit on #437 at
     * 156621f). */
    expect(await jobState(business.id, retried)).toBe('done');
    expect((await books(business.id)).expenses).toEqual([]);

    await send('yes', 'wamid.K8-YES2');
    expect((await books(business.id)).expenses).toEqual([600_000]);
  });
});

describe("CG5: a nameless correction of a customer's sale while a yes retries", () => {
  it('withdraws the sale and asks; the retried yes books nothing', async () => {
    const { business } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.K13-SALE', SALE);
    await queueOnly('wamid.K13-YES', 'yes');
    const retried = await failOnceAndBackOff(business.id);

    await send('No, 4 not 3', 'wamid.K13-FIX', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionWithdrawn().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:superseded']);
    await bringDue(business.id);
    await run();
    expect(await jobState(business.id, retried)).toBe('done');
    expect(await books(business.id)).toEqual({ invoices: [], expenses: [] });
  });
});

/**
 * CG5: a correction mixed with another record is asked about, whether or not the waiting sale names
 * a customer (owner ruling OWN-102(2); CodeRabbit on #437 at 156621f). An anonymous waiting sale was
 * superseded before the mixed-instruction checks ran, so "No, 4 not 3. Sold 2 bags at 10k to
 * someone else" dropped the 2-bag sale and left a four-wig preview to confirm. The same case for a
 * named customer is in `meta-correction-ambiguous.integration.test.ts`.
 */
const ANON_SALE = {
  intent: 'RecordSale',
  customer: { kind: 'none' },
  items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
  statedTotal: 150_000,
  reportedPayment: 0,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
};
const ANON_FOUR = {
  ...ANON_SALE,
  items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
  statedTotal: 200_000,
};

/** Sends one message and asserts the worker had a job to run for it. */
async function sendWorked(text: string, wamid: string) {
  await post(messagePayload(OWNER, wamid, text));
  const runner = buildRunner(workerDb, db, deps);
  let worked = await runner.runOnce();
  expect(worked).toBe(true);
  while (worked) worked = await runner.runOnce();
}

const sales = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ id: string; state: string; command: unknown }>(
      sql`SELECT id, state, command FROM command_drafts
           WHERE business_id = ${businessId}::uuid AND intent = 'RecordSale'
           ORDER BY insertion_seq`,
    ),
  ).then((rows) => [...rows]);

const invoiceCount = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM invoices WHERE business_id = ${businessId}::uuid`,
    ),
  ).then((rows) => Number(rows[0]?.n ?? 0));

async function seedWalkIn() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  return identity.createBusinessWithOwner(db, {
    name: 'Walk-in Wigs',
    businessType: null,
    ownerUserId: user.id,
  });
}

describe('CG5: an anonymous waiting sale and a correction mixed with another sale', () => {
  it('asks, and leaves the waiting sale exactly as it was', async () => {
    const business = await seedWalkIn();
    stubTransport.replyWith(ANON_SALE);
    await sendWorked('Sold 3 wigs for 150k', 'wamid.AM-SALE');
    const before = await sales(business.id);
    expect(before.map((r) => r.state)).toEqual(['pending']);

    stubTransport.replyWith(ANON_FOUR);
    const sent = stubSender.sent.length;
    await sendWorked('No, 4 not 3. Sold 2 bags at 10k to someone else', 'wamid.AM-FIX');
    expect(stubSender.sent.length).toBe(sent + 1);
    /* Nothing replaced: the same draft, the same command, and no second draft to confirm. */
    expect(await sales(business.id)).toEqual(before);
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('still lets a plain correction supersede it', async () => {
    const business = await seedWalkIn();
    stubTransport.replyWith(ANON_SALE);
    await sendWorked('Sold 3 wigs for 150k', 'wamid.AP-SALE');
    stubTransport.replyWith(ANON_FOUR);
    await sendWorked('No, 4 not 3', 'wamid.AP-FIX');
    const rows = await sales(business.id);
    expect(rows.map((r) => r.state)).toEqual(['superseded', 'pending']);
    expect((rows[1]?.command as { items: { quantity: number }[] }).items[0]?.quantity).toBe(4);
  });
});
