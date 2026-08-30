/**
 * The deterministic router (MASTER-PLAN §5.3.3, ADR 0007).
 *
 * "Deterministic first" is not an optimisation. Most of what a merchant sends
 * is a greeting, a number, or the word "yes", and every one of those that
 * reaches a model costs money, adds a second of latency, and introduces a
 * chance of being understood as something else. This function is what keeps
 * them away from one.
 *
 * It is also a privacy boundary. Routing happens on the raw message BEFORE the
 * gateway runs, so a message that never needs a model never needs tokenising
 * either — no vault write, no match-key lookup, nothing leaves. The gateway is
 * paid for only by the messages that actually require it.
 *
 * Two rules make the whole thing safe to reason about:
 *
 *  1. **A classification fires only when the WHOLE message is that command.**
 *     "no" is a refusal; "no, 3 not 4" is a correction and belongs to the
 *     model (CG5). Substring matching would silently turn one into the other.
 *  2. **The cost of being wrong is not symmetric.** Missing a deterministic
 *     match costs one model call. Inventing one can opt a merchant out of
 *     their own service or start deleting their books. Destructive intents are
 *     therefore matched tightly and everything else loosely.
 */

/** What a message turned out to be, when it turned out to be something known. */
export type DeterministicIntent =
  | { kind: 'greeting' }
  | { kind: 'help' }
  /** A bare number. What it MEANS depends on what was asked — see the note below. */
  | { kind: 'number'; value: number }
  | { kind: 'affirm' }
  | { kind: 'deny' }
  | { kind: 'cancel' }
  /** Regulatory opt-out. Must be honoured whatever the conversation was doing. */
  | { kind: 'stop' }
  | { kind: 'start' }
  | { kind: 'records' }
  | { kind: 'debtors' }
  /** What is left on the shelf. Free, because a merchant checks it hourly. */
  | { kind: 'stock' }
  | { kind: 'remind'; invoiceNumber: string }
  | { kind: 'payment_details' }
  /** Take me to my books on the web. Answered with a tap-through, not a URL to type. */
  | { kind: 'dashboard' }
  | { kind: 'resend' }
  | { kind: 'upgrade' }
  /** Begins the NDPR erasure flow. Always confirmed before anything is erased. */
  | { kind: 'delete_my_data' };

export type Route =
  | { route: 'deterministic'; intent: DeterministicIntent }
  | { route: 'model'; reason: 'unrecognised' | 'empty' };

/**
 * Politeness that carries no meaning, stripped from either end before
 * matching. Without this, "abeg who owes me" and "yes please" — both perfectly
 * ordinary — would each cost a model call.
 *
 * Only ever stripped from the EDGES. A filler in the middle of a sentence is
 * part of a sentence, and a sentence is not a command.
 */
const FILLERS = new Set([
  'please',
  'pls',
  'plz',
  'abeg',
  'biko',
  'jare',
  'kindly',
  'ok',
  'okay',
  'ok o',
  'sir',
  'ma',
  'madam',
  'boss',
  'thanks',
  'thank you',
  'tanx',
  'oya',
  'na',
  'now',
  'sha',
]);

/**
 * Normalise for matching: case, punctuation, spacing, and the variation
 * selectors and zero-width joiners that ride along with emoji on a phone
 * keyboard.
 *
 * Deliberately does NOT strip diacritics. Nothing matched here needs it, and
 * folding ẹ to e is the kind of thing that quietly breaks Yoruba text
 * elsewhere once it exists as a helper.
 */
function normalise(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFE0E\uFE0F]/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Remove meaningless politeness from both ends, repeatedly. */
function stripFillers(text: string): string {
  let words = text.split(' ').filter(Boolean);
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    if (FILLERS.has(words[0]!)) {
      words = words.slice(1);
      changed = true;
    }
    if (words.length > 1 && FILLERS.has(words[words.length - 1]!)) {
      words = words.slice(0, -1);
      changed = true;
    }
    // Two-word fillers ("thank you") survive the single-word pass above.
    if (words.length > 2 && FILLERS.has(words.slice(-2).join(' '))) {
      words = words.slice(0, -2);
      changed = true;
    }
  }
  return words.join(' ');
}

/**
 * Exact phrases, matched against the whole (normalised, de-filled) message.
 *
 * A table rather than a chain of regexes because every entry here is a
 * decision someone can disagree with, and disagreeing with a list is easier
 * than disagreeing with a regex.
 */
