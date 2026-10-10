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

  /* Reviewer A, round 2: a token that is the subject must not let the next
   * word open a question; a greeting or a second sentence must not carry a
   * record through as a question; amounts in words are amounts. */
  it.each([
    'CUSTOMER_7K2 has paid',
    'CUSTOMER_7K2 has paid in full',
    'CUSTOMER_7K2 has paid for the invoice',
    'CUSTOMER_7K2 has paid her balance',
    'CUSTOMER_7K2 have paid',
    'CUSTOMER_7K2 did pay me',
    'CUSTOMER_7K2 has bought rice',
    'CUSTOMER_7K2 has collected the goods',
    'CUSTOMER_7K2 has received the goods',
    'CUSTOMER_7K2 was paid',
    'How far, I sold two bags of rice to CUSTOMER_7K2 for fifty thousand naira',
    'How far, CUSTOMER_7K2 paid me fifty thousand',
    'how far boss, sold rice to CUSTOMER_7K2',
    'how far, CUSTOMER_7K2 don pay',
    'Is it ok? I sold rice to CUSTOMER_7K2',
    'did you get it? CUSTOMER_7K2 paid me',
    'any payment from CUSTOMER_7K2? she paid fifty thousand',
    'list sales and add rice sale',
    'do invoice for CUSTOMER_7K2',
    'do invoice for CUSTOMER_7K2 two bags rice',
    'do sale for CUSTOMER_7K2',
    'tell CUSTOMER_7K2 she owes 5k',
  ])('never reads %j as a question', (text) => {
    expect(requestKind(text)).not.toBe('read');
  });

  it.each([
    ['How far, CUSTOMER_7K2 paid me fifty thousand', 'write'],
    ['sold rice five thousand naira', 'write'],
    ['how far? how much did we sell today?', 'read'],
    ['how far, how much do I have to collect?', 'read'],
    ["CUSTOMER_7K2's balance", 'read'],
    ['did CUSTOMER_7K2 pay?', 'read'],
    ['do I owe any supplier?', 'read'],
    ['sales', 'read'],
    ['expenses', 'read'],
    ['Good morning. How much did we sell this month?', 'read'],
    ['How far?', 'unknown'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Reviewer A, round 3: greetings phrased as questions, and second clauses
   * joined by a new line, a comma, "and", a dash or an emoji, must not carry
   * a record through; a dropped subject is no question. */
  it.each([
    'how are you, CUSTOMER_7K2 paid me',
    'how you dey, Ada paid me',
    'how are you CUSTOMER_7K2 don pay',
    'how body, Ada paid me',
    'how na, Ada paid me',
    "how's it going, CUSTOMER_7K2 has paid",
    'how is it going, sold rice to Ada',
    "what's up, CUSTOMER_7K2 paid me",
    'whats up CUSTOMER_7K2 paid',
    'wetin dey, Ada paid me',
    'wetin dey happen CUSTOMER_7K2 don pay',
    'how much did we sell today\nI sold rice to Ada',
    'how much did we sell today\nCUSTOMER_7K2 paid me',
    'who owes me\nAda paid me',
    'how you dey\nAda paid me',
    'how much did we sell today, I sold rice to Ada',
    'what is my balance, Ada paid me',
    'show my sales today, Ada bought rice',
    'who owes me and CUSTOMER_7K2 paid me',
    'how much did we sell today; sold rice to Ada',
    'how much did we sell today… sold rice to Ada',
    'how much did we sell today - sold rice to Ada',
    'how much did we sell today 🙏 sold rice to Ada',
    'boss has paid me',
    'sir has paid me',
    'ma has paid',
    'did sold rice',
    'have sold rice to CUSTOMER_7K2',
    'has collected',
  ])('never reads %j as a question', (text) => {
    expect(requestKind(text)).not.toBe('read');
  });

  it.each([
    ['how much did we sell today? thanks', 'read'],
    ['how much did we sell today? thank you', 'read'],
    ["what's my balance? thanks boss", 'read'],
    ['how much did we sell today? 🙏', 'read'],
    ['who owes me? how much?', 'read'],
    ['how much did we sell today? and yesterday?', 'read'],
    ['how much did we sell vs. last month?', 'read'],
    ['what did Mr. CUSTOMER_7K2 pay?', 'read'],
    ['how much did we sell, this month?', 'read'],
    ['sales and expenses this month', 'read'],
    ['bought rice and beans 5k', 'write'],
    ['how much did we sell today\nsold rice 5k', 'write'],
    ['customer paid ₦7,500 transfer', 'write'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 4: "and" inside one question keeps it a question; a participle
   * after a split is no instruction; separators without spaces, in capitals,
   * or as a colon, "&", "+" or "/" still separate; a bare name or a money
   * word is never a neutral fragment. */
  it.each([
    ['how much did we sell and spend this month?', 'read'],
    ['how much have I spent and received this month', 'read'],
    ['how much did we spend on fuel and transport this month?', 'read'],
    ['how much do CUSTOMER_7K2 and CUSTOMER_9M4 owe?', 'read'],
    ['what do CUSTOMER_7K2 and CUSTOMER_9M4 owe me', 'read'],
    ['what is my cash and bank balance?', 'read'],
    ['profit and loss', 'read'],
    ['sales and purchases this month', 'read'],
    ['send me the P & L for last month', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  it.each([
    'how many sales were cancelled and refunded this month?',
    'how many orders were returned and refunded',
    'how much was paid and refunded this month',
    'how much did we receive, refund or reverse this month',
  ])('never reads the question %j as a write', (text) => {
    expect(requestKind(text)).not.toBe('write');
  });

  it.each([
    'who owes me And CUSTOMER_7K2 has paid',
    'WHO OWES ME AND CUSTOMER_7K2 HAS PAID',
    'how much did we sell today?I sold rice to CUSTOMER_7K2',
    'how much did we sell today.I sold rice to CUSTOMER_7K2',
    'who owes me?Ada paid me',
    'how much did we sell today: I sold rice to CUSTOMER_7K2',
    'what happened today: CUSTOMER_7K2 bought rice',
    'who owes me & Ada paid me',
    'who owes me + Ada paid me',
    'who owes me / Ada paid me',
    'who owes me\r\nAda paid me',
    'who owes me but Ada paid me',
    "what's my balance? CUSTOMER_7K2 is up to date now",
    'who owes me? CUSTOMER_7K2 money dey bank',
    "what's my balance? CUSTOMER_7K2 money is in my account now",
    'who paid me today? CUSTOMER_7K2, all of it',
    'any sales today? ok CUSTOMER_7K2 all of it today',
    'which customer paid today? CUSTOMER_7K2 full',
    'which customer bought rice today, CUSTOMER_7K2',
  ])('never reads %j as a question', (text) => {
    expect(requestKind(text)).not.toBe('read');
  });

  /* Round 5: a greeting, courtesy or period set off by a comma does not sink
   * the question; a later part with a subject or a traded object of its own
   * is a statement, not the question's tail. */
  it.each([
    'good morning, how much did we sell today?',
    'Good morning, who owes me?',
    'good afternoon, what are my sales today',
    'good evening, show me sales for today',
    'good morning sir, who owes me',
    'morning, who owes me',
    'hello, good morning, who owes me',
    'ok, who owes me',
    'thanks, how much did we sell today?',
    'today, how much did we sell?',
    'this month, how much did we spend?',
    'sales today, thanks',
    'profit this month, please',
    'sales and expenses for this month, please',
    'how much did we sell, by customer',
  ])('reads %j as a question about the books', (text) => {
    expect(requestKind(text)).toBe('read');
  });

  it.each([
    'who owes me, CUSTOMER_7K2 sent money',
    'who owes me, CUSTOMER_7K2 transferred',
    'who owes me, CUSTOMER_7K2 don transfer',
    'who owes me, CUSTOMER_7K2 no longer owes',
    'who owes me, CUSTOMER_7K2 owes nothing now',
    'did CUSTOMER_7K2 pay me, she sent it',
    'did CUSTOMER_7K2 pay today, yes she did',
    'how much did we sell today, sold rice to CUSTOMER_7K2',
    'how much did we sell today and sold rice to CUSTOMER_7K2',
    'how much did we sell today, also sold rice to CUSTOMER_7K2',
    'how much did I spend, bought fuel today',
    'how much did we sell today, rice to CUSTOMER_7K2',
    'who owes me, not CUSTOMER_7K2',
    'who owes me, except CUSTOMER_7K2',
  ])('never reads %j as a question', (text) => {
    expect(requestKind(text)).not.toBe('read');
  });

  /* Deliberate, per OWN-25 (a rephrase is cheaper than a guess): a name set
   * off on its own is not trusted to be part of the question. */
  it.each([
    "what's my balance with CUSTOMER_7K2 and CUSTOMER_9M4",
    'CUSTOMER_7K2, how much does she owe?',
  ])('asks for %j to be rephrased', (text) => {
    expect(requestKind(text)).toBe('unknown');
  });

  /* Codex, on 715866e. */
  it.each([
    ['who owes me, CUSTOMER_7K2 owes me', 'unknown'],
    ['CUSTOMER_7K2 owes me', 'unknown'],
    ['she owed me', 'unknown'],
    ['how much do CUSTOMER_7K2 and CUSTOMER_9M4 owe?', 'read'],
    ['how much does CUSTOMER_7K2 owe?', 'read'],
    ['export sales to Excel', 'read'],
    ['export my P&L as PDF', 'read'],
    ['download the sales report', 'read'],
    ['show sales on 10 October 2026', 'read'],
    ['what were sales on 10/10/2026', 'read'],
    ['how much did we sell on 5th March?', 'read'],
    ['sales for the last 30 days', 'read'],
    ['how much did we sell in the last 7 days?', 'read'],
    ['record of sales', 'read'],
    ['record of expenses this month', 'read'],
    ['records of payments this week', 'read'],
    ['record a sale', 'write'],
    ['sold rice 10/10 5k', 'write'],
    ['sold rice 5k on 10 October', 'write'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 7: a decimal or a range is a figure, not a date. */
  it.each([
    ['sales today 5.5', 'unknown'],
    ['sales today 2-3', 'unknown'],
    ['sales yesterday 15/20', 'unknown'],
    ['record of sales 10.5', 'unknown'],
    ['Ada paid 10.5', 'write'],
    ['sold 2-3 bags', 'write'],
    ['bought fuel 12.50', 'write'],
    ['what were sales on 10/10/2026', 'read'],
    ['sales on 10-10-2026', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Codex, on b183fbf. */
  it.each([
    ['who owes me more than 50k', 'read'],
    ['which customers owe above 100k?', 'read'],
    ['can you show me sales this month?', 'read'],
    ['could you show me the ledger?', 'read'],
    ['can you export my P&L as PDF?', 'read'],
    ['send my records for March', 'read'],
    ['show refunded payments this month', 'read'],
    ['how many invoices were cancelled this month?', 'read'],
    ['refunded payments this month', 'read'],
    ['show me P/L for last month', 'read'],
    ['export P/L as PDF', 'read'],
    ['who owes me, Ada sent money', 'unknown'],
    ['who owes me, Bola transferred', 'unknown'],
    ['which customer paid today, Ada', 'unknown'],
    ['can you reverse the last sale?', 'unknown'],
    ['refund Ada 5k', 'write'],
    ['cancel the last invoice', 'write'],
    ['did Ada pay 20k?', 'unknown'],
    ['sold rice for more than 50k', 'write'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  it('is not fooled by a year into seeing money', () => {
    expect(requestKind('sales in 2026')).toBe('read');
    expect(requestKind('sold rice 2026k')).toBe('write');
    expect(requestKind('how much did we sell in 2026?')).toBe('read');
  });
});
