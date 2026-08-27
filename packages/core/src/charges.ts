/**
 * The checkout breakdown (spec §19.1; PR-057) — every line a record, and
 * the taxable base STATED rather than inferred from the arithmetic. A
 * canonical example must never contain arithmetic whose tax basis has to
 * be guessed; neither may a checkout.
 */
export const CHARGE_TYPES = ['PAYMENT_PROCESSING', 'DELIVERY', 'SERVICE', 'SURCHARGE'] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];

export const CHARGE_BENEFICIARIES = ['MERCHANT', 'REKODA', 'PROVIDER'] as const;
export type ChargeBeneficiary = (typeof CHARGE_BENEFICIARIES)[number];

/** In or out of the taxable base: a stated fact on every line. */
export type LineTaxCode = 'STANDARD_RATE' | 'ZERO_RATED' | 'NOT_IN_BASE';

export interface BreakdownLine {
  label: string;
  amountMinor: number;
  /** Null means NOT in the base — the §19.1 default for a charge nobody
   * configured into it. */
  taxCode: LineTaxCode | null;
}

export interface CheckoutBreakdown {
  lines: BreakdownLine[];
  taxableBaseMinor: number;
  vatMinor: number;
  totalMinor: number;
}

export class SurchargeNotConfigured extends Error {
  constructor() {
    super(
      'a customer surcharge is configuration-gated: Rekoda must never add a charge the merchant did not choose to add',
    );
  }
}

const assertMinor = (value: number, what: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative integer of minor units, got ${value}`);
  }
};

/**
 * Sum a breakdown whose every line states its own tax treatment.
 *
 * VAT applies to the sum of STANDARD_RATE lines only, at `vatRateBps`
 * basis points, rounded half-up in integer arithmetic — minor units in,
 * minor units out, no floating point anywhere near money.
 *
 * A SURCHARGE line may enter only when `surchargeConfigured` says the
 * merchant chose it: in several markets a surcharge is regulated or
 * prohibited, so the gate is on the concept, not the amount.
 */
export function computeCheckoutBreakdown(input: {
  lines: ReadonlyArray<BreakdownLine & { type?: ChargeType }>;
  vatRateBps: number;
  surchargeConfigured?: boolean;
}): CheckoutBreakdown {
  if (!Number.isSafeInteger(input.vatRateBps) || input.vatRateBps < 0) {
    throw new RangeError(`vatRateBps must be a non-negative integer, got ${input.vatRateBps}`);
  }
  for (const line of input.lines) {
    assertMinor(line.amountMinor, `line "${line.label}"`);
    if (line.type === 'SURCHARGE' && !input.surchargeConfigured) {
      throw new SurchargeNotConfigured();
    }
  }
  const taxableBaseMinor = input.lines
    .filter((line) => line.taxCode === 'STANDARD_RATE')
    .reduce((sum, line) => sum + line.amountMinor, 0);
  /* Half-up on the half kobo, in integers. */
  const vatMinor = Math.floor((taxableBaseMinor * input.vatRateBps + 5_000) / 10_000);
  const grossMinor = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);
  return {
    lines: [...input.lines],
    taxableBaseMinor,
    vatMinor,
    totalMinor: grossMinor + vatMinor,
  };
}
