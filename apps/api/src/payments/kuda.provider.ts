/**
 * Kuda behind the provider-neutral port (spec §18; P3, PR-071).
 *
 * The fourth collector — and the first that is a BANK, which is exactly
 * why it earns its place in the suite: §6–7 of the payments canon says
 * capabilities are modelled explicitly so providers can differ without
 * the transaction engine changing, and Kuda differs more than Mono or
 * OPay ever did. Wire shapes follow Kuda's Open API v2.1 envelope (one
 * POST endpoint carrying serviceType/requestRef/data under a bearer
 * token; naira amounts as integer kobo); the conformance fixtures pin
 * the exact bodies this adapter is built against, and PRODUCTION
 * ENABLEMENT REMAINS BLOCKED by the 0093 capability rows ("OPEN
 * COMPLIANCE: Kuda regulatory and commercial approval") — the wire this
 * adapter speaks is confirmed when that approval lands, and unblocking
 * is a data change.
 *
 * Where Kuda's model differs, the adapter says so instead of inventing:
 *  - there is no hosted checkout to initialize. Kuda collection rides
 *    bank transfers into a Kuda virtual account, and the port's
 *    initialized state IS a checkout URL — so `initializeTransaction`
 *    refuses with the capability gap BY NAME, without a request and
 *    without a fabricated endpoint;
 *  - virtual accounts are minted from identity fields this port does
 *    not carry, and money lands IN them rather than settling to the
 *    merchant's external account: `createSubaccount` answers `rejected`
 *    with that sentence, without a request;
 *  - there are no settlement batches, because the bank credit IS the
 *    settlement: `listSettlements` answers an EMPTY list without a
 *    request — nothing §20-shaped is invented, and Kuda money truth
 *    arrives with the FEED integration behind the same 0093 blocker.
 *
 * What remains is real and documented: TRANSACTION_STATUS_QUERY through
 * the v2.1 envelope, verifying a transfer by the reference it carried.
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

export class KudaApiError extends Error {}

/**
 * Not a provider answer and not an outage: the port asked for something
 * Kuda's model does not have. Callers never see this in practice — the
 * 0093 capability rows keep the resolver from ever picking Kuda before
 * the commercial integration defines the collection flow.
 */
export class KudaCapabilityGapError extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;

export class KudaProvider implements PaymentProviderPort {
  readonly providerType = 'kuda';
  private readonly log = new Logger(KudaProvider.name);

  constructor(
    private readonly apiToken: string,
    private readonly baseUrl: string,
  ) {}

  createSubaccount(_input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    /* No request: a fact about Kuda's model, not a provider answer. */
    return Promise.resolve({
      state: 'rejected',
      reason:
        'Kuda mints virtual accounts from identity fields this port does not carry, and funds land in them rather than settling to an external account; the commercial integration wires this, not an API call from here',
    });
  }

  initializeTransaction(_input: InitializeTransactionInput): Promise<InitializeTransactionResult> {
    /* No request and no invented endpoint: the gap is named instead. */
    return Promise.reject(
      new KudaCapabilityGapError(
        'Kuda exposes no hosted checkout to initialize; collection rides bank transfers into a Kuda virtual account, and that flow arrives with the commercial integration the 0093 capability row names',
      ),
    );
  }

  async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    const body = await this.invoke('TRANSACTION_STATUS_QUERY', reference, {
      isThirdPartyBankTransfer: true,
      transactionRequestReference: reference,
    });
    const parsed = body as {
      status?: boolean;
      message?: string;
      data?: {
        transactionReference?: string;
        status?: string;
        amount?: number;
        transactionDate?: string;
      };
    };
    /* Kuda answers an unknown reference in-band: status false, HTTP 200. */
    if (parsed.status !== true || !parsed.data || typeof parsed.data.amount !== 'number') {
      return { found: false };
    }
    const providerStatus = parsed.data.status ?? 'unknown';
    const succeeded = providerStatus.toUpperCase() === 'SUCCESSFUL';
    return {
      found: true,
      transaction: {
        succeeded,
        reference,
        /* Integer kobo, straight from the wire. */
        amountK: parsed.data.amount,
        /* Kuda is a naira bank; the wire states no currency field. */
        currency: 'NGN',
        providerStatus,
        providerTransactionId: parsed.data.transactionReference ?? '',
        /* Kuda states no fee on the status query. Zero means "not
         * computed here"; the actual cost arrives with the bank record. */
        providerFeeK: 0,
        /* Every Kuda collection is a bank transfer. */
        method: 'transfer',
        paidAtIso: succeeded ? (parsed.data.transactionDate ?? null) : null,
      },
    };
  }

  listSettlements(_fromIso: string): Promise<ProviderSettlement[]> {
    /* No batches to poll and none invented (§20): the bank credit is the
     * settlement, and the FEED integration reads the account. */
    return Promise.resolve([]);
  }

  listSettlementTransactions(_settlementId: string): Promise<string[]> {
    return Promise.resolve([]);
  }

  /** Kuda's v2.1 envelope: one endpoint, serviceType names the call. */
  private async invoke(serviceType: string, requestRef: string, data: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/v2.1`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ serviceType, requestRef, data }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      /* Status only — a Kuda error body can echo the request. */
      this.log.warn(`Kuda ${serviceType} answered HTTP ${response.status}`);
      throw new KudaApiError(`${serviceType} failed with HTTP ${response.status}`);
    }
    return response.json();
  }
}
