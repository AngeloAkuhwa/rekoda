/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * Meta webhook suite: one real purchase, one financial truth (G-81, OD-23) (part 5 of 5). Split
 * by concern from meta.integration.test.ts; the shared app, stubs and payload helpers are in
 * meta-webhook.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { withBusiness, sql } from '@rekoda/db';
import { db, deps, stubSender, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import {
  DELEGATE,
  ALIGN,
  MILO,
  QUESTION,
  SAME_DONE,
  SEPARATE_LEAD,
  REASK,
  CLOSED,
  RACE,
  seedMerchant,
  addDelegate,
  say,
  reply,
  purchaseStates,
  footprint,
  purchases,
  bookMilo,
} from './meta-purchase-truth.fixtures.js';

useMetaWebhookHarness();

/**
 * G-81, OD-23: one real-world purchase must never become two financial
 * truths, and two real purchases must never be collapsed because they share
 * an amount, a product, a supplier or a day. A purchase that may be one
 * already waiting or booked is ASKED about ("same" or "separate"), never
 * silently dropped and never silently booked; the final net sits in the
 * purchase work, under a lock, before any posting.
 */
describe('one real purchase, one financial truth (G-81, OD-23)', () => {
  describe('Codex review of 5bfe87e', () => {
    const POS_MILO = { ...MILO, paymentMethod: 'pos' };

    it("the sender's own undelivered preview is replaced by their resend, silently (was G-91)", async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say('wamid.U1-buy', MILO, 'I bought 10 cartons of Milo for 100k cash');
      /* The preview never reached them: still pending, never described. */
      expect(await purchaseStates(business.id)).toEqual(['pending']);
      await say('wamid.U1-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      expect(stubSender.lastText).not.toContain('Your earlier preview');
      expect(stubSender.lastText).not.toContain(QUESTION);
      /* One confirmable draft, so two yeses book it once. */
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
      await reply('wamid.U1-yes-1', 'yes');
      await reply('wamid.U1-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });

    it('a replacing preview whose own send fails gives back the undelivered draft (final-head review of eb0ad6d)', async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say('wamid.U6-buy', MILO, 'I bought 10 cartons of Milo for 100k cash');
      stubSender.failWith();
      await say('wamid.U6-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      /* The resend reached nobody, so what it replaced comes back and the
       * resend is withdrawn: one draft remains, and the merchant was shown
       * neither, so no "yes" books it (G-20, owner ruling). */
      expect(await purchaseStates(business.id)).toEqual(['pending', 'superseded']);
      await reply('wamid.U6-yes-1', 'yes');
      await reply('wamid.U6-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(0);
      expect(await purchaseStates(business.id)).toEqual(['pending', 'superseded']);
    });

    it('a purchase held back for an arithmetic question is no undelivered copy (final-head review of 77e9da8)', async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say('wamid.U5-buy', MILO, 'I bought 10 cartons of Milo for 100k cash');
      /* Paid more than the total: CG1 asks, and its draft is unpreviewed. */
      await say(
        'wamid.U5-cg1',
        { ...MILO, reportedPayment: 150_000 },
        'I bought 10 cartons of Milo for 100k, paid 150k',
      );
      await say('wamid.U5-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      /* The question is not counted, so the one undelivered preview is the
       * single match and is replaced. */
      expect((await purchaseStates(business.id))[0]).toBe('superseded');
      expect((await purchaseStates(business.id)).at(-1)).toBe('pending');
    });

    it('an undelivered draft with another reference is no longer proven separate (OWN-32)', async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say(
        'wamid.U3-milo',
        { ...MILO, supplierReference: 'invoice 2231' },
        'I bought 10 cartons of Milo for 100k cash, invoice 2231',
      );
      await say(
        'wamid.U3-rice',
        {
          ...MILO,
          description: '4 bags of rice',
          productMention: 'rice',
          quantity: 4,
          supplierReference: 'invoice 5590',
        },
        'I bought 4 bags of rice for 100k cash, invoice 5590',
      );
      /* The sender's one undelivered draft of the same total is replaced, as
       * any other: neither the reference nor an untrusted product proves it
       * another purchase. */
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'pending']);
    });

    it('a resend replaces the one undelivered draft it may be, whatever its reference (OWN-32)', async () => {
      const business = await seedMerchant();
      stubSender.failWith();
      await say(
        'wamid.U4-a',
        { ...MILO, supplierReference: 'invoice 2231' },
        'I bought 10 cartons of Milo for 100k cash, invoice 2231',
      );
      stubSender.failWith();
      await say(
        'wamid.U4-b',
        { ...MILO, supplierReference: 'invoice 5590' },
        'I bought 10 cartons of Milo for 100k cash, invoice 5590',
      );
      await say(
        'wamid.U4-again',
        { ...MILO, supplierReference: 'invoice 2231' },
        'I bought 10 cartons of Milo for 100k cash, invoice 2231',
      );
      /* Each new draft replaces the one undelivered draft before it: the
       * references no longer set either apart. */
      expect(await purchaseStates(business.id)).toEqual(['superseded', 'superseded', 'pending']);
    });

    it('a funding-answer rebuild is replaced by a same-total preview with another reference (OWN-32)', async () => {
      const business = await seedMerchant();
      await say(
        'wamid.L2-pos',
        { ...POS_MILO, supplierReference: 'invoice 2231' },
        'I bought 10 cartons of Milo for 100k, paid by POS, invoice 2231',
      );
      await reply('wamid.L2-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      /* RED before OWN-32: invoice 2281 proved this another purchase, so the
       * rebuild stayed waiting beside it ("is still waiting"). */
      await say(
        'wamid.L2-typed',
        { ...MILO, supplierReference: 'invoice 2281' },
        'I bought 10 cartons of Milo for 100k cash, invoice 2281',
      );
      expect(stubSender.lastText).toContain('was replaced by this one');
      expect((await purchaseStates(business.id)).filter((s) => s === 'pending')).toHaveLength(1);
      await reply('wamid.L2-yes', 'yes');
      await reply('wamid.L2-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });

    it("another member's undelivered preview is never replaced by it", async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      stubSender.failWith();
      await say('wamid.U2-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      await say('wamid.U2-o', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(await purchaseStates(business.id)).toEqual(['pending', 'pending']);
    });

    it('a rebuild the member declared "separate" is never replaced by the fresh preview', async () => {
      const business = await seedMerchant();
      /* A funding-answer rebuild with invoice 2231. */
      await say(
        'wamid.L1-pos',
        { ...POS_MILO, supplierReference: 'invoice 2231' },
        'I bought 10 cartons of Milo for 100k, paid by POS, invoice 2231',
      );
      await reply('wamid.L1-bank', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      /* A typed purchase of another total: both wait. Its total is then set
       * equal by hand, since no reference proves two purchases (OWN-32). */
      await say(
        'wamid.L1-typed',
        { ...MILO, amount: 100_001, reportedPayment: 100_001 },
        'I bought 10 cartons of Milo for 100,001 cash',
      );
      expect(stubSender.lastText).toContain('is still waiting');
      await withBusiness(db, business.id, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = command || ${ALIGN}::jsonb
           WHERE business_id = ${business.id}::uuid AND command->>'amount' = '100001'`),
      );
      /* The same total with no reference matches both: asked about both. */
      await say('wamid.L1-again', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.L1-sep', 'separate');
      expect(stubSender.lastText).toContain(SEPARATE_LEAD);
      expect(stubSender.lastText).not.toContain('was replaced by this one');
      /* The rebuild, the typed preview and the fresh one all still wait. */
      expect((await purchaseStates(business.id)).filter((s) => s === 'pending')).toHaveLength(3);
      await reply('wamid.L1-yes-1', 'yes');
      await reply('wamid.L1-yes-2', 'yes');
      await reply('wamid.L1-yes-3', 'yes');
      /* The fresh one and the typed one book (the "separate" answer named
       * both). The rebuild was never declared apart from the typed preview,
       * and its reference no longer proves it (OWN-32): its yes is refused
       * and asked about, never booked as a third purchase unasked. */
      expect(stubSender.lastText).toContain(RACE);
      expect(await purchases(business.id)).toBe(2);
    });

    it('a funding-answer rebuild that replaced an own preview, then failed to send, leaves the question answerable (fan-out review of 8dfce8f)', async () => {
      const business = await seedMerchant();
      await say('wamid.R7-cash', MILO, 'I bought 10 cartons of Milo for 100k cash');
      expect(stubSender.lastText).toContain('Paid in full by cash');
      await say('wamid.R7-pos', POS_MILO, 'I bought 10 cartons of Milo for 100k, paid by POS');
      /* The rebuild replaces the member's own waiting preview, and its send
       * fails: everything goes back as the member last saw it. */
      stubSender.failWith();
      await reply('wamid.R7-bank-1', 'bank');
      await reply('wamid.R7-bank-2', 'bank');
      expect(stubSender.lastText).toContain('Paid in full by transfer');
      expect(stubSender.lastText).not.toContain(CLOSED);
      await reply('wamid.R7-yes-1', 'yes');
      await reply('wamid.R7-yes-2', 'yes');
      expect(await purchases(business.id)).toBe(1);
    });

    it('a reference equal to the reported part payment is not stored', async () => {
      const business = await seedMerchant();
      await say(
        'wamid.R1-buy',
        { ...MILO, reportedPayment: 35_000, supplierReference: 'invoice 35000' },
        'I bought 10 cartons of Milo for 100k, paid 35k, invoice 35000',
      );
      const [row] = [
        ...(await withBusiness(db, business.id, (tx) =>
          tx.execute<{ ref: string | null }>(sql`
            SELECT command->>'supplierReference' AS ref FROM command_drafts
             WHERE business_id = ${business.id}::uuid AND intent = 'RecordPurchase'`),
        )),
      ];
      expect(row!.ref).toBeNull();
    });

    it('the re-ask after a no never offers cancel', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'C9');
      await say('wamid.C9-d', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain(QUESTION);
      await reply('wamid.C9-no', 'no', DELEGATE);
      expect(stubSender.lastText).toContain(REASK);
      expect(stubSender.lastText).not.toMatch(/cancel/i);
    });
  });

  describe('G-87 (OWN-31): one purchase read once as a purchase and once as an expense', () => {
    const MILO_EXPENSE = {
      intent: 'RecordExpense',
      description: '10 cartons of Milo',
      amount: 100_000,
      category: 'supplies',
      paymentMethod: 'cash',
    };
    const ACROSS = 'Is this the same one?';
    const SEPARATE_EXPENSE = 'OK, this is a separate expense.';
    const ALIGN_EXPENSE = JSON.stringify({ amount: 100_000 });

    async function expenseStates(businessId: string): Promise<string[]> {
      const rows = await withBusiness(db, businessId, (tx) =>
        tx.execute<{ state: string }>(sql`
          SELECT state FROM command_drafts
           WHERE business_id = ${businessId}::uuid AND intent = 'RecordExpense'
           ORDER BY insertion_seq`),
      );
      return [...rows].map((r) => r.state);
    }

    async function alignExpense(businessId: string) {
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          UPDATE command_drafts SET command = command || ${ALIGN_EXPENSE}::jsonb
           WHERE business_id = ${businessId}::uuid AND intent = 'RecordExpense'`),
      );
    }

    it('a booked purchase sent again and read as an expense is asked about; "same" saves nothing more', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await bookMilo(business.id, 'BX1');
      const before = await footprint(business.id);
      await say('wamid.X1-exp', MILO_EXPENSE, 'Paid 100k for 10 cartons of Milo', DELEGATE);
      /* RED before G-87: the expense was previewed and its yes booked a
       * second financial truth for the one purchase. */
      expect(stubSender.lastText).toContain('A stock purchase of');
      expect(stubSender.lastText).toContain(ACROSS);
      expect(await expenseStates(business.id)).toEqual(['held']);
      await reply('wamid.X1-yes', 'yes', DELEGATE);
      await reply('wamid.X1-same', 'same', DELEGATE);
      expect(stubSender.lastText).toContain(SAME_DONE);
      await reply('wamid.X1-yes-2', 'yes', DELEGATE);
      const { units: _u, audit: _a, ...books } = await footprint(business.id);
      const { units: _bu, audit: _ba, ...booksBefore } = before;
      expect(books).toEqual(booksBefore);
    });

    it('"separate" shows the expense to check, and only a yes books it', async () => {
      const business = await seedMerchant();
      await bookMilo(business.id, 'BX2');
      await say('wamid.X2-exp', MILO_EXPENSE, 'Paid 100k for 10 cartons of Milo');
      expect(stubSender.lastText).toContain(ACROSS);
      await reply('wamid.X2-sep', 'separate');
      expect(stubSender.lastText).toContain(SEPARATE_EXPENSE);
      expect(await purchases(business.id)).toBe(1);
      await reply('wamid.X2-yes', 'yes');
      expect(stubSender.lastText).toContain('expense');
      expect(await purchases(business.id)).toBe(2);
    });

    it('a booked expense and then the same purchase as a stock purchase is asked about', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      await say('wamid.X3-exp', MILO_EXPENSE, 'Paid 100k for 10 cartons of Milo');
      await reply('wamid.X3-exp-yes', 'yes');
      expect(await purchases(business.id)).toBe(1);
      await say('wamid.X3-buy', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
      expect(stubSender.lastText).toContain('An expense of');
      expect(stubSender.lastText).toContain(ACROSS);
      await reply('wamid.X3-yes', 'yes', DELEGATE);
      expect(await purchases(business.id)).toBe(1);
    });

    it("the member's own waiting purchase preview is asked about, never replaced by an expense", async () => {
      const business = await seedMerchant();
      await say('wamid.X4-buy', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await say('wamid.X4-exp', MILO_EXPENSE, 'Paid 100k for 10 cartons of Milo');
      expect(stubSender.lastText).toContain('A preview of a');
      expect(stubSender.lastText).toContain(ACROSS);
      expect(await purchaseStates(business.id)).toEqual(['pending']);
      expect(await expenseStates(business.id)).toEqual(['held']);
    });

    it('two expenses of one total are never asked about: genuine operating expenses', async () => {
      const business = await seedMerchant();
      await say('wamid.X5-a', MILO_EXPENSE, 'Paid 100k for fuel');
      await reply('wamid.X5-a-yes', 'yes');
      await say('wamid.X5-b', MILO_EXPENSE, 'Paid 100k for fuel again');
      expect(stubSender.lastText).not.toContain(ACROSS);
      await reply('wamid.X5-b-yes', 'yes');
      expect(await purchases(business.id)).toBe(2);
    });

    it('an expense of another total is never asked about', async () => {
      const business = await seedMerchant();
      await bookMilo(business.id, 'BX6');
      await say('wamid.X6-exp', { ...MILO_EXPENSE, amount: 99_000 }, 'Paid 99k for fuel');
      expect(stubSender.lastText).not.toContain(ACROSS);
      await reply('wamid.X6-yes', 'yes');
      expect(await purchases(business.id)).toBe(2);
    });

    it('a purchase preview and an expense preview of one total: the second yes is refused at the work', async () => {
      const business = await seedMerchant();
      await addDelegate(business.id);
      /* Built by hand (another total, then aligned): the chat flow asks
       * before it would leave both waiting. */
      await say('wamid.X7-buy', MILO, 'I bought 10 cartons of Milo for 100k cash');
      await say(
        'wamid.X7-exp',
        { ...MILO_EXPENSE, amount: 100_001 },
        'Paid 100,001 for 10 cartons of Milo',
        DELEGATE,
      );
      await alignExpense(business.id);
      /* OD-15: the newest preview, the delegate's expense, books first. */
      await reply('wamid.X7-yes-1', 'yes');
      expect(await purchases(business.id)).toBe(1);
      const before = await footprint(business.id);
      await reply('wamid.X7-yes-2', 'yes');
      expect(stubSender.lastText).toContain(RACE);
      expect(stubSender.lastText).toContain('An expense of');
      expect(await footprint(business.id)).toEqual(before);
      await reply('wamid.X7-same', 'same');
      expect(stubSender.lastText).toContain(SAME_DONE);
      expect(await purchases(business.id)).toBe(1);
    });

    it('an expense yes refused at the work leaves nothing behind, through the command bus too', async () => {
      const config = deps.config as { commandRecordExpense: boolean };
      const was = config.commandRecordExpense;
      config.commandRecordExpense = true;
      try {
        const business = await seedMerchant();
        await addDelegate(business.id);
        await say(
          'wamid.X8-exp',
          { ...MILO_EXPENSE, amount: 100_001 },
          'Paid 100,001 for 10 cartons of Milo',
        );
        await say('wamid.X8-buy', MILO, 'I bought 10 cartons of Milo for 100k cash', DELEGATE);
        await alignExpense(business.id);
        /* The delegate's purchase books first; the owner's expense yes is
         * refused before its posting, and its bus claim rolled back. */
        await reply('wamid.X8-yes-1', 'yes');
        expect(await purchases(business.id)).toBe(1);
        const before = await footprint(business.id);
        await reply('wamid.X8-yes-2', 'yes');
        expect(stubSender.lastText).toContain(RACE);
        expect(stubSender.lastText).toContain('A stock purchase of');
        expect(await footprint(business.id)).toEqual(before);
        expect(await expenseStates(business.id)).toEqual(['held']);
      } finally {
        config.commandRecordExpense = was;
      }
    });
  });
});
