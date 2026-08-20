/**
 * Amounts in words (MASTER-PLAN §5.3.6).
 *
 * Not decoration. A figure written twice — once in digits, once in words — is
 * how a document survives a smudged fax, a bad photocopy and a dispute, and it
 * is what Nigerian invoices and receipts have always carried. It is also the
 * line a bank teller reads when a merchant takes a receipt to the counter.
 *
 * Conventions here are Nigerian and deliberate:
 *
 *   - "and" before the final group under a hundred: One Hundred **and** Fifty
 *   - kobo written as kobo, not as a decimal
 *   - "Only" at the end, which is what stops a number being extended by hand
 *   - Title Case, because that is how it appears on every invoice in the market
 */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];

const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** Short scale, as used in Nigeria. */
const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];

/** 0–999 in words. Returns '' for zero, so callers can skip empty groups. */
function underThousand(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)]!;
    const ones = ONES[n % 10]!;
    return ones ? `${tens}-${ones}` : tens;
  }
  const hundreds = `${ONES[Math.floor(n / 100)]!} Hundred`;
  const rest = n % 100;
  // "and" before the last group: One Hundred and Fifty, not One Hundred Fifty.
  return rest ? `${hundreds} and ${underThousand(rest)}` : hundreds;
}

/** A whole number in words. */
export function numberToWords(value: number): string {
  if (!Number.isFinite(value)) throw new Error('numberToWords: not a finite number');
  const n = Math.floor(Math.abs(value));
  if (n === 0) return 'Zero';

  const groups: string[] = [];
  let remaining = n;
  let scale = 0;

  while (remaining > 0) {
    const group = remaining % 1000;
    if (group > 0) {
      const scaleName = SCALES[scale];
      if (scaleName === undefined) throw new Error('numberToWords: value is too large');
      groups.unshift(scaleName ? `${underThousand(group)} ${scaleName}` : underThousand(group));
    }
    remaining = Math.floor(remaining / 1000);
    scale++;
  }

  /**
   * "and" before a final group under a hundred, and only then. One Million and
   * Fifty reads correctly; One Million and Two Thousand does not, and neither
   * does One Thousand and One Hundred.
   */
  const tail = n % 1000;
  if (groups.length > 1 && tail > 0 && tail < 100) {
    const last = groups.pop()!;
    return `${groups.join(' ')} and ${last}`;
  }
  return groups.join(' ');
}

/**
 * Integer kobo as it appears on a document.
 *
 *   15_000_000 → "One Hundred and Fifty Thousand Naira Only"
 *    1_005_050 → "Ten Thousand and Fifty Naira, Fifty Kobo Only"
 *
 * "Only" terminates the line so nobody can add a word to it. A negative amount
 * is written as a negative rather than silently made positive — a credit note
 * is a real document and hiding its sign would be the wrong kind of tidy.
 */
export function nairaInWords(kobo: number): string {
  if (!Number.isInteger(kobo)) throw new Error('nairaInWords: kobo must be an integer');

  const negative = kobo < 0;
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100);
  const minor = abs % 100;

  const parts: string[] = [`${numberToWords(naira)} Naira`];
  // Kobo as kobo, not as a decimal. A document that says "Fifty Naira point
  // five zero" is a document written by a computer.
  if (minor > 0) parts.push(`${numberToWords(minor)} Kobo`);

  const words = `${parts.join(', ')} Only`;
  return negative ? `Minus ${words}` : words;
}
