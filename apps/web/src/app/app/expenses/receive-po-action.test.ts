/**
 * Receiving a purchase order from the dashboard (G-61).
 *
 * Money handed over on delivery left Cash or Bank, and the form never picks
 * one: a paid receive names its account or is refused before the API is
 * called; a receive wholly on credit needs none.
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
    expect(state.error).toBe('Say how you paid it: cash or transfer.');
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
