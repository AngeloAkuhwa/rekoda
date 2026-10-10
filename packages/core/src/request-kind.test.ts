import { describe, expect, it } from 'vitest';
import { requestKind } from './request-kind.js';

describe('what a view-only member is asking for (G-57, OWN-25)', () => {
  it.each([
    'record a sale of 50k cash',
    'sold rice 5k',
    'Ada paid me 20k',
    'bought 10 cartons for 180k',
    'I spent 20k on fuel',
    'add a 5k sale for Chidi',
    'can you record a 5k expense?',
    'abeg record sale 3 bags 12k',
    'Ada ordered 3 wigs 150k',
    'restocked 20 cartons of indomie 90k',
    'we received 50,000 from Bola',
    'customer paid ₦7,500 transfer',
  ])('reads %j as a write', (text) => {
    expect(requestKind(text)).toBe('write');
  });

  it.each([
    'how much did we sell this month?',
    'how much does Ada owe?',
    'who paid me this month?',
    'how much did I spend?',
    'show sales for today',
    'what did we spend last week',
    'which customers still owe me money?',
    'sales this month',
    'expenses last week',
    'total sold this month',
    'my debtors',
    'what is unreconciled',
    'send me the P&L for last month',
    'supplier balances',
    'wetin I sell today',
    'how much I don sell this week?',
    'who dey owe me',
    'sales for march 2026',
  ])('reads %j as a question about the books', (text) => {
    expect(requestKind(text)).toBe('read');
  });

  it.each([
    'Ada 20k',
    'rice and beans for Chidi',
    'did Ada pay 20k?',
    'can I record a sale of 5k?',
    'sold rice to Ada',
    'expense 5k fuel',
    'Ada owes 20k',
    'what is this?',
    'thanks',
    '',
    '   ',
  ])('leaves %j unknown rather than guessing', (text) => {
    expect(requestKind(text)).toBe('unknown');
  });

  it('never reads a figure beside trade as a question, even with a question mark', () => {
    expect(requestKind('Ada paid me 20k?')).not.toBe('read');
    expect(requestKind('sold rice 5k?')).not.toBe('read');
    expect(requestKind('did Ada pay 20k?')).not.toBe('read');
  });

  /* Reviewer A, round 1: changes to what is recorded, and statements that say
   * more than a books question, were read as questions and sent to the
   * model. None of them may read. */
  it.each([
    'Ada settled her balance',
    'Ada cleared her balance',
    'Ada don clear her debt',
    "clear Ada's debt",
    'Ada debt cleared',
    'write off Ada debt',
    'update Ada balance',
    'reduce Ada balance',
    'increase Ada debt',
    'set opening balance',
    'remove the sale from yesterday',
    "refund Ada's payment today",
    'expense today fuel',
    'fuel expense today',
    'today expense: fuel',
    'sales today: rice and beans',
    'purchase today from Chidi',
    'payment today Ada',
    'Can you reverse the last sale?',
    "Could you delete yesterday's expense?",
    "Can you mark Ada's invoice as paid?",
    'sold rice to Ada?',
    'reconcile the Moniepoint transfer',
    'how do I delete a sale?',
  ])('never reads %j as a question', (text) => {
    expect(requestKind(text)).not.toBe('read');
  });

  it.each([
    ["clear Ada's debt", 'write'],
    ['reverse the last sale', 'write'],
    ['delete yesterday expense', 'write'],
    ['Ada settled her balance', 'unknown'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Reviewer C, round 1: common summary phrasings a view-only member uses. */
  it.each([
    "today's sales",
    "this month's sales",
    "this month's expenses",
    'total sales',
    'total expenses',
    'overdue invoices',
    'invoices this month',
    'how many invoices',
    'unmatched payments',
    'cash flow',
    'sales for 2025',
    'sales in Q3',
    'profit this month',
    'P&L for September',
    'send me my statement',
    'unpaid invoices',
    'bank reconciliation',
    'report for last month',
    'debtors list',
    'income statement',
    'balance sheet',
    'monthly report',
    'purchases this month',
    'show me the ledger',
    'can I see sales this week?',
  ])('reads %j as a question about the books', (text) => {
    expect(requestKind(text)).toBe('read');
  });

  /* It reads the gateway's tokenised text: a customer or contact token is a
   * name, and the digits inside it are not money. */
  it('never reads the digits in a vault token as a figure', () => {
    expect(requestKind('sales for CUSTOMER_7K2 this month')).toBe('read');
    expect(requestKind('what did CUSTOMER_7K2 buy?')).toBe('read');
    expect(requestKind('how much does CUSTOMER_9M4 owe?')).toBe('read');
    expect(requestKind('CUSTOMER_7K2 paid me 20k')).toBe('write');
    expect(requestKind('CUSTOMER_7K2 20k')).toBe('unknown');
    expect(requestKind('send me the report for CUSTOMER_7K2')).toBe('read');
    expect(requestKind('send the report to EMAIL_1')).toBe('unknown');
    expect(requestKind('how much has CUSTOMER_7KQ paid this month?')).toBe('read');
    expect(requestKind('did CUSTOMER_9ZZ pay?')).toBe('read');
    expect(requestKind('what did CUSTOMER_A3C buy this month?')).toBe('read');
    expect(requestKind('CUSTOMER_7KQ balance')).toBe('read');
  });

  it('is not fooled by a year into seeing money', () => {
    expect(requestKind('sales in 2026')).toBe('read');
    expect(requestKind('sold rice 2026k')).toBe('write');
    expect(requestKind('how much did we sell in 2026?')).toBe('read');
  });
});
