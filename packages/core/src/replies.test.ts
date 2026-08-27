/**
 * What Rekoda says back (MASTER-PLAN §5.3.4).
 *
 * Copy is a product surface and a bug in a string is still a bug. These assert
 * the three rules the file is built on: short enough to read on a phone, never
 * claiming something that has not happened, and naming what to do next.
 */
import { describe, expect, it } from 'vitest';
import * as replies from './replies.js';

/**
 * Every reply this file can produce, with arguments that stretch it.
 *
 * A list, and not a sample. The sweep below used to run over twelve of the
 * sixty-odd builders here and was called "every reply", which is the sort of
 * test that reads as coverage and is not: the length ceiling held for the
 * twelve nobody interpolates anything into, and nowhere else.
 *
 * Keyed by builder name so `is complete` can fail when somebody adds a reply
 * and forgets this file. Arguments are picked to be the long end of what
 * production passes: the widest figures, the fullest lists, the longest
 * product names a Nigerian shop actually types.
 */
const NAIRA_MILLIONS = 987_654_321;
const LONG_NAME = 'Ankara wax print bale, six yards, Hitarget';

const debtors: replies.DebtorLine[] = Array.from({ length: 8 }, (_, i) => ({
  invoiceNumber: `INV-2026-00000${i + 1}`,
  balanceDueK: 4_500_000 + i,
  daysOverdue: i * 9,
}));
const shelf: replies.StockLine[] = Array.from({ length: 20 }, (_, i) => ({
  name: `${LONG_NAME} ${i + 1}`,
  onHand: i,
}));

