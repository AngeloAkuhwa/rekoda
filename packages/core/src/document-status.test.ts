import { describe, expect, it } from 'vitest';
import { collectionStatusFor, paymentStatusFor } from './document-status.js';

describe('paymentStatusFor (Appendix E.3)', () => {
  it('walks UNPAID through PARTIALLY_PAID to PAID as settlement arrives', () => {
    expect(paymentStatusFor(10_000, 0)).toBe('UNPAID');
    expect(paymentStatusFor(10_000, 1)).toBe('PARTIALLY_PAID');
    expect(paymentStatusFor(10_000, 9_999)).toBe('PARTIALLY_PAID');
    expect(paymentStatusFor(10_000, 10_000)).toBe('PAID');
  });

  /* A debt worked off by credit is as settled as one paid in cash: the
   * caller passes payments PLUS applied credits, and this cannot tell the
   * difference — deliberately. */
  it('does not care how the settlement happened', () => {
    expect(paymentStatusFor(10_000, 4_000 + 6_000)).toBe('PAID');
  });
});

describe('collectionStatusFor (Appendix E.3)', () => {
  /* Due dates resolve to the END of the Lagos day (due-dates.ts): "pay on
   * Friday" is not late at 09:00 on Friday. */
  const endOfLagosDay = (day: string) => new Date(`${day}T23:59:59.999+01:00`);

  it('is CURRENT for a settled document, an undated debt, and one not yet due', () => {
    const now = new Date('2026-08-10T10:00:00+01:00');
    expect(collectionStatusFor(endOfLagosDay('2026-08-01'), 0, now)).toBe('CURRENT');
    expect(collectionStatusFor(null, 5_000, now)).toBe('CURRENT');
    expect(collectionStatusFor(endOfLagosDay('2026-08-20'), 5_000, now)).toBe('CURRENT');
  });

  it('is DUE on the due day itself, and OVERDUE the day after', () => {
    expect(
      collectionStatusFor(
        endOfLagosDay('2026-08-10'),
        5_000,
        new Date('2026-08-10T10:00:00+01:00'),
      ),
    ).toBe('DUE');
    expect(
      collectionStatusFor(
        endOfLagosDay('2026-08-10'),
        5_000,
        new Date('2026-08-11T00:01:00+01:00'),
      ),
    ).toBe('OVERDUE');
  });
});
