/**
 * The Paystack adapter (docs/payments-v1.md §6, §10, §20) — the ONLY file
 * that knows Paystack's URLs, field names and vocabulary. Everything it
 * returns is the port's neutral shape.
 *
 * Facts this file owns so nothing above has to:
 *  - amounts are integer kobo in BOTH directions; no arithmetic happens here;
 *  - `channels` leads with bank_transfer — Nigerian V1 is transfer-first;
 *  - Paystack requires an email; when Rekoda has none the answer is
 *    `requires_customer_information`, never `customer123@rekoda.app`;
 *  - a verify miss (unknown reference) is `{found: false}`, not an exception —
 *    an unknown reference is a routine investigation, not a crash;
 *  - the secret key goes into an Authorization header and nowhere else.
 */
import { Logger } from '@nestjs/common';
import {
  paystackChargeResponse,
  paystackInitializeResponse,
  paystackSettlementListResponse,
  paystackSettlementTransactionsResponse,
  paystackSubaccountResponse,
  paystackVerifyResponse,
} from '@rekoda/contracts';
import type {
  CreateSubaccountInput,
  CreateSubaccountResult,
  InitializeTransactionInput,
  InitializeTransactionResult,
  PaymentProviderPort,
  ProviderSettlement,
  VerifyTransactionResult,
} from './provider.port.js';

/** A hung provider must never hold a worker (or its transaction) open. */
/** A runaway guard: 200 pages is 40,000 settlements or transactions. */
const SETTLEMENT_MAX_PAGES = 200;
const REQUEST_TIMEOUT_MS = 15_000;

export class PaystackApiError extends Error {}

/**
 * Paystack's settlement vocabulary → ours. Anything unrecognised becomes
 * `held` in the adapter (see the port): the sweep will neither claim money
 * settled nor failed on a word this file has never seen.
 */
const SETTLEMENT_STATUS: Record<string, 'pending' | 'processing' | 'settled' | 'failed'> = {
  success: 'settled',
  processing: 'processing',
  pending: 'pending',
  failed: 'failed',
};

const CHANNEL_TO_METHOD: Record<string, string> = {
  bank_transfer: 'transfer',
  dedicated_nuban: 'transfer',
  card: 'card',
  ussd: 'transfer',
  bank: 'transfer',
};