const ALL: Record<string, readonly replies.Reply[]> = {
  greeting: [replies.greeting()],
  help: [replies.help()],
  optedOut: [replies.optedOut()],
  optedIn: [replies.optedIn()],
  cancelled: [replies.cancelled()],
  confirmErasure: [replies.confirmErasure(), replies.confirmErasure(4)],
  confirmationLapsed: [replies.confirmationLapsed('that stock change')],
  erasureNotYours: [replies.erasureNotYours()],
  erasureDone: [replies.erasureDone(0), replies.erasureDone(12)],
  erasureKept: [replies.erasureKept()],
  viewOnlyRole: [replies.viewOnlyRole()],
  strayNumber: [replies.strayNumber()],
  clarification: [replies.clarification('Which invoice was that payment against?')],
  allowanceExhausted: [
    replies.allowanceExhausted(50),
    replies.allowanceExhausted(3, 'DOCUMENT_GENERATION'),
  ],
  ordersNotInPlan: [replies.ordersNotInPlan()],
  chatNotInPlan: [replies.chatNotInPlan()],
  trialEnded: [replies.trialEnded()],
  upgradeRequested: [replies.upgradeRequested()],
  quotaReachedForBusiness: [replies.quotaReachedForBusiness()],
  busyRightNow: [replies.busyRightNow()],
  couldNotRead: [replies.couldNotRead()],
  preview: [replies.preview(`Sale of ${LONG_NAME} to CUSTOMER_7K2 for ₦450,000, ₦100,000 paid.`)],
  arithmeticQuestion: [replies.arithmeticQuestion('45,000 times 12 is 540,000.')],
  alreadyConfirmed: [replies.alreadyConfirmed()],
  nothingToConfirm: [replies.nothingToConfirm()],
  correctionTaken: [replies.correctionTaken()],
  issued: [replies.issued('INV-2026-000041', NAIRA_MILLIONS, NAIRA_MILLIONS)],
  documentSent: [replies.documentSent('INV-2026-000041')],
  paymentConfirmed: [
    replies.paymentConfirmed(NAIRA_MILLIONS, 'INV-2026-000041', 'RCT-2026-000007'),
  ],
  paymentRecorded: [
    replies.paymentRecorded('RCT-2026-000007', NAIRA_MILLIONS, 'INV-2026-000041', NAIRA_MILLIONS),
  ],
  receiptRecordedReady: [
    replies.receiptRecordedReady(NAIRA_MILLIONS, 'INV-2026-000041', 'RCT-2026-000007'),
  ],
  paymentNoOpenInvoice: [replies.paymentNoOpenInvoice()],
  paymentWhichInvoice: [replies.paymentWhichInvoice(1), replies.paymentWhichInvoice(37)],
  paymentAlreadySettled: [replies.paymentAlreadySettled('INV-2026-000041')],
  paymentBalanceMoved: [
    replies.paymentBalanceMoved('INV-2026-000041', 0, NAIRA_MILLIONS),
    replies.paymentBalanceMoved('INV-2026-000041', NAIRA_MILLIONS, 0),
  ],
  paymentLinkReady: [
    replies.paymentLinkReady(
      'INV-2026-000041',
      NAIRA_MILLIONS,
      'https://checkout.paystack.com/0123456789abcdefghijklmnop',
    ),
  ],
  catalogueCheckout: [
    replies.catalogueCheckout(
      'INV-2026-000041',
      NAIRA_MILLIONS,
      'https://checkout.paystack.com/0123456789abcdefghijklmnop',
    ),
    replies.catalogueCheckout('INV-2026-000041', NAIRA_MILLIONS, null),
  ],
  catalogueOrderDelivered: [replies.catalogueOrderDelivered('INV-2026-000041', NAIRA_MILLIONS)],
  catalogueOrderNoLink: [replies.catalogueOrderNoLink('INV-2026-000041', NAIRA_MILLIONS)],
  paymentLinkSettled: [replies.paymentLinkSettled('INV-2026-000041')],
  paymentLinkUnavailable: [replies.paymentLinkUnavailable()],
  paymentLinkNothingOwed: [replies.paymentLinkNothingOwed()],
  paymentLinkNeedsConnection: [replies.paymentLinkNeedsConnection()],
  paymentLinkNeedsEmail: [replies.paymentLinkNeedsEmail('INV-2026-000041')],
  debtorList: [
    replies.debtorList([], 0, 0),
    replies.debtorList(debtors, NAIRA_MILLIONS, 8),
    /* The overflow shape: eight shown out of forty five. */
    replies.debtorList(debtors, NAIRA_MILLIONS, 45),
  ],
  overdueReminder: [
    replies.overdueReminder({
      invoiceNumber: 'INV-2026-000041',
      balanceDueK: NAIRA_MILLIONS,
      daysOverdue: 94,
      businessName: 'Mama Ngozi Fabrics and General Merchandise Enterprises',
    }),
  ],
  reminderReady: [replies.reminderReady('INV-2026-000041')],
  reminderNothingToChase: [replies.reminderNothingToChase('INV-2026-000041')],
  voiceUnavailable: [replies.voiceUnavailable()],
  voiceTooLong: [replies.voiceTooLong(120), replies.voiceTooLong(90), replies.voiceTooLong(60)],
  voiceUnreadable: [replies.voiceUnreadable()],
  salesAnswer: [
    replies.salesAnswer({
      label: 'this month',
      salesK: NAIRA_MILLIONS,
      invoices: 412,
      moneyInK: NAIRA_MILLIONS,
    }),
  ],
  expensesAnswer: [
    replies.expensesAnswer({ label: 'this month', moneyOutK: NAIRA_MILLIONS, expenses: 412 }),
  ],
  customerBalanceAnswer: [
    replies.customerBalanceAnswer([], 0),
    replies.customerBalanceAnswer(debtors, NAIRA_MILLIONS),
  ],
  suppliersAnswer: [replies.suppliersAnswer(0), replies.suppliersAnswer(NAIRA_MILLIONS)],
  unreconciledAnswer: [replies.unreconciledAnswer(0), replies.unreconciledAnswer(412)],
  reportRequestAnswer: [replies.reportRequestAnswer()],
  dashboardLink: [
    replies.dashboardLink('https://app.rekoda.ng/s/0123456789abcdefghijklmnopqrstuv', 15),
  ],
  dashboardUnavailable: [replies.dashboardUnavailable()],
  recordsSummary: [
    replies.recordsSummary({
      salesK: NAIRA_MILLIONS,
      moneyInK: NAIRA_MILLIONS,
      moneyOutK: NAIRA_MILLIONS,
      owedToYouK: NAIRA_MILLIONS,
    }),
  ],
  resending: [replies.resending('INV-2026-000041')],
  nothingToResend: [replies.nothingToResend()],
  onlyText: [replies.onlyText()],
  linkQuestion: [{ text: replies.linkQuestion('CUSTOMER_7K2', 'CUSTOMER_9M4') }],
  photoUnavailable: [replies.photoUnavailable()],
  notYet: [replies.notYet('Your debtor list')],
  expenseSaved: [replies.expenseSaved(NAIRA_MILLIONS, `Diesel for the generator, ${LONG_NAME}`)],
  orderRaised: [replies.orderRaised('ORD-2026-000041', 'INV-2026-000041', NAIRA_MILLIONS)],
  purchaseSaved: [
    replies.purchaseSaved(NAIRA_MILLIONS, NAIRA_MILLIONS),
    replies.purchaseSaved(NAIRA_MILLIONS, 0, { name: LONG_NAME, onHand: 412 }),
  ],
  noAccount: [replies.noAccount()],
  stockList: [
    replies.stockList([], 0, 0),
    replies.stockList(shelf, 20, 1),
    /* Twenty of forty five, with empty shelves the page could not all show. */
    replies.stockList(shelf, 45, 6),
  ],
  stockSaved: [replies.stockSaved(LONG_NAME, 412, 412), replies.stockSaved(LONG_NAME, -412, 0)],
  graduationNudge: [replies.graduationNudge(NAIRA_MILLIONS, 200_000_000)],
};

