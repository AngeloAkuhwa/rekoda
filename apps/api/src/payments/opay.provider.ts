/**
 * OPay behind the provider-neutral port (spec §18; P3, PR-070).
 *
 * The third collector through the SAME conformance suite. Wire shapes
 * follow OPay's cashier API (create / status under a Bearer key plus the
 * merchant id header; amounts as integer kobo inside an amount object);
 * the conformance fixtures pin the exact bodies this adapter is built
 * against, and PRODUCTION ENABLEMENT REMAINS BLOCKED by the 0093
 * capability row ("OPEN COMMERCIAL: OPay production access").
 *
 * Where OPay's model differs, the adapter says so:
 *  - sub-merchant onboarding is a commercial arrangement, not a simple
 *    API call: `createSubaccount` answers `rejected` without a request;
 *  - no settlement batches are exposed to poll: `listSettlements`
 *    answers an EMPTY list without a request — nothing §20-shaped is
 *    invented for a provider that does not report it.
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

export class OPayApiError extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;

/** OPay's status vocabulary, translated conservatively. */
const SUCCEEDED = new Set(['SUCCESS']);

export class OPayProvider implements PaymentProviderPort {
  readonly providerType = 'opay';
  private readonly log = new Logger(OPayProvider.name);

  constructor(
    private readonly publicKey: string,
    private readonly merchantId: string,
    private readonly baseUrl: string,
  ) {}

  createSubaccount(_input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    /* No request: sub-merchant onboarding at OPay is a commercial
     * arrangement, not an API call this port can make. */
    return Promise.resolve({
      state: 'rejected',
      reason: 'OPay sub-merchant onboarding is a commercial arrangement, not an API request',
    });
  }

  async initializeTransaction(
    input: InitializeTransactionInput,
  ): Promise<InitializeTransactionResult> {
    if (!input.customerEmail) {
      return { state: 'requires_customer_information', missing: ['email'] };
    }

    const body = await this.request('POST', '/api/v1/international/cashier/create', {
      reference: input.reference,
      /* Kobo, UNMULTIPLIED, inside OPay's amount object. */
      amount: { total: input.amountK, currency: input.currency },
      product: { name: 'Rekoda payment', description: 'Rekoda payment' },
      userInfo: { userEmail: input.customerEmail },
      payMethod: 'BankTransfer',
    });
    const data = (body as { code?: string; data?: { cashierUrl?: string; orderNo?: string } }).data;
    const checkoutUrl = data?.cashierUrl;
    if (!checkoutUrl) {
      throw new OPayApiError('cashier create refused: no cashier URL in the response');
    }
    return { state: 'initialized', checkoutUrl, accessCode: data?.orderNo ?? '' };
  }

  async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    const body = await this.request('POST', '/api/v1/international/cashier/status', {
      reference,
    });
    const parsed = body as {
      code?: string;
      data?: {
        status?: string;
        orderNo?: string;
        amount?: { total?: number; currency?: string };
        createTime?: number;
      };
    };
    /* OPay answers an unknown reference in-band, not with a 404. */
    if (parsed.code !== '00000' || !parsed.data || typeof parsed.data.amount?.total !== 'number') {
      return { found: false };
    }
    const providerStatus = parsed.data.status ?? 'unknown';
    const succeeded = SUCCEEDED.has(providerStatus);
    return {
      found: true,
      transaction: {
        succeeded,
        reference,
        amountK: parsed.data.amount.total,
        currency: parsed.data.amount.currency ?? 'NGN',
        providerStatus,
        providerTransactionId: parsed.data.orderNo ?? '',
        /* OPay does not state a fee on the status call. Zero means "not
         * computed here"; the actual fee arrives with settlement truth. */
        providerFeeK: 0,
        method: 'transfer',
        paidAtIso:
          succeeded && typeof parsed.data.createTime === 'number'
            ? new Date(parsed.data.createTime).toISOString()
            : null,
      },
    };
  }

  listSettlements(_fromIso: string): Promise<ProviderSettlement[]> {
    /* No batches to poll and none invented (§20). */
    return Promise.resolve([]);
  }

  listSettlementTransactions(_settlementId: string): Promise<string[]> {
    return Promise.resolve([]);
  }

  private async request(method: string, path: string, payload: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.publicKey}`,
        MerchantId: this.merchantId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      /* Status only — an OPay error body can echo the request. */
      this.log.warn(`OPay ${path} answered HTTP ${response.status}`);
      throw new OPayApiError(`${path} failed with HTTP ${response.status}`);
    }
    return response.json();
  }
}
