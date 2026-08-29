/**
 * Deterministic comparison of two independent document extractions
 * (AI hardening item 9, docs/ai-model-strategy.md §6).
 *
 * Two models read the same document; this file decides whether they read
 * the same THING. It is deliberately dumb: numbers must match exactly —
 * the directive forbids fuzzy tolerance on monetary amounts, and a
 * comparison that forgives ₦500 on a ₦500,000 invoice has already decided
 * which model to believe — and strings match after formatting
 * normalisation only (case, whitespace), never semantically. No model is
 * consulted about the disagreement, because a third opinion does not
 * manufacture certainty, it manufactures a majority.
 */

/**
 * The paths where two extractions disagree, in document order.
 *
 * Empty means the readings agree on every field either produced. Compared
 * canonically: numbers exactly; strings after trim/lowercase/whitespace
 * collapse; null and undefined as the same absence; arrays index by index
 * with a length mismatch charged to the array's own path.
 */
export function divergentFields(a: unknown, b: unknown): string[] {
  const paths: string[] = [];
  walk(a, b, '', paths);
  return paths;
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null && right === null) return;
  if (left === null || right === null) {
    out.push(path || '(root)');
    return;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    // EXACT. ₦499,900 is not ₦500,000, and 2 wigs are not 3.
    if (left !== right) out.push(path);
    return;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (normalise(left) !== normalise(right)) out.push(path);
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      out.push(path);
      return;
    }
    left.forEach((item, i) => walk(item, right[i], `${path}.${i}`, out));
    return;
  }
  if (
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const keys = new Set([
      ...Object.keys(left as Record<string, unknown>),
      ...Object.keys(right as Record<string, unknown>),
    ]);
    for (const key of keys) {
      walk(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        out,
      );
    }
    return;
  }
  // Different types entirely (a number where the other read a string).
  out.push(path || '(root)');
}

/** Formatting differences are not disagreements; anything else is. */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A command's monetary magnitude in KOBO, for the dual-extraction
 * threshold (`AI_DUAL_EXTRACT_THRESHOLD_K`).
 *
 * The MAX of every money-typed field the command carries, plus each line's
 * quantity × unitPrice, converted from the contract's naira to the
 * threshold's kobo. Max rather than sum, because the question is "is this
 * document big enough to read twice", and a total of ₦600,000 answers yes
 * whatever the part-payment beside it says. Field names, not a generic
 * numeric walk: a quantity of 600,000 sachets is not ₦600,000.
 */
const MONEY_FIELDS = new Set([
  'statedTotal',
  'reportedPayment',
  'amount',
  'unitPrice',
  'discount',
  'deliveryFee',
]);

export function commandValueK(command: unknown): number {
  let maxNaira = 0;

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;

    for (const [key, value] of Object.entries(record)) {
      if (MONEY_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
        maxNaira = Math.max(maxNaira, value);
      }
      visit(value);
    }
    // A line's real weight is its extended total, not its unit price.
    const quantity = record['quantity'];
    const unitPrice = record['unitPrice'];
    if (typeof quantity === 'number' && typeof unitPrice === 'number') {
      maxNaira = Math.max(maxNaira, quantity * unitPrice);
    }
  };

  visit(command);
  return Math.round(maxNaira * 100);
}
