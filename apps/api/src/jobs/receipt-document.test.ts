/**
 * What the receipt PDF is drawn from: the stored snapshot, read (G-49).
 *
 * The mapping is the one place a snapshot field can be dropped on its way to
 * paper, so each receipt generation is read through it and laid out.
 */
import { describe, expect, it } from 'vitest';
import { layoutReceipt } from '@rekoda/core';
import { receiptDocumentOf } from './render-document.handler.js';

const BASE = {
  documentNumber: 'RCT-2026-000002',
  issuedAtIso: '2026-09-26T10:00:00.000Z',
  invoiceNumber: 'INV-2026-000001',
  currency: 'NGN',
};

function printed(snapshot: Record<string, unknown>): string {
  return layoutReceipt(
    receiptDocumentOf(
      { receiptNumber: 'RCT-2026-000002', issuedAt: new Date(), snapshot },
      'Ada Fashion',
    ),
  )
    .map((b) => `${b.text} ${b.value ?? ''}`)
    .join('\n');
}

describe('a receipt snapshot on its way to paper', () => {
  it('a named overpayment prints the customer credit', () => {
    const text = printed({
      ...BASE,
      amountK: 12_000_000,
      allocatedK: 10_000_000,
      verified: false,
      excessDisposition: 'customer_credit',
    });
    expect(text).toContain('Amount received ₦120,000');
    expect(text).toContain('Applied to INV-2026-000001 ₦100,000');
    expect(text).toContain('Customer credit ₦20,000');
    expect(text).not.toMatch(/review|refund|confirmed with the payment provider/i);
  });

  it('an anonymous overpayment prints an unlinked, unapplied amount', () => {
    const text = printed({
      ...BASE,
      amountK: 12_000_000,
      allocatedK: 10_000_000,
      verified: false,
      excessDisposition: 'unattributed',
    });
    expect(text).toContain('Unapplied amount ₦20,000');
    expect(text).toContain('This amount is not linked to a customer yet.');
    expect(text).not.toMatch(/customer credit|owed to|refund|review/i);
  });

  it('a G-48 overpaid snapshot without the field keeps its neutral wording', () => {
    const text = printed({ ...BASE, amountK: 12_000_000, allocatedK: 10_000_000, verified: false });
    expect(text).toContain('The remaining ₦20,000 was not applied to this invoice.');
    expect(text).not.toMatch(/customer credit|unapplied amount/i);
  });

  it('an unknown disposition value is ignored, never printed', () => {
    const doc = receiptDocumentOf(
      {
        receiptNumber: 'RCT-2026-000002',
        issuedAt: new Date(),
        snapshot: { ...BASE, amountK: 2, allocatedK: 1, verified: false, excessDisposition: 'x' },
      },
      'Ada Fashion',
    );
    expect(doc).not.toHaveProperty('excessDisposition');
  });

  it('an exact merchant receipt carries no disposition', () => {
    const doc = receiptDocumentOf(
      {
        receiptNumber: 'RCT-2026-000002',
        issuedAt: new Date(),
        snapshot: { ...BASE, amountK: 10_000_000, allocatedK: 10_000_000, verified: false },
      },
      'Ada Fashion',
    );
    expect(doc).not.toHaveProperty('excessDisposition');
    expect(doc.verified).toBe(false);
  });
});