/* Exported, and deliberately not a reply builder. `isSendable` and
 * `truncateForSending` are the gate the replies pass through rather than
 * things it produces; `MAX_REPLY_CHARS` is the number they are measured
 * against. Everything else in the module has to be in ALL. */
const NOT_A_REPLY_BUILDER = new Set(['isSendable', 'truncateForSending']);

const EVERY_REPLY = Object.values(ALL).flat();

describe('every reply', () => {
  /**
   * The test that keeps the sweep honest.
   *
   * Without it, a new builder ships uncovered and the suite still reports
   * "every reply" passing, which is how the length ceiling came to be
   * enforced on twelve messages out of sixty-odd.
   */
  it('is in this file, including the one somebody just added', () => {
    const exported = Object.entries(replies)
      .filter(([name, value]) => typeof value === 'function' && !NOT_A_REPLY_BUILDER.has(name))
      .map(([name]) => name);
    expect(exported.sort()).toEqual(Object.keys(ALL).sort());
  });

  it('is short enough to read without tapping "Read more"', () => {
    for (const reply of EVERY_REPLY) {
      expect(replies.isSendable(reply), reply.text).toBe(true);
      expect(reply.text.length).toBeLessThanOrEqual(replies.MAX_REPLY_CHARS);
    }
  });

  it('never uses an em or en dash, which no merchant types', () => {
    for (const reply of EVERY_REPLY) {
      expect(reply.text, reply.text).not.toMatch(/[–—]/);
    }
  });

  /**
   * The single worst thing a bookkeeping assistant can say is "Saved!" about
   * something that was not.
   *
   * Curated on purpose, and the one sweep here that is NOT over everything:
   * `issued`, `expenseSaved` and their neighbours are sent after a write and
   * are supposed to claim one. These are the replies sent when nothing has
   * been written, where a claim would be a lie.
   */
  const NOTHING_WAS_WRITTEN = [
    replies.greeting(),
    replies.help(),
    replies.optedOut(),
    replies.optedIn(),
    replies.cancelled(),
    replies.confirmErasure(),
    replies.strayNumber(),
    replies.quotaReachedForBusiness(),
    replies.busyRightNow(),
    replies.couldNotRead(),
    replies.notYet('Your debtor list'),
    replies.noAccount(),
    replies.voiceUnavailable(),
    replies.photoUnavailable(),
    replies.onlyText(),
    replies.trialEnded(),
    replies.allowanceExhausted(50),
    replies.nothingToConfirm(),
    replies.nothingToResend(),
    replies.dashboardUnavailable(),
    replies.paymentLinkUnavailable(),
    replies.paymentLinkNeedsConnection(),
  ];

  it('never claims a record was saved when none was', () => {
    for (const reply of NOTHING_WAS_WRITTEN) {
      // Affirmative claims only: "Cancelled. Nothing was saved." must not
      // match, so the regex targets the claim rather than the word.
      expect(reply.text, reply.text).not.toMatch(
        /\b(?:saved!|i(?:'ve| have)? saved|has been saved|recorded it|invoice sent|receipt sent)\b/i,
      );
    }
  });

  it('does not apologise its way through a failure', () => {
    // "Something went wrong" wastes the one message a merchant will read.
    for (const reply of [replies.busyRightNow(), replies.couldNotRead()]) {
      expect(reply.text).not.toMatch(/something went wrong|an error occurred|try again later\.$/i);
    }
  });
});

describe('the stock list', () => {
  const shelf = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ name: `Product ${from + i + 1}`, onHand: from + i }));

  it('says how many products it did not show', () => {
    /* The bug this exists for: twenty rows handed to a merchant who has forty
     * five products, presented as the whole shop. A merchant reading it
     * concludes twenty five of their products stopped being counted. */
    const text = replies.stockList(shelf(20), 45, 0).text;
    expect(text).toContain('...and 25 more on your dashboard.');
  });

  it('says nothing about overflow when there is none', () => {
    const text = replies.stockList(shelf(3), 3, 0).text;
    expect(text).not.toContain('more on your dashboard');
  });

  it('counts empty shelves across the shop, not across the page', () => {
    /* Six have run out; the page had room for the one at the top. Counting
     * the page would tell the merchant one shelf is empty when six are. */
    const rows = [{ name: 'Rice', onHand: 0 }, ...shelf(19, 1)];
    expect(replies.stockList(rows, 45, 6).text).toContain('6 of them have run out.');
  });

  it('names the one that ran out when only one has', () => {
    const rows = [{ name: 'Bags of rice', onHand: 0 }, ...shelf(4, 1)];
    expect(replies.stockList(rows, 5, 1).text).toContain('You have run out of Bags of rice.');
  });

  /**
   * The reason the rows are fitted to a budget rather than left to the
   * backstop.
   *
   * `truncateForSending` slices at a character. On a list that means the last
   * rows go, and so do the two lines that say what was left out and what has
   * run out: the merchant is handed a partial list with nothing saying it is
   * partial, which is the exact failure this whole reply exists to prevent.
   */
  it('drops rows rather than let the message be cut off mid list', () => {
    const long = Array.from({ length: 20 }, (_, i) => ({
      name: `Ankara wax print bale, six yards, Hitarget ${i + 1}`,
      onHand: i + 1,
    }));
    const built = replies.stockList(long, 45, 3);
    expect(replies.isSendable(built)).toBe(true);
    expect(replies.truncateForSending(built).text).toBe(built.text);
    // Fewer rows than it was handed, and the count under them still true.
    const shown = built.text.split('\n').filter((l) => l.startsWith('Ankara')).length;
    expect(shown).toBeLessThan(20);
    expect(built.text).toContain(`...and ${45 - shown} more on your dashboard.`);
    expect(built.text).toContain('3 of them have run out.');
  });

  it('shows one row even when the name alone fills the message', () => {
    // A list with no rows in it is not a stock list, and nothing is behind us.
    const text = replies.stockList([{ name: 'x'.repeat(2_000), onHand: 4 }], 9, 0).text;
    expect(text).toContain('x'.repeat(2_000));
    expect(text).toContain('...and 8 more on your dashboard.');
  });

  it('does not offer a dashboard to a merchant counting nothing', () => {
    const text = replies.stockList([], 0, 0).text;
    expect(text).toMatch(/not counting any stock yet/i);
    expect(text).toContain('add 20 bags of rice');
  });
});

