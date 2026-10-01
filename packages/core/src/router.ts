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
  /**
   * An affirmation asked as a QUESTION or with a doubting face: "na so?",
   * "yes?", "e correct 🤔". In Pidgin "Na so?" is "Really?". It confirms
   * nothing; the merchant is asked for a plain yes (G-68).
   */
  | { kind: 'unsure' }
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
 *
 * NORMALISATION MAY REMOVE PRESENTATION NOISE. IT MUST NOT REMOVE LANGUAGE
 * MEANING (G-68). Nigerian Pidgin and Nigerian English are first-class
 * registers (OWN-18), so every word here was reviewed for what it means at
 * the edge of a short command, not assumed empty because it is Nigerian:
 *
 *  - `abeg`, `biko`, `jare`, `sha` are politeness or emphasis. "abeg who owes
 *    me", "no jare", "yes sha" keep their meaning without them.
 *  - `oya` urges ("come on, go ahead"). At the edge of a command it adds
 *    urgency, not content: "oya send payment link" is "send payment link".
 *    ALONE it is an answer in its own right, which is why it is also a phrase
 *    below; the strip never empties a message, so a bare "oya" survives.
 *  - `na` is NOT here. At the START of a message it is the Pidgin copula and
 *    carries the meaning: "na so" (that is right), "na cash", "na 20k
 *    remain", "na Ada buy am". Stripping it turned "na so" into "so" and made
 *    the affirmation unreachable. Only a TRAILING `na` (an urging particle,
 *    "send am na") is noise; see `TRAILING_FILLERS`.
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
  'now',
  'sha',
]);

/**
 * Noise only at the END of a message: an urging `na` ("who dey owe me na")
 * and the emphatic `o` / `oo` ("na so o", "no oo"). A message that is only
 * "o" survives, because the strip never empties a message.
 */
const TRAILING_FILLERS = new Set(['na', 'o', 'oo', 'ooo']);

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
    const last = words[words.length - 1]!;
    if (words.length > 1 && (FILLERS.has(last) || TRAILING_FILLERS.has(last))) {
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
    [
      'help',
      'menu',
      'options',
      'what can you do',
      'what can i do here',
      'how does this work',
      'how e dey work',
      'wetin you fit do',
      'wetin i fit do here',
    ],
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
      'na correct',
      /* Bare "oya" after a preview is "go on, do it". With nothing waiting it
       * meets the same honest "nothing waiting for a yes" as a bare "yes". */
      'oya',
      /* "oya" is an edge filler, so this whole phrase would strip to a bare
       * "o"; it is matched before stripping (see `routeMessage`). */
      'oya o',
      'oya oo',
      'oya ooo',
      'that is right',
      'right',
      'approved',
    ],
    { kind: 'affirm' },
  ],
  [
    [
      'no',
      'nope',
      'nah',
      'not correct',
      'wrong',
      'e no correct',
      'incorrect',
      'no o',
      'no be so',
      'that one no correct',
    ],
    { kind: 'deny' },
  ],
  [
    [
      'cancel',
      'forget it',
      'never mind',
      'nevermind',
      'abort',
      'leave it',
      'forget am',
      'leave am',
      'no do am',
      'make we leave am',
      'cancel am',
      'cancel it',
    ],
    { kind: 'cancel' },
  ],
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
      'make i see my books',
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
      'wetin dey left',
      'how many remain',
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
      'who still dey owe',
      'who still dey owe me',
      'show me people wey owe me',
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
  [['resend', 'send again', 'send it again', 'resend it', 'send am again'], { kind: 'resend' }],
  [
    [
      'upgrade',
      'upgrade me',
      'upgrade my plan',
      'i want to upgrade',
      'i want upgrade',
      'i wan upgrade',
      'i want to pay',
      'top up',
      'topup',
      'buy more messages',
    ],
    { kind: 'upgrade' },
  ],
];

