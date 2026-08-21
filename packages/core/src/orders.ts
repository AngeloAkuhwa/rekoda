/**
 * An order somebody else placed (MASTER-PLAN §5.3.5, "Door 2").
 *
 * A customer messages the merchant asking for things. The merchant forwards
 * that message to Rekoda. What arrives is a request in a stranger's words:
 * names of goods and how many, and no money at all.
 *
 * ── why the model never names a price here ─────────────────────────────────
 *
 * Everywhere else in Rekoda an amount from the model is TESTIMONY: what the
 * merchant said, reported so the arithmetic can disagree with it out loud. A
 * forwarded order has no such testimony to report. The person who wrote the
 * message is not the person who sets the prices, and anything they said about
 * money is a hope rather than a quote. So the command carries names and
 * quantities, and every figure below comes from the merchant's own catalogue.
 *
 * That makes an unpriced product a QUESTION rather than a guess. A shop whose
 * head ties have no price cannot be quoted for head ties, and inventing one
 * would put a number on a document that the merchant never agreed to.
 */
import { formatKobo } from './money.js';

/** One line as the forwarded message asked for it. No money, by construction. */
export interface RequestedLine {
  readonly name: string;
  readonly quantity: number;
}

/** A product the merchant sells, as the catalogue knows it. */
export interface PricedProduct {
  readonly id: string;
  readonly name: string;
  /** Null when the merchant has never set one. That is a question, not a zero. */
  readonly unitPriceK: number | null;
  readonly active: boolean;
}

export interface PricedLine {
  readonly productId: string;
  /** The catalogue's name, not the customer's wording, so the document is the shop's. */
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceK: number;
  readonly lineTotalK: number;
}

export interface PricedOrder {
  readonly lines: readonly PricedLine[];
  /** Asked for by name, and the shop has no such product. */
  readonly unknown: readonly string[];
  /** The shop HAS it and has never priced it. A different problem, said differently. */
  readonly unpriced: readonly string[];
  readonly totalK: number;
}

/** Case and spacing folded, exactly as `productByName` folds them in SQL. */
function fold(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Turn a forwarded request into money the merchant's own catalogue supports.
 *
 * Matching is exact after folding, deliberately not fuzzy, for the reason the
 * stock lookup gives: "rice" and "bags of rice" are one product in some shops
 * and two in others, and a matcher that guessed would quote a customer for
 * something nobody meant. An unmatched name comes back as a question.
 *
 * A HIDDEN product still prices. Taking something out of the shop stops
 * Rekoda advertising it; it does not stop a customer who already knows about
 * it from asking, and refusing to quote a merchant's own goods because of a
 * listing flag would be the flag deciding what the shop sells.
 *
 * Quantities are summed when the same product is asked for twice, because a
 * message saying "2 bales and another bale" wants three bales on one line,
 * not two lines a merchant has to add up.
 */
export function priceOrder(
  requested: readonly RequestedLine[],
  catalogue: readonly PricedProduct[],
): PricedOrder {
  const byName = new Map<string, PricedProduct>();
  for (const product of catalogue) byName.set(fold(product.name), product);

  const lines = new Map<string, PricedLine>();
  const unknown: string[] = [];
  const unpriced: string[] = [];

  for (const line of requested) {
    const product = byName.get(fold(line.name));
    if (!product) {
      if (!unknown.includes(line.name)) unknown.push(line.name);
      continue;
    }
    if (product.unitPriceK === null) {
      if (!unpriced.includes(product.name)) unpriced.push(product.name);
      continue;
    }

    const quantity = Math.trunc(line.quantity);
    /* A fraction of a bale is not an order, it is a parse that went wrong,
     * and the same rule already guards the sale path's stock movements. */
    if (quantity < 1) {
      if (!unknown.includes(line.name)) unknown.push(line.name);
      continue;
    }

    const existing = lines.get(product.id);
    const total = (existing?.quantity ?? 0) + quantity;
    lines.set(product.id, {
      productId: product.id,
      name: product.name,
      quantity: total,
      unitPriceK: product.unitPriceK,
      lineTotalK: product.unitPriceK * total,
    });
  }

  const priced = [...lines.values()];
  return {
    lines: priced,
    unknown,
    unpriced,
    totalK: priced.reduce((sum, line) => sum + line.lineTotalK, 0),
  };
}

/**
 * What to ask when an order cannot be quoted as it stands.
 *
 * One question, like every other refusal in the product: a merchant on a
 * phone in a busy shop answers one and abandons a list. The unpriced case
 * comes first because it is the one they can fix in a sentence.
 */
export function orderQuestion(order: PricedOrder): string | null {
  if (order.unpriced.length > 0) {
    const names = list(order.unpriced);
    return (
      `I do not have a price for ${names}. ` +
      `Tell me what to charge and I will quote the whole order.`
    );
  }
  if (order.unknown.length > 0) {
    const names = list(order.unknown);
    return (
      `I cannot find ${names} in what you sell. ` +
      `Tell me the price and I will add it, or say what they meant instead.`
    );
  }
  if (order.lines.length === 0) {
    return 'I could not find anything to quote in that. What are they asking for?';
  }
  return null;
}

/**
 * The preview, in the order a Nigerian receipt reads.
 *
 * It says "quote", never "sale". Nothing has been bought: the customer asked,
 * the merchant is about to answer, and a preview that called it a sale would
 * be teaching them that a request and a purchase look the same.
 */
export function orderPreview(order: PricedOrder, note: string | null): string {
  const lines: string[] = ['This is what they are asking for:', ''];

  for (const line of order.lines) {
    lines.push(`${line.quantity} × ${line.name} at ${formatKobo(line.unitPriceK)}`);
  }
  lines.push(`*Total: ${formatKobo(order.totalK)}*`);

  /* Echoed once and never stored. A delivery address is the customer's, it is
   * already on the merchant's phone in the message they forwarded, and
   * keeping a copy would be a liability with no bookkeeping purpose. */
  if (note) lines.push('', `They also said: ${note}`);

  lines.push('', 'Reply *yes* to raise the invoice, or tell me what to change.');
  return lines.join('\n');
}

/** `a`, `a and b`, `a, b and c`. What a person would say out loud. */
function list(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
