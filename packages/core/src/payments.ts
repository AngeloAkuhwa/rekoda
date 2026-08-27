/**
 * The Payment Hub's domain rules (docs/payments-v1.md).
 *
 * Pure, and in the barrel: nothing here touches node:crypto, a database or a
 * provider SDK. These are the decisions — is this provider event the money we
 * expected, how does a confirmed amount reconcile against an obligation, who
 * bears a fee — and decisions about money must be checkable without mocking
 * the thing that carries them.
 *
 * Provider-neutral by construction. Nothing in this file knows what a
 * subaccount code or a `charge.success` is; adapters translate providers into
 * these shapes, and everything above (invoices, receipts, ledger,
 * reconciliation) consumes only these.
 */

/* ── states (payments-v1 §5, §8, §17, §23, §27) ───────────────────────────── */

export const CONNECTION_STATUSES = [
  'not_configured',
  'pending_details',
  'pending_provider_creation',
  'pending_kyc',
  'pending_settlement_verification',
  'active',
  'suspended',
  'failed',
  'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const INTENT_STATUSES = [
  'created',
  'awaiting_provider',
  'awaiting_customer',
  'processing',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;
export type PaymentIntentStatus = (typeof INTENT_STATUSES)[number];

/** Terminal intents accept no further transitions — a webhook arriving after
 * expiry must not resurrect one. */
export function isTerminalIntentStatus(status: PaymentIntentStatus): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'expired' || status === 'cancelled'
  );
}

export type ReconciliationState =
  | 'matched'
  | 'partial_match'
  | 'overpaid'
  | 'unmatched'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'duplicate'
  | 'reversed'
  | 'requires_review';

export type SettlementStatus =
  'not_applicable' | 'pending' | 'processing' | 'settled' | 'failed' | 'held';

export type FeePolicy = 'customer_bearing' | 'merchant_bearing' | 'platform_bearing';

/** §19: who ends up out of pocket. Rekoda's concept — never the provider's. */
export const ECONOMIC_FEE_BEARERS = ['MERCHANT', 'CUSTOMER', 'REKODA', 'SHARED'] as const;
export type EconomicFeeBearer = (typeof ECONOMIC_FEE_BEARERS)[number];

/** What each blended fee policy always meant economically. One place. */
export function bearerOfFeePolicy(policy: FeePolicy): EconomicFeeBearer {
  switch (policy) {
    case 'customer_bearing':
      return 'CUSTOMER';
    case 'platform_bearing':
      return 'REKODA';
    case 'merchant_bearing':
      return 'MERCHANT';
  }
}

/* ── the Rekoda reference (payments-v1 §9) ────────────────────────────────── */

/**
 * Crockford base32 — no I, L, O, U — same alphabet as customer tokens, and for
 * the same reason: these get read over the phone to a bank's support line.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type RandomBytes = (n: number) => Uint8Array;

/**
 * `RKD-PAY-20260819-A83F92` — the authoritative reference Rekoda mints BEFORE
 * anything reaches a provider.
 *
 * The date segment is not decoration: an unmatched transfer three weeks later
 * is investigated by a human, and "which day was this minted" narrows a search
 * before any system is opened. Uniqueness is the database's job (a unique
 * index), not this function's — six base32 characters is 2^30 per day, so a
 * collision is a retry, not a redesign.
 *
 * Randomness is injected because `@rekoda/core` has none by design; callers
 * pass `randomBytes` from node:crypto. Modulo bias is avoided the same way the
 * token generator avoids it: 256 % 32 === 0.
 */
export function paymentReference(at: Date, random: RandomBytes): string {
  return mintReference('PAY', at, random);
}

/**
 * The same shape under a different prefix.
 *
 * Shared rather than copied because the properties above are the reason it is
 * safe to read one aloud, and a second implementation is a second place for
 * an alphabet to drift.
 */