/**
 * Regulatory keywords: the ONE consent vocabulary, for merchants and customers.
 *
 * No filler stripping and no phrase list: the message must be this word.
 * Carriers and Meta treat these the same way, and for good reason: "stop by
 * my shop tomorrow" must not unsubscribe anybody, and a merchant typing STOP
 * must always be heard.
 *
 * A `Set`, not an object literal: an object answers "constructor" from its
 * prototype, and these must match exactly these words or nothing.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'stop',
  'stop all',
  'stopall',
  'unsubscribe',
  'quit',
]);
const START_WORDS: ReadonlySet<string> = new Set(['start', 'unstop', 'subscribe']);

/**
 * How much may decorate a STOP, per side, counted in GRAPHEMES (what a person
 * sees as one character: a skin-toned emoji, a flag, a keycap or a whole
 * family is one).
 *
 * The longest genuine form we have seen is ten exclamation marks
 * ("STOP!!!!!!!!!!"); three skin-toned emoji with a space take four; quotes,
 * a closing bracket and a couple of emoji fit easily. Sixteen keeps every one
 * of those with room to spare, while a paste ("stop" then 400 dashes, or
 * 2,000 exclamation marks) is refused: past that point it is not somebody
 * decorating a word, it is a wall of characters with a word in it.
 */
const DECORATION = 16;
/** START is strict: at most this many `.`, `!` or emoji after the word. */
const START_MARKS = 5;
/**
 * A cheap length bound, checked before segmenting. A STOP with sixteen
 * decorations each side is under 50 graphemes; even sixteen ZWJ family emoji
 * on each side (up to 11 code units each) stay under this.
 */
const MAX_CONSENT_CODE_UNITS = 512;

/**
 * Bidirectional overrides and isolates (U+202A to U+202E, U+2066 to U+2069).
 * Unlike the other format characters these are NOT invisible: they reorder
 * what is shown, so "\u202Estop" displays as "pots". A message carrying one
 * is not credibly the word it spells, so it changes nobody's consent.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/u;

/**
 * Every line-breaking control: LF, CR, vertical tab, form feed, NEL, and the
 * line and paragraph separators. A consent keyword is one line; a STOP or a
 * START followed by more lines is a message with the word in it.
 */
const LINE_BREAKS = /[\n\r\v\f\u0085\u2028\u2029]/u;

/**
 * The format characters that ARE invisible (zero-width spaces, the
 * left-to-right and right-to-left marks, the word joiner, the soft hyphen),
 * removed wherever they sit: "ST\u00ADOP" is what the person saw and meant
 * as STOP. The zero-width JOINER is kept, because it is what makes a family
 * of emoji one emoji; inside a letter it is dropped when the letter is read.
 */
const INVISIBLE = /(?![\u200D])\p{Cf}/gu;

/**
 * Marks that read as a QUESTION, however they are drawn: "?" and its
 * full-width form, and the pictographs "❓", "❔", "⁉", plus "‼", "〰" and
 * "〽", which an earlier review ruled are not a plain exclamation. A STOP may
 * carry them; a START never does, so "start ❓" is no more a START than
 * "start?" is.
 */
const QUESTION_MARKS: ReadonlySet<string> = new Set([
  '?',
  '\uFF1F',
  '\u2753',
  '\u2754',
  '\u2049',
  '\u203C',
  '\u3030',
  '\u303D',
]);
/**
 * Marks a START may carry, mirroring plain "." and "!": their full-width
 * forms, and the single-exclamation pictographs "❗" and "❕".
 */
const START_PUNCTUATION: ReadonlySet<string> = new Set([
  '.',
  '!',
  '\uFF0E',
  '\uFF01',
  '\u2757',
  '\u2755',
  /* "…" is three full stops in one character, and "start ..." is a START. */
  '\u2026',
]);

