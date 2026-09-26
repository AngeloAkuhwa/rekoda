/**
 * The dashboard's overpayment two-step (G-49, OWN-16), at the action.
 *
 * The API decides and computes; what this proves is the form's half of the
 * bargain: the first answer becomes a question with the server's figures, the
 * confirmation is sent only for exactly the figures shown, and a stale
 * confirmation is told apart from an ordinary typo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/session-cookies', () => ({ readSessionToken: vi.fn(async () => 'tok') }));
vi.mock('@/server/api', () => ({
  cancelQuote: vi.fn(),
  convertQuote: vi.fn(),
  createQuote: vi.fn(),
  creditInvoice: vi.fn(),
  recordPayment: vi.fn(),
  voidInvoice: vi.fn(),
  viewOnlyRefusal: vi.fn(),
}));

const api = await import('@/server/api');
const { recordPaymentAction } = await import('./actions');
const recordPayment = vi.mocked(api.recordPayment);

const CLIENT_REF = '6c0e7f1a-2b3d-4c5e-8f90-a1b2c3d4e5f6';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const FIRST = {
  invoiceNumber: 'INV-2026-000001',
  amount: '180000',
  method: 'cash',
  clientRef: CLIENT_REF,
};
const CONFIRMING = {
  ...FIRST,
  confirmOverpayment: '1',
  expectedBalanceK: '15000000',
  confirmedAmountK: '18000000',
  confirmedInvoiceNumber: 'INV-2026-000001',
};

beforeEach(() => recordPayment.mockReset());

describe('recording more than an invoice owes, from the dashboard', () => {
  it('turns the first answer into a question with the server figures, saving nothing', async () => {
    recordPayment.mockResolvedValue({
      outcome: 'confirm_overpayment',
      invoiceNumber: 'INV-2026-000001',
      balanceDueK: 15_000_000,
      amountReceivedK: 18_000_000,
      allocatedK: 15_000_000,
      creditK: 3_000_000,
      customerLinked: true,
    });
    const state = await recordPaymentAction({}, form(FIRST));

    expect(recordPayment.mock.calls[0]?.[1]).toEqual({
      invoiceNumber: 'INV-2026-000001',
      amountK: 18_000_000,
      method: 'cash',
      clientRef: CLIENT_REF,
    });
    expect(state.done).toBeUndefined();
    expect(state.overpayment).toMatchObject({
      invoiceNumber: 'INV-2026-000001',
      amountK: 18_000_000,
      expectedBalanceK: 15_000_000,
    });
    expect(state.overpayment?.consequence).toContain('₦30,000 becomes customer credit');
    expect(state.overpayment?.consequence).toContain('Nothing is saved until you confirm');
  });

  it('names an unlinked excess as unapplied, never as owed to anyone', async () => {
    recordPayment.mockResolvedValue({
      outcome: 'confirm_overpayment',
      invoiceNumber: 'INV-2026-000001',
      balanceDueK: 15_000_000,
      amountReceivedK: 18_000_000,
      allocatedK: 15_000_000,
      creditK: 3_000_000,
      customerLinked: false,
    });
    const state = await recordPaymentAction({}, form(FIRST));
    expect(state.overpayment?.consequence).toContain('is recorded as unapplied');
    expect(state.overpayment?.consequence).not.toMatch(/customer credit|owed to|refund/i);
  });

  it('confirms with the balance shown and the same form key', async () => {
    recordPayment.mockResolvedValue({
      outcome: 'recorded',
      receiptNumber: 'RCT-2026-000001',
      invoiceNumber: 'INV-2026-000001',
      amountK: 15_000_000,
      balanceDueK: 0,
      receivedK: 18_000_000,
      creditK: 3_000_000,
    });
    const state = await recordPaymentAction({}, form(CONFIRMING));
    expect(recordPayment.mock.calls[0]?.[1]).toEqual({
      invoiceNumber: 'INV-2026-000001',
      amountK: 18_000_000,
      method: 'cash',
      clientRef: CLIENT_REF,
      confirmOverpayment: true,
      expectedBalanceK: 15_000_000,
    });
    expect(state.done).toContain('Receipt RCT-2026-000001 for ₦180,000');
    expect(state.done).toContain('₦150,000 paid INV-2026-000001 in full');
  });

  it('a changed amount is a new question, not a yes', async () => {
    recordPayment.mockResolvedValue({ outcome: 'not_found' });
    await recordPaymentAction({}, form({ ...CONFIRMING, amount: '190000' }));
    const sent = recordPayment.mock.calls[0]?.[1];
    expect(sent).not.toHaveProperty('confirmOverpayment');
    expect(sent).not.toHaveProperty('expectedBalanceK');
  });

  it('a stale confirmation says the balance changed and nothing was recorded', async () => {
    recordPayment.mockResolvedValue({
      outcome: 'balance_moved',
      invoiceNumber: 'INV-2026-000001',
      balanceDueK: 10_000_000,
      excessK: 8_000_000,
    });
    const state = await recordPaymentAction({}, form(CONFIRMING));
    expect(state.error).toContain('now owes ₦100,000, not what you confirmed');
    expect(state.error).toContain('nothing was recorded');
    /* The refusal may be recorded against the form key (command bus on), so
     * the re-asked submit must carry a new one, or it is refused as reused. */
    expect(state.freshKey).toBe(true);
  });

  it('every refusal that may have spent the form key asks for a fresh one', async () => {
    for (const outcome of [
      { outcome: 'balance_moved', invoiceNumber: 'INV-2026-000001', balanceDueK: 1, excessK: 1 },
      { outcome: 'already_settled', invoiceNumber: 'INV-2026-000001' },
      { outcome: 'not_found' },
    ] as const) {
      recordPayment.mockResolvedValue(outcome);
      const state = await recordPaymentAction({}, form(FIRST));
      expect(state.freshKey, outcome.outcome).toBe(true);
      expect(state.done).toBeUndefined();
    }
  });
});