export class PaystackProvider implements PaymentProviderPort {
  readonly providerType = 'paystack';
  private readonly log = new Logger(PaystackProvider.name);

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string,
  ) {}

  async createSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    /**
     * percentage_charge is the PLATFORM's cut of each split payment, and in
     * V1 Rekoda takes none (§14: platform fee is zero) — the merchant's
     * subaccount receives everything Paystack does not keep as its own fee.
     */
    const response = await fetch(`${this.baseUrl}/subaccount`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        business_name: input.businessName,
        settlement_bank: input.settlementBankCode,
        account_number: input.settlementAccountNumber,
        percentage_charge: 0,
      }),
    });

    /**
     * Paystack answers 400 for an account IT rejected (bad NUBAN, name
     * mismatch, unsupported bank) — that is a product state the merchant
     * fixes, not an outage to retry. Anything else non-OK is an outage.
     */
    const parsed = paystackSubaccountResponse.safeParse(
      await response.json().catch(() => ({ status: false })),
    );
    if (response.ok && parsed.success && parsed.data.status && parsed.data.data) {
      return { state: 'created', subaccountCode: parsed.data.data.subaccount_code };
    }
    if (response.status === 400 || (response.ok && parsed.success && !parsed.data.status)) {
      return {
        state: 'rejected',
        reason: parsed.success
          ? (parsed.data.message ?? 'provider rejected the account')
          : 'provider rejected the account',
      };
    }
    this.log.warn(`Paystack /subaccount answered HTTP ${response.status}`);
    throw new PaystackApiError(`/subaccount failed with HTTP ${response.status}`);
  }

  async initializeTransaction(
    input: InitializeTransactionInput,
  ): Promise<InitializeTransactionResult> {
    if (!input.customerEmail) {
      return { state: 'requires_customer_information', missing: ['email'] };
    }

    const body: Record<string, unknown> = {
      reference: input.reference,
      // Already kobo. Multiplying here turns ₦1,500 into ₦150,000.
      amount: input.amountK,
      currency: input.currency,
      email: input.customerEmail,
      channels: ['bank_transfer', 'card'],
    };
    if (input.subaccountCode) body['subaccount'] = input.subaccountCode;

    const parsed = paystackInitializeResponse.safeParse(
      await this.request('POST', '/transaction/initialize', body),
    );
    if (!parsed.success || !parsed.data.status || !parsed.data.data) {
      throw new PaystackApiError(
        `initialize refused: ${parsed.success ? (parsed.data.message ?? 'no message') : 'unreadable response'}`,
      );
    }
    return {
      state: 'initialized',
      checkoutUrl: parsed.data.data.authorization_url,
      accessCode: parsed.data.data.access_code,
    };
  }

  async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    return verifyPaystackTransaction(this.secretKey, this.baseUrl, reference);
  }

  async listSettlements(fromIso: string): Promise<ProviderSettlement[]> {
    const out: ProviderSettlement[] = [];
    for (let page = 1; page <= SETTLEMENT_MAX_PAGES; page++) {
      const query = `?from=${encodeURIComponent(fromIso)}&perPage=100&page=${page}`;
      const parsed = paystackSettlementListResponse.safeParse(
        await this.get(`/settlement${query}`),
      );
      if (!parsed.success || !parsed.data.status) {
        throw new PaystackApiError('settlement list returned an unreadable response');
      }
      const rows = parsed.data.data ?? [];
      for (const s of rows) {
        out.push({
          settlementId: String(s.id),
          status: SETTLEMENT_STATUS[s.status] ?? 'held',
          providerStatus: s.status,
          settledAtIso:
            SETTLEMENT_STATUS[s.status] === 'settled'
              ? (s.settlement_date ?? s.effective_date ?? null)
              : null,
          /* Kobo, verbatim from GET /settlement (§20): total_amount is
           * what the covered payments summed to, effective_amount what
           * left after Paystack's deductions. Absent on old rows → null,
           * and null means "nothing authoritative to record". */
          grossK: typeof s.total_amount === 'number' ? s.total_amount : null,
          netK: typeof s.effective_amount === 'number' ? s.effective_amount : null,
        });
      }
      /* Stop when the pager says this was the last page, or the page came
       * back short. Reading only page one silently dropped every settlement
       * batch past the first hundred in a busy window. */
      const pageCount = parsed.data.meta?.pageCount ?? page;
      if (page >= pageCount || rows.length < 100) break;
      if (page === SETTLEMENT_MAX_PAGES) {
        this.log.warn(`settlement list exceeded ${SETTLEMENT_MAX_PAGES} pages; stopping`);
      }
    }
    return out;
  }

  async listSettlementTransactions(settlementId: string): Promise<string[]> {
    const refs: string[] = [];
    const id = encodeURIComponent(settlementId);
    for (let page = 1; page <= SETTLEMENT_MAX_PAGES; page++) {
      const parsed = paystackSettlementTransactionsResponse.safeParse(
        await this.get(`/settlement/${id}/transactions?perPage=200&page=${page}`),
      );
      if (!parsed.success || !parsed.data.status) {
        throw new PaystackApiError('settlement transactions returned an unreadable response');
      }
      const rows = parsed.data.data ?? [];
      for (const t of rows) {
        if (typeof t.reference === 'string' && t.reference.length > 0) refs.push(t.reference);
      }
      /* Every reference past the first page used to be dropped, so a busy
       * merchant's payments reconciled as exceptions forever. */
      const pageCount = parsed.data.meta?.pageCount ?? page;
      if (page >= pageCount || rows.length < 200) break;
      if (page === SETTLEMENT_MAX_PAGES) {
        this.log.warn(`settlement ${id} exceeded ${SETTLEMENT_MAX_PAGES} pages; stopping`);
      }
    }
    return refs;
  }

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      this.log.warn(`Paystack ${path.split('?')[0]} answered HTTP ${response.status}`);
      throw new PaystackApiError(`${path.split('?')[0]} failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  private async request(method: string, path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // The body may explain (bad subaccount, disabled channel) but may also
      // echo request fields — log the status, never the body.
      /* The bare path only: a query string here can carry references. */
      this.log.warn(`Paystack ${path.split('?')[0]} answered HTTP ${response.status}`);
      throw new PaystackApiError(`${path.split('?')[0]} failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.secretKey}` };
  }
}

/**
 * Does Paystack accept this secret key? (ADR 0019, fix-plan 6 M5a.)
 *
 * A free function rather than a port method, because the key under test is
 * the MERCHANT's, not the one the singleton adapter was built with. /balance
 * is the cheapest authenticated read: 200 means the key is live, 401 means
 * Paystack said no, and anything else is an outage to surface, not a verdict
 * on the key.
 */
export async function verifyPaystackKey(
  secretKey: string,
  baseUrl: string,
): Promise<'ok' | 'invalid'> {
  const response = await fetch(`${baseUrl}/balance`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { authorization: `Bearer ${secretKey}` },
  });
  if (response.ok) return 'ok';
  if (response.status === 401 || response.status === 403) return 'invalid';
  throw new PaystackApiError(`/balance failed with HTTP ${response.status}`);
}

/**
 * Server-side verify under a CALLER-SUPPLIED key (fix-plan 6, M5c).
 *
 * The class method above delegates here with the platform key it was built
 * with; the merchant-key paths call this directly, because on ADR 0019's
 * model the authoritative answer about a merchant's money lives behind the
 * merchant's own key. Same normalisation, same "404 is a routine miss".
 */
export async function verifyPaystackTransaction(
  secretKey: string,
  baseUrl: string,
  reference: string,
): Promise<VerifyTransactionResult> {
  const response = await fetch(`${baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return { found: false };
  if (!response.ok) {
    throw new PaystackApiError(`verify failed with HTTP ${response.status}`);
  }

  const parsed = paystackVerifyResponse.safeParse(await response.json());
  if (!parsed.success) throw new PaystackApiError('verify returned an unreadable response');
  // status:false with a readable envelope is Paystack's own "not found".
  if (!parsed.data.status || !parsed.data.data) return { found: false };

  const d = parsed.data.data;
  return {
    found: true,
    transaction: {
      succeeded: d.status === 'success',
      reference: d.reference,
      amountK: d.amount,
      currency: d.currency,
      providerStatus: d.status,
      providerTransactionId: String(d.id),
      providerFeeK: d.fees ?? 0,
      method: CHANNEL_TO_METHOD[d.channel ?? ''] ?? 'unknown',
      paidAtIso: d.paid_at ?? null,
    },
  };
}

