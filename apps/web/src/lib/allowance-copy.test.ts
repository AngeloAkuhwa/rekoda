import { describe, expect, it } from 'vitest';
import { quoteConvertExhausted } from './allowance-copy';

describe('quoteConvertExhausted', () => {
  it('names the month for a paid plan', () => {
    expect(quoteConvertExhausted(100, 'month')).toBe(
      'You have used all 100 invoices and receipts in your plan this month. Upgrade on the billing page and convert again.',
    );
  });

  it('names the free trial, never a month, for a trial (G-109)', () => {
    const text = quoteConvertExhausted(25, 'trial');
    expect(text).toBe(
      'You have used all 25 invoices and receipts included in your free trial. Choose a plan on the billing page and convert again.',
    );
    expect(text).not.toMatch(/month/);
  });

  it('reads a missing window as a month (an older API)', () => {
    expect(quoteConvertExhausted(100, undefined)).toContain('this month');
  });
});
