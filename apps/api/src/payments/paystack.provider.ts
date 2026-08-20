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
  paystackSubaccountResponse,
  paystackVerifyResponse,
} from '@rekoda/contracts';
import type {
  CreateSubaccountInput,
  CreateSubaccountResult,
  InitializeTransactionInput,
  InitializeTransactionResult,
  PaymentProviderPort,
  VerifyTransactionResult,
} from './provider.port.js';

export class PaystackApiError extends Error {}

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
      { headers: this.headers() },
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

  private async request(method: string, path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // The body may explain (bad subaccount, disabled channel) but may also
      // echo request fields — log the status, never the body.
      this.log.warn(`Paystack ${path} answered HTTP ${response.status}`);
      throw new PaystackApiError(`${path} failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.secretKey}` };
  }
}
