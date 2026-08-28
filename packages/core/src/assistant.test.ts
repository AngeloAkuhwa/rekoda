import { describe, expect, it } from 'vitest';
import { ASSISTANT_MAX_ITEMS, composeShelfAnswer, shelfMatches } from './assistant.js';

const SHELF = [
  { name: 'wig' },
  { name: 'lace frontal' },
  { name: 'gel' },
  { name: 'GB' }, // Two characters: never matched, it lives inside too many words.
];

describe('what the message names', () => {
  it('matches a product by whole word, case folded', () => {
    expect(shelfMatches('How much is the WIG?', SHELF).map((p) => p.name)).toEqual(['wig']);
  });

  it('matches a multi-word name', () => {
    expect(shelfMatches('do you have lace frontal in stock', SHELF).map((p) => p.name)).toEqual([
      'lace frontal',
    ]);
  });

  it('does not match a name inside another word', () => {
    /* "wiggle" contains "wig"; answering would be a guess about a word the
     * customer never said. */
    expect(shelfMatches('the wiggle dance', SHELF)).toEqual([]);
  });

  it('ignores names too short to mean anything', () => {
    expect(shelfMatches('2 GB of data', SHELF)).toEqual([]);
  });

  it('never names more products than a reply can carry', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `item${i}` }));
    const ask = many.map((p) => p.name).join(' and ');
    expect(shelfMatches(ask, many)).toHaveLength(ASSISTANT_MAX_ITEMS);
  });

  it('escapes regex metacharacters in product names', () => {
    const shelf = [{ name: 'wig (deluxe)' }];
    expect(shelfMatches('price of wig (deluxe) please', shelf)).toHaveLength(1);
  });
});

describe('the answer', () => {
  it('prices a counted product and says it is on the shelf', () => {
    expect(composeShelfAnswer([{ name: 'wig', unitPriceK: 150_000, onHand: 4 }])).toBe(
      'wig: ₦1,500. In stock.',
    );
  });

  it('says out of stock when the counted shelf is empty, without a price to tempt', () => {
    expect(composeShelfAnswer([{ name: 'wig', unitPriceK: 150_000, onHand: 0 }])).toBe(
      'wig is out of stock right now.',
    );
  });

  it('prices an uncounted product with no availability claim: a service does not run out', () => {
    expect(composeShelfAnswer([{ name: 'braiding', unitPriceK: 500_000, onHand: null }])).toBe(
      'braiding: ₦5,000.',
    );
  });

  it('answers several products on their own lines', () => {
    const answer = composeShelfAnswer([
      { name: 'wig', unitPriceK: 150_000, onHand: 4 },
      { name: 'gel', unitPriceK: 80_000, onHand: null },
    ]);
    expect(answer).toBe('wig: ₦1,500. In stock.\ngel: ₦800.');
  });

  it('declines to answer what nothing matched', () => {
    expect(composeShelfAnswer([])).toBeNull();
  });

  it('never uses an em or en dash, which no merchant types', () => {
    const answer = composeShelfAnswer([
      { name: 'wig', unitPriceK: 150_000, onHand: 0 },
      { name: 'gel', unitPriceK: 80_000, onHand: 2 },
    ]);
    expect(answer).not.toMatch(/[–—]/);
  });
});
