/**
 * CG5: when a correction is clear enough to keep the customer of the draft it corrects (OWN-100).
 * Beside `gates.test.ts`, which is over the layout limit and may not grow.
 */
import { describe, expect, it } from 'vitest';
import {
  clearlyCorrects,
  correctionWordsExplained,
  draftFigures,
  unnamedFiguresChanged,
  explicitlyCorrects,
  looksLikeCorrection,
  replacedFiguresFit,
} from './gates.js';

describe('a correction clear enough to keep the draft customer (clearlyCorrects, OWN-100)', () => {
  it.each([
    'No, 4 not 3',
    'sorry, 60k each not 50k',
    'no, 60k not 50k',
    '4 not 3',
    'No, 4 not 3.',
    'it was 60k not 50k',
    'the price should be 60k',
    'make it 5',
    /* Not a time: a thousands figure and a unit that starts like "s"/"sec" (CodeRabbit, cf96697). */
    'make it 6k',
    'make it 5 sets',
    'make it ₦60,000',
    /* N for naira, as merchants type it (independent review of 4536d82). */
    'the price should be N60,000',
    'make it N60k',
    'change it to 4',
    'no, it should be 4 wigs',
    '5 wigs instead of 3',
    'no, 60k instead of 50k',
    /* Currency as merchants type it. */
    'no, make it 60,000',
    'should be ₦ 60,000',
    'make it 60.5k',
    'no, 60k not 50k!',
    'make it 20k',
    'no, the balance should be 10k',
    'make it NGN 60000',
    'should be N60k not N50k',
    'make it 4pcs',
    'total should be 50k',
    'Price should be 60k each',
    'change the price to 60k',
    'change the price to 1.6m',
    'the delivery fee should be 2k',
    /* Item names that begin like a month or a day are items. */
    'make it 5 sunglasses',
    '5 monitors instead of 3',
    'make it 5 decoders',
    'no, she paid 60k not 50k',
    'make it 5 wigs',
  ])('%j clearly corrects', (text) => {
    expect(clearlyCorrects(text)).toBe(true);
  });

  it.each([
    'Sold 2 bags for 20k, not paid yet',
    'Bola bought 2 shoes, not delivered',
    'Ada bought 3 wigs for 150k',
    'Wait, I also sold 2 bags for 20k',
    'actually, sold 2 bags for 20k',
    'Not paid yet, sold 2 bags for 20k',
    'sorry, Bola bought 2 shoes',
    'Sold 2 bags for 20k not 2 days ago',
    'sold 5 bags, not 2 days late',
    'sold 3 bags at 10k each, not 2 paid',
    'Sold 2 bags for 20k not 2.5 days ago',
    /* "should be", "make it" or "change it to" without a figure says no replacement figure
     * (CodeRabbit on #437 at c712b1e). */
    'Sold 2 bags for 20k, not paid yet; should be delivered tomorrow',
    'Sold 2 bags for 20k, make it quick',
    'Bola bought 2 shoes, change it to Friday delivery',
    /* A figure that is a time, or wording inside a whole new sale, replaces nothing in the
     * waiting draft (owner review of #437 at 49f2586). */
    'Sold 2 bags for 20k, make it 5pm delivery.',
    'Sold 3 wigs for 90k, delivery should be 2pm.',
    'Sold 2 bags for 20k instead of going home.',
    'Sold 3 wigs for 90k; change it to 4pm delivery.',
    'make it 5pm',
    'should be 2 days',
    'change it to 4:30',
    'make it the 5th',
    'instead of going home',
    'Wait, also sold 3 wigs for 90k, make it 4',
    'I sold 2 bags for N20k rather than 3',
    'sold 2 bags at 10k, make it 3',
    /* A correction mixed with a new sale, and a currency the gate does not read: asked about. */
    'No, 4 not 3, and I also sold 2 bags for 20k',
    'No, 4 not 3. Sold 2 bags at 10k to someone else',
    /* A figure or comparison that changes no field of the draft (CodeRabbit on #437 at 49f2586). */
    'Sold 2 bags for 20k; deliver by bike rather than car',
    'deliver by bike rather than car',
    'No, delivery should be 2 days',
    'balance should be 10k by Friday',
    'make it 5 wigs and 2 bags for Bola',
    /* A whole new sale in any wording: the message must be only a correction (independent review
     * of #437 at b5079a8). */
    'Sold 5 bags, 10k each, total should be 50k',
    'Sold 3 wigs @ 30k each, should be 90k total',
    'Sold 3 wigs @30k, make it 4',
    'Sold 3 wigs 90k, delivery should be 25 Dec',
    'Order 3 wigs 90k, delivery should be 2 Dec',
    'New sale: 3 wigs at 30k, total should be 90k',
    'Sold 2 bags 20k, make it 5 tomorrow',
    'Sold 2 bags 20k. Balance should be 5k',
    'Sold 2 bags 20k, she paid 15k not 20k',
    'Sold 2 bags 20k, discount should be 10 percent',
    'Sold 2 bags at NGN20k, make it 3',
    'Sold 3 shoes\nprice 15k each\nshould be 45k',
    'Sold 2 bags. Total should be 40k.',
    'SOLD 2 BAGS 20K, SHOULD BE 25K',
    'Sold two bags for twenty thousand, make it 3',
    'Customer carry 2 bags 20k, should be 2',
    'Wait, sold 2 bags 20k instead of 3',
    'should be 12 noon',
    'make it 5 tomorrow',
    /* Adding to the draft, or another sale (independent review at 1184521). */
    'make it 5 more',
    '5 more instead of 3',
    '4 more not 3',
    'make it 5 extra',
    'make it 5 again',
    'make it 5 also',
    'make it 5 too',
    'make it 5 another',
    'the other should be 5k',
    'the new should be 5',
    'the order should be 5',
    /* Counting records or people, and a bare decimal that is a time (independent review at cffb6a5). */
    'make it 2 sales',
    'make it 2 orders',
    '2 customers not 3',
    'should be 2 invoices',
    '5 transactions instead of 3',
    'make it 2 separate',
    'should be 2 times',
    'make it 4.30',
    'should be 2.30',
    /* Seconds are a time too (CodeRabbit on #437 at cf96697). */
    'make it 5 seconds',
    'should be 30 secs',
    'Bola bought 2 shoes for 30k, should be 2',
    '   ',
  ])('%j does not', (text) => {
    expect(clearlyCorrects(text)).toBe(false);
  });

  /* Functional bounds only: a wall-clock budget belongs in no unit test (CodeRabbit on #437 at
   * 0e12742). A correction is a line of at most 80 characters, and anything longer is refused by
   * its length before the expression runs. */
  it.each([
    { text: `make it ${'1'.repeat(71)}k`, length: 80, corrects: true },
    { text: `${'no, '.repeat(18)}4 not 3.`, length: 80, corrects: true },
    { text: `${'no '.repeat(26)}xy`, length: 80, corrects: false },
    { text: `make it ${'1'.repeat(72)}k`, length: 81, corrects: false },
    { text: `${'no, '.repeat(18)}4 not 3.!`, length: 81, corrects: false },
    { text: `no, ${'1,'.repeat(2_000)}1 not 2`, length: 4_011, corrects: false },
  ])('a $length-character message is a correction: $corrects', ({ text, length, corrects }) => {
    expect(text).toHaveLength(length);
    expect(clearlyCorrects(text)).toBe(corrects);
  });

  it.each(['change the price to 60k', 'price should be 60k each', 'the delivery fee should be 2k'])(
    '%j is a correction to the outer gate too, so it reaches the CG5 checks',
    (text) => {
      expect(looksLikeCorrection(text, true)).toBe(true);
      expect(looksLikeCorrection(text, false)).toBe(false);
    },
  );
});

