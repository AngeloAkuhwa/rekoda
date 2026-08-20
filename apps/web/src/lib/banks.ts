/**
 * Nigerian banks a merchant can settle to (docs/payments-v1.md §3).
 *
 * A static, curated list on purpose: the onboarding form needs a name a
 * vendor recognises in under two seconds, and the CBN/NIBSS codes here are
 * stable public identifiers. A provider-synced list (Paystack GET /bank)
 * can replace this when multi-provider support needs it; the form's shape
 * does not change.
 */
export interface Bank {
  code: string;
  name: string;
}

export const BANKS: readonly Bank[] = [
  { code: '044', name: 'Access Bank' },
  { code: '050', name: 'Ecobank' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank' },
  { code: '214', name: 'FCMB' },
  { code: '058', name: 'GTBank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '50211', name: 'Kuda' },
  { code: '50515', name: 'Moniepoint' },
  { code: '999992', name: 'OPay' },
  { code: '999991', name: 'PalmPay' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC' },
  { code: '232', name: 'Sterling Bank' },
  { code: '032', name: 'Union Bank' },
  { code: '033', name: 'UBA' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
] as const;

export function bankName(code: string | null): string | null {
  if (!code) return null;
  return BANKS.find((bank) => bank.code === code)?.name ?? null;
}