export function mintReference(prefix: string, at: Date, random: RandomBytes): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');

  const bytes = random(6);
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += ALPHABET[bytes[i]! % 32];

  return `RKD-${prefix}-${y}${m}${d}-${suffix}`;
}

export const PAYMENT_REFERENCE_PATTERN = /^RKD-PAY-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * Every Rekoda payment reference a free text carries (§9, §22.1 tier 1).
 *
 * Case-insensitive and normalised to the minted casing, because a bank's
 * narration processor may fold case; the alphabet stays the minted one
 * (no I, L, O, U), so a reference read over a phone still scans.
 */
export function paymentReferencesIn(text: string): string[] {
  const found = text.toUpperCase().match(/RKD-PAY-\d{8}-[0-9A-HJKMNP-TV-Z]{6}/g);
  return found ? [...new Set(found)] : [];
}

/**
 * The graduation gate (ADR 0019, fix-plan 6 M5d). A Paystack Starter
 * account carries a N2,000,000 LIFETIME collection cap; crossing N1,500,000
 * is the moment to say so, while there is still room to register before
 * collections stop mid-sale. Kobo, like every other amount.
 */
export const GRADUATION_NUDGE_K = 150_000_000;
export const STARTER_CAP_K = 200_000_000;

/* ── judging a provider's claim (payments-v1 §21) ─────────────────────────── */

export interface ExpectedPayment {
  reference: string;
  amountK: number;
  currency: string;
}

export interface ReportedPayment {
  reference: string;
  /** Integer subunits. Paystack already reports kobo — adapters must NOT
   * multiply by 100 again; a double conversion turns ₦1,500 into ₦150,000. */
  amountK: number;
  currency: string;
  /** Normalised by the adapter: did the provider call this successful? */
  succeeded: boolean;
}

export type PaymentJudgement =
  /** Money moved and it is OUR money. `reconciliation` says how it lands. */
  | {
      verdict: 'confirmed';
      amountK: number;
      reconciliation: 'matched' | 'partial_match' | 'overpaid';
    }
  /** Not accepted as this obligation's payment. Nothing downstream fires. */
  | {
      verdict: 'rejected';
      reason:
        'provider_not_success' | 'reference_mismatch' | 'currency_mismatch' | 'non_positive_amount';
    };

/**
 * The decision at the heart of the webhook pipeline.
 *
 * The asymmetry is deliberate and comes straight from the spec's own example.
 * A WRONG CURRENCY or a reference that is not ours is a rejection — that event
 * is not this obligation's money, whatever else it may be. A wrong AMOUNT is
 * not a rejection: a bank transfer of ₦80,000 against a ₦100,000 invoice is
 * real money that really moved (payments-v1 §22), so the payment confirms and
 * reconciliation says `partial_match` — the invoice stays partially paid and
 * the balance stays owed. Rejecting it would make the merchant's books deny a
 * transfer their bank statement shows.
 *
 * What this function refuses to do is the thing §21 forbids: let ₦90,000 mark
 * a ₦100,000 invoice PAID.
 */
export function judgeProviderPayment(
  expected: ExpectedPayment,
  reported: ReportedPayment,
): PaymentJudgement {
  if (!reported.succeeded) return { verdict: 'rejected', reason: 'provider_not_success' };
  if (reported.reference !== expected.reference) {
    return { verdict: 'rejected', reason: 'reference_mismatch' };
  }
  if (reported.currency.toUpperCase() !== expected.currency.toUpperCase()) {
    return { verdict: 'rejected', reason: 'currency_mismatch' };
  }
  if (!Number.isInteger(reported.amountK) || reported.amountK <= 0) {
    return { verdict: 'rejected', reason: 'non_positive_amount' };
  }

  const reconciliation =
    reported.amountK === expected.amountK
      ? 'matched'
      : reported.amountK < expected.amountK
        ? 'partial_match'
        : 'overpaid';
  return { verdict: 'confirmed', amountK: reported.amountK, reconciliation };
}