describe('a correction that names someone is never clear enough to inherit (OWN-100)', () => {
  /* "for <word>" may be a person or an item; asked about (CodeRabbit on #437 at ebeeadb). */
  it.each(['No, 4 for Ada, not 3', 'No, 4 for Tunde, not 3'])('%j is not clearlyCorrects', (t) => {
    expect(clearlyCorrects(t)).toBe(false);
  });

  const WIGS = ['wig'];
  it.each([
    'No, 4 not 3',
    'make it 4 wigs',
    '4 wigs instead of 3',
    'sorry, 60k each not 50k',
    'make it 4pcs',
    'make it N60k',
    'the price should be 50k',
    'change the delivery fee to 2k',
  ])('%j holds only words the sale explains', (t) => {
    expect(correctionWordsExplained(t, WIGS)).toBe(true);
  });

  it.each(['make it 5 Tunde', '4 Bola not 3', 'make it 5 shoes', 'no, 4 sunglasses not 3'])(
    '%j holds a word the sale does not, which may be a person',
    (t) => {
      expect(correctionWordsExplained(t, WIGS)).toBe(false);
    },
  );
  /* OD-63(a) Option B (owner ruling 22 Nov 2026): the bare item word never explains a correction,
   * since an item may be named like a person; its plural form still does. */
  it.each([
    ['4 Tunde not 3', ['Tunde']],
    ['make it 4 wig', ['wig']],
    ['make it 4 ankara', ['ankara']],
    ['make it 4 Price', ['Price']],
    ['make it 4 set', ['set']],
    /* A figure's thousands suffix is part of the figure (Codex on #437 at 5bbe9b8). */
    ['make it 4k Price', ['Price']],
    ['make it 4 k Price', ['Price']],
    ['make it ₦4,000k Set', ['Set']],
  ])('%j holds only the bare item word, so it is not explained', (t, items) => {
    expect(correctionWordsExplained(t, items)).toBe(false);
  });

  it.each([
    ['4 Tundes not 3', ['Tunde']],
    ['make it 4 wigs', ['wig']],
    ['make it 4 dresses', ['dress']],
    ['make it 4 pieces', ['Tunde']],
    ['make it 4 sets', ['set']],
    ['make it 4 kits', ['kit']],
    /* A grammatical word an item's name holds is still grammar outside the item-word position
     * (CodeRabbit on #437 at 9c587bd). */
    ['change the price to 60k', ['ready to wear']],
  ])('%j holds a plural or a unit, so it is explained', (t, items) => {
    expect(correctionWordsExplained(t, items)).toBe(true);
  });
});

