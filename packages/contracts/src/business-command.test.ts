import { describe, expect, it } from 'vitest';
import { CUSTOMER_NAME_MAX_CHARS, customerName, parseBusinessCommand } from './business-command.js';

describe('StructuredBusinessCommand — the AI border checkpoint', () => {
  it('accepts a well-formed sale', () => {
    const r = parseBusinessCommand({
      intent: 'RecordSale',
      customer: { kind: 'token', token: 'CUSTOMER_X92' },
      items: [{ name: 'Bag', quantity: 4, unitPrice: 28000 }],
      statedTotal: null,
      reportedPayment: 80000,
      paymentMethod: 'transfer',
      discount: null,
      deliveryFee: null,
      dueDescription: 'Friday',
    });
    expect(r.ok).toBe(true);
  });

  it('carries where the sale happened ONLY when the merchant said so (§27)', () => {
    const base = {
      intent: 'RecordSale',
      customer: { kind: 'none' },
      items: [{ name: 'Wig', quantity: 2, unitPrice: 60000 }],
      statedTotal: null,
      reportedPayment: null,
      paymentMethod: 'transfer',
      discount: null,
      deliveryFee: null,
      dueDescription: null,
    };
    // Named channel: accepted verbatim from the fixed list.
    expect(parseBusinessCommand({ ...base, saleSource: 'instagram' }).ok).toBe(true);
    // Nothing said: the field is simply absent, and that is a valid sale.
    expect(parseBusinessCommand(base).ok).toBe(true);
    // An invented channel is rejected at the border, not stored as data.
    expect(parseBusinessCommand({ ...base, saleSource: 'darkweb' }).ok).toBe(false);
  });

  it('rejects hostile amounts — the ₦10bn injection ceiling holds', () => {
    const r = parseBusinessCommand({
      intent: 'RecordSale',
      customer: { kind: 'none' },
      items: [{ name: 'x', quantity: 1, unitPrice: 999_999_999_999 }],
      statedTotal: null,
      reportedPayment: null,
      paymentMethod: 'unknown',
      discount: null,
      deliveryFee: null,
      dueDescription: null,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects negative and non-finite money outright', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = parseBusinessCommand({
        intent: 'RecordExpense',
        description: 'diesel',
        amount: bad,
        category: null,
        paymentMethod: 'cash',
      });
      expect(r.ok).toBe(false);
    }
  });

  it('customer refs are tokens or mentions — a phone number is not a valid token', () => {
    const r = parseBusinessCommand({
      intent: 'RecordPayment',
      customer: { kind: 'token', token: '+2348031234567' },
      amount: 100000,
      relativeAmount: null,
      documentRef: null,
      paymentMethod: 'transfer',
    });
    expect(r.ok).toBe(false);
  });

  it('an unknown intent cannot smuggle itself in', () => {
    expect(parseBusinessCommand({ intent: 'DeleteAllRecords' }).ok).toBe(false);
    expect(parseBusinessCommand(null).ok).toBe(false);
    expect(parseBusinessCommand('yes').ok).toBe(false);
  });

  it('malformed output reports, never throws', () => {
    const r = parseBusinessCommand({ intent: 'RecordSale' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('customer');
  });
});

/* Codex on #271: Unicode-equivalent spellings of one name are equally valid
 * (G-60). Length is measured composed (NFC), the form the matcher uses. */
describe('customerName, in either Unicode composition', () => {
  const valid = (value: string) => customerName.safeParse(value).success;

  it.each([
    ['a one-letter initial', 'Á'],
    ['a two-letter name', 'Áda'],
    ['a long Yoruba name', 'Olúwadámilọ́lá Adébáyọ̀-Ọláòṣebìkan Ògúntóyè Fáṣọlá Àdìgún Ọ̀ṣúnbíyìí'],
    ['a name one past the limit', `${'Ọ̀'.repeat(CUSTOMER_NAME_MAX_CHARS + 1)}`],
    ['a name at the limit', `${'Ọ̀'.repeat(CUSTOMER_NAME_MAX_CHARS)}`],
  ])('treats %s the same composed and decomposed', (_, name) => {
    expect(valid(name.normalize('NFD'))).toBe(valid(name.normalize('NFC')));
  });

  it('refuses a one-letter initial in either form, and accepts a long valid name', () => {
    expect(valid('Á')).toBe(false);
    expect(valid('Á')).toBe(false);
    const long = 'Olúwadámilọ́lá Adébáyọ̀-Ọláòṣebìkan Ògúntóyè Fáṣọlá Àdìgún Ọ̀ṣúnbíyìí';
    expect(valid(long.normalize('NFD'))).toBe(true);
  });
});
