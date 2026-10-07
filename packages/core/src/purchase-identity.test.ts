/**
 * One real purchase, one financial truth (G-81, OD-23), decided without a
 * database. The rule is the owner's: a purchase of the same total inside 24
 * hours is a possible duplicate unless BOTH sides carry a strong structured
 * difference (a different stated reference, or two different TRUSTED
 * products), and suppliers, quantity, raw names and wording are never one.
 */
import { describe, expect, it } from 'vitest';
import {
  PURCHASE_IDENTITY_WINDOW_SECONDS,
  declaredSeparate,
  normalisePurchaseReference,
  ownerOf,
  provenSeparate,
  purchaseIdentityVerdict,
  purchaseMatches,
  purchaseTotalK,
  sameRecord,
  storedPurchaseReference,
  type PurchaseFacts,
  type PurchaseRecord,
} from './purchase-identity.js';

const NOW = new Date('2026-10-02T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const LONG_AGO = new Date('2026-09-01T00:00:00Z');

const facts = (over: Partial<PurchaseFacts> = {}): PurchaseFacts => ({
  amountK: 10_000_000,
  at: NOW,
  product: null,
  reference: null,
  separateFrom: [],
  self: { draftId: null, expenseId: null },
  ...over,
});

const record = (over: Partial<PurchaseRecord> = {}): PurchaseRecord => ({
  ...facts({ at: minutesAgo(60) }),
  self: { draftId: 'd1', expenseId: 'e1' },
  id: 'e1',
  state: 'booked',
  bookedAt: minutesAgo(59),
  requestedBy: 'owner',
  billNumber: null,
  ...over,
});

/** For the fresh-review blocks below, which predate the refined facts. */
const known = (id: string, since = LONG_AGO) => ({ id, since });
const trusted = (id: string) => ({ id, trusted: true });

describe('what proves two purchases of one total separate (D3, refined)', () => {
  it('two different TRUSTED products', () => {
    expect(
      provenSeparate(facts({ product: trusted('milo') }), record({ product: trusted('peak') })),
    ).toBe(true);
  });

  it('a different stated reference on both sides', () => {
    expect(provenSeparate(facts({ reference: '41' }), record({ reference: '42' }))).toBe(true);
  });

  it('a field on one side only proves nothing', () => {
    expect(provenSeparate(facts(), record({ product: trusted('milo') }))).toBe(false);
    expect(provenSeparate(facts({ reference: '41' }), record())).toBe(false);
  });

  it('the same product and reference prove nothing', () => {
    expect(
      provenSeparate(
        facts({ product: trusted('milo'), reference: '41' }),
        record({ product: trusted('milo'), reference: '41' }),
      ),
    ).toBe(false);
  });

  it('quantity and suppliers are never part of the rule: there is no field for them', () => {
    expect(Object.keys(facts())).not.toContain('quantity');
    expect(Object.keys(facts())).not.toContain('supplier');
  });
});

describe('a stated supplier reference', () => {
  it.each([
    ['EMK-0041', 'OTHER:41'],
    ['#2231', 'OTHER:2231'],
    ['INV/2026/114', 'INV:226114'],
    ['inv 2231', 'INV:2231'],
  ])('%j normalises to %j', (raw, expected) => {
    expect(normalisePurchaseReference(raw)).toBe(expected);
  });

  it.each(['Emeka', "Emeka's receipt", 'the receipt', '', '   ', 'x'.repeat(50), 'emk 0041'])(
    '%j is not a reference (no digit, a name, or too long)',
    (raw) => {
      expect(normalisePurchaseReference(raw)).toBeNull();
    },
  );

  it('anything that is not a string is not a reference', () => {
    expect(normalisePurchaseReference(null)).toBeNull();
    expect(normalisePurchaseReference(41)).toBeNull();
    expect(normalisePurchaseReference(undefined)).toBeNull();
  });
});

describe('which records a new purchase may be', () => {
  it('the same total, booked inside 24 hours', () => {
    expect(purchaseMatches(facts(), [record()], NOW)).toHaveLength(1);
  });

  it('a different total, even by one kobo, is never compared', () => {
    expect(purchaseMatches(facts(), [record({ amountK: 10_000_001 })], NOW)).toHaveLength(0);
  });

  it('a booking 24 hours old or more is outside the rolling window (D2)', () => {
    const edge = new Date(NOW.getTime() - PURCHASE_IDENTITY_WINDOW_SECONDS * 1000);
    expect(purchaseMatches(facts(), [record({ bookedAt: edge, at: edge })], NOW)).toHaveLength(0);
    const inside = new Date(edge.getTime() + 1000);
    expect(purchaseMatches(facts(), [record({ bookedAt: inside, at: inside })], NOW)).toHaveLength(
      1,
    );
  });

  it('a waiting preview always counts (D1)', () => {
    expect(
      purchaseMatches(facts(), [record({ state: 'pending', bookedAt: null })], NOW),
    ).toHaveLength(1);
  });

  it('"separate" excuses ONLY the records its question named, in both directions', () => {
    const named = { draftId: 'd1', expenseId: null };
    const declared = facts({ separateFrom: [named] });
    expect(declaredSeparate(declared, record())).toBe(true);
    expect(purchaseMatches(declared, [record()], NOW)).toHaveLength(0);
    /* The booked one is the "separate" preview; the new one is what it named. */
    const namedOne = facts({ self: { draftId: 'd9', expenseId: null } });
    const bookedSeparate = record({ separateFrom: [{ draftId: 'd9', expenseId: null }] });
    expect(purchaseMatches(namedOne, [bookedSeparate], NOW)).toHaveLength(0);
    /* A record the question did not name is not excused, however old. */
    const unnamed = record({ self: { draftId: 'd2', expenseId: 'e2' }, at: minutesAgo(120) });
    expect(purchaseMatches(declared, [unnamed], NOW)).toHaveLength(1);
  });

  it('a named waiting draft is still named once it is booked', () => {
    expect(sameRecord({ draftId: 'd1', expenseId: null }, { draftId: 'd1', expenseId: 'e1' })).toBe(
      true,
    );
    expect(sameRecord({ draftId: null, expenseId: 'e1' }, { draftId: 'd1', expenseId: 'e1' })).toBe(
      true,
    );
    expect(sameRecord({ draftId: null, expenseId: null }, { draftId: null, expenseId: null })).toBe(
      false,
    );
  });

  it('booked records come first, newest first', () => {
    const matches = purchaseMatches(
      facts(),
      [
        record({ id: 'waiting', state: 'pending', bookedAt: null, at: minutesAgo(1) }),
        record({ id: 'old', bookedAt: minutesAgo(300) }),
        record({ id: 'new', bookedAt: minutesAgo(10) }),
      ],
      NOW,
    );
    expect(matches.map((m) => m.id)).toEqual(['new', 'old', 'waiting']);
  });
});

describe("the same member's own case (D4)", () => {
  const pendingOwn = record({ id: 'mine', state: 'pending', bookedAt: null, requestedBy: 'owner' });
  const pendingOther = record({
    id: 'theirs',
    state: 'pending',
    bookedAt: null,
    requestedBy: 'del',
  });
  const pendingNobody = record({
    id: 'nobody',
    state: 'pending',
    bookedAt: null,
    requestedBy: null,
  });
  const bookedOwn = record({ id: 'booked', requestedBy: 'owner' });

  it("the member's own waiting preview is replaced, never asked about", () => {
    expect(purchaseIdentityVerdict([pendingOwn], 'owner')).toEqual({
      replace: [pendingOwn],
      asked: [],
      ask: null,
    });
  });

  it('their own BOOKED purchase is asked about', () => {
    expect(purchaseIdentityVerdict([bookedOwn], 'owner').ask).toBe(bookedOwn);
  });

  it("another member's waiting preview is asked about, never replaced", () => {
    expect(purchaseIdentityVerdict([pendingOther], 'owner')).toEqual({
      replace: [],
      asked: [pendingOther],
      ask: pendingOther,
    });
  });

  it('a preview with no recorded requester is never "yours"', () => {
    expect(ownerOf(pendingNobody, 'owner')).toBe('unknown');
    expect(purchaseIdentityVerdict([pendingNobody], 'owner').replace).toEqual([]);
    /* Nor is anything yours when Rekoda cannot say who is asking. */
    expect(purchaseIdentityVerdict([pendingOwn], null).replace).toEqual([]);
  });

  it('the question names EVERY other match, booked first', () => {
    const verdict = purchaseIdentityVerdict([bookedOwn, pendingOther, pendingOwn], 'owner');
    expect(verdict.asked).toEqual([bookedOwn, pendingOther]);
    expect(verdict.ask).toBe(bookedOwn);
  });
});

describe('a stored command total', () => {
  it('reads kobo from a purchase', () => {
    expect(purchaseTotalK({ intent: 'RecordPurchase', amount: 100_000 })).toBe(10_000_000);
    expect(purchaseTotalK({ intent: 'RecordPurchase', amount: 0.5 })).toBe(50);
  });

  it('is null for anything else', () => {
    expect(purchaseTotalK({ intent: 'RecordExpense', amount: 100 })).toBeNull();
    expect(purchaseTotalK({ intent: 'RecordPurchase', amount: '100' })).toBeNull();
    expect(purchaseTotalK({ intent: 'RecordPurchase', amount: 0 })).toBeNull();
    expect(purchaseTotalK(null)).toBeNull();
  });
});

describe('Codex review of #262: a booking after the message is not compared by default', () => {
  it('a negative age (booked after the instant compared at) is outside the default window', () => {
    const future = record({
      bookedAt: new Date(NOW.getTime() + 60_000),
      at: new Date(NOW.getTime() + 60_000),
    });
    expect(purchaseMatches(facts(), [future], NOW)).toHaveLength(0);
  });
});

describe('fresh review of #262: the refined D3 (owner, 2 Oct 2026)', () => {
  const product = (id: string, isTrusted: boolean) => ({ id, trusted: isTrusted });

  it('a supplier row never proves two purchases separate, however old', () => {
    expect(
      provenSeparate(
        facts({ supplier: known('emeka') } as Partial<PurchaseFacts>),
        record({ supplier: known('chidi') } as Partial<PurchaseRecord>),
      ),
    ).toBe(false);
  });

  it('a product row created from chat never proves it, however old', () => {
    expect(
      provenSeparate(
        facts({ product: product('milo', false) } as Partial<PurchaseFacts>),
        record({ product: product('peak', false) } as Partial<PurchaseRecord>),
      ),
    ).toBe(false);
  });

  it('two different TRUSTED products (catalogue-linked) prove it', () => {
    expect(
      provenSeparate(
        facts({ product: product('milo', true) } as Partial<PurchaseFacts>),
        record({ product: product('peak', true) } as Partial<PurchaseRecord>),
      ),
    ).toBe(true);
  });
});

describe('fresh review of #262: one document number in two formats is one reference', () => {
  it.each([
    ['2231', 'INV-2231'],
    ['EMK-0041', 'EMK 41'],
    ['INV/2026/0114', 'inv 2026 114'],
    ['RCPT 2231', '#2231'],
  ])('%j and %j never prove separate', (a, b) => {
    expect(
      provenSeparate(
        facts({ reference: normalisePurchaseReference(a) }),
        record({ reference: normalisePurchaseReference(b) }),
      ),
    ).toBe(false);
  });

  it.each([
    '100k',
    '₦100000',
    'N100000',
    '12/09/2026',
    '2026-09-12',
    'Ada 07',
    'Ada 12',
    '08031234567',
    '0123456789',
    '+2348031234567',
    'Emeka 2',
  ])('%j is not a reference', (raw) => {
    expect(normalisePurchaseReference(raw)).toBeNull();
  });

  it.each(['EMK-0041', 'INV 2231', '#2231', 'INV/2026/114', 'receipt 4471'])(
    '%j is a reference',
    (raw) => {
      expect(normalisePurchaseReference(raw)).not.toBeNull();
    },
  );

  it('different numbers of the same kind still prove separate', () => {
    expect(
      provenSeparate(
        facts({ reference: normalisePurchaseReference('INV-0041') }),
        record({ reference: normalisePurchaseReference('INV-0042') }),
      ),
    ).toBe(true);
  });
});

describe('the window is a rolling 24 hours, never a Lagos day (D2)', () => {
  it('a booking at 23:50 Lagos still counts for a message at 01:10 the next Lagos day', () => {
    const now = new Date('2026-10-02T00:10:00Z'); // 01:10 Lagos, 2 Oct
    const t = new Date('2026-10-01T22:50:00Z'); // 23:50 Lagos, 1 Oct
    const booking = record({ bookedAt: t, at: t });
    expect(purchaseMatches(facts({ at: now }), [booking], now)).toHaveLength(1);
  });

  it('a booking from earlier the SAME Lagos day but over 24 hours ago does not', () => {
    const now = new Date('2026-10-02T22:30:00Z'); // 23:30 Lagos, 2 Oct
    const t = new Date('2026-10-01T22:20:00Z'); // 23:20 Lagos, 1 Oct
    const booking = record({ bookedAt: t, at: t });
    expect(purchaseMatches(facts({ at: now }), [booking], now)).toHaveLength(0);
  });
});

describe('Codex review of ff9443e', () => {
  it('P1: zero padding split by a separator is still one reference', () => {
    expect(
      provenSeparate(
        facts({ reference: normalisePurchaseReference('EMK-0041') }),
        record({ reference: normalisePurchaseReference('EMK-00-41') }),
      ),
    ).toBe(false);
  });

  it('P2: the preview window is measured from the earlier purchase MESSAGE, not its booking', () => {
    const lateBooking = record({ at: minutesAgo(25 * 60), bookedAt: minutesAgo(60) });
    expect(purchaseMatches(facts(), [lateBooking], NOW)).toHaveLength(0);
  });
});

describe('Codex review of cfc4720', () => {
  it.each(['0803-123-4567', '0803 123 4567', '+234 803 123 4567', '012-345-6789', '0123 456 789'])(
    'P2: %j (a formatted phone or account number) is not a reference',
    (raw) => {
      expect(normalisePurchaseReference(raw)).toBeNull();
    },
  );
});

describe('Codex review of 3fcc173', () => {
  it.each([
    '125,000.00',
    '125000.00',
    '20261002',
    '2026-10',
    '10/2026',
    'Receipt 12/09/2026',
    'INV 125,000',
  ])('P2: %j (an amount or a date) is not a reference', (raw) => {
    expect(normalisePurchaseReference(raw)).toBeNull();
  });

  it('P2: plain digits with no document marker are in doubt, so no reference', () => {
    expect(normalisePurchaseReference('2231')).toBeNull();
    expect(normalisePurchaseReference('#2231')).toBe('OTHER:2231');
    expect(normalisePurchaseReference('INV-2231')).toBe('INV:2231');
  });

  it('P2: two own waiting previews of one total are asked about, never both replaced', () => {
    const a = record({ id: 'a', state: 'pending', bookedAt: null, requestedBy: 'owner' });
    const b = record({ id: 'b', state: 'pending', bookedAt: null, requestedBy: 'owner' });
    const verdict = purchaseIdentityVerdict([a, b], 'owner');
    expect(verdict.replace).toEqual([]);
    expect(verdict.asked).toEqual([a, b]);
  });
});

describe('fresh review of 75fd1c9: references by document kind, never letters', () => {
  const ref = (raw: string, total?: number) => normalisePurchaseReference(raw, total);

  it('I1: an invoice number and a receipt number never prove one purchase two', () => {
    expect(
      provenSeparate(
        facts({ reference: ref('invoice 2231') }),
        record({ reference: ref('receipt RCPT-0041') }),
      ),
    ).toBe(false);
  });

  it('I1: two invoices with different numbers do prove it', () => {
    expect(
      provenSeparate(
        facts({ reference: ref('invoice 2231') }),
        record({ reference: ref('INV-2232') }),
      ),
    ).toBe(true);
  });

  it('I1: a reference of unknown kind ("#", a letter prefix) never proves it', () => {
    expect(
      provenSeparate(facts({ reference: ref('#2231') }), record({ reference: ref('#2232') })),
    ).toBe(false);
    expect(
      provenSeparate(facts({ reference: ref('EMK-0041') }), record({ reference: ref('EMK-0042') })),
    ).toBe(false);
  });

  it.each(['TOLU-77', 'JOHN99', '#ADA-12', 'IBK22', 'EMK-0041'])(
    'I2: %j is stored with no letters',
    (raw) => {
      const stored = storedPurchaseReference(raw);
      expect(stored).not.toBeNull();
      expect(stored!).toMatch(/^(INV|RCPT|WAYBILL|PO|OTHER):\d+$/);
      expect(stored!.slice(stored!.indexOf(':'))).not.toMatch(/[A-Za-z]/);
      expect(stored!.startsWith('OTHER:')).toBe(true);
    },
  );

  it.each([
    ['receipt 120000', 120_000],
    ['NGN150K', null],
    ['INV-2026-10-02', null],
    ['INV-20261002', null],
    ['INV 10:30', null],
  ])('minor: %j is not a reference (an amount, the total, a date or a time)', (raw, total) => {
    expect(normalisePurchaseReference(raw, total)).toBeNull();
  });
});

describe('Codex review of 7f173b6: the stored form meets every check', () => {
  it.each([
    ['INV:100000', 100_000],
    ['INV:10000000', 100_000],
    ['RCPT:20261002', null],
    ['PO:0803123456', null],
    ['INV:08031234567', null],
    ['INV:0001', null],
    ['OTHER:7', null],
  ])('P2: %j in the stored form is not a reference (total %j)', (raw, total) => {
    expect(storedPurchaseReference(raw, total)).toBeNull();
    expect(normalisePurchaseReference(raw, total)).toBeNull();
  });

  it('a genuine stored reference still reads back unchanged', () => {
    expect(storedPurchaseReference('INV:2231', 100_000)).toBe('INV:2231');
    expect(storedPurchaseReference('OTHER:0041', 100_000)).toBe('OTHER:0041');
  });
});

describe('Codex review of 0e9bf52: compact dates in any order', () => {
  it.each(['invoice 03102026', 'INV:03102026', 'INV-10032026', 'receipt 31122025'])(
    'P2: %j is a date, never a reference',
    (raw) => {
      expect(normalisePurchaseReference(raw, 100_000)).toBeNull();
      expect(storedPurchaseReference(raw, 100_000)).toBeNull();
    },
  );

  it('an eight-digit invoice number that is not a date is still one', () => {
    expect(storedPurchaseReference('invoice 45102026', 100_000)).toBe('INV:45102026');
  });
});