/* OD-60 A+ (owner ruling 22 Nov 2026): a "not" that only states a new record's payment or delivery
 * is no correction cue, so an obvious new sale is not asked about. */
describe('a "not" about a new record is not a correction cue', () => {
  it.each([
    'Sold 2 bags for 20k, not paid yet',
    'sold 3 wigs to Bola for 30k not yet paid',
    'Bought 5 cartons for 50k, not delivered',
    'Sold 2 bags for 20k, not fully paid yet',
    'Sold 2 bags for 20k, not yet paid',
    /* The same state words opening the message (CodeRabbit on #437 at b2703e7). */
    'Not paid yet, bought fuel 5k',
    "It's not paid yet, bought fuel 5k",
    'it is not delivered yet, bought 5 cartons for 50k',
  ])('%j is a new record', (t) => {
    expect(looksLikeCorrection(t, true)).toBe(false);
  });

  it.each([
    'it is not paid, she paid 60k not 50k',
    'Bola has not paid 50k, he only paid 5k',
    'Bola has not yet paid 50k, he only paid 5k',
    'no, 4 not 3',
    'Wait, I also sold 2 bags for 20k',
  ])('%j still reads like a correction', (t) => {
    expect(looksLikeCorrection(t, true)).toBe(true);
  });
});

/* OD-60 A+ (owner ruling OWN-102(2)): an explicit correction goes on to the CG5 rules; a message whose
 * only cue is a hesitation is ambiguous and asked about. */
