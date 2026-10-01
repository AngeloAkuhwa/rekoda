/**
 * Conversational continuation state (Build 6).
 *
 * What lets a short reply be understood as an answer to the thing Rekoda
 * itself just asked, or as a follow-up to the question it just answered:
 *
 *     "How much did I sell?"  ->  "Which period?"  ->  "Last month."
 *
 * Three things in a conversation must never be confused, and only two of
 * them live here:
 *
 *  A. FINANCIAL CONFIRMATION: a previewed command draft a "yes" confirms
 *     (CG2, G-23). That is `command_drafts`, with its own window and its own
 *     atomic claim, and nothing in this file can reach it.
 *  B. CLARIFICATION: Rekoda asked ONE specific question ("Which period?") and
 *     the next short reply may answer it. One-shot: claimed once, atomically.
 *  C. QUERY CONTINUATION: the merchant just asked a READ ("show my sales"),
 *     and a follow-up ("what about last month?") may continue it.
 *
 * The state is typed and structured, never a transcript: a kind, what answer
 * is expected, the query subject as an enum, a vault token (never a name), an
 * invoice number, a period from a fixed list, and the exact options a
 * numbered list showed. Everything a continuation can RESOLVE to is a read
 * (`ResumedRead`): there is no path from this state to a write, so a short
 * reply can never become permission to record money because of some older
 * conversation.
 *
 * The one answer that leads toward a write (G-68 Phase 2) still is not one:
 * a funding-source answer ("bank", "cash") rebuilds the retired purchase
 * with that account and shows a FRESH preview through the ordinary gates.
 * The retired draft is never claimed or revived, and only a normal "yes" to
 * the new preview records anything.
 *
 * Pure: no database, no clock. The repository persists it, keyed to the
 * actual person who was asked (`user_id`), never just the business.
 */
import type { AnsweredPeriod, FundingSource, Route } from './router.js';
import { fundingSourceAnswer, periodAnswer } from './router.js';

/**
 * How long a question Rekoda asked, or a read it just answered, stays open
 * for a short reply to continue it: ten minutes.
 *
 * Neither the canonical specification nor an owner decision fixes a number,
 * so this is an implementation decision recorded here, flagged for the
 * owner to confirm. Deliberately NOT `CONFIRMATION_TTL_SECONDS` (G-23's five
 * minutes): that window bounds how long a financial preview may be
 * CONFIRMED, and borrowing it would tie two unrelated decisions together.
 * Ten minutes because a merchant answering "Which period?" usually does so
 * within a minute or two, but may be interrupted by a customer at the
 * counter; and short enough that "last month" typed an hour later, about
 * something else entirely, is not glued to a question nobody remembers.
 * Expiry costs little: an expired question is simply absent, and the reply
 * is understood as it would have been without it.
 */
export const CONTINUATION_TTL_SECONDS = 600;

/**
 * How long after a G-61 funding-source question was FIRST asked a short
 * "bank" or "cash" may still rebuild that purchase (G-68 review): thirty
 * minutes from the retired draft's creation, judged at the moment the answer
 * reached Rekoda. Past it, a re-ask no longer offers the short answer and a
 * late "bank" is an ordinary message, so a Monday purchase is never rebuilt
 * and booked on Friday. An implementation value for the owner to confirm
 * (OPEN OWNER DECISION OD-19).
 */
export const FUNDING_ANSWER_WINDOW_SECONDS = 1800;

/** The Query topics a continuation may carry (the command contract's list). */
export const QUERY_TOPICS = [
  'debtors',
  'customer_balance',
  'supplier_balances',
  'sales_summary',
  'expenses_summary',
  'unreconciled',
  'report_request',
] as const;
export type QueryTopic = (typeof QUERY_TOPICS)[number];

/** The topics answered over a window of trading, which "Which period?" asks about. */
export const PERIOD_TOPICS = ['sales_summary', 'expenses_summary'] as const;
export type PeriodTopic = (typeof PERIOD_TOPICS)[number];

export const CONTINUATION_PERIODS = ['today', 'week', 'month', 'last_month'] as const;

/** The shape of a vault customer token (the command contract's own pattern). */
export const CUSTOMER_TOKEN = /^CUSTOMER_[A-Z0-9]{2,12}$/;
/** A document number, the reference both sides already share; not PII. */
export const DOCUMENT_REF = /^[A-Z]{2,4}-\d{4}-\d{6}$/;

/** At most this many numbered options are ever shown, or remembered. */
export const MAX_CHOICE_OPTIONS = 9;

/** One line of a numbered list Rekoda presented: "2. INV-2026-000004". */
export interface ChoiceOption {
  readonly ordinal: number;
  readonly ref: { readonly kind: 'invoice'; readonly invoiceNumber: string };
}

/** B: Rekoda asked which period; the next short reply may name one. */
export interface PeriodClarification {
  readonly kind: 'clarification';
  readonly expects: 'period';
  readonly topic: PeriodTopic;
}

/**
 * B: Rekoda presented an explicit numbered list ("1. INV-A  2. INV-B").
 * The exact options shown are kept, so "2" can only ever mean what line 2
 * said. Representable now; nothing in Build 6 asks one yet (the routing
 * build decides which questions do and what an answer then triggers).
 */