const REMIND =
  /^(?:remind|chase|reminder for|send (?:a )?reminder for|remind (?:me )?about)\s+(inv)\s+(\d{4})\s+(\d{6})$/;

const PHRASES: ReadonlyArray<readonly [readonly string[], DeterministicIntent]> = [
  [
    [
      'hi',
      'hy',
      'hey',
      'hello',
      'helo',
      'hallo',
      'good morning',
      'good afternoon',
      'good evening',
      'morning',
      'afternoon',
      'evening',
      'how far',
      'how you dey',
      'how are you',
      'wetin dey',
      'wetin dey happen',
      'bawo',
      'sannu',
      'kedu',
      'ndewo',
      'greetings',
      'yo',
      'start chat',
    ],
    { kind: 'greeting' },
  ],
  [
    ['help', 'menu', 'options', 'what can you do', 'how does this work', 'how e dey work'],
    { kind: 'help' },
  ],
  [
    [
      'yes',
      'yep',
      'yeah',
      'yh',
      'ya',
      'yes o',
      'correct',
      'confirm',
      'confirmed',
      'send it',
      'send am',
      'go ahead',
      'proceed',
      'sure',
      'e correct',
      'na so',
      'that is right',
      'right',
      'approved',
    ],
    { kind: 'affirm' },
  ],
  [
    ['no', 'nope', 'nah', 'not correct', 'wrong', 'e no correct', 'incorrect', 'no o'],
    { kind: 'deny' },
  ],
  [['cancel', 'forget it', 'never mind', 'nevermind', 'abort', 'leave it'], { kind: 'cancel' }],
  [
    [
      'records',
      'my records',
      'show my records',
      'send my records',
      'transactions',
      'my transactions',
    ],
    { kind: 'records' },
  ],
  [
    [
      'dashboard',
      'my dashboard',
      'open dashboard',
      'open my dashboard',
      'dashboard link',
      'my books',
      'open my books',
      'see my books',
      'show me my books',
      'web',
      'website',
      'log in',
      'login',
      'sign in',
      'signin',
      'portal',
      'my account',
    ],
    { kind: 'dashboard' },
  ],
  [
    [
      'stock',
      'my stock',
      'stock level',
      'stock levels',
      'check stock',
      'what is left',
      'what dey left',
      'wetin remain',
      'inventory',
      'my inventory',
    ],
    { kind: 'stock' },
  ],
  [
    [
      'who owes me',
      'who owe me',
      'who dey owe me',
      'who owes me money',
      'debtors',
      'my debtors',
      'debtor list',
      'owing',
      'who is owing me',
      'who dey owe',
    ],
    { kind: 'debtors' },
  ],
  [
    [
      'payment details',
      'send payment details',
      'payment link',
      'send payment link',
      'send the payment link',
      'send her payment details',
      'send him payment details',
      'send them payment details',
      'how can they pay',
      'collect payment',
    ],
    { kind: 'payment_details' },
  ],
  [['resend', 'send again', 'send it again', 'resend it'], { kind: 'resend' }],
  [
    [
      'upgrade',
      'upgrade me',
      'upgrade my plan',
      'i want to upgrade',
      'i want to pay',
      'top up',
      'topup',
      'buy more messages',
    ],
    { kind: 'upgrade' },
  ],
];

/**
 * Regulatory keywords, matched on the bare message only.
 *
 * No filler stripping and no phrase list: the message must be exactly this
 * word. Carriers and Meta treat these the same way, and for good reason —
 * "stop by my shop tomorrow" must not unsubscribe anybody, and a merchant
 * typing STOP must always be heard.
 */
const KEYWORDS: Readonly<Record<string, DeterministicIntent>> = {
  stop: { kind: 'stop' },
  'stop all': { kind: 'stop' },
  stopall: { kind: 'stop' },
  unsubscribe: { kind: 'stop' },
  quit: { kind: 'stop' },
  start: { kind: 'start' },
  unstop: { kind: 'start' },
  subscribe: { kind: 'start' },
};

/**
 * Did a CUSTOMER ask a shop to stop, or to start again (PR-135)?
 *
 * The same words, and deliberately the same matching, as the merchant's
 * STOP above: one vocabulary, so a customer who has used STOP anywhere
 * else on WhatsApp finds it works here. What differs is entirely what the
 * caller then DOES with it - a merchant's STOP is a global fact about
 * Rekoda's messages to them, a customer's is a fact about one shop's
 * messages to one person - which is why this returns the intent rather
 * than acting, and why it is a separate function from `routeMessage`
 * rather than a flag on it.
 *
 * Everything else answers null: a customer's ordinary message is the
 * away assistant's business, not this function's.
 */
