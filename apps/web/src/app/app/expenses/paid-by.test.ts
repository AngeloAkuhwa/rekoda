/**
 * The register's "Paid by" column (G-61).
 */
import { describe, expect, it } from 'vitest';
import { paidBy } from './paid-by';

describe('paidBy', () => {
  it('names the account a paid purchase left', () => {
    expect(paidBy('transfer')).toBe('Transfer');
    expect(paidBy('cash')).toBe('Cash');
  });

  it('says how a credit purchase was made, never that it is still unpaid', () => {
    /* A supplier payment can settle it later without touching the row, so
     * the label must stay true after the debt is cleared. */
    expect(paidBy('credit')).toBe('On credit');
    expect(paidBy('credit')).not.toMatch(/not paid|unpaid|owing/i);
  });
});