describe('an explicit correction against a hesitation', () => {
  it.each([
    'no, it was Bola not Ada',
    'No, Ada paid 150k not 180k',
    'sorry, 4 wigs for Ada not 3',
    'No, 4 for Ada, not 3',
    'correction: Bola bought it',
    'e no be Ada, na Bola',
    'Wait, it was 4 not 3',
    'Not paid 5k, it was 4k',
    'not Bola, Ada',
    '4 wigs instead of 3',
    'make it 5',
  ])('%j is explicit', (t) => {
    expect(explicitlyCorrects(t)).toBe(true);
  });

  it.each([
    'Wait, I also sold 2 bags for 20k',
    'wait, fuel 6k',
    'Actually, Bola bought 2 bags',
    'Sorry, I also sold 2 bags for 20k',
    'No, I also sold 2 bags',
    /* A correction phrase beside an adding word is as likely a second record: asked about, and
     * nothing is superseded (CodeRabbit on #437 at aff3f63). */
    'Wait, I also bought fuel for 6k, total should be 6k',
    'make it another 2 bags',
    /* A correction phrase inside a whole new record is no explicit correction (CodeRabbit on #437
     * at b2703e7). */
    'Sold 2 bags for 20k, total should be 20k',
  ])('%j is only a hesitation', (t) => {
    expect(looksLikeCorrection(t, true)).toBe(true);
    expect(explicitlyCorrects(t)).toBe(false);
  });
});

/* OD-67 Option B (owner ruling OWN-103(3), 22 Nov 2026): a figure the correction says was wrong must
 * be one the waiting draft holds, in its own sense, or the correction is asked about. */
describe('a replaced figure the waiting draft does not hold', () => {
  const sale = draftFigures({
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 100_000,
    discount: null,
    deliveryFee: null,
  });
  const fuel = draftFigures({ description: 'fuel', amount: 5_000 });
  const priced = draftFigures({ items: [{ name: 'oil', quantity: 2, unitPrice: 4.5 }] });
  const bought = draftFigures({ description: 'nails', amount: 50, quantity: 3 });

  it.each([
    ['No, 4 not 3', sale],
    ['4 wigs instead of 3', sale],
    ['sorry, 60k each not 50k', sale],
    ['no, it was 200k not 150k', sale],
    ['she paid 120k not 100k', sale],
    ['No, 4 pcs not 3 pcs', sale],
    ['no, 6k not 5k', fuel],
    ['no, ₦6,000 not ₦5,000', fuel],
    ['6000 not 5000', fuel],
    ['Not paid 5k, it was 4k', fuel],
    ['no, 5 not 4.50', priced],
    ['make it 5', sale],
    ['no, it was Bola not Ada', sale],
    ['No, it was 6k, not the 5k', fuel],
    ['No, 4 pcs not 3, amount 60 not 50', bought],
    ['amount 60 not 50', bought],
    /* The total as the preview rounds it (CodeRabbit on #437 at d80426e). */
    [
      'No, total should be ₦16.38 not ₦15.38',
      draftFigures({ items: [{ name: 'rice', quantity: 1.5, unitPrice: 10.25 }] }),
    ],
    ['no, 6k not 5k', draftFigures({ description: 'fuel', amount: 5_000 })],
    [
      'No, 2 kg not 1.5 kg',
      draftFigures({ items: [{ name: 'rice', quantity: 1.5, unitPrice: 1.5 }] }),
    ],
    /* A stock adjustment's count is one of its figures (Codex on #437 at af169b0). */
    ['No, 4 not 3', draftFigures({ productMention: 'wig', quantityDelta: 3 })],
    ['No, 4 not 3', draftFigures({ productMention: 'wig', quantityDelta: -3 })],
  ])('%j fits', (t, figures) => {
    expect(replacedFiguresFit(t, figures)).toBe(true);
  });

  it.each([
    ['4 not 3', fuel],
    ['No, 5 not 4', sale],
    ['no, 60k not 40k', sale],
    ['no, 6k not 3k', fuel],
    /* A quantity is never a price: 3 is no ₦3 here, and 50k no 50 wigs. */
    ['No, 4 pcs not 50 pcs', sale],
    ['no, ₦4 not ₦3', sale],
    ['6000 not 3000', fuel],
    ['no, 5 not 4.40', priced],
    /* A filler between "not" and the figure still names it (CodeRabbit on #437 at 4a5fd80). */
    ['No, it was 6k, not the 5k', draftFigures({ description: 'fuel', amount: 7_000 })],
    /* Each figure is read in its own clause: "amount" makes the second one money. */
    ['No, 4 pcs not 3, amount 60 not 3', bought],
    /* Two bare figures with nothing to say which is which are asked about. */
    ['No, 4 not 3, 60 not 50', bought],
    /* "1.5m" is ₦1.5 million, never ₦1.50; "1.5 kg" a weight, never ₦1.50 (CodeRabbit, d80426e). */
    ['No, it was 1.6m not 1.5m', draftFigures({ description: 'fuel', amount: 1.5 })],
    [
      'No, 2 kg not 1.5 kg',
      draftFigures({ items: [{ name: 'rice', quantity: 3, unitPrice: 1.5 }] }),
    ],
  ])('%j does not fit', (t, figures) => {
    expect(replacedFiguresFit(t, figures)).toBe(false);
  });
});

