import { billingChargeStatus } from '@rekoda/contracts';
import { describe, expect, it } from 'vitest';
import { chargeStatusLabel } from './charge-status';

describe('the billing page status words (G-69)', () => {
  it('calls a successful charge Paid', () => {
    expect(chargeStatusLabel('paid')).toBe('Paid');
  });

  it('translates every status a charge can carry, never the raw word', () => {
    for (const status of billingChargeStatus.options) {
      const label = chargeStatusLabel(status);
      expect(label).toBeTruthy();
      expect(label).not.toBe(status);
    }
  });
});