export interface ChoiceClarification {
  readonly kind: 'clarification';
  readonly expects: 'choice';
  readonly topic: QueryTopic | null;
  readonly options: readonly ChoiceOption[];
}

/**
 * C: the read Rekoda just answered, as a subject a follow-up may continue:
 * the topic, the window it covered, and who or what it was about, as a token
 * or a document number. "Show Ada's balance" is kept as CUSTOMER_7K2.
 */
export interface QueryContinuation {
  readonly kind: 'query';
  readonly topic: QueryTopic;
  readonly period: AnsweredPeriod | null;
  readonly customerToken: string | null;
  readonly documentRef: string | null;
}

/**
 * B: Rekoda asked where a purchase's money came from (G-61, OWN-17: POS is a
 * channel, the books need the account). Holds ONLY the id of the retired
 * purchase draft that asked; the answer rebuilds that purchase with the
 * account filled in and shows a FRESH preview through the ordinary gates.
 * It never executes the retired draft (G-68 Phase 2, migration 0155).
 */
export interface FundingSourceClarification {
  readonly kind: 'clarification';
  readonly expects: 'funding_source';
  readonly draftId: string;
}

export type ContinuationState =
  PeriodClarification | ChoiceClarification | FundingSourceClarification | QueryContinuation;

/** What a short reply answered, when it fits what was expected. */
export type ContinuationAnswer =
  | { readonly kind: 'period'; readonly period: AnsweredPeriod }
  | { readonly kind: 'choice'; readonly option: ChoiceOption }
  | { readonly kind: 'funding_source'; readonly source: FundingSource };

/**
 * Does this message answer the open state? Null when it does not fit, and
 * null is always safe: the message is then understood exactly as it would
 * have been with no state at all (and the caller retires the state, so the
 * newest thing said wins).
 *
 * Conservative on purpose:
 *  - a period question takes only a whole-message period ("last month");
 *    "I bought 10 cartons for 100k" is a new purchase, never an answer;
 *  - a bare number answers ONLY an explicit numbered list, and only with an
 *    ordinal that list showed; "2" while a period is expected is not guessed
 *    at, and "2" with nothing open stays a stray number;
 *  - a read continues only on the topics answered over a window, by naming
 *    another window.
 */
export function continuationAnswer(
  state: ContinuationState,
  message: { readonly text: string; readonly route: Route },
): ContinuationAnswer | null {
  if (state.kind === 'clarification' && state.expects === 'choice') {
    if (message.route.route !== 'deterministic' || message.route.intent.kind !== 'number') {
      return null;
    }
    const value = message.route.intent.value;
    const option = state.options.find((o) => o.ordinal === value);
    return option ? { kind: 'choice', option } : null;
  }

  /* A period or an account is never a deterministic command, so a message
   * the router classified (a "yes", a "2", "who owes me") is never one. */
  if (message.route.route === 'deterministic') return null;

  if (state.kind === 'clarification' && state.expects === 'funding_source') {
    const source = fundingSourceAnswer(message.text);
    return source ? { kind: 'funding_source', source } : null;
  }

  if (state.kind === 'clarification') {
    const period = periodAnswer(message.text);
    return period ? { kind: 'period', period } : null;
  }

  if (!isPeriodTopic(state.topic)) return null;
  const period = periodAnswer(message.text);
  return period ? { kind: 'period', period } : null;
}

/**
 * A READ, and the only thing a continuation can resume into. There is no
 * variant that records, previews or confirms anything: if a later build lets
 * an answer complete a write command, that command must walk the ordinary
 * gates and show a FRESH preview, which is a different function with a
 * different return type, never this one.
 */
export interface ResumedRead {
  readonly kind: 'read';
  readonly topic: PeriodTopic;
  readonly period: AnsweredPeriod;
}

/**
 * The read a period answer resumes, or null when the pair does not make one.
 * A choice answer resumes nothing in Build 6: no question that offers a
 * numbered list exists yet, and an option is a reference, not an action.
 */
export function resumedRead(
  state: ContinuationState,
  answer: ContinuationAnswer,
): ResumedRead | null {
  if (answer.kind !== 'period') return null;
  if (state.kind === 'clarification' && state.expects === 'period') {
    return { kind: 'read', topic: state.topic, period: answer.period };
  }
  if (state.kind === 'query' && isPeriodTopic(state.topic)) {
    return { kind: 'read', topic: state.topic, period: answer.period };
  }
  return null;
}

/** Whether a clarification is consumed by its answer (one-shot). */
export function isOneShot(state: ContinuationState): boolean {
  return state.kind === 'clarification';
}

export function isPeriodTopic(topic: string | null): topic is PeriodTopic {
  return (PERIOD_TOPICS as readonly string[]).includes(topic ?? '');
}

function isQueryTopic(topic: unknown): topic is QueryTopic {
  return typeof topic === 'string' && (QUERY_TOPICS as readonly string[]).includes(topic);
}

