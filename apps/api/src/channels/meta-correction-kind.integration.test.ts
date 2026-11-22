/**
 * CG5 (OD-60): one contract decides whether a message read as a correction may change the draft
 * waiting for a yes, for superseding it and for keeping its customer alike (`correctionMayChange`).
 *
 * Before this, `looksLikeCorrection` alone superseded every waiting draft, whatever kind of record
 * the model read: "Bought fuel 5k, not paid yet" replaced a waiting sale (CodeRabbit on #437 at
 * 3d66867). Now a correction read as another kind, aimed at another member's request, sent with
 * two waiting, after something else was said, or while an earlier message is retrying, is asked
 * about and changes nothing. A clear correction of the member's own single request of the same
 * kind still replaces it. The books are asserted, never only the reply.
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

describe('CG5: a correction read as another kind of record (OD-60)', () => {
  it.each([['"No, 4 not 3" read as an expense', 'No, 4 not 3']])(
    '%s never replaces the waiting sale',
    async (_, text) => {
      const { business, ada } = await seedOwner();
      await send('Ada bought 3 wigs for 150k', 'wamid.K1-SALE', SALE);

      await send(text, 'wamid.K1-FIX', expense(5_000));
      expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
      expect(await drafts(business.id)).toEqual(['RecordSale:pending']);

      /* The yes after the question is about it; the next one saves Ada's sale, and nothing else. */
      await send('yes', 'wamid.K1-YES1');
      expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
      await send('yes', 'wamid.K1-YES2');
      expect(await books(business.id)).toEqual({
        invoices: [{ customer_id: ada.id, total_k: 15_000_000 }],
        expenses: [],
      });
    },
  );
});

/* OD-60 A+ (owner ruling 22 Nov 2026): a "not" that only says a new record is unpaid is no
 * correction cue. The expense is an ordinary new record with its own preview, never asked about,
 * and the waiting sale is left exactly as it was. */
describe('CG5: an obvious new record beside a waiting draft (OD-60 A+)', () => {
  it('"Bought fuel 5k, not paid yet" is previewed on its own and the sale still waits', async () => {
    const { business } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.K1n-SALE', SALE);

    await send('Bought fuel 5k, not paid yet', 'wamid.K1n-NEW', expense(5_000));
    expect(stubSender.lastText).not.toBe(replies.correctionNotClear().text);
    expect(stubSender.lastText).not.toContain(replies.correctionTaken().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:pending', 'RecordExpense:pending']);
    expect(await books(business.id)).toEqual({ invoices: [], expenses: [] });
  });

  it('"Sold 2 bags for 20k, not paid yet" beside Ada\'s sale is a new sale that never takes Ada', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.K1b-SALE', SALE);

    await send('Sold 2 bags for 20k, not paid yet', 'wamid.K1b-NEW', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'bag', quantity: 2, unitPrice: 10_000 }],
      statedTotal: 20_000,
    });
    expect(stubSender.lastText).not.toContain('The same customer as before');
    expect(await drafts(business.id)).toEqual(['RecordSale:pending', 'RecordSale:pending']);
    const customers = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ customer: unknown }>(sql`
        SELECT command->'customer' AS customer FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale' ORDER BY insertion_seq`),
    );
    expect([...customers].map((r) => r.customer)).toEqual([
      { kind: 'token', token: ada.token },
      { kind: 'none' },
    ]);
  });
});

describe('CG5: a new record opening "not paid yet" or saying "should be" (CodeRabbit, b2703e7)', () => {
  it.each([['Not paid yet, bought fuel 5k'], ["It's not paid yet, bought fuel 5k"]])(
    '%j beside a waiting expense is previewed on its own',
    async (text) => {
      const { business } = await seedOwner();
      await send('fuel 6k', 'wamid.NP-EXP', expense(6_000));
      await send(text, 'wamid.NP-NEW', expense(5_000));
      expect(stubSender.lastText).not.toBe(replies.correctionNotClear().text);
      expect(await drafts(business.id)).toEqual(['RecordExpense:pending', 'RecordExpense:pending']);
    },
  );

  it('a nameless sale keeps its shown preview, and the yes books exactly it', async () => {
    const { business } = await seedOwner();
    const nameless = { ...SALE, customer: { kind: 'none' } };
    await send('sold 3 wigs', 'wamid.SB-SALE', nameless);
    await send('Sold 2 bags for 20k, total should be 20k', 'wamid.SB-NEW', {
      ...nameless,
      items: [{ name: 'bag', quantity: 2, unitPrice: 10_000 }],
      statedTotal: 20_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:pending']);
    for (const n of [1, 2]) await send('yes', `wamid.SB-YES${n}`);
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: null, total_k: 15_000_000 },
    ]);
  });
});

