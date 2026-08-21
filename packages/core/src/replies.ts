/**
 * What Rekoda says back (MASTER-PLAN §5.3.4).
 *
 * Copy lives here, as pure functions, for two reasons. It is the product
 * surface most merchants will ever see — every one of these lines is read on a
 * phone, in a shop, by someone with thirty seconds — so it deserves to be in
 * one reviewable place rather than scattered through handlers. And it is
 * testable: a message that promises something the system cannot do is a bug,
 * and a bug in a string is still a bug.
 *
 * Three rules run through all of it.
 *
 * 1. **Short.** WhatsApp shows about three lines before "Read more". Anything
 *    past that is a message the merchant has to work to read.
 * 2. **Never claim what has not happened.** "Saved!" before a document exists
 *    is the single worst thing a bookkeeping assistant can say.
 * 3. **A failure names what to do next.** "Something went wrong" wastes the
 *    one message the merchant will actually read.
 */

import type { UsageUnit } from './allowances.js';
import { formatKobo } from './money.js';

/** Every message carries the tokens it was built with, un-rehydrated. */
export interface Reply {
  /** May contain CUSTOMER_x tokens. Rehydrated at the very last moment. */
  readonly text: string;
}

const reply = (text: string): Reply => ({ text });

export function greeting(): Reply {
  return reply(
    'Hello 👋 I keep your books. Tell me a sale the way you would tell a person, ' +
      'like "Ada bought 3 wigs for 150k, paid 100k", and I will record it.\n\n' +
      'Type *help* to see everything I can do.',
  );
}

export function help(): Reply {
  return reply(
    'Here is what I can do:\n\n' +
      '• *Record a sale*: "sold 2 bags to Ada for 40k"\n' +
      '• *Record a payment*: "Ada paid 20k"\n' +
      '• *Record an expense*: "fuel 12k"\n' +
      '• *Record stock*: "bought 10 crates of ankara for 50k"\n' +
      '• *who owes me* shows your debtors\n' +
      '• *remind INV-2026-000004* writes a reminder you can forward\n' +
      "• *records* shows this month's totals\n" +
      '• *payment details* sends a payment link\n' +
      '• *resend* sends your last document again\n\n' +
      'Reply *STOP* at any time to stop messages.',
  );
}

export function optedOut(): Reply {
  return reply(
    'Done. I will not message you again. Your records are untouched and still ' +
      'yours.\n\nReply *START* whenever you want me back.',
  );
}

export function optedIn(): Reply {
  return reply('Welcome back 👋 Tell me a sale whenever you are ready.');
}

export function cancelled(): Reply {
  return reply('Cancelled. Nothing was saved.');
}

/**
 * Erasure is confirmed, never performed on the first ask.
 *
 * The one place in the product where a second message is worth the friction:
 * an accidental deletion of a merchant's books cannot be undone by any amount
 * of apology.
 */
export function confirmErasure(draftsDiscarded = 0): Reply {
  const lines = [
    'You are asking me to delete your data. This removes your customers and ' +
      'their details permanently and cannot be undone.',
  ];
  /* Asking to erase clears whatever was waiting for a yes, and the merchant
   * has to be told: a sale they previewed a minute ago silently vanishing is
   * how a shop ends up with a day's takings unrecorded. */
  if (draftsDiscarded > 0) {
    lines.push(
      draftsDiscarded === 1
        ? 'The entry that was waiting for your yes has been dropped. Send it again after this.'
        : `The ${draftsDiscarded} entries waiting for your yes have been dropped. Send them again after this.`,
    );
  }
  lines.push('Reply *DELETE MY DATA* again to confirm, or anything else to keep it.');
  return reply(lines.join('\n\n'));
}

/**
 * Erasure asked for by somebody who is not the owner.
 *
 * Deleting every customer's contact details is irreversible and business
 * wide, so it is the owner's decision and nobody else's. Says who can rather
 * than only who cannot, so the person asking knows what to do next.
 */
export function erasureNotYours(): Reply {
  return reply(
    'Only the business owner can delete customer data, because it cannot be ' +
      'undone. Ask them to send "delete my data" from their own number.',
  );
}

/**
 * Erasure, performed. The count makes the claim checkable: a merchant who
 * knows they had customers and reads "0 records" knows to ask questions.
 */