/** A command draft's id: a uuid, nothing else. */
const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isPeriod(value: unknown): value is AnsweredPeriod {
  return typeof value === 'string' && (CONTINUATION_PERIODS as readonly string[]).includes(value);
}

/** The columns a continuation is stored as; typed, never a transcript. */
export interface ContinuationColumns {
  readonly kind: string;
  readonly expects: string | null;
  readonly topic: string | null;
  readonly period: string | null;
  readonly customerToken: string | null;
  readonly documentRef: string | null;
  readonly options: unknown;
  /** The retired purchase draft a funding-source question asked about (0155). */
  readonly draftId: string | null;
}

function parseOptions(value: unknown): ChoiceOption[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHOICE_OPTIONS) {
    return null;
  }
  const options: ChoiceOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const ref = e['ref'] as Record<string, unknown> | undefined;
    if (
      typeof e['ordinal'] !== 'number' ||
      !Number.isInteger(e['ordinal']) ||
      e['ordinal'] < 1 ||
      e['ordinal'] > value.length ||
      !ref ||
      ref['kind'] !== 'invoice' ||
      typeof ref['invoiceNumber'] !== 'string' ||
      !DOCUMENT_REF.test(ref['invoiceNumber'])
    ) {
      return null;
    }
    options.push({
      ordinal: e['ordinal'],
      ref: { kind: 'invoice', invoiceNumber: ref['invoiceNumber'] },
    });
  }
  /* Each ordinal once, and (with every ordinal in 1..n) therefore exactly
   * 1..n, as the 0154 CHECK requires: "2" must have exactly one meaning,
   * and no list skips a number it showed. */
  if (new Set(options.map((o) => o.ordinal)).size !== options.length) return null;
  return options;
}

/**
 * The stored row, read back defensively: anything not exactly a shape this
 * file writes is null, and null is "no continuation", the safe reading.
 */
export function parseContinuation(row: ContinuationColumns): ContinuationState | null {
  if (row.kind === 'clarification') {
    if (row.expects === 'period') {
      if (!isPeriodTopic(row.topic)) return null;
      return { kind: 'clarification', expects: 'period', topic: row.topic };
    }
    if (row.expects === 'choice') {
      const options = parseOptions(row.options);
      if (!options) return null;
      if (row.topic !== null && !isQueryTopic(row.topic)) return null;
      return { kind: 'clarification', expects: 'choice', topic: row.topic, options };
    }
    if (row.expects === 'funding_source') {
      if (row.draftId === null || !DRAFT_ID.test(row.draftId)) return null;
      if (row.topic !== null || row.options !== null) return null;
      return { kind: 'clarification', expects: 'funding_source', draftId: row.draftId };
    }
    return null;
  }
  if (row.kind === 'query' && row.expects === null) {
    if (!isQueryTopic(row.topic)) return null;
    if (row.period !== null && !isPeriod(row.period)) return null;
    if (row.customerToken !== null && !CUSTOMER_TOKEN.test(row.customerToken)) return null;
    if (row.documentRef !== null && !DOCUMENT_REF.test(row.documentRef)) return null;
    return {
      kind: 'query',
      topic: row.topic,
      period: row.period,
      customerToken: row.customerToken,
      documentRef: row.documentRef,
    };
  }
  return null;
}

/**
 * The columns a state is stored as. Throws on a value that is not a token,
 * a document number or a listed period: a name typed into a "customer" slot
 * is a privacy bug at the call site, and the write must fail loudly (the
 * table's CHECK constraints refuse it too).
 */
export function continuationColumns(state: ContinuationState): ContinuationColumns {
  if (state.kind === 'clarification' && state.expects === 'period') {
    return {
      kind: 'clarification',
      expects: 'period',
      topic: state.topic,
      period: null,
      customerToken: null,
      documentRef: null,
      options: null,
      draftId: null,
    };
  }
  if (state.kind === 'clarification' && state.expects === 'funding_source') {
    if (!DRAFT_ID.test(state.draftId)) {
      throw new Error('continuation: a funding-source question names its draft by id');
    }
    return {
      kind: 'clarification',
      expects: 'funding_source',
      topic: null,
      period: null,
      customerToken: null,
      documentRef: null,
      options: null,
      draftId: state.draftId,
    };
  }
  if (state.kind === 'clarification') {
    const options = parseOptions(state.options);
    if (!options) throw new Error('continuation: a numbered list must be 1-9 distinct invoices');
    return {
      kind: 'clarification',
      expects: 'choice',
      topic: state.topic,
      period: null,
      customerToken: null,
      documentRef: null,
      options,
      draftId: null,
    };
  }
  if (state.customerToken !== null && !CUSTOMER_TOKEN.test(state.customerToken)) {
    throw new Error('continuation: a customer is stored as a vault token, never a name');
  }
  if (state.documentRef !== null && !DOCUMENT_REF.test(state.documentRef)) {
    throw new Error('continuation: a document reference must be a document number');
  }
  return {
    kind: 'query',
    expects: null,
    topic: state.topic,
    period: state.period,
    customerToken: state.customerToken,
    documentRef: state.documentRef,
    options: null,
    draftId: null,
  };
}
