import { formatKobo, type Kobo } from '@rekoda/core';

/**
 * The ONLY way money is rendered in apps/web (MASTER.md §7.1).
 * Hand-rolled currency formatting anywhere else is a review rejection —
 * this is the same function the PDFs use, so screen and document never disagree.
 */
export function Money({ kobo, currency = 'NGN' }: { kobo: Kobo; currency?: string }) {
  return <span className="rk-money">{formatKobo(kobo, currency)}</span>;
}
