/**
 * The dataset's own integrity: the properties that must hold for every
 * case ANYONE adds, enforced here rather than in review (G-07).
 */
import { describe, expect, it } from 'vitest';
import { detectStructuralPii } from '@rekoda/core/privacy';
import {
  EVAL_BEHAVIOURS,
  EVAL_CASES,
  EVAL_CATEGORIES,
  EVAL_DATASET_VERSION,
  EVAL_REGISTERS,
  datasetFingerprint,
  registerOf,
  validateDataset,
  type EvalCase,
} from './dataset.js';

describe('the evaluation dataset', () => {
  it('passes its own integrity check', () => {
    expect(validateDataset(EVAL_CASES)).toEqual([]);
  });

  it('is version 2 and larger than the v1 set it extends', () => {
    expect(EVAL_DATASET_VERSION).toBe(2);
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(75);
  });

  it('is de-identified: no case carries structural PII', () => {
    /* The dataset is committed to the repository, so it must already be
     * what the interpreter sees AFTER the gateway: tokens, never a phone
     * number or account number. The same detector the interpreter fails
     * closed on guards the fixtures. */
    for (const evalCase of EVAL_CASES) {
      expect(detectStructuralPii(evalCase.input), evalCase.id).toEqual([]);
    }
  });

  it('covers every category, register and behaviour', () => {
    const categories = new Set(EVAL_CASES.map((c) => c.category));
    for (const category of EVAL_CATEGORIES) expect(categories.has(category), category).toBe(true);
    const registers = new Set(EVAL_CASES.map(registerOf));
    for (const register of EVAL_REGISTERS) expect(registers.has(register), register).toBe(true);
    const covered = new Set(EVAL_CASES.flatMap((c) => c.covers));
    for (const behaviour of EVAL_BEHAVIOURS) expect(covered.has(behaviour), behaviour).toBe(true);
  });

  it('pins the safety categories with real cases', () => {
    expect(EVAL_CASES.filter((c) => c.expect.kind === 'refusal').length).toBeGreaterThanOrEqual(4);
    expect(
      EVAL_CASES.filter((c) => c.expect.kind === 'clarification').length,
    ).toBeGreaterThanOrEqual(5);
  });
});