/**
 * The ONLY emoji a START may carry: ones that mean yes. A false START
 * re-subscribes somebody who opted out, so "start 🛑", "start ❌",
 * "start 👎", "start 🤔" or "start 😡" must not, and the only safe list is a
 * closed one. Compared without variation selectors or skin tones.
 *
 *  - 👍 thumbs up, 👌 OK hand, 💯 hundred points: yes, agreed.
 *  - ✅ ✔ ☑: the check marks people tick to say yes or done.
 *  - 🙏 folded hands: in Nigeria "please" or "thank you", a polite ask.
 *  - 🙂 😊 ☺ 😀 😃 😄: smiles, glad to be back.
 *  - 🎉 party popper, ❤ red heart: welcome back, warmth.
 */
const AFFIRMING_EMOJI: ReadonlySet<string> = new Set([
  '\u{1F44D}',
  '\u{1F44C}',
  '\u{1F4AF}',
  '\u2705',
  '\u2714',
  '\u2611',
  '\u{1F64F}',
  '\u{1F642}',
  '\u{1F60A}',
  '\u263A',
  '\u{1F600}',
  '\u{1F603}',
  '\u{1F604}',
  '\u{1F389}',
  '\u2764',
]);

/**
 * Country flags stay allowed after a START ("START 🇳🇬" is a Nigerian
 * merchant's ordinary message), EXCEPT the ones whose two letters spell a
 * refusal: 🇳🇴 reads as "NO".
 */
const NEGATING_FLAGS: ReadonlySet<string> = new Set(['\u{1F1F3}\u{1F1F4}']);

/**
 * Symbols that look like letters or numbers but are decoration all the same,
 * carved out of the letter-like rule in `classify`: "№", "℃", "™", "®", "©".
 * Keycaps ("1️⃣") are the other carve-out, kept because a STOP followed by a
 * keycap is still a STOP; so "stop 5️⃣0️⃣0️⃣0️⃣" opts out too, which is the
 * cheap direction.
 */
const LETTERLIKE_DECORATION: ReadonlySet<string> = new Set([
  '\u2116',
  '\u2103',
  '\u2122',
  '\u00AE',
  '\u00A9',
]);

/**
 * Enclosed letters and numbers ("ⓑ", "🅑", "⒝", "①"): they spell words, so
 * they are never decoration. Regional indicators sit in the same block and
 * are judged separately: a pair is a flag, a lone one is a letter.
 */
const ENCLOSED_ALPHANUMERIC = /[\u2460-\u24FF\u{1F100}-\u{1F1E5}]/u;

type Grapheme =
  /** Part of a word: a letter, read through NFKC (full-width, maths letters). */
  | { kind: 'letter'; value: string }
  | { kind: 'space' }
  /** One displayed emoji: a pictograph sequence, a flag, or a keycap. */
  | { kind: 'emoji'; affirming: boolean }
  /** One punctuation or symbol code point, judged on its RAW form. */
  | { kind: 'mark'; question: boolean; startable: boolean; dash: boolean }
  /** A digit, a non-Latin letter, anything else: never decoration. */
  | { kind: 'other' };

let segmenter: Intl.Segmenter | null = null;

/** Without variation selectors, which only choose text or emoji style. */
function bare(grapheme: string): string {
  return grapheme.replace(/[\uFE0E\uFE0F]/gu, '');
}

/**
 * What one grapheme IS, decided on what the person saw, never on its NFKC
 * expansion: "№" and "℃" are symbols, even though NFKC turns them into
 * "No" and "°C"; "1️⃣" is one emoji, not a digit.
 */
