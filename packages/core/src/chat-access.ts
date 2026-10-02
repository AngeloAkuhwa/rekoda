/**
 * Which deterministic Chat commands a business may use (G-65).
 *
 * The router answers some messages without a model: "who owes me", "stock",
 * "resend" and the rest. Skipping the model skips a cost; it must never skip
 * the product boundary. "who owes me" typed as a fixed phrase and "which of my
 * customers still owe me money?" sent to the model are the same capability,
 * answering a question about the merchant's own books (spec §3.1, the
 * `FINANCIAL_QA` capability), and they meet the same entitlement. English and
 * Pidgin phrasings route to the same intent kind, so they share the answer.
 *
 * NOT every deterministic command is Chat. STOP and START are regulatory
 * consent, the erasure ceremony is the merchant's data-protection right, the
 * dashboard link opens the shared control plane (spec §3.2a), and "upgrade" is
 * the one message from a merchant who wants to pay. Those work on every plan,
 * lapsed included. One guard in front of every deterministic intent would have
 * locked a merchant out of their own consent and erasure rights.
 *
 * Pure: the caller resolves the plan and whether `REKODA_CHAT` is held.
 */
import type { DeterministicIntent } from './router.js';

/**
 * How a deterministic intent is entitled.
 *
 *  - `universal`: works on every plan, including a lapsed one.
 *  - `conversation`: yes, a questioned yes, no and cancel. Never refused
 *    here: "no" and "cancel" keep their safety meaning on every plan, and a
 *    "yes" (or "yes?") is judged by the DRAFT it would confirm
 *    (`chatDraftAccess`), not by its words.
 *  - `chat`: a Chat capability. Needs `REKODA_CHAT`; a lapsed plan is told
 *    its plan ended, exactly as the model path tells it.
 *  - `chat_kept_on_lapse`: a Chat capability that a lapsed plan keeps,
 *    because the copy a lapsed merchant is given promises it and spec §4.5
 *    keeps existing books readable and existing invoices collectible. A LIVE
 *    plan without `REKODA_CHAT` (Integrate only) is still refused it.
 */
export type DeterministicAccessClass = 'universal' | 'conversation' | 'chat' | 'chat_kept_on_lapse';

/**
 * Every intent the router can produce, classified. A `Record` over the kind
 * union, so a new intent does not compile until somebody decides this.
 */
export const DETERMINISTIC_ACCESS: Readonly<
  Record<DeterministicIntent['kind'], DeterministicAccessClass>
> = {
  greeting: 'universal',
  help: 'universal',
  /* A bare number is answered with a question back; it does nothing. */
  number: 'universal',
  stop: 'universal',
  start: 'universal',
  delete_my_data: 'universal',
  dashboard: 'universal',
  upgrade: 'universal',

  affirm: 'conversation',
  /* "na so?", "yes?": a questioned yes (Build 7, G-68). It confirms nothing
   * and is never refused by its words; `unsureReply` judges what it points
   * at, as `confirmPendingDraft` judges a yes. */
  unsure: 'conversation',
  deny: 'conversation',
  cancel: 'conversation',

  debtors: 'chat_kept_on_lapse',
  records: 'chat_kept_on_lapse',
  stock: 'chat_kept_on_lapse',
  payment_details: 'chat_kept_on_lapse',
  remind: 'chat_kept_on_lapse',

  /* The one deterministic command that delivers a document. A lapsed or
   * read-only plan sends no new document (G-65). */
  resend: 'chat',
};

/** What the business's standing is, as the handler resolved it. */
export interface ChatStanding {
  /** The effective plan id (`expired` for a lapsed trial or a lapsed paid plan). */
  readonly plan: string;
  /** Whether the effective entitlements include `REKODA_CHAT`. */
  readonly holdsChat: boolean;
}

/**
 * The decision. `plan_lapsed` and `chat_not_in_plan` are refusals; each is
 * answered with a sentence and nothing else happens.
 */
export type ChatAccess = 'allow' | 'plan_lapsed' | 'chat_not_in_plan';

/**
 * The order is the model path's order (`interpretedReply`): a lapsed plan is
 * its own sentence first, then the entitlement. An explicit `REKODA_CHAT`
 * grant on a lapsed plan therefore does not reopen recording here either,
 * exactly as it does not reopen the model path.
 */
function decide(access: DeterministicAccessClass, standing: ChatStanding): ChatAccess {
  if (access === 'universal' || access === 'conversation') return 'allow';
  if (standing.plan === 'expired') {
    return access === 'chat_kept_on_lapse' ? 'allow' : 'plan_lapsed';
  }
  return standing.holdsChat ? 'allow' : 'chat_not_in_plan';
}

/** May this business run this deterministic intent's handler? */
export function deterministicAccess(
  kind: DeterministicIntent['kind'],
  standing: ChatStanding,
): ChatAccess {
  return decide(DETERMINISTIC_ACCESS[kind], standing);
}

/** Does this intent need the business's standing at all? Universal ones do not. */
export function needsChatStanding(kind: DeterministicIntent['kind']): boolean {
  const access = DETERMINISTIC_ACCESS[kind];
  return access === 'chat' || access === 'chat_kept_on_lapse';
}

/**
 * A "yes" confirming a draft made by Chat: a sale, a payment, an expense, a
 * purchase, a stock count, an order. The yes is when it becomes a record, so
 * it meets the same boundary the message that made it met. A plan that
 * lapsed or switched to Integrate between the preview and the yes records
 * nothing; the draft stays pending, so the same yes works after an upgrade
 * if its window is still open.
 */
export function chatDraftAccess(standing: ChatStanding): ChatAccess {
  return decide('chat', standing);
}

/**
 * A resumed read (Build 6): "last month" after "Which period?". It answers a
 * question about the books, so it is the same capability as `records`, and a
 * lapsed plan keeps it as it keeps `records`.
 */
export function resumedReadAccess(standing: ChatStanding): ChatAccess {
  return decide('chat_kept_on_lapse', standing);
}