/* ── fees never distort revenue (payments-v1 §14–15, §43.5–6) ─────────────── */

export interface FeeSplitInput {
  /** The obligation — what the goods cost. The ONLY figure allowed into Sales Revenue. */
  invoiceAmountK: number;
  providerFeeK: number;
  /** Rekoda's own cut, when one exists. Zero in V1. */
  platformFeeK?: number;
  policy: FeePolicy;
}

export interface FeeSplit {
  /** Always exactly the invoice amount. The invariant this function exists for. */
  revenueK: number;
  /** What the customer is asked to hand over. */
  customerPaysK: number;
  /** What reaches the merchant's bank. */
  merchantSettlementK: number;
  /** What Rekoda absorbs (platform-bearing policy only). */
  platformAbsorbsK: number;
  providerFeeK: number;
  platformFeeK: number;
}

/**
 * ₦100,000 invoice + ₦300 processing charge = ₦100,300 paid, ₦100,000 revenue.
 *
 * Whoever bears the fee, `revenueK === invoiceAmountK`, unconditionally — a
 * processor fee is a cost of collection, not a bigger sale, and a bigger sale
 * is what every "just add it to the total" shortcut quietly books.
 */
export function splitFees(input: FeeSplitInput): FeeSplit {
  const platformFeeK = input.platformFeeK ?? 0;
  if (input.invoiceAmountK < 0 || input.providerFeeK < 0 || platformFeeK < 0) {
    throw new Error('splitFees: amounts must be non-negative integer kobo');
  }
  if (
    !Number.isInteger(input.invoiceAmountK) ||
    !Number.isInteger(input.providerFeeK) ||
    !Number.isInteger(platformFeeK)
  ) {
    throw new Error('splitFees: amounts must be non-negative integer kobo');
  }

  const base = {
    revenueK: input.invoiceAmountK,
    providerFeeK: input.providerFeeK,
    platformFeeK,
  };

  switch (input.policy) {
    case 'customer_bearing':
      // The customer covers collection costs; the merchant is made whole.
      return {
        ...base,
        customerPaysK: input.invoiceAmountK + input.providerFeeK + platformFeeK,
        merchantSettlementK: input.invoiceAmountK,
        platformAbsorbsK: 0,
      };
    case 'merchant_bearing':
      // The merchant absorbs collection costs out of the sale.
      return {
        ...base,
        customerPaysK: input.invoiceAmountK,
        merchantSettlementK: input.invoiceAmountK - input.providerFeeK - platformFeeK,
        platformAbsorbsK: 0,
      };
    case 'platform_bearing':
      // Rekoda eats the provider fee; the platform fee, if any, still stands.
      return {
        ...base,
        customerPaysK: input.invoiceAmountK,
        merchantSettlementK: input.invoiceAmountK - platformFeeK,
        platformAbsorbsK: input.providerFeeK,
      };
  }
}

/* ── the provider resolver (spec §17, §18; PR-068) ─────────────────────── */

/** §18's three ports. A provider that does two things has two rows. */
export type ProviderCapabilityKind = 'COLLECT' | 'FEED' | 'PAYOUT';

export interface PlatformCapability {
  providerType: string;
  capability: ProviderCapabilityKind;
  status: 'AVAILABLE' | 'BLOCKED';
  /** The external blocker by name, when blocked. */
  reason?: string | null;
}

export interface CandidateConnection {
  connectionId: string;
  providerType: string;
  /** The §17.1 derivation: all four axes must permit it. */
  productionEnabled: boolean;
  /** For deterministic seniority when more than one connection is eligible. */
  connectedAtMs: number;
}