function classify(grapheme: string): Grapheme {
  const plain = bare(grapheme);
  if (/^\s+$/u.test(plain)) return { kind: 'space' };
  if (QUESTION_MARKS.has(plain)) {
    return { kind: 'mark', question: true, startable: false, dash: false };
  }
  if (START_PUNCTUATION.has(plain)) {
    return { kind: 'mark', question: false, startable: true, dash: false };
  }
  /* A keycap is one emoji, never a digit (carve-out, see above). */
  if (/^[0-9#*]\uFE0F?\u20E3$/u.test(grapheme)) return { kind: 'emoji', affirming: false };
  if (LETTERLIKE_DECORATION.has(plain)) {
    return { kind: 'mark', question: false, startable: false, dash: false };
  }
  /* A flag: a PAIR of regional indicators. */
  if (/^\p{Regional_Indicator}{2}$/u.test(plain)) {
    return { kind: 'emoji', affirming: !NEGATING_FLAGS.has(plain) };
  }
  /* Anything that reads as a letter or a number is not decoration: an
   * enclosed letter, a lone regional indicator, a symbol whose NFKC form
   * holds a letter or digit ("⒝" is "(b)"). Letters themselves are read
   * below, as part of the word. */
  const folded = plain
    .replace(/\u200D/gu, '')
    .normalize('NFKC')
    .toLowerCase();
  const letterlike =
    ENCLOSED_ALPHANUMERIC.test(plain) ||
    /\p{Regional_Indicator}/u.test(plain) ||
    /* Not itself a letter, yet reads as one: "⒝" is "(b)", "½" is "1/2". */
    (!/^[\p{L}\p{M}\u200D]+$/u.test(plain) && /[\p{L}\p{N}]/u.test(folded)) ||
    /* A letter drawn as an emoji ("ℹ" is a letter in Unicode). */
    (/\p{L}/u.test(plain) && /\p{Extended_Pictographic}/u.test(plain));
  if (letterlike) return { kind: 'other' };
  if (/\p{Extended_Pictographic}/u.test(grapheme)) {
    const core = plain.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
    return { kind: 'emoji', affirming: AFFIRMING_EMOJI.has(core) };
  }
  if ([...plain].length === 1 && /^[\p{P}\p{S}]$/u.test(plain)) {
    return { kind: 'mark', question: false, startable: false, dash: /^\p{Pd}$/u.test(plain) };
  }
  if (/^[a-z]+$/u.test(folded)) return { kind: 'letter', value: folded };
  return { kind: 'other' };
}

/** May this grapheme decorate a STOP (on either side)? */
function decoratesStop(g: Grapheme): boolean {
  return g.kind === 'space' || g.kind === 'emoji' || g.kind === 'mark';
}

/**
 * May this grapheme follow a START? Only "." or "!" in some form, an
 * affirming emoji, or a flag that does not spell a refusal.
 */
function followsStart(g: Grapheme): boolean {
  return (g.kind === 'emoji' && g.affirming) || (g.kind === 'mark' && g.startable);
}

/**
 * Did this message ask to stop, or to start again? Null for everything else.
 *
 * Shared by `routeMessage` (a merchant talking to Rekoda),
 * `customerConsentIntent` (a customer talking to a shop) and
 * `consentIntentOf` (a typed text, a tapped button's id or its title), so
 * the vocabulary and the exactness rule live in ONE place and cannot drift
 * apart between the paths.
 *
 * Deliberately NOT `normalise`. That function exists to be forgiving, turning
 * any punctuation into a space, and forgiveness is the wrong property here:
 * "-----start-----", "s.t.o.p", or a paste of four hundred dashes with
 * "start" inside all collapse to the bare word under it, and the one that
 * re-subscribed an opted-out merchant was exactly that (G-24). A consent
 * change is a legal fact about a person, so the raw message has to credibly
 * BE the command, not reduce to it.
 *
 * So the message is read as GRAPHEMES, what a person sees as one character,
 * and each one is judged on its raw form: never character by character after
 * a normalisation that could turn a symbol into letters or split one emoji
 * into several. The word is the run of letter graphemes (spaces allowed
 * inside, for "stop all"); everything before and after it is decoration or
 * the message is not consent. Nothing alphanumeric may sit beside the word.
 *
 * ASYMMETRIC on purpose, because the two mistakes do not cost the same:
 *
 *  - A STOP that is missed keeps messaging a person who asked us not to.
 *    That is a regulatory failure, so a STOP is heard however it is
 *    DECORATED with punctuation, symbols, emoji and spaces, up to
 *    `DECORATION` graphemes on each side: "STOP!!!!!!", "stop?", "*STOP*",
 *    "🛑STOP🛑", "(stop)", "STOP :)", "STOP 1️⃣", "STOP №". Before the word,
 *    dashes are the one exception: a single bullet ("-" or "•" then a space)
 *    is a list item, a run of them is a separator line or a paste, so
 *    "-----stop-----" is refused.
 *  - A false START re-subscribes somebody who opted out. So a START keeps
 *    the strict shape: nothing before the word, then at most `START_MARKS`
 *    of ".", "!" or an AFFIRMING emoji (`AFFIRMING_EMOJI`, or a country flag
 *    that does not spell a refusal), never a question mark in any form.
 */
function consentKeyword(raw: string): 'stop' | 'start' | null {
  /* The longest genuine consent message is a word with sixteen decorations
   * on each side, well under this; anything longer is not consent, and is
   * refused before it is segmented. */
  if (BIDI_CONTROLS.test(raw)) return null;
  /* Surrounding whitespace, a trailing line break included, is not part of
   * the message, and neither are the invisible format characters: both go
   * BEFORE the length gate, so trailing spaces never refuse a STOP. A line
   * break anywhere else is a second line. */
  const text = raw.replace(INVISIBLE, '').trim();
  if (text.length > MAX_CONSENT_CODE_UNITS) return null;
  if (!text || LINE_BREAKS.test(text)) return null;

  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  const graphemes = [...segmenter.segment(text)].map((s) => classify(s.segment));

  const first = graphemes.findIndex((g) => g.kind === 'letter');
  if (first < 0) return null;
  let last = first;
  for (let i = graphemes.length - 1; i > first; i--) {
    if (graphemes[i]!.kind === 'letter') {
      last = i;
      break;
    }
  }

  /* The words: runs of letters, and what separates them. Anything inside
   * the span that is neither a letter nor decoration refuses. */
  const runs: string[] = [];
  const separators: Grapheme[][] = [];
  let run = '';
  let separator: Grapheme[] = [];
  for (const g of graphemes.slice(first, last + 1)) {
    if (g.kind === 'letter') {
      if (run === '' && runs.length > 0) separators.push(separator);
      run += g.value;
      separator = [];
    } else if (decoratesStop(g)) {
      if (run !== '') runs.push(run);
      run = '';
      separator.push(g);
    } else {
      return null;
    }
  }
  runs.push(run);
  /* The one keyword with a space inside: "stop all", spaces only between. */
  const units: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const spaced = (separators[i] ?? []).every((g) => g.kind === 'space');
    if (runs[i] === 'stop' && runs[i + 1] === 'all' && spaced) {
      units.push('stop all');
      i++;
    } else {
      units.push(runs[i]!);
    }
  }
  const before = graphemes.slice(0, first);
  const after = graphemes.slice(last + 1);
  const inside = separators.flat();

  /*
   * A STOP may be said up to three times ("STOP STOP", "stop!!! stop!!!"),
   * the same word each time, separated only by decoration: someone who
   * repeats it means it more, not less. Mixed words ("stop start",
   * "STOP quit") stay refused, and START is never repeated (G-24).
   */
  const repeatedStop =
    units.length >= 2 &&
    units.length <= 3 &&
    units.every((u) => u === units[0]) &&
    STOP_WORDS.has(units[0]!) &&
    inside.length <= DECORATION;
  if (units.length > 1 && !repeatedStop) return null;
  const word = units[0]!;

  if (STOP_WORDS.has(word) && (units.length === 1 || repeatedStop)) {
    /* One list bullet ("-" or "•", then a space) is a list item. */
    const lead =
      before.length >= 2 &&
      before[0]!.kind === 'mark' &&
      (before[0]!.dash || isBullet(text)) &&
      before[1]!.kind === 'space'
        ? before.slice(2)
        : before;
    if (lead.length > DECORATION || after.length > DECORATION) return null;
    if (!lead.every((g) => decoratesStop(g) && !(g.kind === 'mark' && g.dash))) return null;
    if (!after.every(decoratesStop)) return null;
    return 'stop';
  }

  if (START_WORDS.has(word) && units.length === 1) {
    if (before.length > 0) return null;
    /* Spaces may separate the word from its marks, never the marks. */
    let spaces = 0;
    while (spaces < after.length && after[spaces]!.kind === 'space') spaces++;
    const marks = after.slice(spaces);
    if (marks.length > START_MARKS || !marks.every(followsStart)) return null;
    return 'start';
  }
  return null;
}

/** Does the message open with a bullet character ("•" and its relatives)? */
function isBullet(text: string): boolean {
  return /^[\u2022\u2023\u2043]/u.test(text);
}

/**
 * Did a CUSTOMER ask a shop to stop, or to start again (PR-135)?
 *
 * The same words, and deliberately the same matcher, as the merchant's
 * STOP: one vocabulary, so a customer who has used STOP anywhere
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
  return consentKeyword(raw);
}

/**
 * The same question, asked of a message however the person sent it
 * (remediation R11).
 *
 * A customer who taps a button labelled "Stop messages" has asked for the
 * same thing as one who types the word, and WhatsApp delivers that tap with
 * no message text at all. Reading only `text` meant the tap was not heard -
 * the quietest possible way to keep messaging somebody who asked you not
 * to.
 *
 * Every candidate goes through `customerConsentIntent`, so the vocabulary
 * and the exact-match rule stay in ONE place: "stop by my shop" still
 * unsubscribes nobody, whichever field it arrives in. The id is tried
 * before the title because a merchant who wires a button to the payload
 * `stop` means it, whatever the label above it reads.
 */
export function consentIntentOf(message: {
  text: string | null;
  replyId: string | null;
  replyTitle: string | null;
}): 'stop' | 'start' | null {
  for (const candidate of [message.text, message.replyId, message.replyTitle]) {
    if (!candidate) continue;
    const intent = customerConsentIntent(candidate);
    if (intent) return intent;
  }
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

  // Matched on the RAW message by the shared consent matcher, before any
  // filler stripping and never after normalisation: "stop" is the message
  // or it is not (G-24).
  const consent = consentKeyword(raw);
  if (consent) return { route: 'deterministic', intent: { kind: consent } };

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
    if (phrases.includes(text)) return { route: 'deterministic', intent: doubted(raw, intent) };
  }
  /* A whole phrase built only of edge words ("oya o") is stripped down to
   * nothing meaningful above, so it is also tried exactly as sent. Still a
   * whole-message match: nothing is added, nothing is guessed. */
  for (const [phrases, intent] of PHRASES) {
    if (phrases.includes(normalised)) {
      return { route: 'deterministic', intent: doubted(raw, intent) };
    }
  }

  return { route: 'model', reason: 'unrecognised' };
}