export function erasureDone(erasedFacets: number): Reply {
  return reply(
    `Done. Your customers' saved details are deleted (${erasedFacets} ` +
      `record${erasedFacets === 1 ? '' : 's'}). Your invoices and books keep only their ` +
      'reference numbers.\n\nFor anything more, including your conversations and account, ' +
      'see rekoda.app/data-deletion.',
  );
}

/** The merchant asked to delete, then said anything but the confirm phrase. */
export function erasureKept(): Reply {
  return reply('Kept. Nothing was deleted.');
}

/**
 * A number, with no question waiting for one.
 *
 * Sending "I did not understand" here would be a small lie — the number was
 * perfectly clear, there was just nothing to apply it to.
 */
export function strayNumber(): Reply {
  return reply(
    'I am not sure what that number is for. Tell me the whole thing, like ' +
      '"sold 3 wigs for 150k", and I will record it.',
  );
}

/**
 * The model asked a question. Passed through verbatim, and it is one question
 * by contract: a merchant on a phone answers one and abandons a list.
 */
export function clarification(question: string): Reply {
  return reply(question.trim());
}

/**
 * The MONTHLY allowance ran out (docs/metering-v1.md §3) — a doorway, not a
 * wall. Says exactly three things: what ran out, that nothing was lost, and
 * the two ways to continue. Reading is never gated, so the free commands are
 * named rather than implied. The merchant who hits this is the product
 * working, and the message must feel that way.
 */
export function allowanceExhausted(allowance: number, unit: UsageUnit = 'messages'): Reply {
  return reply(
    `You have used all ${allowance} ${UNIT_WORDS[unit]} in your plan this month. ` +
      'Nothing is lost. Your records are safe, and *who owes me*, *payment details* and ' +
      'your dashboard still work.\n\n' +
      'Reply *upgrade* and we will move you to a bigger plan.',
  );
}

/**
 * Each unit said the way a merchant would say it.
 *
 * The doorway reply names what ran out, and "you have used all 25 documents"
 * has to read as a sentence about invoices and receipts rather than about a
 * column name — a merchant who cannot tell which limit they hit cannot tell
 * which plan would fix it.
 */
const UNIT_WORDS: Record<UsageUnit, string> = {
  messages: 'messages',
  voice_seconds: 'seconds of voice notes',
  documents: 'invoices and receipts',
  documents_understood: 'document scans',
  orders: 'orders',
};

/**
 * The 30-day trial is over.
 *
 * Not the same message as a used-up allowance, because it is not the same
 * event: the books are still theirs, still readable, still exportable, and
 * what ended is the free recording. Reading is never gated, so the free
 * commands are named rather than implied.
 */
export function trialEnded(): Reply {
  return reply(
    'Your 30-day free trial has ended. Everything you recorded is still yours: ' +
      '*who owes me*, *records*, *payment details* and your dashboard all still work.\n\n' +
      'Reply *upgrade* to keep recording and we will set you up.',
  );
}

/**
 * A merchant asked to pay us. The one message that must never bounce off a
 * dead end: it is logged as a request a human answers, and it says so
 * plainly rather than pointing at a self-service page that does not exist.
 */
export function upgradeRequested(): Reply {
  return reply(
    'Noted 👍 We have your upgrade request and will reach you on this number to ' +
      'set it up.\n\nYour records are safe in the meantime.',
  );
}

/** The daily ceiling refused this merchant. Their own budget, their own day. */
export function quotaReachedForBusiness(): Reply {
  return reply(
    'You have reached today’s limit for messages I need to think about. ' +
      'It resets at midnight.\n\n' +
      'Short commands still work. Try *who owes me* or *payment details*.',
  );
}

/** The platform ceiling. Not the merchant's fault, and it should not read as if it were. */
export function busyRightNow(): Reply {
  return reply(
    'I am very busy right now and could not read that properly. Please send it ' +
      'again in a few minutes. Nothing was lost.',
  );
}

/**
 * We reached the model and could not use what came back.
 *
 * Deliberately does not apologise for the merchant's phrasing. Usually the
 * sentence was fine and we were not.
 */
export function couldNotRead(): Reply {
  return reply(
    'I could not turn that into a record. Try it as one line with the amount, ' +
      'like "sold 3 wigs to Ada for 150k, paid 100k".',
  );
}

/**
 * CG2 — the preview, verbatim from the gate.
 *
 * Passed through rather than reformatted here, because the gate already
 * decided which figures a merchant must see and reformatting is how a line
 * quietly goes missing.
 */