describe('the integrity check catches a broken dataset (G-07)', () => {
  const first = EVAL_CASES[0]!;
  const withCase = (evalCase: EvalCase) => [...EVAL_CASES, evalCase];

  it('a duplicate id', () => {
    expect(validateDataset(withCase({ ...first }))).toContain(`duplicate case id ${first.id}`);
  });

  it('a required category with no case', () => {
    const without = EVAL_CASES.filter((c) => c.category !== 'adversarial_injection');
    expect(validateDataset(without)).toContain('category adversarial_injection has no case');
  });

  it('a safety category with too few cases', () => {
    const without = EVAL_CASES.filter((c) => c.expect.kind !== 'refusal');
    expect(validateDataset(without).join('\n')).toContain('refusal cases: 0');
  });

  it('a malformed expectation', () => {
    const errors = validateDataset(
      withCase({
        ...first,
        id: 'broken',
        expect: { kind: 'command', intent: '', checks: { amount: Number.NaN } },
      }),
    );
    expect(errors).toContain('broken: command expectation without an intent');
    expect(errors).toContain('broken: amount is not a number');
    expect(
      validateDataset(
        withCase({ ...first, id: 'empty', expect: { kind: 'refusal', forbiddenNumbers: [] } }),
      ),
    ).toContain('empty: refusal forbids nothing');
  });

  it('an expected token the input never names', () => {
    expect(
      validateDataset(
        withCase({
          ...first,
          id: 'ghost',
          input: 'sold 2 wigs',
          expect: {
            kind: 'command',
            intent: 'RecordSale',
            checks: { customerToken: 'CUSTOMER_ZZQ' },
          },
        }),
      ),
    ).toContain('ghost: expected customer token is not in the input');
  });

  it('a one-line sale that does not pin its whole line, or a named window its words (Codex on #273)', () => {
    const errors = validateDataset(
      withCase({
        ...first,
        id: 'loose',
        input: 'sold 3 wigs 50k each',
        expect: { kind: 'command', intent: 'RecordSale', checks: { unitPrice: 50_000 } },
      }),
    );
    expect(errors).toContain('loose: a one-line sale names no product');
    expect(errors).toContain('loose: a one-line sale pins no quantity');
    expect(
      validateDataset(
        withCase({
          ...first,
          id: 'window',
          input: 'how much did I sell today',
          expect: {
            kind: 'command',
            intent: 'Query',
            checks: { topic: 'sales_summary', period: 'today' },
          },
        }),
      ),
    ).toContain('window: a named window pins no periodText');
  });

  it('every intent pins the fields that would corrupt the books (final review on #273)', () => {
    const errorsFor = (id: string, intent: string, checks: Record<string, unknown>) =>
      validateDataset(
        withCase({
          ...first,
          id,
          input: 'sold 3 wigs',
          expect: { kind: 'command', intent, checks } as EvalCase['expect'],
        }),
      );
    expect(
      errorsFor('sale', 'RecordSale', { product: 'wig', quantity: 3, unitPrice: 1_000 }),
    ).toEqual(
      expect.arrayContaining([
        'sale: a sale pins no payment state',
        'sale: a sale pins no payment method',
      ]),
    );
    expect(errorsFor('lines', 'RecordSale', { items: [], quantity: 1 })).toContain(
      'lines: a sale pins both items and quantity',
    );
    expect(errorsFor('pay', 'RecordPayment', { paymentMethod: 'cash' })).toEqual(
      expect.arrayContaining([
        'pay: a payment pins no amount',
        'pay: a payment pins no relativeAmount',
      ]),
    );
    expect(errorsFor('stock', 'RecordPurchase', { amount: 1, paymentMethod: null })).toContain(
      'stock: a purchase pins no quantity',
    );
    expect(
      errorsFor('count', 'RecordPurchase', {
        amount: 1,
        quantity: 5,
        paymentMethod: null,
        reportedPayment: null,
      }),
    ).toContain('count: a purchase counts stock it does not name');
    expect(errorsFor('typo', 'RecordSael', {})).toContain('typo: unknown intent RecordSael');
    expect(errorsFor('field', 'Query', { periodTxt: null })).toContain(
      'field: unknown check periodTxt',
    );
    expect(
      errorsFor('blank', 'RecordPurchase', {
        amount: 1,
        quantity: 2,
        product: ' ',
        paymentMethod: null,
        reportedPayment: null,
      }),
    ).toContain('blank: a blank product stem');
  });

  it('payments pin their invoice, purchases their supplier, sales and payments their customer (confirmation review on #273)', () => {
    const errorsFor = (id: string, intent: string, checks: Record<string, unknown>) =>
      validateDataset(
        withCase({
          ...first,
          id,
          input: 'sold 3 wigs',
          expect: { kind: 'command', intent, checks } as EvalCase['expect'],
        }),
      );
    expect(
      errorsFor('pay', 'RecordPayment', {
        amount: 1,
        relativeAmount: null,
        paymentMethod: 'cash',
        noCustomer: true,
      }),
    ).toContain('pay: a payment pins no documentRef');
    expect(
      errorsFor('buy', 'RecordPurchase', {
        amount: 1,
        quantity: null,
        reportedPayment: null,
        paymentMethod: null,
      }),
    ).toEqual(
      expect.arrayContaining([
        'buy: a purchase pins no supplier',
        'buy: a purchase pins no supplierReference',
      ]),
    );
    expect(
      errorsFor('who', 'RecordSale', {
        product: 'wig',
        quantity: 3,
        unitPrice: 1_000,
        unpaid: true,
        paymentMethod: 'unknown',
      }),
    ).toContain('who: a sale pins no customer');
    expect(errorsFor('owes', 'Query', { topic: 'customer_balance' })).toContain(
      'owes: a balance question pins no customer',
    );
  });

  it('a pinned value the contract does not allow, or a forbidden intent nobody has (per-file review)', () => {
    const typo = validateDataset(
      withCase({
        ...first,
        id: 'typo',
        input: 'sold 3 wigs',
        expect: {
          kind: 'command',
          intent: 'RecordPayment',
          checks: {
            amount: 1,
            relativeAmount: 'rest',
            paymentMethod: 'Cash',
            documentRef: null,
            noCustomer: true,
          },
        },
      }),
    );
    expect(typo).toEqual(
      expect.arrayContaining([
        'typo: paymentMethod Cash is not a value the contract allows',
        'typo: relativeAmount rest is not a value the contract allows',
      ]),
    );
    expect(
      validateDataset(
        withCase({
          ...first,
          id: 'action',
          expect: { kind: 'refusal', forbiddenNumbers: [5], forbiddenIntents: ['RecordPaymnet'] },
        }),
      ),
    ).toContain('action: unknown forbidden intent RecordPaymnet');
  });

  it('an expense must say what it is for (Codex on 30cb408)', () => {
    expect(
      validateDataset(
        withCase({
          ...first,
          id: 'spend',
          input: 'fuel 5k',
          expect: {
            kind: 'command',
            intent: 'RecordExpense',
            checks: { amount: 5_000, paymentMethod: 'unknown' },
          },
        }),
      ),
    ).toContain('spend: an expense pins no description');
  });

  it('expenses pin a category, purchases a description, orders and adjustments their lines (Codex on 4d26187)', () => {
    const errorsFor = (id: string, intent: string, checks: Record<string, unknown>) =>
      validateDataset(
        withCase({
          ...first,
          id,
          input: 'sold 3 wigs',
          expect: { kind: 'command', intent, checks } as EvalCase['expect'],
        }),
      );
    expect(
      errorsFor('spend', 'RecordExpense', {
        amount: 1,
        description: ['fuel'],
        paymentMethod: 'cash',
      }),
    ).toContain('spend: an expense pins no category');
    expect(
      errorsFor('buy', 'RecordPurchase', {
        amount: 1,
        quantity: null,
        reportedPayment: null,
        paymentMethod: null,
        supplierMention: null,
        supplierReference: null,
      }),
    ).toContain('buy: a purchase pins no description');
    expect(errorsFor('order', 'RecordOrder', {})).toEqual(
      expect.arrayContaining(['order: an order pins no customer', 'order: an order pins no items']),
    );
    expect(errorsFor('adjust', 'AdjustInventory', {})).toEqual(
      expect.arrayContaining([
        'adjust: an adjustment names no product',
        'adjust: an adjustment pins no count',
      ]),
    );
    expect(
      validateDataset(
        withCase({ ...first, id: 'junk', source: 'typed', expect: { kind: 'not_a_document' } }),
      ),
    ).toContain('junk: a junk case that is not a page');
  });

  it('every value that changes what is booked or sent is exercised (Codex on ab20cf1)', () => {
    const without = (pick: (c: EvalCase) => boolean) =>
      validateDataset(EVAL_CASES.filter((c) => !pick(c)));
    expect(without((c) => c.id === 'discount-1')).toContain('no case states a discount');
    expect(without((c) => c.id === 'delivery-1')).toContain('no case states a deliveryFee');
    expect(without((c) => c.id === 'half-1')).toContain('relativeAmount half has no case');
    expect(without((c) => c.id === 'query-excel')).toContain('format excel has no case');
    expect(without((c) => c.id === 'query-report')).toContain('format pdf has no case');
    const unpinned = EVAL_CASES.map((c) =>
      c.id === 'period-unsupported' && c.expect.kind === 'command'
        ? { ...c, expect: { ...c.expect, checks: { topic: 'sales_summary', period: 'custom' } } }
        : c,
    );
    const errors = validateDataset(unpinned);
    expect(errors).toContain('period-unsupported: a question pins no format');
    expect(errors).toContain('period-unsupported: a custom window pins no words');
  });

  it('stated references and every query topic are covered (Codex on dfda62e)', () => {
    const without = (pick: (c: EvalCase) => boolean) =>
      validateDataset(EVAL_CASES.filter((c) => !pick(c)));
    expect(without((c) => c.id === 'pay-ref-1')).toContain(
      'no payment case states an invoice reference',
    );
    expect(without((c) => c.id === 'supply-ref-1')).toContain(
      'no purchase case states a supplier reference',
    );
    expect(without((c) => c.id === 'query-unreconciled')).toContain(
      'query topic unreconciled has no case',
    );
    expect(without((c) => c.id === 'query-report' || c.id === 'query-excel')).toContain(
      'query topic report_request has no case',
    );
  });

  it('a token the gateway could never mint (Codex on #273)', () => {
    /* Production tokens are three Crockford base32 characters: no L, no two. */
    expect(
      validateDataset(withCase({ ...first, id: 'short', input: 'CUSTOMER_A1 paid 5k' })),
    ).toContain('short: malformed customer token');
    expect(
      validateDataset(withCase({ ...first, id: 'crockford', input: 'CUSTOMER_L2Q paid 5k' })),
    ).toContain('crockford: malformed customer token');
  });

  it('a fixture leaking a raw phone number, named by kind and never repeated', () => {
    const errors = validateDataset(
      withCase({ ...first, id: 'leak', input: 'call 08031234567 about the wigs' }),
    );
    expect(errors).toContain('leak: structural PII in input (phone)');
    expect(errors.join('\n')).not.toContain('08031234567');
  });

  it('a missing version', () => {
    expect(validateDataset(EVAL_CASES, 0)).toContain('dataset version missing');
  });
});

