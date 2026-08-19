/**
 * Amounts in words (MASTER-PLAN §5.3.6).
 *
 * A figure written twice — digits and words — is how a document survives a
 * smudged photocopy and a dispute, and it is the line a bank teller reads.
 * Getting "and" in the wrong place makes a document look machine-written,
 * which is exactly the impression a merchant's invoice cannot afford.
 */
import { describe, expect, it } from 'vitest';
import { nairaInWords, numberToWords } from './words.js';

describe('whole numbers', () => {
  it.each([
    [0, 'Zero'],
    [1, 'One'],
    [15, 'Fifteen'],
    [20, 'Twenty'],
    [21, 'Twenty-One'],
    [99, 'Ninety-Nine'],
    [100, 'One Hundred'],
  ])('%i → %s', (n, words) => {
    expect(numberToWords(n)).toBe(words);
  });

  it('puts "and" before a final group under a hundred', () => {
    // One Hundred and Fifty, not One Hundred Fifty. The American form reads
    // as a machine on a Nigerian invoice.
    expect(numberToWords(150)).toBe('One Hundred and Fifty');
    expect(numberToWords(1_050)).toBe('One Thousand and Fifty');
    expect(numberToWords(1_000_050)).toBe('One Million and Fifty');
  });

  it('does NOT put "and" before a group of a hundred or more', () => {
    // "One Thousand and One Hundred" is wrong; "One Thousand One Hundred" is
    // not. The rule is about the final group's size, not its position.
    expect(numberToWords(1_100)).toBe('One Thousand One Hundred');
    expect(numberToWords(1_500)).toBe('One Thousand Five Hundred');
    expect(numberToWords(2_000_000)).toBe('Two Million');
  });

  it('handles the scale a Nigerian merchant actually reaches', () => {
    expect(numberToWords(150_000)).toBe('One Hundred and Fifty Thousand');
    expect(numberToWords(4_500_000)).toBe('Four Million Five Hundred Thousand');
    expect(numberToWords(1_234_567)).toBe(
      'One Million Two Hundred and Thirty-Four Thousand Five Hundred and Sixty-Seven',
    );
  });

  it('skips empty groups instead of saying "Zero Thousand"', () => {
    expect(numberToWords(1_000_001)).toBe('One Million and One');
    expect(numberToWords(1_000_000)).toBe('One Million');
  });
});

describe('naira on a document', () => {
  it('writes the plan`s own example', () => {
    // "Ada bought 3 wigs for 150k" — the line that appears on her invoice.
    expect(nairaInWords(15_000_000)).toBe('One Hundred and Fifty Thousand Naira Only');
  });

  it('ends with "Only", which is what stops a number being extended by hand', () => {
    expect(nairaInWords(5_000)).toMatch(/ Only$/);
    expect(nairaInWords(0)).toBe('Zero Naira Only');
  });

  it('writes kobo as kobo, not as a decimal', () => {
    // "Fifty Naira point five zero" is a document written by a computer.
    expect(nairaInWords(5_050)).toBe('Fifty Naira, Fifty Kobo Only');
    expect(nairaInWords(1_005_050)).toBe('Ten Thousand and Fifty Naira, Fifty Kobo Only');
  });

  it('omits the kobo clause entirely when there is none', () => {
    expect(nairaInWords(15_000_000)).not.toMatch(/Kobo/);
  });

  it('keeps a negative negative rather than tidying the sign away', () => {
    // A credit note is a real document; hiding its sign is the wrong kind of
    // tidy, and the words are what a reader trusts over the digits.
    expect(nairaInWords(-5_000)).toBe('Minus Fifty Naira Only');
  });

  it('refuses a fractional kobo instead of rounding one silently', () => {
    // Every amount in this system is integer kobo by construction. A float
    // arriving here means something upstream stopped being exact.
    expect(() => nairaInWords(50.5)).toThrow(/integer/);
  });

  it('agrees with the digits on a large sale', () => {
    // ₦4,500,000 — a generator, a bulk order. Read aloud it must match.
    expect(nairaInWords(450_000_000)).toBe('Four Million Five Hundred Thousand Naira Only');
  });
});