export function preview(text: string): Reply {
  return reply(text.trim());
}

/** CG1 — the one arithmetic question, verbatim from the gate. */
export function arithmeticQuestion(text: string): Reply {
  return reply(text.trim());
}

/**
 * The confirmation lost its race (CG3).
 *
 * Silence would be wrong — the merchant tapped twice and deserves to know it
 * worked — but so would apologising for a success.
 */
export function alreadyConfirmed(): Reply {
  return reply('Already saving that one 👍');
}

/** A "yes" with nothing outstanding to say yes to. */
export function nothingToConfirm(): Reply {
  return reply(
    'There is nothing waiting for a yes. Tell me a sale and I will show it to ' +
      'you before saving.',
  );
}

/** CG5 — the correction landed and replaced what came before. */
export function correctionTaken(): Reply {
  return reply('Got it. I have replaced the earlier version.');
}

/**
 * The document exists. The FIRST message in this file allowed to say so.
 *
 * The number is in it because that is what a merchant quotes down the phone
 * when a customer asks, and the balance is in it because "what is still owed"
 * is the question they will be asked next.
 */
export function issued(documentNumber: string, totalK: number, balanceDueK: number): Reply {
  const lines = [`Saved ✅ ${documentNumber} for ${formatKobo(totalK)}.`];
  if (balanceDueK > 0) lines.push(`${formatKobo(balanceDueK)} still owed.`);
  return reply(lines.join('\n'));
}

/** Kobo → ₦, no decimals when there are none. Mirrors the money engine. */

/**
 * The caption above a delivered document.
 *
 * Names the document, because that is what a merchant needs when they forward
 * it to a customer and when they look for it again in three weeks. It does not
 * repeat the total — the total is on the document, and a caption that restates
 * a figure is a second place for that figure to be wrong.
 */
export function documentSent(reference: string): Reply {
  return reply(`${reference} is ready. Here is your copy. Forward it to your customer.`);
}

/**
 * The caption above a delivered RECEIPT — which is also the owner's payment
 * notification, in one message instead of two.
 *
 * This is the moment the product exists for, so the first word is the news.
 * "Confirmed" is load-bearing: it means the provider said so server-side
 * (PAYMENT_PROVIDER_CONFIRMED), never that someone showed a screenshot. The
 * amount IS repeated here, unlike an invoice caption, because a merchant
 * deciding whether to release goods should not have to open a PDF first.
 */
export function paymentConfirmed(
  amountK: number,
  invoiceNumber: string,
  receiptNumber: string,
): Reply {
  return reply(
    `Money in ✅ ${formatKobo(amountK)} confirmed for ${invoiceNumber}.\n` +
      `Receipt ${receiptNumber} is attached. Forward it to your customer.`,
  );
}

/**
 * A payment the MERCHANT reported, recorded against an invoice.
 *
 * Deliberately not the same message as `paymentConfirmed`: that one says
 * "confirmed" because a provider verified it server-side, and this one must
 * never borrow that word (ADR 0014). What it can promise is what actually
 * happened — the books moved, a receipt exists, and this is what is left.
 */
export function paymentRecorded(
  receiptNumber: string,
  amountK: number,
  invoiceNumber: string,
  balanceDueK: number,
): Reply {
  const lines = [`Saved ✅ ${formatKobo(amountK)} recorded against ${invoiceNumber}.`];
  lines.push(
    balanceDueK === 0
      ? 'That settles it. Nothing left owing.'
      : `${formatKobo(balanceDueK)} still owed.`,
  );
  lines.push(`Receipt ${receiptNumber} is on its way.`);
  return reply(lines.join('\n'));
}

/**
 * The receipt for a merchant-reported payment, arriving as a document.
 *
 * The delivery caption for `paymentRecorded`, and the same discipline: the
 * merchant forwards this message with the PDF attached, so it says the
 * receipt is theirs to send and never that anybody confirmed the money.
 */
export function receiptRecordedReady(
  amountK: number,
  invoiceNumber: string,
  receiptNumber: string,
): Reply {
  return reply(
    `Receipt ${receiptNumber} for ${formatKobo(amountK)} on ${invoiceNumber} is ` +
      'attached. Forward it to your customer.',
  );
}

/**
 * They reported a payment and there is nothing open to put it against.
 *
 * Never invents an allocation. An unattached payment in a bookkeeping system
 * is money with no story, and the merchant is the only one who knows which
 * invoice they meant.
 */
