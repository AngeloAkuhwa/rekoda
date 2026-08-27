/**
 * Mono DirectPay behind the provider-neutral port (spec §18; P3, PR-069).
 *
 * The second collector, which is the whole point: provider neutrality is
 * proven by having more than one provider pass the SAME conformance
 * suite. The wire shapes follow Mono's published v2 DirectPay API
 * (initiate / verify under the `mono-sec-key` header, amounts in kobo);
 * the conformance fixtures pin the exact bodies this adapter is built
 * against, and PRODUCTION ENABLEMENT REMAINS BLOCKED by the 0093
 * capability row ("OPEN COMMERCIAL: Mono production terms") — this
 * adapter existing is not the same as it being available to a merchant.
 *
 * Where Mono's model genuinely differs from Paystack's, the adapter says
 * so instead of pretending:
 *  - DirectPay mints no per-merchant subaccounts; settlement goes to the
 *    beneficiary account on file. `createSubaccount` answers `rejected`
 *    with that sentence, without making a request.
 *  - DirectPay exposes no settlement batches to poll. `listSettlements`
 *    answers an EMPTY list without a request — no §20 rows are invented,
 *    and Mono settlement truth arrives with the feed integration the
 *    external-blockers table already names.
 */
import { Logger } from '@nestjs/common';
import type {
  CreateSubaccountInput,
  CreateSubaccountResult,
  InitializeTransactionInput,
  InitializeTransactionResult,
  PaymentProviderPort,
  ProviderSettlement,
  VerifyTransactionResult,
} from './provider.port.js';

export class MonoApiError extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;

export class MonoDirectPayProvider implements PaymentProviderPort {
  readonly providerType = 'mono';
  private readonly log = new Logger(MonoDirectPayProvider.name);

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string,
  ) {}

  createSubaccount(_input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    /* No request: this is a fact about Mono's model, not a provider answer. */
    return Promise.resolve({
      state: 'rejected',
      reason:
        'Mono DirectPay settles to the beneficiary account on file; it does not mint per-merchant subaccounts',
    });
  }

  async initializeTransaction(
    input: InitializeTransactionInput,
  ): Promise<InitializeTransactionResult> {
    /* Same rule as every adapter: an email Rekoda does not know is a
     * product state, never an invented address, and no request happens. */
    if (!input.customerEmail) {
      return { state: 'requires_customer_information', missing: ['email'] };
    }

    const body = await this.request('POST', '/v2/payments/initiate', {
      /* Kobo, UNMULTIPLIED — Mono's amounts are minor units already. */
      amount: input.amountK,
      type: 'onetime-debit',
      method: 'account',
      currency: input.currency,
      reference: input.reference,
      description: 'Rekoda payment',
      customer: { email: input.customerEmail },
    });
    const data = (body as { status?: string; data?: { id?: string; mono_url?: string } }).data;
    const checkoutUrl = data?.mono_url;
    if (!checkoutUrl) {
      throw new MonoApiError('initiate refused: no payment link in the response');
    }
    return { state: 'initialized', checkoutUrl, accessCode: data?.id ?? '' };
  }

  async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    let body: unknown;
    try {
      body = await this.request('POST', '/v2/payments/verify', { reference });
    } catch (error) {
      if (error instanceof MonoApiError && error.message.includes('HTTP 404')) {
        return { found: false };
      }
      throw error;
    }
    const data = (
      body as {
        data?: {
          id?: string;
          status?: string;
          amount?: number;
          fee?: number;
          currency?: string;
          created_at?: string;
        };
      }
    ).data;
    if (!data || typeof data.amount !== 'number') return { found: false };
    const providerStatus = data.status ?? 'unknown';
    return {
      found: true,
      transaction: {
        /* The adapter's translation; the native word rides along for audit. */
        succeeded: providerStatus === 'successful',
        reference,
        amountK: data.amount,
        currency: data.currency ?? 'NGN',
        providerStatus,
        providerTransactionId: data.id ?? '',
        providerFeeK: typeof data.fee === 'number' ? data.fee : 0,
        /* DirectPay debits the customer's account. */
        method: 'transfer',
        paidAtIso: providerStatus === 'successful' ? (data.created_at ?? null) : null,
      },
    };
  }

  listSettlements(_fromIso: string): Promise<ProviderSettlement[]> {
    /* No batches to poll and none invented (§20): Mono settlement truth
     * arrives with the feed integration, not from this port. */
    return Promise.resolve([]);
  }

  listSettlementTransactions(_settlementId: string): Promise<string[]> {
    return Promise.resolve([]);
  }

  private async request(method: string, path: string, payload: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'mono-sec-key': this.secretKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      /* Status only — a Mono error body can echo the request. */
      this.log.warn(`Mono ${path} answered HTTP ${response.status}`);
      throw new MonoApiError(`${path} failed with HTTP ${response.status}`);
    }
    return response.json();
  }
}