describe('the failures each say something different', () => {
  it('tells a merchant at their own limit when it resets', () => {
    const text = replies.quotaReachedForBusiness().text;
    expect(text).toMatch(/limit/i);
    expect(text).toMatch(/midnight/i);
    // And what still works, so the message is not a dead end.
    expect(text).toMatch(/who owes me|records/i);
  });

  it('does not blame the merchant when the platform is busy', () => {
    const text = replies.busyRightNow().text;
    expect(text).toMatch(/busy/i);
    expect(text).toMatch(/nothing was lost/i);
    expect(text).not.toMatch(/you (?:sent|typed|wrote) .*(?:wrong|incorrectly)/i);
  });

  it('shows the shape of a message that works when it could not read one', () => {
    // Cheaper than an explanation, and it is what the merchant needs.
    expect(replies.couldNotRead().text).toMatch(/sold .* for .*k/i);
  });
});

describe('erasure', () => {
  it('asks for confirmation and says plainly what is lost', () => {
    const text = replies.confirmErasure().text;
    expect(text).toMatch(/cannot be undone/i);
    expect(text).toMatch(/DELETE MY DATA/);
    // The one place a second message is worth the friction: an accidental
    // deletion cannot be undone by any amount of apology.
    expect(text).toMatch(/again to confirm/i);
  });
});