export function paymentNoOpenInvoice(): Reply {
  return reply(
    'I could not find an unpaid invoice for that customer. Tell me the invoice ' +
      'number, like "INV-2026-000004 paid 20k", or record the sale first and I will ' +
      'take the payment against it.',
  );
}

/**
 * They reported a payment, named nobody, and more than one invoice is open.
 *
 * The newest is not the answer. A merchant who says "received 20k" after
 * issuing three invoices this morning has told us the amount and nothing
 * else, and guessing puts a customer's money on another customer's account
 * where nobody will look for it again.
 */
export function paymentWhichInvoice(openCount: number): Reply {
  return reply(
    `You have ${openCount} unpaid invoices open, so I do not want to guess which ` +
      'one this is. Tell me the invoice number, like "INV-2026-000004 paid 20k", ' +
      'or say the customer, like "Ada paid 20k".',
  );
}

/**
 * The invoice was settled between the preview and the yes.
 *
 * A provider payment landing in that window is the ordinary cause, and the
 * merchant is owed the reason rather than silence. Nothing is posted: the
 * money is already on the books, and recording it twice would put the
 * customer in credit for a payment they made once.
 */
export function paymentAlreadySettled(invoiceNumber: string): Reply {
  return reply(
    `${invoiceNumber} was already paid off before I could record that, so I have ` +
      'not added it twice. Check the payments list, and if this is a separate ' +
      'payment tell me which invoice it belongs to.',
  );
}

/**
 * The invoice owes less than the merchant just reported.
 *
 * Between the preview and the write a provider payment landed, so part of
 * their figure has nowhere to go. Nothing is posted: applying what fits and
 * dropping the rest would leave real money with no story, and only the
 * merchant knows whether the excess is a second invoice, a deposit, or a
 * mistake.
 */
export function paymentBalanceMoved(
  invoiceNumber: string,
  balanceDueK: number,
  excessK: number,
): Reply {
  return reply(
    `${invoiceNumber} only has ${formatKobo(balanceDueK)} owing now, which is ` +
      `${formatKobo(excessK)} less than you said. Another payment came in while you ` +
      'were typing, so I have not recorded anything. Tell me the amount to put on ' +
      'this invoice, or which invoice the rest belongs to.',
  );
}

/* ── collecting money: the payment-details command ───────────────────────── */

/**
 * The payment link, ready to forward. The figure is repeated here because the
 * merchant forwards this message as-is and the customer decides from it.
 */
export function paymentLinkReady(
  invoiceNumber: string,
  amountK: number,
  checkoutUrl: string,
): Reply {
  return reply(
    `Payment link for ${invoiceNumber}: ${formatKobo(amountK)} outstanding.\n${checkoutUrl}\n\n` +
      'Forward it to your customer. I will tell you the moment the money lands, ' +
      'and the receipt follows by itself.',
  );
}

/** The latest invoice settled between the ask and the mint. Scoped to that
 * invoice only: another may still be open, and "who owes me" is the answer. */
export function paymentLinkSettled(invoiceNumber: string): Reply {
  return reply(
    `${invoiceNumber} is fully paid. Nothing to collect on it. ` +
      'Ask *who owes me* to see what is still open.',
  );
}

/** The provider could not be reached or refused the link. Not the merchant's
 * doing, so the message never blames their records. */
export function paymentLinkUnavailable(): Reply {
  return reply(
    'I could not reach your payment provider just now, so there is no link yet. ' +
      'Try *payment details* again in a few minutes. Nothing was lost.',
  );
}

/** Nothing is owed, so there is nothing to collect. */
export function paymentLinkNothingOwed(): Reply {
  return reply(
    'Every invoice you have issued is fully paid, so there is nothing to collect. ' +
      'Record a sale first and I can make a payment link for it.',
  );
}

/** Collection needs a settlement account first (§47 posture: honest, never a dead link). */
export function paymentLinkNeedsConnection(): Reply {
  return reply(
    'To collect payments straight to your bank, first add your settlement account ' +
      'at rekoda.app under Payments. It takes one minute, once.',
  );
}

/** The provider requires an email Rekoda does not hold for this customer. */
export function paymentLinkNeedsEmail(invoiceNumber: string): Reply {
  return reply(
    `To make a payment link for ${invoiceNumber}, your payment provider needs the ` +
      'customer’s email address, and I do not have one for them yet. ' +
      'Adding customer details by chat is coming.',
  );
}

