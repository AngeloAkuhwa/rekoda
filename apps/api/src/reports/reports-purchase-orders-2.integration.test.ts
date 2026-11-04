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
import {
  createPurchaseOrderResponse,
  receivePurchaseOrderResponse,
  reportsExpensesResponse,
  reportsStatementsResponse,
} from '@rekoda/contracts';
import { conversationsRepo, stockRepo, withBusiness, sql, type Db } from '@rekoda/db';
import { recordPurchaseWork } from '../commands/spend-commands.js';
import { app, db, onboard, post, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

describe('purchase orders, and what receiving one does', () => {
  const PO = {
    items: [
      { name: 'Ankara bale', quantity: 10, unitPriceK: 500_000 },
      { name: 'Thread spools', quantity: 5, unitPriceK: 20_000 },
    ],
  };

  const PO_TOTAL_K = 5_100_000;

  /* G-61: receiving a PO funds the paid part from the account the merchant
   * chose, and a paid receive with no account is refused before anything. */
  // Kept identical to the copy in reports-purchase-orders-1.integration.test.ts,
  // reports-purchase-orders-3.integration.test.ts. It belongs to this describe block's own
  // setup, which each part keeps as it was. Change them together.
  async function openPo(auth: Record<string, string>) {
    const created = createPurchaseOrderResponse.parse(
      (await post('/v1/reports/purchase-orders', { ...PO, clientRef: randomUUID() }, auth)).json(),
    );
    if (created.outcome !== 'created') throw new Error('purchase order not created');
    return created.poNumber;
  }

  // Kept identical to the copy in reports-purchase-orders-1.integration.test.ts,
  // reports-purchase-orders-3.integration.test.ts. It belongs to this describe block's own
  // setup, which each part keeps as it was. Change them together.
  async function books(auth: Record<string, string>) {
    const st = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    const asset = (code: string) =>
      st.balanceSheet.assets.find((l) => l.code === code)?.amountK ?? 0;
    const liability = (code: string) =>
      st.balanceSheet.liabilities.find((l) => l.code === code)?.amountK ?? 0;
    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    return {
      cash: asset('1000'),
      bank: asset('1020'),
      payable: spend.payableK,
      cashOutK: st.cashflow.outK,
      balanced: st.balanceSheet.balanced,
      method: spend.entries[0]?.method ?? null,
      entries: spend.entries.length,
      ap: liability('2000'),
    };
  }

  /* G-89: a dashboard receive is compared with the purchases already BOOKED
   * in Chat, under the same OD-23 / OWN-21 policy and the same lock as a
   * chat yes. A waiting chat preview is conversational state, not a
   * purchase, and is never compared from here. */
  describe('a receive that may be a purchase already booked in Chat (G-89)', () => {
    let seq = 0;

    /**
     * A chat purchase preview of the PO's total, waiting for a yes.
     *
     * Kept identical to the copy in reports-purchase-orders-3.integration.test.ts. It advances
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
     * Kept identical to the copy in reports-purchase-orders-3.integration.test.ts. It advances
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

    /**
     * The yes on a chat preview: the purchase work, exactly as chat runs it.
     *
     * Kept identical to the copy in reports-purchase-orders-3.integration.test.ts. It belongs
     * to this describe block's own setup, which each part keeps as it was. Change them
     * together.
     */
    function chatYes(on: Db, businessId: string, draftId: string) {
      return withBusiness(on, businessId, (tx) =>
        recordPurchaseWork(tx, {
          businessId,
          description: '10 Ankara bales and 5 thread spools',
          amountK: PO_TOTAL_K,
          paidK: PO_TOTAL_K,
          method: 'transfer',
          sourceType: 'chat',
          sourceId: draftId,
          supplierId: null,
          arrivals: [{ product: 'Ankara bale', quantity: 10, costK: PO_TOTAL_K }],
        }),
      );
    }

    // Kept identical to the copy in reports-purchase-orders-3.integration.test.ts. It belongs
    // to this describe block's own setup, which each part keeps as it was. Change them
    // together.
    async function chatBooked(businessId: string, reference: string | null = null) {
      const draftId = await chatPreview(businessId, reference);
      const booked = await chatYes(db, businessId, draftId);
      return booked.expenseId;
    }

    // Kept identical to the copy in reports-purchase-orders-3.integration.test.ts. It belongs
    // to this describe block's own setup, which each part keeps as it was. Change them
    // together.
    async function counts(businessId: string) {
      const rows = await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, string>>(sql`
          SELECT
            (SELECT count(*) FROM expenses WHERE business_id = ${businessId}::uuid)::text AS expenses,
            (SELECT count(*) FROM ledger_transactions WHERE business_id = ${businessId}::uuid)::text AS postings,
            (SELECT count(*) FROM inventory_movements WHERE business_id = ${businessId}::uuid)::text AS movements,
            (SELECT count(*) FROM bills WHERE business_id = ${businessId}::uuid)::text AS bills`),
      );
      const row = [...rows][0]!;
      return {
        expenses: Number(row['expenses']),
        postings: Number(row['postings']),
        movements: Number(row['movements']),
        bills: Number(row['bills']),
      };
    }

    // Kept identical to the copy in reports-purchase-orders-3.integration.test.ts. It belongs
    // to this describe block's own setup, which each part keeps as it was. Change them
    // together.
    async function poRow(businessId: string, poNumber: string) {
      const rows = await withBusiness(db, businessId, (tx) =>
        tx.execute<{ status: string; received_expense_id: string | null }>(sql`
          SELECT status, received_expense_id::text AS received_expense_id FROM orders
           WHERE business_id = ${businessId}::uuid AND order_number = ${poNumber}`),
      );
      return [...rows][0]!;
    }

    // Kept identical to the copy in reports-purchase-orders-3.integration.test.ts. It belongs
    // to this describe block's own setup, which each part keeps as it was. Change them
    // together.
    const onHand = async (businessId: string, name: string) =>
      (await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId))).rows.find(
        (r) => r.name === name,
      )?.onHand ?? 0;

    // Kept identical to the copy in reports-purchase-orders-3.integration.test.ts. It belongs
    // to this describe block's own setup, which each part keeps as it was. Change them
    // together.
    async function receive(auth: Record<string, string>, body: Record<string, unknown>) {
      return receivePurchaseOrderResponse.parse(
        (await post('/v1/reports/purchase-orders/receive', body, auth)).json(),
      );
    }

    it('Chat booked first: the receive asks SAME or SEPARATE and writes nothing', async () => {
      const { auth, businessId } = await onboard('+2348177000500');
      const expenseId = await chatBooked(businessId);
      const poNumber = await openPo(auth);
      const before = { ...(await counts(businessId)), books: await books(auth) };

      const asked = await receive(auth, { poNumber, paidK: PO_TOTAL_K, method: 'cash' });
      expect(asked).toMatchObject({
        outcome: 'possible_duplicate',
        poNumber,
        totalK: PO_TOTAL_K,
        matches: [{ expenseId, billNumber: null }],
      });

      /* Nothing moved: no purchase, posting, stock, bill or cash. */
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
      expect(await onHand(businessId, 'Ankara bale')).toBe(10);
    });

    it('SAME: the PO is received and linked, and nothing financial happens twice', async () => {
      const { auth, businessId } = await onboard('+2348177000501');
      const expenseId = await chatBooked(businessId);
      const poNumber = await openPo(auth);
      const before = { ...(await counts(businessId)), books: await books(auth) };

      /* The paid amount and account on the form must not move money again. */
      const same = await receive(auth, {
        poNumber,
        paidK: PO_TOTAL_K,
        method: 'cash',
        sameAs: expenseId,
      });
      expect(same).toEqual({ outcome: 'linked', poNumber, expenseId });
      expect(await poRow(businessId, poNumber)).toEqual({
        status: 'received',
        received_expense_id: expenseId,
      });

      const unchanged = async () => {
        expect(await counts(businessId)).toEqual({
          expenses: before.expenses,
          postings: before.postings,
          movements: before.movements,
          bills: before.bills,
        });
        expect(await books(auth)).toEqual(before.books);
        expect(await onHand(businessId, 'Ankara bale')).toBe(10);
        expect(await onHand(businessId, 'Thread spools')).toBe(0);
      };
      await unchanged();

      /* A repeated SAME (a retry after a lost response) is idempotent. */
      expect(
        await receive(auth, { poNumber, paidK: PO_TOTAL_K, method: 'cash', sameAs: expenseId }),
      ).toEqual({ outcome: 'already_linked', poNumber, expenseId });
      /* And a plain receive of the linked PO books nothing. */
      expect(await receive(auth, { poNumber, paidK: 0 })).toEqual({
        outcome: 'already_received',
      });
      await unchanged();
    });

    it('SAME answered after the Chat purchase aged past 24 hours still links, never books again', async () => {
      const { auth, businessId } = await onboard('+2348177000520');
      const expenseId = await chatBooked(businessId);
      const poNumber = await openPo(auth);
      expect((await receive(auth, { poNumber, paidK: 0 })).outcome).toBe('possible_duplicate');

      /* The merchant answers a day later: the booking has left the window
       * that decides when to ASK, but SAME is still the truth (fresh review
       * of 23e0803: re-checking by window turned a late SAME into a refusal
       * whose advice booked the purchase twice). */
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE expenses SET created_at = created_at - interval '25 hours'
                        WHERE business_id = ${businessId}::uuid AND id = ${expenseId}::uuid`),
      );
      const before = await counts(businessId);
      expect(await receive(auth, { poNumber, paidK: 0, sameAs: expenseId })).toEqual({
        outcome: 'linked',
        poNumber,
        expenseId,
      });
      expect(await receive(auth, { poNumber, paidK: 0 })).toEqual({ outcome: 'already_received' });
      expect(await counts(businessId)).toEqual(before);
      expect(await onHand(businessId, 'Ankara bale')).toBe(10);
    });

    it('SAME naming a voided Chat purchase writes nothing and leaves the order open', async () => {
      const { auth, businessId } = await onboard('+2348177000521');
      const expenseId = await chatBooked(businessId);
      const poNumber = await openPo(auth);
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE expenses SET status = 'voided'
                        WHERE business_id = ${businessId}::uuid AND id = ${expenseId}::uuid`),
      );
      expect(await receive(auth, { poNumber, paidK: 0, sameAs: expenseId })).toEqual({
        outcome: 'no_longer_matches',
        poNumber,
      });
      expect(await poRow(businessId, poNumber)).toEqual({
        status: 'open',
        received_expense_id: null,
      });
    });

    it('SAME naming a different purchase than the PO is linked to fails safe', async () => {
      const { auth, businessId } = await onboard('+2348177000502');
      /* Two genuine Chat purchases of one total, the second declared separate
       * by the merchant: the PO, with no reference, may be either. */
      const first = await chatBooked(businessId, 'invoice 1001');
      const second = await chatBookedSeparate(businessId, [first]);
      const poNumber = await openPo(auth);

      const asked = await receive(auth, { poNumber, paidK: 0 });
      expect(asked.outcome).toBe('possible_duplicate');
      if (asked.outcome !== 'possible_duplicate') return;
      /* Every match is offered, newest first, so SAME can name the OLDER
       * one the order really is (Codex review of 4582f91). */
      expect(asked.matches.map((m) => m.expenseId)).toEqual([second, first]);

      expect(await receive(auth, { poNumber, paidK: 0, sameAs: first })).toMatchObject({
        outcome: 'linked',
        expenseId: first,
      });
      const before = await counts(businessId);
      expect(await receive(auth, { poNumber, paidK: 0, sameAs: second })).toEqual({
        outcome: 'linked_elsewhere',
        poNumber,
      });
      /* Never silently relinked. */
      expect(await poRow(businessId, poNumber)).toEqual({
        status: 'received',
        received_expense_id: first,
      });
      expect(await counts(businessId)).toEqual(before);

      /* The purchase NOT picked is left for the order it really is. */
      const nextPo = await openPo(auth);
      expect(await receive(auth, { poNumber: nextPo, paidK: 0 })).toMatchObject({
        outcome: 'possible_duplicate',
        matches: [{ expenseId: second }],
      });
    });

    it('SAME on a PO already received with its own purchase changes nothing', async () => {
      const { auth, businessId } = await onboard('+2348177000503');
      const poNumber = await openPo(auth);
      expect((await receive(auth, { poNumber, paidK: 0 })).outcome).toBe('received');
      const before = await counts(businessId);
      expect(await receive(auth, { poNumber, paidK: 0, sameAs: randomUUID() })).toEqual({
        outcome: 'linked_elsewhere',
        poNumber,
      });
      expect(await counts(businessId)).toEqual(before);
    });

    it('SAME naming a purchase that is not a possible duplicate writes nothing', async () => {
      const { auth, businessId } = await onboard('+2348177000504');
      const poNumber = await openPo(auth);
      expect(await receive(auth, { poNumber, paidK: 0, sameAs: randomUUID() })).toEqual({
        outcome: 'no_longer_matches',
        poNumber,
      });
      expect(await poRow(businessId, poNumber)).toEqual({
        status: 'open',
        received_expense_id: null,
      });
      expect((await counts(businessId)).expenses).toBe(0);
    });

    it('SEPARATE: a genuine second purchase is received normally, exactly once', async () => {
      const { auth, businessId } = await onboard('+2348177000505');
      const expenseId = await chatBooked(businessId);
      const poNumber = await openPo(auth);
      const asked = await receive(auth, { poNumber, paidK: 2_000_000, method: 'transfer' });
      expect(asked.outcome).toBe('possible_duplicate');

      const body = { poNumber, paidK: 2_000_000, method: 'transfer', separateFrom: [expenseId] };
      expect(await receive(auth, body)).toMatchObject({
        outcome: 'received',
        poNumber,
        owedK: PO_TOTAL_K - 2_000_000,
      });
      /* A retried SEPARATE books nothing twice. */
      expect(await receive(auth, body)).toEqual({ outcome: 'already_received' });

      expect(await counts(businessId)).toMatchObject({ expenses: 2 });
      expect(await onHand(businessId, 'Ankara bale')).toBe(20);
      expect(await onHand(businessId, 'Thread spools')).toBe(5);
      expect(await poRow(businessId, poNumber)).toEqual({
        status: 'received',
        received_expense_id: null,
      });
      expect((await books(auth)).balanced).toBe(true);
    });
  });
});
