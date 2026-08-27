import type {
  CreateSubaccountInput,
  CreateSubaccountResult,
  InitializeTransactionInput,
  InitializeTransactionResult,
  PaymentProviderPort,
  ProviderSettlement,
  VerifiedTransaction,
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
    this.initialized.length = 0;
    this.subaccountsCreated.length = 0;
    this.verifications.clear();
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
