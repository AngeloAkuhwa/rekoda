/**
 * The command a public API sale becomes.
 *
 * Pure, so the route and its tests build the SAME payload: the command bus
 * fingerprints this object (`requestHash`), and a retry is recognised only
 * if every field comes out identical. The totals are computed here from the
 * caller's lines rather than taken from them: a program that sends a total
 * is a program that can send one that does not match its own items.
 */
import { computeMoneyFromKobo } from '@rekoda/core';
import type { publicApi } from '@rekoda/contracts';
import type { RecordSaleInput } from '../../commands/sale-commands.js';

export function publicSaleInput(
  data: publicApi.v1.RecordSaleRequest,
  caller: { businessId: string; keyPrefix: string },
  sourceId: string,
): RecordSaleInput {
  const money = computeMoneyFromKobo({
    items: data.items,
    discountK: data.discountK ?? 0,
    deliveryFeeK: data.deliveryFeeK ?? 0,
    vatK: data.vatK ?? 0,
    amountPaidK: data.amountPaidK ?? 0,
  });
  return {
    businessId: caller.businessId,
    customerId: data.customerId ?? null,
    /* No pseudonym minted here. A token names a customer the merchant's own
     * channels met; an API caller naming one it invented would put a
     * stranger in the merchant's customer list. */
    customerToken: null,
    items: data.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPriceK: item.unitPriceK,
    })),
    subtotalK: money.subtotalK,
    discountK: money.discountK,
    deliveryFeeK: money.deliveryFeeK,
    vatK: money.vatK,
    totalK: money.totalK,
    paidK: money.amountPaidK,
    balanceDueK: money.balanceDueK,
    method: data.method ?? 'transfer',
    sourceType: 'api',
    /* The sale's own event identity, never the application's (G-77). */
    sourceId,
    saleSource: null,
    dueDate: data.dueDate ? new Date(data.dueDate) : null,
    actor: `api:${caller.keyPrefix}`,
  };
}