/**
 * The periods a short answer can name (Build 6), matched against the WHOLE
 * message exactly as the phrase table above is.
 *
 * Not a date parser: a fixed vocabulary that names one of the windows
 * `resolvePeriod` already draws, and nothing else. Deliberately absent are
 * phrases with two defensible readings: "last week" (the previous calendar
 * week, or the last seven days?) and "past month" (last month, or the last
 * thirty days?). A message that is not exactly one of these is not an answer
 * to "Which period?", and goes wherever it would have gone without the
 * question. Broader language belongs to the routing build, not here.
 */
const PERIOD_ANSWERS: ReadonlyArray<readonly [readonly string[], AnsweredPeriod]> = [
  [['today', 'today only', 'just today'], 'today'],
  [
    [
      'this week',
      'week',
      'the week',
      'last 7 days',
      'the last 7 days',
      'past 7 days',
      'last seven days',
      'the last seven days',
    ],
    'week',
  ],
  [['this month', 'month', 'the month', 'so far this month'], 'month'],
  [['last month', 'previous month', 'the previous month'], 'last_month'],
  /*
   * Nigerian English and Pidgin forms of the same four windows (G-68 Phase 2,
   * OWN-18), each reviewed for a second reading:
   *  - "dis" is how "this" is written in Pidgin and texting; it never means
   *    anything else at the head of a window.
   *  - "this month so far" is "so far this month" said the other way round.
   *  - "the month wey pass" is Pidgin for the month that has passed: last
   *    month, and nothing else.
   * Rejected: "today today" (Pidgin emphasis for "right now", an urgency
   * idiom, not a window); "last week" and "past month" stay out for the
   * reasons above. A trailing "o" ("last month o") is presentation noise,
   * stripped before this table is read.
   */
  [['dis week', 'dis week so far'], 'week'],
  [['dis month', 'dis month so far', 'this month so far'], 'month'],
  [['the month wey pass', 'month wey pass'], 'last_month'],
];