describe('a replaced figure and its replacement agree on what they are', () => {
  /* Five pieces at ₦3 each: 5 is a quantity and ₦3 a price the draft holds. */
  const fivePieces = draftFigures({ items: [{ name: 'wig', quantity: 5, unitPrice: 3 }] });
  const threePieces = draftFigures({ items: [{ name: 'wig', quantity: 3, unitPrice: 3 }] });

  it('refuses a count written in place of an amount (CodeRabbit on #437 at 6b3fc05)', () => {
    expect(replacedFiguresFit('No, 4 pc not ₦3', fivePieces)).toBe(false);
    expect(replacedFiguresFit('No, ₦4 not 3 pcs', threePieces)).toBe(false);
  });

  it('still accepts a pair of the same kind', () => {
    expect(replacedFiguresFit('No, 4 pcs not 3', threePieces)).toBe(true);
    expect(replacedFiguresFit('No, ₦4 not ₦3', fivePieces)).toBe(true);
  });
});

describe('corrections use displayed figures', () => {
  it('reads the balance a part-paid purchase preview shows (CodeRabbit on #437 at 600a155)', () => {
    const partPaid = draftFigures({
      intent: 'RecordPurchase',
      description: 'ankara fabric',
      amount: 50_000,
      reportedPayment: 20_000,
    });
    expect(replacedFiguresFit('No, balance should be 25k not 30k', partPaid)).toBe(true);
    expect(replacedFiguresFit('No, amount 60k not 50k', partPaid)).toBe(true);
    expect(replacedFiguresFit('No, balance should be 25k not 35k', partPaid)).toBe(false);
  });

  it('recognises a decimal million suffix in the inheritance check', () => {
    expect(correctionWordsExplained('change the price to 1.6m', ['wig'])).toBe(true);
    expect(correctionWordsExplained('1.6m Price not 1.5m', ['Price'])).toBe(false);
  });

  it('uses the stock arrival quantity for purchases and the original quantity for sales', () => {
    const purchase = draftFigures({
      intent: 'RecordPurchase',
      productMention: 'wig',
      quantity: 3.5,
      amount: 50_000,
    });
    expect(replacedFiguresFit('No, 4 pcs not 3', purchase)).toBe(true);
    expect(purchase.quantities).toEqual([3]);

    const sale = draftFigures({ intent: 'RecordSale', items: [{ quantity: 3.5, unitPrice: 50 }] });
    expect(sale.quantities).toEqual([3.5]);
  });
});

