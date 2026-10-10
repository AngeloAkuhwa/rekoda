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

  /* Round 9: dropped-subject past tense is shorthand for a change, not a
   * description; a comparison filters only the figure it governs. */
  it.each([
    'cleared CUSTOMER_7K2 debt',
    "cleared CUSTOMER_7K2's debt",
    'Cleared CUSTOMER_7K2 debt today',
    'settled CUSTOMER_7K2 balance',
    'settled the balance',
    'settled all my debts',
    'refunded CUSTOMER_7K2',
    'refunded the customer',
    'cancelled the invoice',
    'cancelled the last invoice',
    'cancelled invoice',
    'deleted the last sale',
    'reversed the last payment',
    'voided the last invoice',
    'marked invoice paid',
    'updated CUSTOMER_7K2 balance',
    'reconciled the bank',
    'have cleared the debt',
    'have settled the balance',
    'has cancelled the invoice',
    'when CUSTOMER_7K2 paid me 20k over transfer',
    'did CUSTOMER_7K2 pay 20k over transfer',
    'who paid 20k over transfer',
  ])('never reads %j as a question', (text) => {
    expect(requestKind(text)).not.toBe('read');
  });

  it.each([
    ['cancelled invoices last month', 'read'],
    ['refunded payments this month', 'read'],
    ['show refunded payments this month', 'read'],
    ['how many invoices were cancelled this month?', 'read'],
    ['has CUSTOMER_7K2 settled her balance?', 'read'],
    ['who owes me more than 50k', 'read'],
    ['list expenses over 5k this month', 'read'],
    ['who owes me 50k and above', 'read'],
    ['who owes me, PDF', 'read'],
    ['how much did I sell, Monday', 'read'],
    ['show me sales, Oga', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Codex, on 76c605a: every figure must be governed by a comparison, a
   * comparison may be in words, and a participle needs a real subject. */
  it.each([
    ['who owes me more than fifty thousand', 'read'],
    ['who owes me more than N50k', 'read'],
    ['who owes me above #20,000', 'read'],
    ['did CUSTOMER_7K2 pay 20k over 2 transfers', 'unknown'],
    ['have now settled the balance', 'unknown'],
    ['has just cancelled the invoice', 'unknown'],
    ['can i get the invoice cancelled?', 'unknown'],
    ['how many invoices were cancelled this month?', 'read'],
    ['has CUSTOMER_7K2 settled her balance?', 'read'],
    ['show refunded payments this month', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 11: perfect tenses and passive "get" are questions; causative
   * get/have is a request for a change; units after a compared figure go
   * with it; N5k is naira. */
  it.each([
    ['which invoices have been cancelled', 'read'],
    ['how many invoices have been cancelled this month', 'read'],
    ['what sales have been reversed', 'read'],
    ['which payments have been refunded', 'read'],
    ['what invoices have i voided this week', 'read'],
    ['do i have any cancelled invoices', 'read'],
    ['did the sale get reversed', 'read'],
    ['can i get cancelled invoices', 'read'],
    ['can i get the list of cancelled invoices', 'read'],
    ['can i get the invoice cancelled?', 'unknown'],
    ['can i have the invoice voided?', 'unknown'],
    ['who owes me more than 50 thousand', 'read'],
    ['who owes me more than 50k naira', 'read'],
    ['who owes me more than 50 thousand naira', 'read'],
    ['did CUSTOMER_7K2 pay me N5k?', 'unknown'],
    ['has customer paid N5k', 'unknown'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 12: a quantified object is still an object. */
  it.each([
    ['can i get all the invoices cancelled', 'unknown'],
    ['can i get all invoices cancelled', 'unknown'],
    ['can we have all the sales for today deleted', 'unknown'],
    ['can i have some invoices voided', 'unknown'],
    ['can i get the sale that has been entered twice deleted', 'unknown'],
    ['can we get the invoice which has been paid cancelled', 'unknown'],
    ['have any invoices from last month been cancelled', 'read'],
    ['please have the invoice cancelled', 'unknown'],
    ['have any invoices been cancelled this month?', 'read'],
    ['do i have any cancelled invoices', 'read'],
    ['which invoices have been cancelled', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Codex, on b3e4927. */
  it.each([
    ['who owes me, ada sent money', 'unknown'],
    ['who owes me, bola transferred', 'unknown'],
    ['which customer paid today, ada', 'unknown'],
    ['how much did we spend on fuel and transport this month?', 'read'],
    ['who owes me more than five hundred thousand', 'read'],
    ['who owes me more than one hundred and fifty thousand', 'read'],
    ['have any invoices been fully cancelled?', 'read'],
    ['have invoices been partially refunded?', 'read'],
    ['have any invoices been cancelled or voided', 'read'],
    ['can i get the invoice cancelled?', 'unknown'],
    ['did Ada pay 2,026?', 'unknown'],
    ['did Ada pay 20.26?', 'unknown'],
    ['how much did we sell in 2026?', 'read'],
    ['tell CUSTOMER_7K2 she owes me', 'unknown'],
    ['tell CUSTOMER_7K2 about the unpaid invoice', 'unknown'],
    ['tell me who owes me', 'read'],
    ['can you tell me my sales this month?', 'read'],
    ['what happened with INV-2026-000004 last week', 'read'],
    ['show invoice INV-2026-000004', 'read'],
    ['INV-2026-000004 paid 20k', 'write'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 15: a list after "and" is a list; a word-amount comparison
   * holds only number words. */
  it.each([
    ['how much did i spend on fuel and transport', 'read'],
    ['how much did i spend on fuel and diesel?', 'read'],
    ['how much did i spend on data and airtime', 'read'],
    ['who bought rice and beans', 'read'],
    ['show me invoices and receipts', 'read'],
    ['how much did i receive via transfer and pos', 'read'],
    ['who owes me, asap', 'read'],
    ['how much did i sell today, sha', 'read'],
    ['who owes me, ada', 'unknown'],
    ['who owes me, ada sent money', 'unknown'],
    ['who owes me more than ten thousand and CUSTOMER_7K2 paid five thousand', 'unknown'],
    ['who owes me more than five thousand and ada paid two thousand', 'unknown'],
    ['who owes me over ten and sold rice five thousand', 'unknown'],
    ['who owes me more than one hundred and fifty thousand', 'read'],
    ['who owes me more than five hundred thousand', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Codex, on 6b0bc76: a day range in one month is a period; making a
   * report of the books is a read. */
  it.each([
    ['show sales from 1 to 5 October', 'read'],
    ['how much did we sell between 1 and 5 October', 'read'],
    ['sales for 1-5 October', 'read'],
    ['show sales from 1 October to 5 October', 'read'],
    ['sold rice 1 to 5 bags 20k', 'write'],
    ['create a sales report', 'read'],
    ['create the P&L report for March', 'read'],
    ['issue a statement', 'read'],
    ['can you create a sales report for this month?', 'read'],
    ['issue an invoice', 'write'],
    ['create a sale', 'write'],
    ['create a report of 5k sale', 'write'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Codex, on 69f3d6c: a report must be what is made, not where a record
   * goes; a balance sheet is a report; a bounded range is a filter. */
  it.each([
    ['add sale to ledger', 'write'],
    ['record sale in ledger', 'write'],
    ['can you add sale to ledger?', 'write'],
    ['add a sale to the report', 'write'],
    ['record sales summary', 'write'],
    ['add sales report for today', 'write'],
    ['create a sales report', 'read'],
    ['issue a statement', 'read'],
    ['create a balance sheet', 'read'],
    ['issue a balance sheet', 'read'],
    ['can you create the balance sheet for March?', 'read'],
    ['show payments between 20k and 50k', 'read'],
    ['show sales from 20k to 50k', 'read'],
    ['who owes me between 10k and 50k?', 'read'],
    ['sold rice from 5k to 10k', 'write'],
    ['did CUSTOMER_7K2 pay 20k between 1k and 5k', 'unknown'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Codex, on 3ee0d0e: bare spelled-out amounts are amounts; a negative
   * contraction opens a question like the auxiliary it negates. Round 18:
   * a singular record anywhere in a made report keeps it a record. */
  it.each([
    ['did Ada pay fifty?', 'unknown'],
    ['did Ada pay ten?', 'unknown'],
    ['has CUSTOMER_7K2 paid twenty?', 'unknown'],
    ['sold rice fifty', 'write'],
    ['sales for the last two weeks', 'read'],
    ['who owes me more than fifty', 'read'],
    ['which one owes me?', 'read'],
    ["didn't CUSTOMER_7K2 pay?", 'read'],
    ["hasn't CUSTOMER_7K2 paid?", 'read'],
    ["don't any customers owe me?", 'read'],
    ['didnt CUSTOMER_7K2 pay', 'read'],
    ["can't i see my sales?", 'read'],
    ['create a sheet for invoice', 'write'],
    ['create sheet invoice', 'write'],
    ['create a sales report', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Codex, on a4847c7: word amounts in a bounded range; courtesy words
   * between "you" and a read verb. */
  it.each([
    ['show sales between twenty thousand and fifty thousand', 'read'],
    ['show sales from twenty thousand to fifty thousand', 'read'],
    ['who owes me between 20k and fifty thousand?', 'read'],
    ['did CUSTOMER_7K2 pay 5k between twenty and fifty thousand', 'unknown'],
    ['sold rice from twenty thousand to fifty thousand', 'write'],
    ['can you please show me sales this month?', 'read'],
    ['could you kindly list expenses?', 'read'],
    ['can you please tell me who owes me?', 'read'],
    ['can you please tell CUSTOMER_7K2 she owes', 'unknown'],
    ['can you please reverse the last sale?', 'unknown'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 20: a read verb aimed at someone else sends the books out; it is
   * not a question about them. */
  it.each([
    ['can you please send the statement to CUSTOMER_7K2', 'unknown'],
    ['can you please send CUSTOMER_7K2 the invoice', 'unknown'],
    ['can you please send her the invoice', 'unknown'],
    ['can you please send reminder to all debtors', 'unknown'],
    ['can you send the report to EMAIL_1', 'unknown'],
    ['could you please give CUSTOMER_7K2 her statement', 'unknown'],
    ['can you please show CUSTOMER_7K2 her balance', 'unknown'],
    ['can you please export sales to CUSTOMER_7K2', 'unknown'],
    ['can you please send me the P&L', 'read'],
    ['can you please show me sales this month?', 'read'],
    ['export sales to Excel', 'read'],
    ['export sales from 1 to 5 October', 'read'],
    ['show me sales from 1 to 5 October', 'read'],
    ['download the sales report', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 21: only what marks a recipient keeps a read from the asker;
   * "all", "customers balances", filters and ranges do not. */
  it.each([
    'can you list all debtors',
    'can you please list all debtors',
    'could you show all sales this month',
    'export all sales to excel',
    'print all invoices',
    'download all reports',
    'can you show customers balances',
    'can you list customers who owe me',
    'print customer balances',
    'can you show me sales to CUSTOMER_7K2',
    'can you list sales to CUSTOMER_7K2 this month',
    'can you show me payments to suppliers',
    'export payments to suppliers',
    'can you show sales from monday to friday',
    'can you show sales from jan to mar',
    'can you show me profit from january to now',
    'can you send me sales to my email',
    'can you export sales to spreadsheet',
  ])('reads %j as a question about the books', (text) => {
    expect(requestKind(text)).toBe('read');
  });

  it.each([
    'can you please send the statement to CUSTOMER_7K2',
    'can you please send her the invoice',
    'can you please show CUSTOMER_7K2 her balance',
    'can you send the report to EMAIL_1',
    'can you please export sales to CUSTOMER_7K2',
    'can you send my customer the invoice',
    'can you show my customer her balance',
    'can you show the customer the invoice',
    'can you show CUSTOMER_9M4 her balance',
    'can you show him the sales',
    'can you send the statement to the accountant',
  ])('never reads %j as a question', (text) => {
    expect(requestKind(text)).not.toBe('read');
  });

  /* Round 22: "to my/our/the …" names a person or a channel; particles
   * are not people; bare send/show meet the same check. */
  it.each([
    'can you send my invoice to my customer',
    'can you send my statement to my customer',
    'can you send our statement to our customers',
    'can you send my sales report to my accountant',
    'export sales to my customer',
    'export the invoice to my client',
    'export sales to the accountant',
    'can you show the invoice to the customer',
    'can you show my invoice to my customer',
    'send my invoice to my customer',
    'send my report to my accountant',
    'show CUSTOMER_7K2 her balance',
    'show the customer the invoice',
    'can you send my accountant the pnl',
    'send our accountant the pnl',
    'can you show my client the invoice',
  ])('never reads %j as a question', (text) => {
    expect(requestKind(text)).not.toBe('read');
  });

  it.each([
    'print out the statement',
    'can you print out the statement',
    'can you list out my debtors',
    'can you list down the debtors',
    'can you show only the sales',
    'can you show just my sales',
    'export out my sales',
    'can you send the report to me',
    'can you send me the report to my email',
    'can you send me my statement to my whatsapp',
    'can you show sales to my customers',
    'can you list sales to the customer',
    'export payments to suppliers',
    'show me sales to CUSTOMER_7K2',
    'list out the debtors',
    'show sales from monday to friday',
  ])('reads %j as a question about the books', (text) => {
    expect(requestKind(text)).toBe('read');
  });

  /* Codex, on 2c4b701. */
  it.each([
    ['show her the invoice', 'unknown'],
    ['show CUSTOMER_7K2 her balance', 'unknown'],
    ['show him the sales', 'unknown'],
    ['send us the P&L', 'read'],
    ['give us sales for March', 'read'],
    ['get us the sales report', 'read'],
    ['did Ada pay half?', 'unknown'],
    ['has CUSTOMER_7K2 paid the remainder?', 'unknown'],
    ['has CUSTOMER_7K2 paid the rest?', 'unknown'],
    ['Ada paid half', 'write'],
    ['show transactions for March', 'read'],
    ['list transactions this month', 'read'],
    ['how many transactions today', 'read'],
    ['show sales for 2 weeks', 'read'],
    ['show expenses for 3 months', 'read'],
    ['sales over 7 days', 'read'],
    ['who owes me over 7k', 'read'],
    ['how much did we make this month?', 'read'],
    ['how much money did we make today?', 'read'],
    ['how much did we earn last week?', 'read'],
    ['made 50k today', 'write'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 24: make/earn read only in a question frame; someone else's
   * channel is a send; one transaction is a record; a relative amount
   * counts only beside a payment. */
  it.each([
    ['made a sale today', 'unknown'],
    ['I made a sale', 'unknown'],
    ['customer made a payment today', 'unknown'],
    ['make an invoice today', 'unknown'],
    ['made sales today', 'unknown'],
    ['we made a profit this month', 'unknown'],
    ['earned today', 'unknown'],
    ['what did I make today', 'read'],
    ['my earnings', 'read'],
    ['send us statement on customer whatsapp', 'unknown'],
    ['send me statement on CUSTOMER_7K2 whatsapp', 'unknown'],
    ["send me the invoice on Ada's whatsapp", 'unknown'],
    ['send me statement on whatsapp', 'read'],
    ['send me the sales pdf', 'read'],
    ['a transaction today', 'unknown'],
    ['transaction for customer today', 'unknown'],
    ['transactions today', 'read'],
    ['show the rest of my sales', 'read'],
    ['who owes me the rest', 'read'],
    ['customer paid the rest', 'write'],
    ['paid the remainder', 'write'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 25: "have … made" asks for a record; a channel belongs to whoever
   * is named beside it, before or after; a contact token is a contact. */
  it.each([
    ['have an invoice made for Ada', 'unknown'],
    ['can we have the payment made to supplier', 'unknown'],
    ['please have the receipt made', 'unknown'],
    ['how much have we made this month?', 'read'],
    ['send me statement on supplier email', 'unknown'],
    ['send me statement on oga whatsapp', 'unknown'],
    ['send me statement on the whatsapp of customer', 'unknown'],
    ['send me statement on Ada number', 'unknown'],
    ['send me the report on PHONE_1', 'unknown'],
    ['send me the report on EMAIL_1', 'unknown'],
    ['send my debtors a reminder', 'unknown'],
    ['send my supplier the invoice', 'unknown'],
    ['send me sales to my number', 'read'],
    ['send me sales on work email', 'read'],
    ['send me sales for jan excel', 'read'],
    ['show number of sales', 'read'],
    ['export payments to suppliers', 'read'],
    ['list my debtors', 'read'],
    ['collect the rest from Ada', 'write'],
    ['PHONE_1 paid 5k', 'write'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 26: "the number", "another WhatsApp" are someone else's unless
   * "my"; a contact token is a destination only after a preposition or a
   * channel; "line" is no channel. */
  it.each([
    ['send me the invoice to the number I gave you', 'unknown'],
    ['send me the invoice to the number above', 'unknown'],
    ['send me the invoice to this number', 'unknown'],
    ['send me the invoice on another number', 'unknown'],
    ['send me the invoice on another whatsapp', 'unknown'],
    ['send me the invoice by new email', 'unknown'],
    ['send me my P&L on email EMAIL_1', 'unknown'],
    ['send me sales on my other phone', 'read'],
    ['send me sales on my new email', 'read'],
    ['PHONE_1 balance', 'read'],
    ['list invoices for PHONE_1', 'read'],
    ['send me PHONE_1 statement', 'read'],
    ['show me EMAIL_1 balance', 'read'],
    ['show my product line sales', 'read'],
    ['show sales by product line', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 27: "line" is a contact again outside "product line" and "line
   * by line"; a phone or email token is a contact unless it is plainly
   * the customer asked about. */
  it.each([
    ["send me the report on Ada's line", 'unknown'],
    ['send me the report on his line', 'unknown'],
    ['send me the report on CUSTOMER_1 line', 'unknown'],
    ['send me the report on the line I gave you', 'unknown'],
    ['show sales line by line', 'read'],
    ['send me sales on my line', 'read'],
    ['send me sales on the shop number', 'read'],
    ['send me sales on my other number', 'read'],
    ['send me the report PHONE_1', 'unknown'],
    ['send me the report bcc EMAIL_1', 'unknown'],
    ['send me the report with PHONE_1', 'unknown'],
    ['send me and PHONE_1 the report', 'unknown'],
    ['send me the report for EMAIL_1', 'unknown'],
    ["PHONE_1's balance", 'read'],
    ['what does PHONE_1 owe', 'read'],
    ['show transactions with PHONE_1', 'read'],
    ['show payments from PHONE_1', 'read'],
    ['sold rice to PHONE_1 5k', 'write'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Round 28: a token after a destination word stays a contact; "work",
   * "shop"… make a number the merchant's only after the/my/our or a
   * preposition; only "line by line" is no channel. */
  it.each([
    ['send me sales cc EMAIL_1 is my accountant', 'unknown'],
    ['send me the report on PHONE_1 is that ok', 'unknown'],
    ["send me the p&l on PHONE_1's", 'unknown'],
    ['send me sales on his personal number', 'unknown'],
    ["send me sales on my supplier's work number", 'unknown'],
    ['send me sales on CUSTOMER_1 work number', 'unknown'],
    ["send me sales on ada's office line", 'unknown'],
    ['send me sales on his line by evening', 'unknown'],
    ['send me sales on the other line by tomorrow', 'unknown'],
    ['send me sales on my work number', 'read'],
    ['send me sales on shop number', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  /* Final review A: a question run straight into someone doing trade, with
   * no comma or "and", states a record; a subject led by a question word,
   * an auxiliary or a determiner stays inside the question. */
  it.each([
    ['who owes me CUSTOMER_7K2 paid', 'unknown'],
    ['who owes me CUSTOMER_7K2 has paid', 'unknown'],
    ['who owes me CUSTOMER_7K2 settled', 'unknown'],
    ['who owes me she paid', 'unknown'],
    ['show sales today ada paid me', 'unknown'],
    ['wetin we sell today CUSTOMER_7K2 don pay', 'unknown'],
    ['how much does CUSTOMER_7K2 owe she has paid', 'unknown'],
    ['what did we sell today CUSTOMER_7K2 bought rice on credit', 'unknown'],
    ['how much did we spend today we paid rent', 'unknown'],
    ['how much did we sell this month i paid the supplier', 'unknown'],
    ['did CUSTOMER_7K2 pay me', 'read'],
    ['which customer paid', 'read'],
    ['how much has CUSTOMER_7K2 paid so far', 'read'],
    ['what did Mr. CUSTOMER_7K2 pay?', 'read'],
    ['what the customer bought', 'read'],
    ['how much we sell today', 'read'],
    ['show me what i sold today', 'read'],
    ['show me products sold today', 'read'],
    ['show expenses we paid this month', 'read'],
    ['list payments we received today', 'read'],
    ['have any invoices been fully cancelled?', 'read'],
  ] as const)('reads %j as %s', (text, kind) => {
    expect(requestKind(text)).toBe(kind);
  });

  it('is not fooled by a year into seeing money', () => {
    expect(requestKind('sales in 2026')).toBe('read');
    expect(requestKind('sold rice 2026k')).toBe('write');
    expect(requestKind('how much did we sell in 2026?')).toBe('read');
  });
});