/** A window a short answer may name; the `PeriodName`s `resolvePeriod` draws. */
export type AnsweredPeriod = 'today' | 'week' | 'month' | 'last_month';

/**
 * Leading words that turn a period into an answer (including the Pidgin
 * copula: "na last month" is "it is last month") or a follow-up without
 * changing which period it is: "for last month", "what about this week".
 */
const PERIOD_LEADS = ['what about', 'how about', 'and for', 'and', 'for', 'in', 'na'];

/**
 * Which period a message names, when the whole message is a period and
 * nothing else; null otherwise (Build 6).
 *
 * Only ever consulted when Rekoda has asked "Which period?" or has just
 * answered a question over a period: on its own a period means nothing, and
 * the router above never classifies one. "I bought 10 cartons for 100k last
 * month" is not a period, it is a purchase, and stays null here.
 */
export function periodAnswer(raw: string): AnsweredPeriod | null {
  const normalised = normalise(raw);
  if (!normalised) return null;
  let text = stripFillers(normalised);
  if (!text || text.length > MAX_COMMAND_CHARS) return null;
  if (!survivedNormalisation(raw, text)) return null;
  for (const lead of PERIOD_LEADS) {
    if (text.startsWith(`${lead} `)) {
      text = text.slice(lead.length + 1);
      break;
    }
  }
  for (const [phrases, period] of PERIOD_ANSWERS) {
    if (phrases.includes(text)) return period;
  }
  return null;
}