describe('CodeRabbit on #437 at 400ca58', () => {
  it('reads a decimal quantity with a unit as one figure, so the correction checks see it', () => {
    expect(clearlyCorrects('change the quantity to 2.5 kg')).toBe(true);
    expect(clearlyCorrects('make it 1.5 litres')).toBe(true);
    expect(clearlyCorrects('No, 2.5 kg not 2 kg')).toBe(true);
    expect(looksLikeCorrection('change the quantity to 2.5 kg', true)).toBe(true);
    /* A bare decimal is still a time, and a decimal before a word that is not a unit stays out. */
    expect(clearlyCorrects('make it 4.30')).toBe(false);
    expect(clearlyCorrects('make it 2.5 Tunde')).toBe(false);
  });

  it('reads the balance a part-paid sale preview shows', () => {
    const sale = draftFigures({
      intent: 'RecordSale',
      items: [{ name: 'generator', quantity: 1, unitPrice: 150_000 }],
      reportedPayment: 110_000,
    });
    expect(replacedFiguresFit('balance should be 35k not 40k', sale)).toBe(true);
    expect(replacedFiguresFit('balance should be 35k not 99k', sale)).toBe(false);
    /* Fully paid: no balance line is shown, so none is a figure the merchant saw. */
    const paid = draftFigures({
      intent: 'RecordSale',
      items: [{ name: 'generator', quantity: 1, unitPrice: 150_000 }],
      reportedPayment: 150_000,
    });
    expect(replacedFiguresFit('balance should be 5k not 0', paid)).toBe(false);
    /* A sale whose figures disagree is asked about (CG1), never shown with a balance. */
    const mismatched = draftFigures({
      intent: 'RecordSale',
      items: [{ name: 'generator', quantity: 1, unitPrice: 150_000 }],
      statedTotal: 100_000,
      reportedPayment: 60_000,
    });
    expect(replacedFiguresFit('balance should be 30k not 40k', mismatched)).toBe(false);
  });

  it('lets the field a correction names classify an unmarked decimal', () => {
    const rice = draftFigures({
      intent: 'RecordSale',
      items: [{ name: 'rice', quantity: 1.5, unitPrice: 2_000 }],
    });
    expect(replacedFiguresFit('No, quantity should be 2 not 1.5', rice)).toBe(true);
    /* An explicit currency still conflicts with the quantity field. */
    expect(replacedFiguresFit('No, quantity should be 2 not ₦1.50', rice)).toBe(false);
    /* With no field named, an unmarked decimal is still read as money. */
    expect(replacedFiguresFit('No, 2 not 1.5', rice)).toBe(false);
  });
});

/* CodeRabbit on #437 (PRRT_kwDOT845J8676qPN): the total a sale preview shows is the one
 * `computeMoney` returns, which rounds the unit price to the kobo first. 1.5 at ₦0.29 is ₦0.44
 * there, though quantity x price x 100 rounds to ₦0.43. A merchant correcting the displayed ₦0.44
 * must be told it was in the draft, whether or not anything was paid. Integer kobo throughout. */
describe('the sale total the preview shows is a figure of the draft', () => {
  const FRACTIONAL = {
    intent: 'RecordSale',
    items: [{ name: 'tape', quantity: 1.5, unitPrice: 0.29 }],
  };

  it.each([
    ['nothing paid', {}],
    ['part paid', { reportedPayment: 0.2 }],
    ['fully paid', { reportedPayment: 0.44 }],
  ])('includes the 44 kobo total when %s', (_, extra) => {
    const figures = draftFigures({ ...FRACTIONAL, ...extra });
    expect(figures.moneyKobo).toContain(44);
    expect(figures.moneyKobo.every(Number.isInteger)).toBe(true);
  });

  it('accepts a correction of the displayed total, and still refuses a figure never shown', () => {
    const figures = draftFigures(FRACTIONAL);
    expect(figures.moneyKobo).toContain(44);
    expect(figures.moneyKobo).not.toContain(45);
  });

  /* A CG1 question shows both totals when the stated one disagrees with the lines. */
  it('includes the computed total beside a stated total that disagrees', () => {
    /* 1.5 at ₦1,000.29 is ₦1,500.44 by `computeMoney` (₦1,500.43 by the gross rebuilt line by line);
     * a stated ₦100 is far outside the ₦50 tolerance, so the question shows ₦1,500.44 and ₦100. */
    const figures = draftFigures({
      intent: 'RecordSale',
      items: [{ name: 'tape', quantity: 1.5, unitPrice: 1000.29 }],
      statedTotal: 100,
    });
    expect(figures.moneyKobo).toEqual(expect.arrayContaining([150_044, 10_000]));
  });

  it('carries a discount and a delivery fee into the shown total', () => {
    const figures = draftFigures({
      intent: 'RecordSale',
      items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
      discount: 10_000,
      deliveryFee: 2_000,
    });
    expect(figures.moneyKobo).toContain(14_200_000);
  });
});

