/**
 * The Mono adapter (ADR 0012, fix-plan 4 G5) — the ONLY file that knows
 * Mono's URLs, header name and vocabulary. Everything it returns is the
 * port's neutral shape.
 *
 * Facts this file owns so nothing above has to:
 *  - the secret key travels in Mono's `mono-sec-key` header and nowhere else;
 *  - amounts are ALREADY integer kobo and always positive; `type` carries
 *    the direction, and this adapter is where `debit` becomes a negative
 *    signed amount so the reconciliation engine reads feed lines and CSV
 *    lines identically;
 *  - a movement of zero kobo is dropped here, because the statement table's
 *    own constraint (`amount_k <> 0`) would reject it anyway — a line that
 *    moves nothing reconciles nothing;
 *  - HTTP 401/403 on a linked account is `unlinked`, not an exception: a
 *    merchant revoking consent at their bank is a product state, and the
 *    page answers it with "link it again".
 */
import { Logger } from '@nestjs/common';
import { monoAccountResponse, monoAuthResponse, monoTransactionsResponse } from '@rekoda/contracts';
import type {
  BankFeedPort,
  FeedTransaction,
  FetchTransactionsResult,
  LinkAccountResult,
} from './feed.port.js';

/** A hung aggregator must never hold a request (or its transaction) open. */
const REQUEST_TIMEOUT_MS = 15_000;

export class MonoApiError extends Error {}

export class MonoProvider implements BankFeedPort {
  readonly providerType = 'mono';
  private readonly log = new Logger(MonoProvider.name);

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string,
  ) {}

  get configured(): boolean {
    return this.secretKey !== '';
  }

  async linkAccount(exchangeCode: string): Promise<LinkAccountResult> {
    const auth = await fetch(`${this.baseUrl}/v2/accounts/auth`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ code: exchangeCode }),
    });
    const parsedAuth = monoAuthResponse.safeParse(await auth.json().catch(() => ({})));

    /* Mono answers 4xx for a code IT rejected — stale, already exchanged,
     * or malformed. That is a state the merchant fixes by re-authorising,
     * not an outage to retry. */
    if (auth.status >= 400 && auth.status < 500) {
      return {
        state: 'rejected',
        reason: parsedAuth.success
          ? (parsedAuth.data.message ?? 'the aggregator rejected the code')
          : 'the aggregator rejected the code',
      };
    }
    if (!auth.ok || !parsedAuth.success || !parsedAuth.data.data?.id) {
      this.log.warn(`Mono /v2/accounts/auth answered HTTP ${auth.status}`);
      throw new MonoApiError(`/v2/accounts/auth failed with HTTP ${auth.status}`);
    }
    const accountRef = parsedAuth.data.data.id;

    /* The label the merchant reads on the card. Best-effort by design: a
     * link that works but cannot be prettily named is still a link. */
    let bankName = 'Linked bank';
    let accountLast4 = '';
    try {
      const details = await fetch(`${this.baseUrl}/v2/accounts/${accountRef}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: this.headers(),
      });
      const parsedDetails = monoAccountResponse.safeParse(await details.json().catch(() => ({})));
      if (details.ok && parsedDetails.success && parsedDetails.data.data?.account) {
        const account = parsedDetails.data.data.account;
        bankName = account.institution?.name ?? bankName;
        accountLast4 = (account.account_number ?? '').slice(-4);
      }
    } catch {
      this.log.warn('Mono account details unavailable; linking with a plain label');
    }

    return { state: 'linked', accountRef, bankName, accountLast4 };
  }

  async fetchTransactions(accountRef: string, sinceDay: string): Promise<FetchTransactionsResult> {
    /* Mono spells days DD-MM-YYYY in this query. The one place the spelling
     * exists is this line. */
    const start = `${sinceDay.slice(8, 10)}-${sinceDay.slice(5, 7)}-${sinceDay.slice(0, 4)}`;
    const url =
      `${this.baseUrl}/v2/accounts/${accountRef}/transactions` +
      `?start=${encodeURIComponent(start)}&paginate=false`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: this.headers(),
    });

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { state: 'unlinked' };
    }
    const parsed = monoTransactionsResponse.safeParse(await response.json().catch(() => ({})));
    if (!response.ok || !parsed.success) {
      this.log.warn(`Mono transactions answered HTTP ${response.status}`);
      throw new MonoApiError(`/v2/accounts/transactions failed with HTTP ${response.status}`);
    }

    const transactions: FeedTransaction[] = [];
    for (const row of parsed.data.data ?? []) {
      /* Kobo in, kobo out; only the SIGN is this adapter's work. */
      const magnitude = Math.abs(Math.trunc(row.amount));
      if (magnitude === 0) continue;
      transactions.push({
        postedOn: row.date.slice(0, 10),
        amountK: row.type === 'debit' ? -magnitude : magnitude,
        narration: row.narration ?? '',
        bankRef: row.id ?? null,
        /* Mono's transaction id, doing double duty: the label above and
         * the §22.3 connection-scoped identity below. */
        externalTransactionId: row.id ?? null,
      });
    }
    return { state: 'ok', transactions };
  }

  private headers(): Record<string, string> {
    return { 'mono-sec-key': this.secretKey, accept: 'application/json' };
  }
}