export interface TransferChargeInput {
  /** RKD-PAY-… — minted before this call, always ours. */
  reference: string;
  /** Integer kobo, passed through untouched. */
  amountK: number;
  currency: string;
  /** The paying customer's own address — Paystack requires one. Travels
   * here and is not stored by Rekoda. */
  email: string;
  /** When the temporary account should stop working (ADR 0016: generous). */
  expiresAtIso: string;
}

export type TransferChargeResult =
  | {
      state: 'account';
      bankName: string;
      accountNumber: string;
      accountName: string | null;
      expiresAtIso: string | null;
    }
  /** Paystack answered and said no — a product state, not an outage. */
  | { state: 'refused'; reason: string };

/**
 * Pay with Transfer (ADR 0016): one charge, one temporary account. Runs on
 * the MERCHANT's own key — this is their charge on their integration, which
 * is the whole of ADR 0019. An envelope that claims success but carries no
 * account number is treated as a refusal: a customer cannot transfer to a
 * status flag.
 */
export async function createTransferCharge(
  secretKey: string,
  baseUrl: string,
  input: TransferChargeInput,
): Promise<TransferChargeResult> {
  const log = new Logger('PaystackTransferCharge');
  const response = await fetch(`${baseUrl}/charge`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: input.email,
      amount: input.amountK,
      currency: input.currency,
      reference: input.reference,
      bank_transfer: { account_expires_at: input.expiresAtIso },
    }),
  });

  const parsed = paystackChargeResponse.safeParse(
    await response.json().catch(() => ({ status: false })),
  );
  if (response.status === 400 || (response.ok && parsed.success && !parsed.data.status)) {
    return {
      state: 'refused',
      reason: parsed.success
        ? (parsed.data.message ?? 'provider refused the charge')
        : 'provider refused the charge',
    };
  }
  if (!response.ok || !parsed.success) {
    log.warn(`Paystack /charge answered HTTP ${response.status}`);
    throw new PaystackApiError(`/charge failed with HTTP ${response.status}`);
  }

  const transfer = parsed.data.data?.bank_transfer;
  if (!transfer?.account_number) {
    return { state: 'refused', reason: 'provider returned no transfer account' };
  }
  return {
    state: 'account',
    bankName: transfer.bank?.name ?? 'your bank app',
    accountNumber: transfer.account_number,
    accountName: transfer.account_name ?? null,
    expiresAtIso: transfer.account_expires_at ?? input.expiresAtIso,
  };
}
