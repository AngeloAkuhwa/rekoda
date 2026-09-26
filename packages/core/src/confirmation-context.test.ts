import { describe, expect, it } from 'vitest';
import { parseConfirmationContext } from './confirmation-context.js';

const VALID = {
  kind: 'payment_overpayment',
  invoiceId: '00000000-0000-4000-8000-000000000001',
  balanceShownK: 10_000_000,
  amountReceivedK: 12_000_000,
  allocatedK: 10_000_000,
  creditK: 2_000_000,
};

describe('the confirmation context a draft carries (G-49)', () => {
  it('reads back exactly what was written', () => {
    expect(parseConfirmationContext(VALID)).toEqual(VALID);
  });

  it('treats anything else as no confirmed overpayment', () => {
    for (const value of [
      null,
      undefined,
      'payment_overpayment',
      [VALID],
      { ...VALID, kind: 'something_else' },
      { ...VALID, invoiceId: 'INV-2026-000001' },
      { ...VALID, balanceShownK: 1.5 },
      { ...VALID, creditK: -1 },
      { ...VALID, creditK: 0, amountReceivedK: 10_000_000 },
      /* Not internally consistent: it is not something Rekoda wrote. */
      { ...VALID, allocatedK: 9_000_000 },
      { ...VALID, amountReceivedK: 13_000_000 },
      /* No extra keys: nothing personal can ride along. */
      { ...VALID, customerName: 'Ada' },
      (({ creditK: _dropped, ...rest }) => rest)(VALID),
    ]) {
      expect(parseConfirmationContext(value), JSON.stringify(value)).toBeNull();
    }
  });
});