/* ── who owes me ─────────────────────────────────────────────────────────── */

export interface DebtorLine {
  invoiceNumber: string;
  balanceDueK: number;
  /** Whole Lagos days past the promised day. Absent or 0 when not late. */
  daysOverdue?: number;
}

/**
 * The debtor list, answered from the ledger. Invoice numbers only, never
 * customer names: this reply crosses WhatsApp in plain text.
 */
export function debtorList(rows: DebtorLine[], totalK: number, count: number): Reply {
  if (count === 0) {
    return reply('Nobody owes you right now. Every invoice you have issued is fully paid.');
  }
  /* How late, on the line the merchant reads. This is the difference between
   * a list and a work queue: "INV-000004: ₦20,000" tells them nothing about
   * who to call first, and the rows arrive oldest-promise-first for exactly
   * that reason. Still invoice numbers and never customer names, because
   * WhatsApp is plaintext. */
  const lines = rows.map((r) => {
    const late =
      r.daysOverdue && r.daysOverdue > 0
        ? r.daysOverdue === 1
          ? ' (1 day late)'
          : ` (${r.daysOverdue} days late)`
        : '';
    return `${r.invoiceNumber}: ${formatKobo(r.balanceDueK)}${late}`;
  });
  const overdueCount = rows.filter((r) => (r.daysOverdue ?? 0) > 0).length;
  const heading =
    count === 1
      ? `One invoice is unpaid: ${formatKobo(totalK)} owed to you.`
      : `${count} invoices are unpaid: ${formatKobo(totalK)} owed to you in total.`;
  const chase =
    overdueCount > 0
      ? `\n\n${overdueCount === 1 ? 'One is' : `${overdueCount} are`} past the day it was promised.`
      : '';
  const overflow =
    count > rows.length ? `\n...and ${count - rows.length} more on your dashboard.` : '';
  return reply(`${heading}${chase}\n\n${lines.join('\n')}${overflow}`);
}

/**
 * A reminder the merchant FORWARDS, unedited, to the person who owes them.
 *
 * Written to be read by the customer rather than by the merchant, which is
 * the whole difference between this and every other reply in this file. That
 * means no Rekoda voice, no emoji, no "your merchant asked me to" — a
 * chasing message that announces it was generated is a chasing message that
 * gets ignored.
 *
 * ONE invoice, never a list. The merchant forwards this into a private
 * conversation, and a list would carry other customers' invoice numbers and
 * balances to somebody with no business seeing them. That is the reason it
 * takes an invoice number rather than answering "remind everybody".
 *
 * No name in it, from either side of the transaction: this text crosses
 * WhatsApp in the clear and the merchant is the one who knows who they are
 * sending it to.
 */
export function overdueReminder(input: {
  invoiceNumber: string;
  balanceDueK: number;
  daysOverdue: number;
  businessName: string;
}): Reply {
  const when =
    input.daysOverdue <= 0
      ? 'now due'
      : input.daysOverdue === 1
        ? 'one day overdue'
        : `${input.daysOverdue} days overdue`;
  return reply(
    `Hello, a friendly reminder about invoice ${input.invoiceNumber} from ` +
      `${input.businessName}. The balance of ${formatKobo(input.balanceDueK)} is ${when}. ` +
      'If you have already sent it, please ignore this message and accept our thanks.',
  );
}

/** The reminder, handed over with an instruction meant for the merchant. */
export function reminderReady(invoiceNumber: string): Reply {
  return reply(
    `Here is a reminder for ${invoiceNumber}. Forward the next message to your ` +
      'customer as it is.',
  );
}

/** Asked to chase an invoice that is settled, or was never issued. */
export function reminderNothingToChase(invoiceNumber: string): Reply {
  return reply(
    `${invoiceNumber} has nothing owing on it, so there is nothing to chase. ` +
      'Send *who owes me* to see what is still open.',
  );
}

/**
 * A voice note arrived and could not be turned into words.
 *
 * The provider was unreachable, or our own transcriber was. Either way it is
 * OUR failure, so it says so and it costs the merchant nothing: no allowance
 * moved, and the way forward is one line rather than an apology.
 */
export function voiceUnavailable(): Reply {
  return reply(
    'I could not listen to that voice note just now. Type it instead and I will ' +
      'record it, or send the voice note again in a minute.',
  );
}

