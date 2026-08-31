/**
 * The provider-neutral bank-feed port (ADR 0012, fix-plan 4 G5).
 *
 * The feed is the second door into `bank_statement_lines`: an aggregator the
 * MERCHANT authorises reads their account, and Rekoda pulls what moved.
 * Everything above this interface speaks these shapes and only these shapes
 * — the day Mono is joined by a second aggregator (the concentration risk
 * MASTER-PLAN names, since Mono is Flutterwave-owned), that is one more
 * adapter and no other file. Same construction as PaymentProviderPort, and
 * the token lives here for the same circular-import lesson.
 *
 * Two rules the shape enforces:
 *  - Rekoda never sees credentials. The merchant authorises inside the
 *    aggregator's own widget; what reaches this port is a one-time exchange
 *    code and, after that, an opaque account reference.
 *  - transactions come out in the SAME signed-kobo convention the CSV parser
 *    produces (positive = money in), so the fingerprint, the dedupe and the
 *    reconciliation never learn which door a line used.
 */

export const BANK_FEED = Symbol('BankFeedProvider');

export interface FeedTransaction {
  /** The day the bank posted it, `YYYY-MM-DD`. */
  postedOn: string;
  /** SIGNED integer kobo. Positive is money INTO the account. */
  amountK: number;
  /**
   * The bank's own words. IN MEMORY ONLY.
   *
   * Not stored, not returned by any reader, not shown to the merchant, never
   * modelled. It exists for the few milliseconds between the provider
   * answering and `importStatementLines` pulling the Rekoda references out
   * of it, and the row it writes does not carry it (migration 0127).
   *
   * It cannot be removed from this type: it is the only thing those
   * references can be extracted FROM, and a provider that stopped supplying
   * it would stop reconciling by reference altogether.
   */
  narration: string;
  /** The aggregator's reference for the movement, when it publishes one. */
  bankRef: string | null;
  /**
   * The aggregator's OWN id for the movement — §22.3 identity, scoped to
   * the connection that produced it, never assumed globally unique. Null
   * where a provider genuinely publishes none.
   */
  externalTransactionId: string | null;
}

export type LinkAccountResult =
  /** The code exchanged; the label fields feed the card the merchant reads. */
  | { state: 'linked'; accountRef: string; bankName: string; accountLast4: string }
  /** The aggregator said no — a stale or already-used code, usually. */
  | { state: 'rejected'; reason: string };

export type FetchTransactionsResult =
  | { state: 'ok'; transactions: FeedTransaction[] }
  /** Access lapsed provider-side: the merchant must authorise again. */
  | { state: 'unlinked' };

export interface BankFeedPort {
  readonly providerType: string;
  /**
   * Whether this deployment has the feed at all. False is a product state
   * the page explains, never an error: a deployment without aggregator
   * credentials runs on statement upload alone, as every deployment did
   * before the feed shipped.
   */
  readonly configured: boolean;
  linkAccount(exchangeCode: string): Promise<LinkAccountResult>;
  /** Everything from `sinceDay` (inclusive, `YYYY-MM-DD`) to now. */
  fetchTransactions(accountRef: string, sinceDay: string): Promise<FetchTransactionsResult>;
}