describe('the money-in moment', () => {
  it('leads with the confirmed figure and names both documents', () => {
    const text = replies.paymentConfirmed(15_000_000, 'INV-2026-000041', 'RCT-2026-000007').text;
    expect(text).toMatch(/^Money in ✅ ₦150,000 confirmed for INV-2026-000041\./);
    expect(text).toContain('RCT-2026-000007');
    // The receipt travels WITH this message, and the merchant's next move is
    // in it — not implied.
    expect(text).toMatch(/attached/i);
    expect(text).toMatch(/forward it to your customer/i);
  });

  it('stays sendable and free of em or en dashes', () => {
    const candidate = replies.paymentConfirmed(123_456_789, 'INV-2026-000001', 'RCT-2026-000001');
    expect(replies.isSendable(candidate)).toBe(true);
    expect(candidate.text).not.toMatch(/[–—]/);
  });
});

describe('a capability that is not built', () => {
  it('says so, and says what does work', () => {
    const text = replies.notYet('Your debtor list').text;
    expect(text).toContain('Your debtor list');
    expect(text).toMatch(/not ready yet/i);
    // This list is a capability CLAIM: it may only name what actually ships.
    // "payments" stays out until RecordPayment is wired end to end.
    expect(text).toMatch(/sales, expenses and stock purchases/i);
    expect(text).not.toMatch(/\bpayments\b/i);
  });
});

describe('sending guards', () => {
  it('refuses an empty reply', () => {
    expect(replies.isSendable({ text: '' })).toBe(false);
    expect(replies.isSendable({ text: '   ' })).toBe(false);
  });

  it('truncates rather than sending nothing', () => {
    // A model's clarification is interpolated verbatim, so the length ceiling
    // has to survive one that runs long.
    const long = { text: 'x'.repeat(5_000) };
    const trimmed = replies.truncateForSending(long);
    expect(trimmed.text.length).toBe(replies.MAX_REPLY_CHARS);
    expect(trimmed.text.endsWith('…')).toBe(true);
    expect(replies.isSendable(trimmed)).toBe(true);
  });

  it('leaves an ordinary reply untouched', () => {
    expect(replies.truncateForSending(replies.greeting()).text).toBe(replies.greeting().text);
  });

  it('passes a clarification through as the model wrote it', () => {
    expect(replies.clarification('  How many wigs?  ').text).toBe('How many wigs?');
  });
});
