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
    expect(requestKind('Ada paid me 20k?')).toBe('unknown');
    expect(requestKind('sold rice 5k?')).toBe('unknown');
  });

  it('is not fooled by a year into seeing money', () => {
    expect(requestKind('sales in 2026')).toBe('unknown');
    expect(requestKind('how much did we sell in 2026?')).toBe('read');
  });
});