describe('the dataset fingerprint (G-07)', () => {
  it('is stable for the same dataset and changes with any case', () => {
    expect(datasetFingerprint()).toBe(datasetFingerprint(EVAL_CASES, EVAL_DATASET_VERSION));
    expect(datasetFingerprint()).toMatch(/^sha256:[0-9a-f]{64}$/);
    const changed = EVAL_CASES.map((c, i) => (i === 0 ? { ...c, input: `${c.input}.` } : c));
    expect(datasetFingerprint(changed)).not.toBe(datasetFingerprint());
    expect(datasetFingerprint(EVAL_CASES, 3)).not.toBe(datasetFingerprint());
  });

  it('does not depend on the order keys were written in', () => {
    const reordered = EVAL_CASES.map((c) => ({
      expect: c.expect,
      input: c.input,
      covers: c.covers,
      source: c.source,
      category: c.category,
      id: c.id,
      ...(c.register ? { register: c.register } : {}),
    }));
    expect(datasetFingerprint(reordered)).toBe(datasetFingerprint());
  });
});

describe('positive coverage the model cannot fake with nulls (Codex on #273, af442ec)', () => {
  it('some case pins a new-name mention and some case pins a stated sale channel', () => {
    const checks = EVAL_CASES.flatMap((c) =>
      c.expect.kind === 'command' ? [c.expect.checks ?? {}] : [],
    ) as Array<Record<string, unknown>>;
    expect(checks.some((k) => typeof k['customerMention'] === 'string')).toBe(true);
    expect(checks.some((k) => typeof k['saleSource'] === 'string')).toBe(true);
  });

  it('a dataset without them is invalid', () => {
    const stripped = EVAL_CASES.filter((c) => c.id !== 'new-name-1' && c.id !== 'channel-1');
    expect(validateDataset(stripped)).toEqual(
      expect.arrayContaining([
        'no case states a new customer name',
        'no case states a sale channel',
      ]),
    );
  });
});