export type ResolveProviderOutcome =
  | { resolved: true; connectionId: string; providerType: string }
  /** The business holds no connection at all for this need. */
  | { resolved: false; reason: 'no_connection' }
  /** Connections exist, but no provider among them may do this on the
   * platform — the detail carries the blockers by name. */
  | { resolved: false; reason: 'no_capable_provider'; detail: string[] }
  /** A capable provider exists, but that merchant's own connection does
   * not derive production-enabled: their §17.1 axes are the refusal. */
  | { resolved: false; reason: 'not_production_enabled'; providerTypes: string[] };

/**
 * Which provider serves this need, decided from CAPABILITY and COMPLIANCE
 * and NOTHING else (§18: production availability is capability and
 * compliance gated; the build plan's slice test says it plainer — never a
 * hardcoded default).
 *
 * Two layers gate together: the PLATFORM may offer the provider
 * (ProviderCapability, the OPEN COMMERCIAL/COMPLIANCE table) and THIS
 * merchant's connection derives production-enabled (§17.1's four axes).
 * When more than one connection survives both gates, the OLDEST wins —
 * seniority is deterministic and merchant-explicable, where any
 * preference list would quietly be the hardcoded default coming back in.
 */
export function resolvePaymentProvider(
  need: ProviderCapabilityKind,
  connections: CandidateConnection[],
  capabilities: PlatformCapability[],
): ResolveProviderOutcome {
  if (connections.length === 0) return { resolved: false, reason: 'no_connection' };

  const capable = new Set(
    capabilities
      .filter((c) => c.capability === need && c.status === 'AVAILABLE')
      .map((c) => c.providerType),
  );
  const withCapableProvider = connections.filter((c) => capable.has(c.providerType));
  if (withCapableProvider.length === 0) {
    const blockers = capabilities
      .filter(
        (c) =>
          c.capability === need &&
          c.status === 'BLOCKED' &&
          connections.some((connection) => connection.providerType === c.providerType),
      )
      .map((c) => c.reason ?? `${c.providerType} is blocked`);
    return { resolved: false, reason: 'no_capable_provider', detail: blockers };
  }

  const eligible = withCapableProvider
    .filter((c) => c.productionEnabled)
    .sort((a, b) => a.connectedAtMs - b.connectedAtMs);
  const winner = eligible[0];
  if (!winner) {
    return {
      resolved: false,
      reason: 'not_production_enabled',
      providerTypes: withCapableProvider.map((c) => c.providerType),
    };
  }
  return { resolved: true, connectionId: winner.connectionId, providerType: winner.providerType };
}

/* ── provider fee estimation from a rate observation (§19.1, §24; PR-072) ── */

/**
 * A PERCENT_PLUS_FLAT rate as one `ProviderCostSchedule` row states it:
 * a percentage of the amount plus a flat fee, the whole thing optionally
 * capped, the flat part optionally waived below a threshold. This is the
 * shape Paystack's collection pricing actually has, and the fields are
 * the observation's — an estimate never carries a number the row cannot
 * justify.
 */
export interface PercentPlusFlatRate {
  /** Parts-per-million of the amount (15000 = 1.5%). */
  percentPpm: number;
  flatMinor: number;
  /** The whole fee is capped here; null means uncapped. */
  capMinor: number | null;
  /** The flat part is waived below this amount; null means never. */
  waiveFlatUnderMinor: number | null;
}

/**
 * What a provider will charge on an amount, DERIVED from the observation
 * in force — the §19.1 ESTIMATED figure, whose row id rides along as
 * `providerCostScheduleId` so the estimate can always name its source.
 * Rounded UP on the percentage, per the planning rule the rate cards
 * are recorded under: model every cost at or above market.
 */
export function estimateProviderFeeMinor(rate: PercentPlusFlatRate, amountMinor: number): number {
  const flat =
    rate.waiveFlatUnderMinor !== null && amountMinor < rate.waiveFlatUnderMinor
      ? 0
      : rate.flatMinor;
  const fee = Math.ceil((amountMinor * rate.percentPpm) / 1_000_000) + flat;
  return rate.capMinor === null ? fee : Math.min(fee, rate.capMinor);
}
