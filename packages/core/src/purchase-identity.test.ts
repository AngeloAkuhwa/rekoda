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
    ['EMK-0041', '41'],
    ['#2231', '2231'],
    ['INV/2026/114', '2026114'],
    ['inv 2231', '2231'],
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
    expect(purchaseMatches(facts(), [record({ bookedAt: edge })], NOW)).toHaveLength(0);
    const inside = new Date(edge.getTime() + 1000);
    expect(purchaseMatches(facts(), [record({ bookedAt: inside })], NOW)).toHaveLength(1);
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
    const unnamed = record({ self: { draftId: 'd2', expenseId: 'e2' }, at: LONG_AGO });
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
    const future = record({ bookedAt: new Date(NOW.getTime() + 60_000) });
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

  it('different numbers still prove separate', () => {
    expect(
      provenSeparate(
        facts({ reference: normalisePurchaseReference('EMK-0041') }),
        record({ reference: normalisePurchaseReference('EMK-0042') }),
      ),
    ).toBe(true);
  });
});
