import type {
  CreateSubaccountInput,
  CreateSubaccountResult,
  InitializeTransactionInput,
  InitializeTransactionResult,
  PaymentProviderPort,
  ProviderSettlement,
  VerifiedDispute,
  VerifiedRefund,
  VerifiedTransaction,
  VerifyDisputeResult,
  VerifyRefundResult,
  VerifyTransactionResult,
} from './provider.port.js';

/**
 * A provider that answers from a script instead of an API.
 *
 * The processing job's whole safety story is "the webhook is a hint; verify
 * is the truth" — so the tests need to control what the truth SAYS,
 * independently of what the webhook claimed. A stub keyed by reference is
 * exactly that control.
 */
export class StubPaymentProvider implements PaymentProviderPort {
  readonly providerType = 'paystack';
  readonly initialized: InitializeTransactionInput[] = [];
  readonly subaccountsCreated: CreateSubaccountInput[] = [];
  private readonly verifications = new Map<string, VerifiedTransaction>();
  private readonly refunds = new Map<string, VerifiedRefund>();
  private readonly disputes = new Map<string, VerifiedDispute>();
  private failRefundRead: Error | null = null;
  private failDisputeRead: Error | null = null;
  private readonly settlements: Array<ProviderSettlement & { references: string[] }> = [];
  private failInitialize: Error | null = null;
  private failVerify: Error | null = null;
  private failSettlements: Error | null = null;
  private rejectSubaccountWith: string | null = null;

  /** Script the authoritative answer for one reference. */
  willVerify(reference: string, overrides: Partial<VerifiedTransaction> = {}): void {
    this.verifications.set(reference, {
      succeeded: true,
      reference,
      amountK: 0,
      currency: 'NGN',
      providerStatus: 'success',
      providerTransactionId: `stub-${this.verifications.size + 1}`,
      providerFeeK: 0,
      method: 'transfer',
      paidAtIso: null,
      ...overrides,
    });
  }

  /** Script the authoritative answer about one refund. */
  willVerifyRefund(providerRefundId: string, overrides: Partial<VerifiedRefund> = {}): void {
    this.refunds.set(providerRefundId, {
      succeeded: true,
      providerRefundId,
      transactionReference: null,
      transactionId: null,
      amountK: 0,
      currency: 'NGN',
      providerStatus: 'processed',
      refundedAtIso: null,
      ...overrides,
    });
  }

  /** Script the authoritative answer about one dispute. */
  willVerifyDispute(providerDisputeId: string, overrides: Partial<VerifiedDispute> = {}): void {
    this.disputes.set(providerDisputeId, {
      providerDisputeId,
      transactionReference: null,
      transactionId: null,
      amountK: null,
      currency: 'NGN',
      providerStatus: 'awaiting-merchant-feedback',
      providerResolution: null,
      outcome: 'open',
      ...overrides,
    });
  }

  failNextDisputeReadWith(error: Error): void {
    this.failDisputeRead = error;
  }

  failNextRefundReadWith(error: Error): void {
    this.failRefundRead = error;
  }

  /** Make the next verify call fail, as a provider outage would. */
  failNextInitializeWith(error: Error): void {
    this.failInitialize = error;
  }

  failNextVerifyWith(error: Error): void {
    this.failVerify = error;
  }

  /** Make the provider refuse the next subaccount, as a bad NUBAN would. */
  rejectNextSubaccount(reason = 'Account number is invalid'): void {
    this.rejectSubaccountWith = reason;
  }

  /** Script one settlement batch and the references it carried. */
  willSettle(settlement: Partial<ProviderSettlement> & { references: string[] }): void {
    this.settlements.push({
      settlementId: `stl-${this.settlements.length + 1}`,
      status: 'settled',
      providerStatus: 'success',
      settledAtIso: '2026-08-19T04:00:00.000Z',
      /* Null by default, as an old provider row would be: a test that
       * wants §20 ingestion scripts the amounts explicitly. */
      grossK: null,
      netK: null,
      ...settlement,
    });
  }

  failNextSettlementsWith(error: Error): void {
    this.failSettlements = error;
  }

  reset(): void {
    this.failDisputeRead = null;
    this.initialized.length = 0;
    this.subaccountsCreated.length = 0;
    this.verifications.clear();
    this.refunds.clear();
    this.disputes.clear();
    this.failRefundRead = null;
    this.settlements.length = 0;
    this.failVerify = null;
    this.failInitialize = null;
    this.failSettlements = null;
    this.rejectSubaccountWith = null;
  }

  createSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    if (this.rejectSubaccountWith) {
      const reason = this.rejectSubaccountWith;
      this.rejectSubaccountWith = null;
      return Promise.resolve({ state: 'rejected', reason });
    }
    this.subaccountsCreated.push(input);
    return Promise.resolve({
      state: 'created',
      subaccountCode: `ACCT_stub${this.subaccountsCreated.length}`,
    });
  }

  initializeTransaction(input: InitializeTransactionInput): Promise<InitializeTransactionResult> {
    if (this.failInitialize) {
      const error = this.failInitialize;
      this.failInitialize = null;
      return Promise.reject(error);
    }
    if (!input.customerEmail) {
      return Promise.resolve({
        state: 'requires_customer_information',
        missing: ['email'],
      });
    }
    this.initialized.push(input);
    return Promise.resolve({
      state: 'initialized',
      checkoutUrl: `https://checkout.stub/${input.reference}`,
      accessCode: `AC_${input.reference}`,
    });
  }

  verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    if (this.failVerify) {
      const error = this.failVerify;
      this.failVerify = null;
      return Promise.reject(error);
    }
    const transaction = this.verifications.get(reference);
    if (!transaction) return Promise.resolve({ found: false });
    return Promise.resolve({ found: true, transaction });
  }

  verifyRefund(providerRefundId: string): Promise<VerifyRefundResult> {
    if (this.failRefundRead) {
      const error = this.failRefundRead;
      this.failRefundRead = null;
      return Promise.reject(error);
    }
    const refund = this.refunds.get(providerRefundId);
    if (!refund) return Promise.resolve({ found: false });
    return Promise.resolve({ found: true, refund });
  }

  /** The refunds scripted against one charge, by the id the charge's verify carried. */
  listRefunds(providerTransactionId: string, _currency: string): Promise<VerifiedRefund[]> {
    if (this.failRefundRead) {
      const error = this.failRefundRead;
      this.failRefundRead = null;
      return Promise.reject(error);
    }
    return Promise.resolve(
      [...this.refunds.values()].filter((r) => r.transactionId === providerTransactionId),
    );
  }

  verifyDispute(providerDisputeId: string): Promise<VerifyDisputeResult> {
    if (this.failDisputeRead) {
      const error = this.failDisputeRead;
      this.failDisputeRead = null;
      return Promise.reject(error);
    }
    const dispute = this.disputes.get(providerDisputeId);
    if (!dispute) return Promise.resolve({ found: false });
    return Promise.resolve({ found: true, dispute });
  }

  listSettlements(_fromIso: string): Promise<ProviderSettlement[]> {
    if (this.failSettlements) {
      const error = this.failSettlements;
      this.failSettlements = null;
      return Promise.reject(error);
    }
    return Promise.resolve(
      this.settlements.map(({ references: _references, ...settlement }) => settlement),
    );
  }

  listSettlementTransactions(settlementId: string): Promise<string[]> {
    const settlement = this.settlements.find((s) => s.settlementId === settlementId);
    return Promise.resolve(settlement ? [...settlement.references] : []);
  }
}