/**
 * Marks that turn a whole-message affirmation into a QUESTION when it ends
 * the message: "?" in its plain and full-width forms, and the pictographs
 * "❓", "❔", "⁉", "‼" (the same set the consent matcher treats as a
 * question). "na so?" is "Really?", not "go ahead".
 */
const QUESTION_ENDINGS = /[?\uFF1F\u2753\u2754\u2049\u203C][\s\uFE0E\uFE0F]*$/u;

/**
 * Faces that mean doubt, wherever they sit in the message: thinking face,
 * flushed face, face with monocle, confused face, face with raised eyebrow.
 * Kept small on purpose: each is read as "I am not sure", and none is ever
 * sent to mean yes. A smile or a thumbs up still affirms.
 */
const DOUBT_FACES = /[\u{1F914}\u{1F633}\u{1F9D0}\u{1F615}\u{1F928}]/u;

/**
 * Normalisation removes punctuation and emoji, so "yes?" and "yes" match the
 * same phrase. That is right for presentation noise and wrong for a question
 * mark or a doubting face, which change the MEANING of an affirmation: the
 * merchant is asking, not agreeing (G-68). Only an affirmation is affected;
 * "who owes me?" is still the debtors list.
 */
function doubted(raw: string, intent: DeterministicIntent): DeterministicIntent {
  if (intent.kind !== 'affirm') return intent;
  return QUESTION_ENDINGS.test(raw.trim()) || DOUBT_FACES.test(raw) ? { kind: 'unsure' } : intent;
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

/**
 * Windows a merchant can NAME that Rekoda cannot count here (Build 6's
 * `periodNotCountable`): "yesterday", "last week", "in March", "this year".
 * Only consulted while "Which period?" is open, so the question can stay
 * open and say which windows it can count, instead of being dropped and the
 * reply sent to the model as if nothing was asked. A whole-message match,
 * after the same normalisation as a period answer: "I bought rice yesterday"
 * is a purchase, never this.
 */
const UNCOUNTABLE_WINDOWS = new Set([
  'yesterday',
  'last week',
  'the last week',
  'previous week',
  'the previous week',
  'past week',
  'this year',
  'dis year',
  'last year',
  'the year',
  'past month',
  'the past month',
  'last 30 days',
  'the last 30 days',
  'past 30 days',
  'last thirty days',
  'last two weeks',
  'last 2 weeks',
  'last three months',
  'last 3 months',
]);
const MONTH_NAMES =
  'january|february|march|april|may|june|july|august|september|october|november|december';
const NAMED_MONTH = new RegExp(String.raw`^(?:last )?(?:${MONTH_NAMES})(?: \d{4})?$`);

export function uncountablePeriod(raw: string): boolean {
  const normalised = normalise(raw);
  if (!normalised) return false;
  let text = stripFillers(normalised);
  if (!text || text.length > MAX_COMMAND_CHARS) return false;
  if (!survivedNormalisation(raw, text)) return false;
  for (const lead of PERIOD_LEADS) {
    if (text.startsWith(`${lead} `)) {
      text = text.slice(lead.length + 1);
      break;
    }
  }
  return UNCOUNTABLE_WINDOWS.has(text) || NAMED_MONTH.test(text);
}

/**
 * Where a purchase's money came from, as the answer to the G-61 question
 * "did it come from your bank account or from physical cash?" (G-68 Phase 2).
 * The two funding ACCOUNTS (OWN-17): money out of the bank is a transfer,
 * physical cash is cash. POS and card are channels, never an answer here.
 */
export type FundingSource = 'transfer' | 'cash';

/**
 * A whole-message answer naming one funding account, and nothing else.
 * Only consulted while that question is open for this member.
 *
 * Each phrase reviewed for a second reading. "bank" and "cash" are the
 * question's own words. The Pidgin copula is meaning, not noise: "na bank",
 * "na cash" ("it was the bank", "it was cash"). Rejected: "pos", "card",
 * "atm", "both", "part cash part transfer" (a channel, or two accounts, which
 * a single answer cannot record), and anything longer, which goes to the
 * model as an ordinary message.
 */
const FUNDING_ANSWERS: ReadonlyArray<readonly [readonly string[], FundingSource]> = [
  [
    [
      'bank',
      'transfer',
      'bank transfer',
      'my bank',
      'bank account',
      'my bank account',
      'from bank',
      'from my bank',
      'from the bank',
      'from bank account',
      'from my bank account',
      'na bank',
      'na transfer',
      'na from bank',
      'na my bank',
      'na my bank account',
      'na from my bank account',
    ],
    'transfer',
  ],
  [
    [
      'cash',
      'physical cash',
      'my cash',
      'from cash',
      'from my cash',
      /* "Money for hand" is cash held in the hand; "from my pocket" is
       * physical money. Neither has a bank reading. */
      'money for hand',
      'na money for hand',
      'from my pocket',
      'cash in hand',
      'na cash',
      'na physical cash',
      'na my cash',
    ],
    'cash',
  ],
];

export function fundingSourceAnswer(raw: string): FundingSource | null {
  const normalised = normalise(raw);
  if (!normalised) return null;
  const text = stripFillers(normalised);
  if (!text || text.length > MAX_COMMAND_CHARS) return null;
  if (!survivedNormalisation(raw, text)) return null;
  for (const [phrases, source] of FUNDING_ANSWERS) {
    if (phrases.includes(text)) return source;
  }
  return null;
}
