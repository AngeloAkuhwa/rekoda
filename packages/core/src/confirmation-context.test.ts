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

const BOUND = {
  kind: 'payment_invoice',
  invoiceId: '00000000-0000-4000-8000-000000000002',
  balanceShownK: 15_000_000,
  amountShownK: 2_000_000,
};

describe('the invoice a payment preview showed (OD-57)', () => {
  it('reads back exactly what was written, an exact payment included', () => {
    expect(parseConfirmationContext(BOUND)).toEqual(BOUND);
    const exact = { ...BOUND, amountShownK: 15_000_000 };
    expect(parseConfirmationContext(exact)).toEqual(exact);
  });

  it('treats anything else as nothing shown', () => {
    for (const value of [
      { ...BOUND, invoiceId: 'INV-2026-000001' },
      { ...BOUND, balanceShownK: 1.5 },
      { ...BOUND, amountShownK: -1 },
      /* Nothing paid, or more than the balance: never this kind. */
      { ...BOUND, amountShownK: 0 },
      { ...BOUND, amountShownK: 15_000_001 },
      /* No extra keys: nothing personal can ride along. */
      { ...BOUND, invoiceNumber: 'INV-2026-000001' },
      { ...BOUND, customerToken: 'CUSTOMER_7K2' },
      (({ amountShownK: _dropped, ...rest }) => rest)(BOUND),
      /* The other kind's keys under this kind's name. */
      { ...VALID, kind: 'payment_invoice' },
    ]) {
      expect(parseConfirmationContext(value), JSON.stringify(value)).toBeNull();
    }
  });
});
