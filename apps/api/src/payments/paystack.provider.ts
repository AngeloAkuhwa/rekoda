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
    const response = await fetch(
      `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: this.headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
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

  async listSettlements(fromIso: string): Promise<ProviderSettlement[]> {
    const query = `?from=${encodeURIComponent(fromIso)}&perPage=100`;
    const parsed = paystackSettlementListResponse.safeParse(await this.get(`/settlement${query}`));
    if (!parsed.success || !parsed.data.status) {
      throw new PaystackApiError('settlement list returned an unreadable response');
    }
    return (parsed.data.data ?? []).map((s) => ({
      settlementId: String(s.id),
      status: SETTLEMENT_STATUS[s.status] ?? 'held',
      providerStatus: s.status,
      settledAtIso:
        SETTLEMENT_STATUS[s.status] === 'settled'
          ? (s.settlement_date ?? s.effective_date ?? null)
          : null,
    }));
  }

  async listSettlementTransactions(settlementId: string): Promise<string[]> {
    const parsed = paystackSettlementTransactionsResponse.safeParse(
      await this.get(`/settlement/${encodeURIComponent(settlementId)}/transactions?perPage=200`),
    );
    if (!parsed.success || !parsed.data.status) {
      throw new PaystackApiError('settlement transactions returned an unreadable response');
    }
    return (parsed.data.data ?? [])
      .map((t) => t.reference)
      .filter((r): r is string => typeof r === 'string' && r.length > 0);
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
