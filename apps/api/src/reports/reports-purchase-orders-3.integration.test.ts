/**
 * The reports surface, end to end: session guard → SQL → contract shape.
 *
 * The NUMBERS are proven in packages/db/src/ledger/reports.integration.test.ts
 * against hand arithmetic; what this suite pins is the wiring — that the
 * endpoints exist, refuse strangers, scope to the session's tenant, and
 * answer in exactly the shape the web tier's zod contracts will parse.
 */
// The reports surface, end to end. Split by concern across reports*.integration.test.ts; the shared setup is in
// reports.fixtures.ts.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conversationsRepo, createDb, withBusiness } from '@rekoda/db';
import { recordExpenseWork, recordPurchaseWork } from '../commands/spend-commands.js';
import { db, onboard, urls, useReportsHarness } from './reports.fixtures.js';
import {
  PO_TOTAL_K,
  openPo,
  books,
  chatYes,
  counts,
  poRow,
  onHand,
  receive,
} from './reports-purchase-orders.fixtures.js';

useReportsHarness();

describe('purchase orders, and what receiving one does', () => {
  /* G-89: a dashboard receive is compared with the purchases already BOOKED
   * in Chat, under the same OD-23 / OWN-21 policy and the same lock as a
   * chat yes. A waiting chat preview is conversational state, not a
   * purchase, and is never compared from here. */
  describe('a receive that may be a purchase already booked in Chat (G-89)', () => {
    let seq = 0;

    /**
     * A chat purchase preview of the PO's total, waiting for a yes.
     *
     * Kept identical to the copy in reports-purchase-orders-2.integration.test.ts. It advances
     * this suite's own counter, so it stays beside that counter. Change them together.
     */
    async function chatPreview(
      businessId: string,
      reference: string | null = null,
      separateFrom: string | null = null,
    ) {
      seq += 1;
      return withBusiness(db, businessId, async (tx) => {
        const message = await conversationsRepo.recordInbound(tx, {
          businessId,
          channel: 'meta',
          kind: 'text',
          body: 'a purchase',
          providerMessageId: `wamid.g89-${businessId}-${seq}`,
        });
        const draft = await conversationsRepo.recordDraft(tx, {
          businessId,
          conversationMessageId: message.id,
          intent: 'RecordPurchase',
          command: {
            intent: 'RecordPurchase',
            supplierMention: null,
            supplierReference: reference,
            description: '10 Ankara bales and 5 thread spools',
            amount: PO_TOTAL_K / 100,
            reportedPayment: PO_TOTAL_K / 100,
            paymentMethod: 'transfer',
            productMention: 'Ankara bale',
            quantity: 10,
          },
          model: null,
          previewed: true,
          separateFrom,
        });
        return draft.id;
      });
    }

    /**
     * A second genuine Chat purchase of the same total, as the merchant's
     * "separate" answer leaves it: a held question naming `others`, and a
     * fresh preview declared separate from exactly those. Since OWN-32
     * (G-92(5)) a different reference no longer sets two purchases apart.
     *
     * Kept identical to the copy in reports-purchase-orders-2.integration.test.ts. It advances
     * this suite's own counter, so it stays beside that counter. Change them together.
     */
    async function chatBookedSeparate(businessId: string, others: readonly string[]) {
      const heldId = await withBusiness(db, businessId, async (tx) => {
        seq += 1;
        const message = await conversationsRepo.recordInbound(tx, {
          businessId,
          channel: 'meta',
          kind: 'text',
          body: 'a purchase',
          providerMessageId: `wamid.g89-${businessId}-${seq}`,
        });
        const held = await conversationsRepo.recordDraft(tx, {
          businessId,
          conversationMessageId: message.id,
          intent: 'RecordPurchase',
          command: { intent: 'RecordPurchase', amount: PO_TOTAL_K / 100 },
          model: null,
          previewed: false,
          held: true,
        });
        await conversationsRepo.nameHeldRecords(
          tx,
          businessId,
          held.id,
          others.map((expenseId) => ({ draftId: null, expenseId })),
        );
        return held.id;
      });
      const draftId = await chatPreview(businessId, null, heldId);
      return (await chatYes(db, businessId, draftId)).expenseId;
    }

    // Kept identical to the copy in reports-purchase-orders-2.integration.test.ts. It belongs
    // to this describe block's own setup, which each part keeps as it was. Change them
    // together.
    async function chatBooked(businessId: string, reference: string | null = null) {
      const draftId = await chatPreview(businessId, reference);
      const booked = await chatYes(db, businessId, draftId);
      return booked.expenseId;
    }

    it('SEPARATE from one purchase still asks about one booked after the question', async () => {
      const { auth, businessId } = await onboard('+2348177000506');
      const first = await chatBooked(businessId, 'invoice 5501');
      const poNumber = await openPo(auth);
      const asked = await receive(auth, { poNumber, paidK: 0 });
      expect(asked).toMatchObject({
        outcome: 'possible_duplicate',
        matches: [{ expenseId: first }],
      });

      const second = await chatBookedSeparate(businessId, [first]);
      expect(await receive(auth, { poNumber, paidK: 0, separateFrom: [first] })).toMatchObject({
        outcome: 'possible_duplicate',
        matches: [{ expenseId: second }],
        alreadySeparate: [first],
      });
      expect((await counts(businessId)).expenses).toBe(2);

      /* Answering the second question with BOTH (what the form carries
       * forward) receives it; the answers never bounce between the two
       * purchases (fresh review of 662e93a). */
      expect(
        await receive(auth, { poNumber, paidK: 0, separateFrom: [first, second] }),
      ).toMatchObject({ outcome: 'received', poNumber });
      expect((await counts(businessId)).expenses).toBe(3);
    });

    it('a Chat purchase of another total is never asked about', async () => {
      const { auth, businessId } = await onboard('+2348177000507');
      await withBusiness(db, businessId, (tx) =>
        recordPurchaseWork(tx, {
          businessId,
          description: 'thread',
          amountK: PO_TOTAL_K - 100,
          paidK: 0,
          method: null,
          sourceType: 'chat',
          sourceId: randomUUID(),
          arrivals: [],
        }),
      );
      const poNumber = await openPo(auth);
      expect((await receive(auth, { poNumber, paidK: 0 })).outcome).toBe('received');
    });

    it('a Chat purchase already linked to another PO is not asked about again', async () => {
      const { auth, businessId } = await onboard('+2348177000508');
      const expenseId = await chatBooked(businessId);
      const firstPo = await openPo(auth);
      expect(
        (await receive(auth, { poNumber: firstPo, paidK: 0, sameAs: expenseId })).outcome,
      ).toBe('linked');
      const secondPo = await openPo(auth);
      /* SAME from a second order to the purchase the first is linked to is
       * refused cleanly, never relinked and never a server error. */
      expect(await receive(auth, { poNumber: secondPo, paidK: 0, sameAs: expenseId })).toEqual({
        outcome: 'no_longer_matches',
        poNumber: secondPo,
      });
      expect(await poRow(businessId, secondPo)).toEqual({
        status: 'open',
        received_expense_id: null,
      });
      expect((await receive(auth, { poNumber: secondPo, paidK: 0 })).outcome).toBe('received');
    });

    it('a waiting Chat preview is not compared; its later yes is refused, not booked twice', async () => {
      const { auth, businessId } = await onboard('+2348177000509');
      const draftId = await chatPreview(businessId);
      const poNumber = await openPo(auth);
      /* A preview is no purchase yet: the receive goes through. */
      expect((await receive(auth, { poNumber, paidK: 0 })).outcome).toBe('received');

      /* The yes re-checks at execution time and finds the received PO
       * (G-81 turns this into the SAME / SEPARATE question in Chat). */
      await expect(chatYes(db, businessId, draftId)).rejects.toMatchObject({
        name: 'PurchaseIdentityCollision',
      });
      expect(await counts(businessId)).toMatchObject({ expenses: 1 });
      expect(await onHand(businessId, 'Ankara bale')).toBe(10);
    });

    it('a receive racing a Chat yes never makes two purchases', async () => {
      for (let round = 0; round < 3; round += 1) {
        const { auth, businessId } = await onboard(`+234817700051${round}`);
        const draftId = await chatPreview(businessId);
        const poNumber = await openPo(auth);
        const chat = createDb(urls.app, { max: 1 });
        let raced: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
        try {
          raced = (await Promise.allSettled([
            chatYes(chat.db, businessId, draftId),
            receive(auth, { poNumber, paidK: 0 }),
          ])) as typeof raced;
        } finally {
          await chat.close();
        }
        const [yes, received] = raced;
        expect(received.status).toBe('fulfilled');
        const outcome = (received as PromiseFulfilledResult<{ outcome: string }>).value.outcome;
        if (yes.status === 'fulfilled') {
          expect(outcome).toBe('possible_duplicate');
        } else {
          expect(yes.reason?.name).toBe('PurchaseIdentityCollision');
          expect(outcome).toBe('received');
        }
        expect((await counts(businessId)).expenses).toBe(1);
      }
    });

    /* G-87 (OWN-31): one purchase recorded in Chat as an EXPENSE and then
     * received as a purchase order must not book twice. The receive asks;
     * SEPARATE receives it; SAME cannot link a stock order to an expense, so
     * it changes nothing and says how to keep the books single. */
    async function chatExpenseBooked(businessId: string) {
      seq += 1;
      return (
        await withBusiness(db, businessId, (tx) =>
          recordExpenseWork(tx, {
            businessId,
            description: 'Ankara bales',
            category: 'supplies',
            amountK: PO_TOTAL_K,
            method: 'transfer',
            sourceType: 'chat',
            sourceId: `g87-po-${seq}`,
          }),
        )
      ).expenseId;
    }

    it('a Chat expense of the same total: the receive asks and writes nothing (G-87)', async () => {
      const { auth, businessId } = await onboard('+2348177000590');
      const expenseId = await chatExpenseBooked(businessId);
      const poNumber = await openPo(auth);
      const before = { ...(await counts(businessId)), books: await books(auth) };

      expect(await receive(auth, { poNumber, paidK: PO_TOTAL_K, method: 'cash' })).toMatchObject({
        outcome: 'possible_duplicate',
        poNumber,
        matches: [{ expenseId, kind: 'expense' }],
      });
      expect(await counts(businessId)).toEqual({
        expenses: before.expenses,
        postings: before.postings,
        movements: before.movements,
        bills: before.bills,
      });
      expect(await books(auth)).toEqual(before.books);
      expect(await poRow(businessId, poNumber)).toEqual({
        status: 'open',
        received_expense_id: null,
      });
    });

    it('SAME as a Chat expense links nothing and leaves the order open (G-87)', async () => {
      const { auth, businessId } = await onboard('+2348177000591');
      const expenseId = await chatExpenseBooked(businessId);
      const poNumber = await openPo(auth);
      const before = await counts(businessId);

      expect(
        await receive(auth, { poNumber, paidK: PO_TOTAL_K, method: 'cash', sameAs: expenseId }),
      ).toEqual({ outcome: 'same_as_expense', poNumber, expenseId });
      expect(await counts(businessId)).toEqual(before);
      expect(await poRow(businessId, poNumber)).toEqual({
        status: 'open',
        received_expense_id: null,
      });
    });

    it('SEPARATE from a Chat expense receives the order normally (G-87)', async () => {
      const { auth, businessId } = await onboard('+2348177000592');
      const expenseId = await chatExpenseBooked(businessId);
      const poNumber = await openPo(auth);

      expect(await receive(auth, { poNumber, paidK: 0, separateFrom: [expenseId] })).toMatchObject({
        outcome: 'received',
        poNumber,
      });
      expect((await counts(businessId)).expenses).toBe(2);
    });

    it('a stock purchase booked in Chat is still asked about as a purchase (G-87)', async () => {
      const { auth, businessId } = await onboard('+2348177000593');
      const expenseId = await chatBooked(businessId);
      const poNumber = await openPo(auth);
      expect(await receive(auth, { poNumber, paidK: 0 })).toMatchObject({
        outcome: 'possible_duplicate',
        matches: [{ expenseId, kind: 'purchase' }],
      });
    });
  });
});
