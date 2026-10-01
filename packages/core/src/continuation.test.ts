/**
 * What a short reply may continue (Build 6), decided without a database.
 *
 * The rules are conservative by construction: a period question takes only
 * a whole-message period, a bare number answers only an explicit numbered
 * list, and the only thing any of it resumes into is a READ.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_TTL_SECONDS,
  continuationAnswer,
  continuationColumns,
  isOneShot,
  parseContinuation,
  resumedRead,
  type ContinuationState,
} from './continuation.js';
import { CONFIRMATION_TTL_SECONDS } from './risk.js';
import { periodAnswer, routeMessage } from './router.js';

const said = (text: string) => ({ text, route: routeMessage(text) });

const PERIOD_QUESTION: ContinuationState = {
  kind: 'clarification',
  expects: 'period',
  topic: 'sales_summary',
};
const INVOICE_LIST: ContinuationState = {
  kind: 'clarification',
  expects: 'choice',
  topic: 'customer_balance',
  options: [
    { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000001' } },
    { ordinal: 2, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000004' } },
  ],
};
const SALES_READ: ContinuationState = {
  kind: 'query',
  topic: 'sales_summary',
  period: 'month',
  customerToken: null,
  documentRef: null,
};

describe('the window is its own decision, not G-23’s', () => {
  it('is ten minutes, and is not the confirmation window', () => {
    expect(CONTINUATION_TTL_SECONDS).toBe(600);
    expect(CONTINUATION_TTL_SECONDS).not.toBe(CONFIRMATION_TTL_SECONDS);
  });
});

describe('a period answer', () => {
  it.each([
    ['Last month.', 'last_month'],
    ['last month', 'last_month'],
    ['for last month pls', 'last_month'],
    ['previous month', 'last_month'],
    ['this month', 'month'],
    ['Today!', 'today'],
    ['this week', 'week'],
    ['what about this week', 'week'],
    ['and today', 'today'],
  ])('%s names %s', (text, period) => {
    expect(periodAnswer(text)).toBe(period);
  });

  it.each([
    /* Two defensible readings each: never guessed. */
    'last week',
    'past month',
    /* A sentence that mentions a period is not a period. */
    'I bought 10 cartons for 100k last month',
    'sold 3 wigs today',
    '2',
    'yes',
    '',
  ])('%j is not one', (text) => {
    expect(periodAnswer(text)).toBeNull();
  });
});

describe('what a reply answers', () => {
  it('answers "Which period?" with a whole-message period', () => {
    expect(continuationAnswer(PERIOD_QUESTION, said('Last month.'))).toEqual({
      kind: 'period',
      period: 'last_month',
    });
  });

  it('does not swallow a new request: a purchase after "Which period?" is a purchase', () => {
    expect(
      continuationAnswer(PERIOD_QUESTION, said('I bought 10 cartons for 100k last month')),
    ).toBeNull();
    expect(continuationAnswer(PERIOD_QUESTION, said('who owes me'))).toBeNull();
    expect(continuationAnswer(PERIOD_QUESTION, said('yes'))).toBeNull();
  });

  it('represents an explicit numbered list, and "2" means its line 2', () => {
    expect(continuationAnswer(INVOICE_LIST, said('2'))).toEqual({
      kind: 'choice',
      option: { ordinal: 2, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000004' } },
    });
  });

  it('a number the list did not show answers nothing', () => {
    expect(continuationAnswer(INVOICE_LIST, said('3'))).toBeNull();
    expect(continuationAnswer(INVOICE_LIST, said('last month'))).toBeNull();
  });

  it('a bare number while a period is expected is not guessed at', () => {
    expect(continuationAnswer(PERIOD_QUESTION, said('2'))).toBeNull();
    expect(continuationAnswer(SALES_READ, said('2'))).toBeNull();
  });

  it('continues a read over a window with another window', () => {
    expect(continuationAnswer(SALES_READ, said('what about last month'))).toEqual({
      kind: 'period',
      period: 'last_month',
    });
  });

  it('continues nothing about a read that has no window', () => {
    const balance: ContinuationState = {
      kind: 'query',
      topic: 'customer_balance',
      period: null,
      customerToken: 'CUSTOMER_7K2',
      documentRef: null,
    };
    expect(continuationAnswer(balance, said('last month'))).toBeNull();
  });
});

describe('a continuation can only ever resume a read', () => {
  it('a period question resumes the question that was asked', () => {
    expect(resumedRead(PERIOD_QUESTION, { kind: 'period', period: 'last_month' })).toEqual({
      kind: 'read',
      topic: 'sales_summary',
      period: 'last_month',
    });
  });

  it('a chosen option resumes nothing: an option is a reference, not an action', () => {
    expect(
      resumedRead(INVOICE_LIST, {
        kind: 'choice',
        option: { ordinal: 2, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000004' } },
      }),
    ).toBeNull();
  });

  it('every resumed value is a read, whatever was open', () => {
    for (const state of [PERIOD_QUESTION, SALES_READ]) {
      for (const text of ['today', 'this week', 'this month', 'last month']) {
        const answer = continuationAnswer(state, said(text));
        const read = answer ? resumedRead(state, answer) : null;
        expect(read?.kind).toBe('read');
        expect(Object.keys(read ?? {}).sort()).toEqual(['kind', 'period', 'topic']);
      }
    }
  });

  it('a clarification is one-shot; a read stays open for the next follow-up', () => {
    expect(isOneShot(PERIOD_QUESTION)).toBe(true);
    expect(isOneShot(INVOICE_LIST)).toBe(true);
    expect(isOneShot(SALES_READ)).toBe(false);
  });
});

describe('stored as typed columns, read back defensively', () => {
  it.each([PERIOD_QUESTION, INVOICE_LIST, SALES_READ])('round-trips %j', (state) => {
    expect(parseContinuation(continuationColumns(state))).toEqual(state);
  });

  it('refuses to store a customer as anything but a vault token', () => {
    expect(() => continuationColumns({ ...SALES_READ, customerToken: 'Ada Obi' } as never)).toThrow(
      /vault token/,
    );
  });

  it('refuses a numbered list with a repeated or missing line', () => {
    expect(() =>
      continuationColumns({
        ...INVOICE_LIST,
        options: [
          { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000001' } },
          { ordinal: 1, ref: { kind: 'invoice', invoiceNumber: 'INV-2026-000004' } },
        ],
      } as never),
    ).toThrow();
    expect(() => continuationColumns({ ...INVOICE_LIST, options: [] } as never)).toThrow();
  });

  it('reads anything it did not write as nothing', () => {
    const base = continuationColumns(SALES_READ);
    expect(parseContinuation({ ...base, topic: 'transfer_money' })).toBeNull();
    expect(parseContinuation({ ...base, customerToken: 'Ada' })).toBeNull();
    expect(parseContinuation({ ...base, period: 'forever' })).toBeNull();
    expect(parseContinuation({ ...base, kind: 'confirmation' })).toBeNull();
    expect(
      parseContinuation({ ...continuationColumns(PERIOD_QUESTION), topic: 'debtors' }),
    ).toBeNull();
  });
});