export function customerConsentIntent(raw: string): 'stop' | 'start' | null {
  const keyword = KEYWORDS[normalise(raw)];
  if (keyword?.kind === 'stop') return 'stop';
  if (keyword?.kind === 'start') return 'start';
  return null;
}

/**
 * Erasure. Deliberately the tightest matcher in the file.
 *
 * These are complete phrases with no room to drift, because the failure this
 * guards against is not "we asked an unnecessary question" — it is beginning
 * to delete a merchant's books because a sentence happened to contain the word
 * "delete". Anything close but not exact goes to the model, which will ask.
 *
 * Recognising the request is still not doing it: the caller confirms first.
 */
const ERASURE = new Set([
  'delete my data',
  'delete all my data',
  'delete my account',
  'delete my records',
  'erase my data',
  'erase all my data',
  'remove my data',
  'forget me',
  'close my account',
  'delete everything',
]);

/**
 * The maximum length a deterministic command can be.
 *
 * Every phrase above is short. A message that reduces to "yes" only after
 * normalisation has thrown most of it away is not somebody agreeing — it is
 * somebody pasting something.
 */
const MAX_COMMAND_CHARS = 60;

/**
 * How much of the original message normalisation is allowed to discard.
 *
 * Normalisation is aggressive because it has to survive phone
 * keyboards, emoji and trailing punctuation. But aggression cuts both ways: a
 * hundred dashes with the word "yes" somewhere inside reduces to exactly "yes"
 * and would confirm a document nobody agreed to. A length cap on the raw
 * message does not close this, it only moves it — the paste just has to be
 * shorter.
 *
 * So the test is proportional: what survived must account for most of what
 * arrived. "yes!!! 👍" survives it comfortably; a wall of punctuation does not.
 */
function survivedNormalisation(raw: string, matched: string): boolean {
  return raw.trim().length <= matched.length * 3 + 20;
}

/**
 * Classify a message without a model, or say that it needs one.
 *
 * A bare number is reported as `{ kind: 'number' }` rather than "menu option",
 * because the router cannot know which it is: "3" answers both "pick an
 * option" and "how many wigs?". Naming it what it is — a number — leaves that
 * decision with the conversation layer, which has the state to make it.
 * Calling it a menu choice here would be the router guessing, which is the one
 * thing it is built not to do.
 */
export function routeMessage(raw: string): Route {
  const normalised = normalise(raw);
  if (!normalised) return { route: 'model', reason: 'empty' };

  // Matched on the bare normalised message, spaces and all — no filler
  // stripping, no fuzziness. "stop" is the message or it is not.
  const keyword = KEYWORDS[normalised];
  if (keyword) return { route: 'deterministic', intent: keyword };

  const text = stripFillers(normalised);
  if (!text || text.length > MAX_COMMAND_CHARS) return { route: 'model', reason: 'unrecognised' };
  if (!survivedNormalisation(raw, text)) return { route: 'model', reason: 'unrecognised' };

  if (ERASURE.has(text)) return { route: 'deterministic', intent: { kind: 'delete_my_data' } };

  if (/^\d{1,2}$/.test(text)) {
    return { route: 'deterministic', intent: { kind: 'number', value: Number(text) } };
  }

  /**
   * "remind INV-2026-000004" — the one command here that carries an argument.
   *
   * A regex rather than a phrase table entry because the invoice number is
   * the point of it, and this file's privacy claim survives: a document
   * number is not PII, it is the reference both sides already share. The
   * shape is pinned exactly (three letters, a four-digit year, six digits)
   * so that a sentence merely CONTAINING an invoice number still reaches the
   * model, where it belongs.
   *
   * Normalisation has already turned the dashes into spaces, so the number
   * is rebuilt rather than read.
   */
  const remind = REMIND.exec(text);
  if (remind) {
    return {
      route: 'deterministic',
      intent: {
        kind: 'remind',
        invoiceNumber: `${remind[1]!.toUpperCase()}-${remind[2]}-${remind[3]}`,
      },
    };
  }

  for (const [phrases, intent] of PHRASES) {
    if (phrases.includes(text)) return { route: 'deterministic', intent };
  }

  return { route: 'model', reason: 'unrecognised' };
}

/**
 * Whether a route means "nothing left this system".
 *
 * Useful to assert on in tests and at the call site, so the privacy claim in
 * this file's header is checked rather than remembered.
 */
export function staysLocal(route: Route): boolean {
  return route.route === 'deterministic';
}
