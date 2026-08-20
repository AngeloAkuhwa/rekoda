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
      '• *who owes me* shows your debtors\n' +
      '• *records* shows your transactions\n\n' +
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
export function confirmErasure(): Reply {
  return reply(
    'You are asking me to delete your data. This removes your customers and ' +
      'their details permanently and cannot be undone.\n\n' +
      'Reply *DELETE MY DATA* again to confirm, or anything else to keep it.',
  );
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

/** The daily ceiling refused this merchant. Their own budget, their own day. */
export function quotaReachedForBusiness(): Reply {
  return reply(
    'You have reached today’s limit for messages I need to think about. ' +
      'It resets at midnight.\n\n' +
      'Short commands still work. Try *who owes me* or *records*.',
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
  const lines = [`Saved ✅ ${documentNumber} for ${formatNaira(totalK)}.`];
  if (balanceDueK > 0) lines.push(`${formatNaira(balanceDueK)} still owed.`);
  return reply(lines.join('\n'));
}

/** Kobo → ₦, no decimals when there are none. Mirrors the money engine. */
function formatNaira(kobo: number): string {
  const whole = Math.floor(Math.abs(kobo) / 100).toLocaleString('en-NG');
  const minor = String(Math.abs(kobo) % 100).padStart(2, '0');
  return `₦${whole}${minor === '00' ? '' : `.${minor}`}`;
}

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

/** A capability the plan names but the product does not have yet. */
export function notYet(what: string): Reply {
  return reply(
    `${what} is not ready yet, but it is coming. Right now I can record sales, ` +
      'payments and expenses.',
  );
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