/* CodeRabbit on #437 at 1ec5a22: only figures a sale preview DISPLAYS are draft figures. A stated
 * total within tolerance is what the preview shows, never the lines' sum it was compared with; an
 * overpayment the preview shows ("Paid over by") is one. */
describe('a sale preview shows only these aggregates', () => {
  const LINES = {
    intent: 'RecordSale',
    items: [
      { name: 'wig', quantity: 1, unitPrice: 10_000 },
      { name: 'weave', quantity: 1, unitPrice: 20_000 },
    ],
  };

  it('keeps the stated total and the line totals, never the undisplayed sum', () => {
    const figures = draftFigures({ ...LINES, statedTotal: 29_900 });
    expect(figures.moneyKobo).toEqual(expect.arrayContaining([2_990_000, 1_000_000, 2_000_000]));
    expect(figures.moneyKobo).not.toContain(3_000_000);
  });

  it('includes a displayed overpayment, and no overpayment when none was shown', () => {
    /* Paid ₦45,000 on ₦30,000: "Paid over by ₦15,000". */
    const over = draftFigures({ ...LINES, statedTotal: 30_000, reportedPayment: 45_000 });
    expect(over.moneyKobo).toContain(1_500_000);
    const exact = draftFigures({ ...LINES, statedTotal: 30_000, reportedPayment: 30_000 });
    expect(exact.moneyKobo).not.toContain(1_500_000);
  });
});

/* OD-76 Option A (owner ruling OWN-107): a correction may change only the figures it names. */
describe('unnamedFiguresChanged', () => {
  const sale = {
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    reportedPayment: 100_000,
  };
  const four = { ...sale, items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }] };

  it.each([
    ['No, 4 not 3', four, false],
    ['No, 4 not 3', { ...four, reportedPayment: 0 }, true],
    ['No, 4 not 3', { ...four, items: [{ name: 'wig', quantity: 4, unitPrice: 40_000 }] }, true],
    ['No, 4 not 3', { ...four, discount: 5_000 }, true],
    ['she paid 120k not 100k', { ...sale, reportedPayment: 120_000 }, false],
    [
      'no, 40k each not 50k',
      { ...sale, items: [{ name: 'wig', quantity: 3, unitPrice: 40_000 }] },
      false,
    ],
  ] as const)('%s, reading %j: %s', (text, reading, expected) => {
    expect(unnamedFiguresChanged(text, sale, reading)).toBe(expected);
  });

  /* Codex on #437 at 0bf9298: a stated total must follow from the corrected lines, and a line the
   * reading renames (or recases) is still checked, never exempted. */
  it.each([
    ['an unnamed stated total that does not follow', { ...four, statedTotal: 199_000 }, true],
    ['a stated total that follows from the lines', { ...four, statedTotal: 200_000 }, false],
    [
      'a recased item at a new price',
      { ...four, items: [{ name: 'Wig', quantity: 4, unitPrice: 40_000 }] },
      true,
    ],
    [
      'a recased item at the same price',
      { ...four, items: [{ name: 'Wig ', quantity: 4, unitPrice: 50_000 }] },
      false,
    ],
    [
      'a renamed only line at a new price',
      { ...four, items: [{ name: 'weave', quantity: 4, unitPrice: 40_000 }] },
      true,
    ],
    ['a dropped priced line', { ...four, items: [] }, true],
  ] as const)('%s', (_, reading, expected) => {
    expect(unnamedFiguresChanged('No, 4 not 3', { ...sale, statedTotal: 150_000 }, reading)).toBe(
      expected,
    );
  });

  it('judges an expense amount the same way', () => {
    const fuel = { description: 'fuel', amount: 5_000 };
    expect(unnamedFiguresChanged('no, 6k not 5k', fuel, { ...fuel, amount: 6_000 })).toBe(false);
    expect(
      unnamedFiguresChanged('it was diesel, not petrol', fuel, { ...fuel, amount: 6_000 }),
    ).toBe(true);
  });
});