describe('CG5: the steps the clarification gives work (OD-60)', () => {
  it('"cancel", then the whole corrected sale, books only the corrected sale', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.K12-SALE', SALE);
    await send('No, 4 not 3', 'wamid.K12-FIX', expense(5_000));
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);

    await send('cancel', 'wamid.K12-CANCEL');
    expect(stubSender.lastText).toBe(replies.cancelled().text);
    await send('Ada bought 4 wigs for 200k', 'wamid.K12-NEW', {
      ...SALE,
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    await send('yes', 'wamid.K12-YES');
    expect(await books(business.id)).toEqual({
      invoices: [{ customer_id: ada.id, total_k: 20_000_000 }],
      expenses: [],
    });
  });
});

describe('CG5: a clear correction of the same kind still replaces the waiting draft', () => {
  it('an expense: the corrected amount is the one booked, once', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k cash', 'wamid.K2-EXP', expense(5_000));
    await send('no, 6k not 5k', 'wamid.K2-FIX', expense(6_000));
    expect(stubSender.lastText).toContain(replies.correctionTaken().text);
    expect(await drafts(business.id)).toEqual([
      'RecordExpense:superseded',
      'RecordExpense:pending',
    ]);

    await send('yes', 'wamid.K2-YES');
    expect((await books(business.id)).expenses).toEqual([600_000]);
  });

  it('a purchase: the corrected amount is the one saved, once', async () => {
    const { business } = await seedOwner();
    await send('bought ankara from Mama Nkechi 50k cash', 'wamid.K3-PUR', purchase(50_000));
    await send('no, 60k not 50k', 'wamid.K3-FIX', purchase(60_000));
    expect(stubSender.lastText).toContain(replies.correctionTaken().text);
    expect(await drafts(business.id)).toEqual([
      'RecordPurchase:superseded',
      'RecordPurchase:pending',
    ]);

    await send('yes', 'wamid.K3-YES');
    expect(stubSender.lastText).toContain('Saved ✅ ₦60,000 stock purchase');
    await send('yes', 'wamid.K3-YES2');
    expect(await drafts(business.id)).toEqual([
      'RecordPurchase:superseded',
      'RecordPurchase:confirmed',
    ]);
  });
});

describe('CG5: a correction that may be about something else is asked about (OD-60)', () => {
  it("another member's correction never replaces the owner's expense", async () => {
    const { business } = await seedOwner();
    const member = await identity.upsertUserByPhone(db, `+${MEMBER}`);
    await identity.addMembership(db, business.id, member.id, 'delegate');
    await send('fuel 5k cash', 'wamid.K4-EXP', expense(5_000));

    await send('no, 6k not 5k', 'wamid.K4-FIX', expense(6_000), MEMBER);
    expect(stubSender.lastText).toBe(replies.correctionForAnotherMember().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending']);
    /* As the reply says: the owner answers their own request, and only it is booked. */
    await send('yes', 'wamid.K4-YES');
    expect((await books(business.id)).expenses).toEqual([500_000]);
  });

  it('a correction after a question is asked about', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k cash', 'wamid.K5-EXP', expense(5_000));
    await send('how much did I sell today', 'wamid.K5-Q', {
      intent: 'Query',
      topic: 'sales_summary',
      customer: null,
      period: 'today',
      periodText: 'today',
      format: 'chat',
    });

    await send('no, 6k not 5k', 'wamid.K5-FIX', expense(6_000));
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending']);
  });

  it('with two previews waiting, neither is replaced', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k cash', 'wamid.K6-E1', expense(5_000));
    await send('diesel 12k cash', 'wamid.K6-E2', { ...expense(12_000), description: 'diesel' });

    await send('no, 6k not 5k', 'wamid.K6-FIX', expense(6_000));
    expect(stubSender.lastText).toBe(replies.correctionNotClearSeveral().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending', 'RecordExpense:pending']);
    /* As the reply says: a yes is told what is waiting, and nothing is booked until the next. */
    await send('yes', 'wamid.K6-YES1');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    expect((await books(business.id)).expenses).toEqual([]);
  });
});

/**
 * A message still retrying when the correction arrives (G-23, OD-60). The merchant's correction is
 * their newest word, so it supersedes the draft: a "yes" retried after it books nothing, and only
 * the corrected preview's own yes books anything. Keeping a customer still waits for that message
 * (`meta-correction-ambiguous`).
 */
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
    await failOnceAndBackOff(business.id);

    await send('no, 6k not 5k', 'wamid.K8-FIX', expense(6_000));
    expect(await drafts(business.id)).toEqual([
      'RecordExpense:superseded',
      'RecordExpense:pending',
    ]);
    await bringDue(business.id);
    await run();
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
    await failOnceAndBackOff(business.id);

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
    expect(await books(business.id)).toEqual({ invoices: [], expenses: [] });
  });
});

