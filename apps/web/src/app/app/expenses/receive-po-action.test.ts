/**
 * Receiving a purchase order from the dashboard (G-61, G-89).
 *
 * Money handed over on delivery left Cash or Bank, and the form never picks
 * one: a paid receive names its account or is refused before the API is
 * called; a receive wholly on credit needs none.
 *
 * A receive that may be a purchase already booked in Chat is a question,
 * SAME or SEPARATE, and the answer goes back with the purchases it is about.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/session-cookies', () => ({ readSessionToken: vi.fn(async () => 'tok') }));
vi.mock('@/server/api', () => ({
  cancelPurchaseOrder: vi.fn(),
  createPurchaseOrder: vi.fn(),
  createRecurring: vi.fn(),
  disposeAsset: vi.fn(),
  paySupplier: vi.fn(),
  receivePurchaseOrder: vi.fn(),
  recordAsset: vi.fn(),
  stopRecurring: vi.fn(),
  voidExpense: vi.fn(),
  withdrawAsset: vi.fn(),
  viewOnlyRefusal: vi.fn(),
}));

const api = await import('@/server/api');
const { receivePurchaseOrderAction } = await import('./actions');
const receive = vi.mocked(api.receivePurchaseOrder);

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const RECEIVED = {
  outcome: 'received' as const,
  poNumber: 'PO-2026-000001',
  totalK: 18_000_000,
  owedK: 8_000_000,
  linesArrived: 1,
};

beforeEach(() => receive.mockReset());

describe('receiving a purchase order', () => {
  it('refuses a paid receive with no account, without calling the API', async () => {
    const state = await receivePurchaseOrderAction(
      {},
      form({ poNumber: 'PO-2026-000001', paid: '100000', method: '' }),
    );
    expect(state.error).toBe(
      'Say where the payment came from: physical cash or your bank account.',
    );
    expect(receive).not.toHaveBeenCalled();
  });

  it('sends the chosen account with a paid receive', async () => {
    receive.mockResolvedValue(RECEIVED);
    await receivePurchaseOrderAction(
      {},
      form({ poNumber: 'PO-2026-000001', paid: '100000', method: 'transfer' }),
    );
    expect(receive).toHaveBeenCalledWith('tok', 'PO-2026-000001', 10_000_000, 'transfer');
  });

  it('needs no account for a receive wholly on credit, and sends none', async () => {
    receive.mockResolvedValue({ ...RECEIVED, owedK: 18_000_000 });
    for (const method of ['', 'cash']) {
      receive.mockClear();
      await receivePurchaseOrderAction({}, form({ poNumber: 'PO-2026-000001', paid: '', method }));
      expect(receive).toHaveBeenCalledWith('tok', 'PO-2026-000001', 0, null);
    }
  });
});

describe('a receive that may be a purchase already booked in Chat (G-89)', () => {
  const EXPENSE = '0b6f8a52-2c3e-4c41-9b7e-6a1f0e0d9c11';
  const OTHER = '6a3c1e8d-7f20-4d55-8a0e-2b9c4f1d7e22';
  const ASKED = {
    outcome: 'possible_duplicate' as const,
    poNumber: 'PO-2026-000001',
    totalK: 18_000_000,
    match: {
      expenseId: EXPENSE,
      bookedAt: '2026-10-07T13:05:00.000Z',
      bookedBy: 'another_member' as const,
      billNumber: null,
    },
    expenseIds: [EXPENSE, OTHER],
    alreadySeparate: [] as string[],
  };

  it('asks SAME or SEPARATE, carrying the purchases the question is about', async () => {
    receive.mockResolvedValue(ASKED);
    const state = await receivePurchaseOrderAction(
      {},
      form({ poNumber: 'PO-2026-000001', paid: '100000', method: 'transfer' }),
    );
    expect(state.error).toBeUndefined();
    expect(state.done).toBeUndefined();
    expect(state.question).toEqual({
      poNumber: 'PO-2026-000001',
      paid: '100000',
      method: 'transfer',
      expenseId: EXPENSE,
      expenseIds: [EXPENSE, OTHER],
      text:
        'Another member recorded a ₦180,000 purchase in Chat on 7 Oct 2026, 14:05, ' +
        'and 1 more of the same amount. Is PO-2026-000001 that same purchase?',
    });
  });

  it('SAME sends the purchase it is the same as, and says nothing was recorded again', async () => {
    receive.mockResolvedValue({
      outcome: 'linked',
      poNumber: 'PO-2026-000001',
      expenseId: EXPENSE,
    });
    const state = await receivePurchaseOrderAction(
      {},
      form({
        poNumber: 'PO-2026-000001',
        paid: '100000',
        method: 'transfer',
        answer: 'same',
        expenseId: EXPENSE,
        expenseIds: `${EXPENSE},${OTHER}`,
      }),
    );
    expect(receive).toHaveBeenCalledWith('tok', 'PO-2026-000001', 10_000_000, 'transfer', {
      sameAs: EXPENSE,
    });
    expect(state.done).toBe(
      'PO-2026-000001 marked as received and linked to the purchase already recorded in Chat. ' +
        'No additional purchase or accounting entry was created.',
    );
  });

  it('SEPARATE sends every purchase the question named', async () => {
    receive.mockResolvedValue({
      outcome: 'received',
      poNumber: 'PO-2026-000001',
      totalK: 18_000_000,
      owedK: 8_000_000,
      linesArrived: 1,
    });
    const state = await receivePurchaseOrderAction(
      {},
      form({
        poNumber: 'PO-2026-000001',
        paid: '100000',
        method: 'transfer',
        answer: 'separate',
        expenseId: EXPENSE,
        expenseIds: `${EXPENSE},${OTHER}`,
      }),
    );
    expect(receive).toHaveBeenCalledWith('tok', 'PO-2026-000001', 10_000_000, 'transfer', {
      separateFrom: [EXPENSE, OTHER],
    });
    expect(state.done).toMatch(/^PO-2026-000001 received:/);
  });

  it('never sends an answer that names no readable purchase', async () => {
    const state = await receivePurchaseOrderAction(
      {},
      form({ poNumber: 'PO-2026-000001', paid: '', answer: 'same', expenseId: 'not-an-id' }),
    );
    expect(receive).not.toHaveBeenCalled();
    expect(state.error).toBe('That answer could not be read. Nothing was recorded. Try again.');
  });

  it('says what a repeated SAME, a conflicting link and a stale answer did', async () => {
    const answer = form({
      poNumber: 'PO-2026-000001',
      paid: '',
      answer: 'same',
      expenseId: EXPENSE,
      expenseIds: EXPENSE,
    });
    receive.mockResolvedValue({
      outcome: 'already_linked',
      poNumber: 'PO-2026-000001',
      expenseId: EXPENSE,
    });
    expect((await receivePurchaseOrderAction({}, answer)).done).toBe(
      'PO-2026-000001 is already received and linked to the purchase recorded in Chat. Nothing was recorded twice.',
    );

    receive.mockResolvedValue({ outcome: 'linked_elsewhere', poNumber: 'PO-2026-000001' });
    expect((await receivePurchaseOrderAction({}, answer)).error).toBe(
      'PO-2026-000001 is already received against a different purchase. Nothing was changed. Check your purchases: if this order and the Chat purchase are the same, one of them may now be recorded twice.',
    );

    receive.mockResolvedValue({ outcome: 'no_longer_matches', poNumber: 'PO-2026-000001' });
    expect((await receivePurchaseOrderAction({}, answer)).error).toBe(
      'That Chat purchase can no longer be linked to this order: it was voided, changed or linked to another order. Nothing was changed. Check your purchases before marking this order received.',
    );
  });

  it('going back from the question records nothing and calls nothing', async () => {
    const state = await receivePurchaseOrderAction(
      {},
      form({ poNumber: 'PO-2026-000001', paid: '100000', method: 'transfer', answer: 'back' }),
    );
    expect(state).toEqual({});
    expect(receive).not.toHaveBeenCalled();
  });

  it('carries every purchase already answered SEPARATE into the next answer', async () => {
    const EARLIER = '9d1e2f30-4a5b-4c6d-8e7f-0a1b2c3d4e55';
    receive.mockResolvedValue({ ...ASKED, expenseIds: [EXPENSE], alreadySeparate: [EARLIER] });
    const state = await receivePurchaseOrderAction(
      {},
      form({ poNumber: 'PO-2026-000001', paid: '', answer: 'separate', expenseIds: EARLIER }),
    );
    expect(state.question?.expenseIds).toEqual([EARLIER, EXPENSE]);
    /* Only the NEW purchase is described and counted. */
    expect(state.question?.text).not.toMatch(/more of the same amount/);
  });
});