/* ── the records command ─────────────────────────────────────────────────── */

/**
 * "records" answered from the same SQL as the dashboard overview — figures a
 * merchant can act on in chat, with the full statements one tap away. No
 * customer appears here; these are totals, and this text crosses WhatsApp in
 * the clear.
 */
export function recordsSummary(input: {
  salesK: number;
  moneyInK: number;
  moneyOutK: number;
  owedToYouK: number;
}): Reply {
  if (
    input.salesK === 0 &&
    input.moneyInK === 0 &&
    input.moneyOutK === 0 &&
    input.owedToYouK === 0
  ) {
    return reply(
      'Nothing in your books yet this month. Record a sale or an expense and the totals build from there.',
    );
  }
  return reply(
    'Your books this month:\n' +
      `Sales ${formatKobo(input.salesK)}\n` +
      `Money in ${formatKobo(input.moneyInK)}\n` +
      `Money out ${formatKobo(input.moneyOutK)}\n` +
      `Owed to you ${formatKobo(input.owedToYouK)}\n\n` +
      'The full statements are on your dashboard.',
  );
}

/* ── the resend command ──────────────────────────────────────────────────── */

/** The document exists and is on its way again. Named, so they know which one. */
export function resending(reference: string): Reply {
  return reply(`Sending ${reference} again now.`);
}

/** Nothing has ever been issued — an honest miss, not an error. */
export function nothingToResend(): Reply {
  return reply(
    'There is no document to resend yet. When an invoice or receipt is issued, ask again and I will send the latest one.',
  );
}

/* ── messages Rekoda cannot read yet ─────────────────────────────────────── */

/**
 * A voice note or a photo arrived. Saying so costs nothing and keeps the
 * merchant moving; silently ignoring it teaches them the number is dead.
 */
export function onlyText(): Reply {
  return reply(
    'I can read typed messages and listen to voice notes. Photos are coming. Type it or say it, and I will record it.',
  );
}

/**
 * A capability the plan names but the product does not have yet.
 *
 * The "right now I can" list is a claim and must stay true: a capability
 * appears here when it ships and not a day before.
 */
export function notYet(what: string): Reply {
  return reply(
    `${what} is not ready yet, but it is coming. Right now I can record sales, ` +
      'expenses and stock purchases, and answer *who owes me*, *records* and *payment details*.',
  );
}

/**
 * An expense is saved. Books moved, no document exists — an expense has no
 * customer to hand paper to, so the message says "in your books", never
 * "receipt" or "invoice".
 */
export function expenseSaved(amountK: number, description: string): Reply {
  return reply(`Saved ✅ ${formatKobo(amountK)} expense: ${description}. It is in your books.`);
}

/**
 * A stock purchase is saved. The figure a merchant needs next is what they
 * still owe the supplier, so it is in the message when it exists — same
 * reasoning as the balance line in `issued`.
 */
export function purchaseSaved(amountK: number, owedK: number): Reply {
  const lines = [`Saved ✅ ${formatKobo(amountK)} stock purchase.`];
  if (owedK > 0) lines.push(`${formatKobo(owedK)} still owed to your supplier.`);
  return reply(lines.join('\n'));
}

/**
 * A stranger. No account, so nothing can be recorded for them.
 *
 * Not silence: someone messaging a business number expects an answer, and
 * "who are you" is a worse first impression than an honest one.
 */
export function noAccount(): Reply {
  return reply(
    'Hello 👋 I keep the books for businesses on Rekoda, and I do not have an ' +
      'account for this number yet.\n\nVisit rekoda.app to set one up. It takes a minute.',
  );
}

/** Length ceiling. WhatsApp accepts 4096; nobody reads that far. */
export const MAX_REPLY_CHARS = 900;

/**
 * The one invariant every reply must satisfy before it is sent.
 *
 * Cheap to check and it catches the failure that matters: an interpolated
 * value — a model's clarification, a customer name — turning a three-line
 * message into a wall, or an empty string being sent as a message.
 */
export function isSendable(candidate: Reply): boolean {
  const text = candidate.text.trim();
  return text.length > 0 && text.length <= MAX_REPLY_CHARS;
}

/** Trim an over-long reply rather than send nothing. */
export function truncateForSending(candidate: Reply): Reply {
  const text = candidate.text.trim();
  if (text.length <= MAX_REPLY_CHARS) return reply(text);
  return reply(`${text.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…`);
}
