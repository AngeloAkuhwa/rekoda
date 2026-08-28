/**
 * The away assistant's ANSWER, composed deterministically (spec §3.2,
 * Appendix D; W4, PR-090).
 *
 * The assistant answers when the merchant cannot, within configured
 * limits — and V1's answer is the one class of question a shop's own rows
 * can answer without judgement: what something costs and whether it is on
 * the shelf. No model sits in this path, on purpose: a customer's message
 * is a conversation, never an instruction (spec §3.1 MUST NOT), and the
 * one thing worse than no answer is a fluent guess about the merchant's
 * prices. What this file cannot answer it declines to answer, returning
 * null — the handoff (PR-091) is the caller's next move, not a worse
 * sentence from here.
 *
 * The assistant holds NO command surface: it composes text, and text only.
 * Appendix D's absolute rule — never HIGH_RISK, no history parameter to
 * soften it — is enforced in the risk layer (PR-017a); this design simply
 * has nothing to enforce it against, which is the strongest form of the
 * guarantee.
 */
import { formatKobo } from './money.js';

export interface ShelfItem {
  name: string;
  unitPriceK: number;
  /** What the counted shelf holds; null when the product is uncounted (a service). */
  onHand: number | null;
}

/** How many products one answer may name: more is a catalogue, not a reply. */
export const ASSISTANT_MAX_ITEMS = 3;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The products a customer's message actually names, by whole-word match on
 * the merchant's own product names. Case folds; two-character names are
 * ignored because they match everything ("GB" inside "digba"). Order is
 * the shelf's, not the message's, so the answer is stable.
 */
export function shelfMatches<T extends { name: string }>(
  text: string,
  products: readonly T[],
): T[] {
  const matched: T[] = [];
  for (const product of products) {
    const name = product.name.trim();
    if (name.length < 3) continue;
    const pattern = new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?:$|[^\\p{L}\\p{N}])`,
      'iu',
    );
    if (pattern.test(text)) matched.push(product);
  }
  return matched.slice(0, ASSISTANT_MAX_ITEMS);
}

/**
 * The answer itself: price from the merchant's own row, availability only
 * where the shelf is COUNTED — an uncounted product is a service, and a
 * service does not run out. Null when nothing was asked that the shelf can
 * answer, which is the honest "not my question" the handoff needs.
 */
export function composeShelfAnswer(items: readonly ShelfItem[]): string | null {
  if (items.length === 0) return null;
  const lines = items.map((item) => {
    if (item.onHand !== null && item.onHand <= 0) {
      return `${item.name} is out of stock right now.`;
    }
    const stocked = item.onHand !== null ? ' In stock.' : '';
    return `${item.name}: ${formatKobo(item.unitPriceK)}.${stocked}`;
  });
  return lines.join('\n');
}
