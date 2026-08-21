/**
 * What kind of expense this was.
 *
 * `expenses.category` has existed since the spend slice as free text: the
 * model writes whatever word it likes, and nothing reads it except the
 * `'stock'` marker that separates a purchase from an expense. The result is
 * a profit and loss statement with one undifferentiated "Operating Expenses"
 * line, which is the difference between a book and a bill.
 *
 * QuickBooks and HelloBooks both break that line out, and an accountant
 * reading a Rekoda statement expects to see where the money went. So the
 * category becomes a fixed set, and the mapping into it is DETERMINISTIC.
 *
 * ── why the model does not decide this ─────────────────────────────────────
 *
 * The model still writes a free-text category, and it is still useful: it is
 * a hint from something that read the whole sentence. But the folding happens
 * here, for the same reason the money engine recomputes every total. A
 * category is what a merchant's P&L is grouped by; if the model picks the
 * word, then "Fuel", "fuel", "petrol" and "generator" are four lines in a
 * statement that should have one, and next month's prompt version silently
 * regroups a year of history.
 *
 * Folding here also covers the case the model never spoke to: most expenses
 * arrive with no category at all, and the description alone is enough to
 * place them.
 */

/**
 * The set, in the order a Nigerian small business meets them.
 *
 * Deliberately ten and deliberately not extensible by a merchant. A fixed
 * chart is what makes one business's statement comparable to another's, and
 * a free-form category list is how a small business ends up with "Fuel",
 * "fuel " and "Feul" as three expense accounts. `'other'` is the honest
 * catch: it means "not classified", never "miscellaneous small things".
 */
export const EXPENSE_CATEGORIES = [
  'rent',
  'salaries',
  'transport',
  'power',
  'supplies',
  'marketing',
  'fees',
  'repairs',
  'professional',
  'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * What each one is called on a statement.
 *
 * Standard-sounding rather than chatty, because these are the words on a
 * document a bank or an accountant reads. The screen may be conversational;
 * a profit and loss statement is not.
 */
export const EXPENSE_CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = {
  rent: 'Rent',
  salaries: 'Salaries and wages',
  transport: 'Transport and delivery',
  power: 'Power and fuel',
  supplies: 'Supplies and packaging',
  marketing: 'Marketing',
  fees: 'Bank charges and fees',
  repairs: 'Repairs and maintenance',
  professional: 'Professional fees',
  other: 'Other expenses',
};

/**
 * The marker `recordPurchase` writes, which is NOT one of the above.
 *
 * Stock is not an operating expense: it debits INVENTORY and only reaches the
 * profit and loss as cost of goods sold when it is sold. It shares the column
 * because it shares the table, so it is named here to keep the two meanings
 * from being confused by anything that reads `category`.
 */
export const STOCK_CATEGORY = 'stock';

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return typeof value === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Word-boundary patterns, most specific first.
 *
 * Order is load-bearing: "electrician" is a repair and "electricity" is
 * power, "sms alert" is a bank charge and "alert" alone is nothing. Every
 * pattern is anchored on word boundaries because substring matching turns
 * "gen" into "general", "genuine" and "agent".
 */
const RULES: ReadonlyArray<readonly [ExpenseCategory, RegExp]> = [
  /* Before power, so "electrician" does not read as electricity, and before
     transport, so "bike repair" is a repair rather than a bike. */
  [
    'repairs',
    /\b(repair|repairs|repaired|fixing|fix(ed)?|maintenance|servicing|mechanic|plumber|electrician|welder|carpenter|spare\s*parts?)\b/,
  ],
  [
    'rent',
    /\b(rent|rents|rental|lease|leased|shop\s*fee|service\s*charge|caution\s*fee|landlord)\b/,
  ],
  [
    'salaries',
    /\b(salary|salaries|wage|wages|staff|worker|workers|apprentice|payroll|stipend|sales\s*(girl|boy))\b/,
  ],
  [
    'power',
    /\b(nepa|phcn|electric(ity|al)?|power|light\s*bill|prepaid\s*meter|meter\s*token|units|generator|gen\s*set|genset|diesel|ago|petrol|kerosene|fuel)\b/,
  ],
  [
    'transport',
    /\b(transport|transportation|fare|bus|okada|keke|danfo|taxi|uber|bolt|dispatch|rider|delivery|deliveries|logistics|courier|waybill|haulage|freight|shipping)\b/,
  ],
  [
    'supplies',
    /\b(nylon|cellophane|packaging|package|carton|cartons|sticker|stickers|label|labels|stationery|printing|photocopy|paper|consumables|cleaning|detergent|broom)\b/,
  ],
  [
    'marketing',
    /\b(advert|adverts|advertising|ads?|promo|promotion|influencer|boost(ed|ing)?|flyer|flyers|banner|billboard|marketing|sponsored)\b/,
  ],
  [
    'fees',
    /\b(bank\s*charge|charges?|sms\s*alert|stamp\s*duty|transfer\s*fee|levy|levies|due|dues|ticket|permit|licence|license|council|association|union|commission|interest|penalt(y|ies)|fine)\b/,
  ],
  [
    'professional',
    /\b(accountant|accounting|auditor|audit|lawyer|legal|solicitor|consultant|consultancy|professional\s*fee|bookkeep(er|ing))\b/,
  ],
];

/**
 * Which category this expense belongs to.
 *
 * The model's word is tried first and the merchant's own description second,
 * because the model has already read the whole message and its category is
 * usually a summary of it; the description is the fallback, and it is the
 * only signal on the many expenses that arrive with no category at all.
 *
 * Never returns `'stock'`. Purchases do not come through here.
 */
export function categoriseExpense(input: {
  description: string;
  category?: string | null;
}): ExpenseCategory {
  /* An already-valid category passes through untouched, so re-running this
   * over rows it has already classified cannot change them. */
  if (isExpenseCategory(input.category)) return input.category;
  return match(input.category ?? '') ?? match(input.description) ?? 'other';
}

function match(text: string): ExpenseCategory | null {
  const haystack = text.toLowerCase();
  for (const [category, pattern] of RULES) if (pattern.test(haystack)) return category;
  return null;
}