describe('CG5: an ineligible correction while a yes retries', () => {
  it('leaves the preview, so the yes the merchant sent first books it once', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.K14-SALE', SALE);
    await queueOnly('wamid.K14-YES', 'yes');
    await failOnceAndBackOff(business.id);

    await send('Wait, I also sold 2 bags', 'wamid.K14-MORE', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'bag', quantity: 2, unitPrice: 10_000 }],
      statedTotal: 20_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionCustomerNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:pending']);
    await bringDue(business.id);
    await run();
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: ada.id, total_k: 15_000_000 },
    ]);
  });
});

/**
 * A correction asked about because of its customer leaves the waiting preview as it was, and the
 * reply says so and gives the step that works (independent review of #437 at 0114957): following
 * it books the corrected sale once, never the uncorrected one beside it.
 */
describe("CG5: the customer question's advice works", () => {
  it('"cancel", then the whole record, books only the corrected sale, even on a second yes', async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.K15-SALE', SALE);
    await send('No, it should be 4 wigs please', 'wamid.K15-FIX', {
      ...SALE,
      customer: { kind: 'none' },
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toBe(replies.correctionCustomerNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:pending']);

    await send('cancel', 'wamid.K15-CANCEL');
    await send('Ada bought 4 wigs for 200k', 'wamid.K15-NEW', {
      ...SALE,
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    await send('yes', 'wamid.K15-YES1');
    await send('yes', 'wamid.K15-YES2');
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: ada.id, total_k: 20_000_000 },
    ]);
  });
});

describe('CG5: a correction with no live draft to change is a new request', () => {
  it('after the preview expired, it supersedes nothing and is previewed on its own', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k cash', 'wamid.K9-EXP', expense(5_000));
    await withBusiness(db, business.id, (tx) =>
      tx.execute(sql`UPDATE command_drafts SET expires_at = clock_timestamp() - interval '1 second'
                      WHERE business_id = ${business.id}::uuid`),
    );

    await send('no, 6k not 5k', 'wamid.K9-FIX', expense(6_000));
    expect(stubSender.lastText).not.toContain(replies.correctionTaken().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:expired', 'RecordExpense:pending']);
    await send('yes', 'wamid.K9-YES');
    expect((await books(business.id)).expenses).toEqual([600_000]);
  });

  /* OWN-102(1): a correction changes only a draft the merchant was shown. A preview whose send
   * failed was never shown, so the correction is asked about and replaces nothing; the unseen
   * preview stays unconfirmable (G-20), and nothing is booked (CodeRabbit on #437 at cacc734). */
  it('a correction of a preview whose send failed is asked about and books nothing', async () => {
    const { business } = await seedOwner();
    stubSender.failWith();
    await send('fuel 5k cash', 'wamid.K10-EXP', expense(5_000));
    await send('no, 6k not 5k', 'wamid.K10-FIX', expense(6_000));
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending']);
    await send('yes', 'wamid.K10-YES');
    await send('yes', 'wamid.K10-YES2');
    expect((await books(business.id)).expenses).toEqual([]);
  });
});

/**
 * OD-63(a): an unrecorded person named like an item could once inherit; since OWN-102(3) the bare
 * item word is asked about and only a plural or unit keeps the customer (`meta-correction-item-word`).
 * A recorded customer with that name is tokenised before the model reads the correction, so it names
 * somebody and keeps nobody.
 */
describe('CG5: a recorded customer named like the waiting sale’s item (OD-63(a))', () => {
  it('"4 Tunde not 3" is asked about and the preview keeps Ada', async () => {
    const { business, ada } = await seedOwner();
    await knownCustomer(business.id, 'Tunde', 'CUSTOMER_9TD');
    const TUNDE_ITEM = { ...SALE, items: [{ name: 'Tunde', quantity: 3, unitPrice: 50_000 }] };
    await send('Ada bought 3 Tunde for 150k', 'wamid.K11-SALE', TUNDE_ITEM);

    await send('4 Tunde not 3', 'wamid.K11-FIX', {
      ...TUNDE_ITEM,
      customer: { kind: 'none' },
      items: [{ name: 'Tunde', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).not.toContain('The same customer as before');
    const sale = await withBusiness(db, business.id, (tx) =>
      tx.execute<{ customer: unknown }>(sql`
        SELECT command->'customer' AS customer FROM command_drafts
         WHERE business_id = ${business.id}::uuid AND intent = 'RecordSale' AND state = 'pending'`),
    );
    expect([...sale].map((r) => r.customer)).toEqual([{ kind: 'token', token: ada.token }]);
  });
});

/**
 * OD-60 A+ (owner ruling 22 Nov 2026): only a message that is clearly a correction of the waiting
 * draft may replace it. A same-kind message that merely reads like one ("Wait, I also sold 2 bags
 * for 20k") is asked whether it changes the waiting request or is a new record, supersedes and
 * confirms nothing, and never takes the draft's customer, whether or not the draft has one.
 */
describe('CG5: a same-kind message that is not clearly a correction (OD-60 A+)', () => {
  const NAMELESS_SALE = { ...SALE, customer: { kind: 'none' } };
  const BAGS = {
    ...SALE,
    customer: { kind: 'none' },
    items: [{ name: 'bag', quantity: 2, unitPrice: 10_000 }],
    statedTotal: 20_000,
  };

  it('beside a sale that names nobody, is asked about and the sale is booked as shown', async () => {
    const { business } = await seedOwner();
    await send('sold 3 wigs for 150k', 'wamid.AP1-SALE', NAMELESS_SALE);

    await send('Wait, I also sold 2 bags for 20k', 'wamid.AP1-MORE', BAGS);
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:pending']);

    await send('yes', 'wamid.AP1-YES1');
    expect(stubSender.lastText).toBe(replies.previewBehindRefusal().text);
    await send('yes', 'wamid.AP1-YES2');
    expect(await books(business.id)).toEqual({
      invoices: [{ customer_id: null, total_k: 15_000_000 }],
      expenses: [],
    });
  });

  it("beside Ada's sale, is asked about, never inherits Ada, and her sale is booked as shown", async () => {
    const { business, ada } = await seedOwner();
    await send('Ada bought 3 wigs for 150k', 'wamid.AP2-SALE', SALE);

    await send('Wait, I also sold 2 bags for 20k', 'wamid.AP2-MORE', BAGS);
    expect(stubSender.lastText).toBe(replies.correctionCustomerNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:pending']);

    await send('yes', 'wamid.AP2-YES1');
    await send('yes', 'wamid.AP2-YES2');
    expect(await books(business.id)).toEqual({
      invoices: [{ customer_id: ada.id, total_k: 15_000_000 }],
      expenses: [],
    });
  });

  it('beside a waiting expense, a same-kind "wait, fuel 6k" is asked about and replaces nothing', async () => {
    const { business } = await seedOwner();
    await send('fuel 5k', 'wamid.AP3-EXP', expense(5_000));

    await send('wait, fuel 6k', 'wamid.AP3-MORE', expense(6_000));
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending']);

    await send('yes', 'wamid.AP3-YES1');
    await send('yes', 'wamid.AP3-YES2');
    expect((await books(business.id)).expenses).toEqual([500_000]);
  });

  it('beside a waiting expense, "Wait, I also bought fuel for 6k, total should be 6k" replaces nothing', async () => {
    /* A correction phrase beside an adding word is as likely a second record (CodeRabbit on #437
     * at aff3f63): asked about, the waiting expense stays, and is the one booked. */
    const { business } = await seedOwner();
    await send('fuel 5k', 'wamid.AP3-EXP2', expense(5_000));

    await send(
      'Wait, I also bought fuel for 6k, total should be 6k',
      'wamid.AP3-ALSO',
      expense(6_000),
    );
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordExpense:pending']);

    await send('yes', 'wamid.AP3-ALSO-YES1');
    await send('yes', 'wamid.AP3-ALSO-YES2');
    expect((await books(business.id)).expenses).toEqual([500_000]);
  });

  it('a clear correction of a sale that names nobody still replaces it and books once', async () => {
    const { business } = await seedOwner();
    await send('sold 3 wigs for 150k', 'wamid.AP4-SALE', NAMELESS_SALE);

    await send('No, 4 not 3', 'wamid.AP4-FIX', {
      ...NAMELESS_SALE,
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    expect(stubSender.lastText).toContain(replies.correctionTaken().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:superseded', 'RecordSale:pending']);
    await send('yes', 'wamid.AP4-YES');
    await send('yes', 'wamid.AP4-YES2');
    expect(await books(business.id)).toEqual({
      invoices: [{ customer_id: null, total_k: 20_000_000 }],
      expenses: [],
    });
  });

  it('while an earlier yes retries, it leaves the nameless sale, so that yes books it once', async () => {
    const { business } = await seedOwner();
    await send('sold 3 wigs for 150k', 'wamid.AP5-SALE', NAMELESS_SALE);
    await queueOnly('wamid.AP5-YES', 'yes');
    await failOnceAndBackOff(business.id);

    await send('Wait, I also sold 2 bags for 20k', 'wamid.AP5-MORE', BAGS);
    expect(stubSender.lastText).toBe(replies.correctionNotClear().text);
    expect(await drafts(business.id)).toEqual(['RecordSale:pending']);
    await bringDue(business.id);
    await run();
    expect((await books(business.id)).invoices).toEqual([
      { customer_id: null, total_k: 15_000_000 },
    ]);
  });
});
