/**
 * The order command (spec §25; PR-025): one work function behind BOTH
 * command names, because they are one financial act with two front doors.
 * `PlaceOrder` is the customer's own hand (storefront); `RecordOrder` is
 * the merchant forwarding what a customer said (chat). The entitlement
 * table gates both with `REKODA_INTEGRATE` — automatic order capture is
 * the thing Integrate sells — and which name the envelope carries preserves
 * WHO acted, which the audit trail is owed.
 *
 * The work is what both ingresses held inline: the order, the invoice it
 * becomes, the linkage in the same statement, the paper, the payable link,
 * the stock it commits and what those goods cost — an order the merchant
 * has agreed to IS a sale on credit, and the shelf has to say so before
 * the next customer is quoted for bales already spoken for.
 */
import { issueRepo, jobsRepo, ordersRepo, outboxRepo, stockRepo, type TenantDb } from '@rekoda/db';
import { postCostOfSale } from '@rekoda/core';

export interface PlaceOrderCmdInput {
  businessId: string;
  customerId: string | null;
  /** The pseudonymous token for the invoice snapshot, chat only. */
  customerToken?: string | null;
  lines: readonly {
    productId: string | null;
    name: string;
    quantity: number;
    unitPriceK: number;
    lineTotalK: number;
  }[];
  totalK: number;
  /** Where the ORDER came from. */
  sourceType: 'chat' | 'storefront';
  sourceId: string;
  /** The storefront form's one-shot key, deduped by `orders_external_ux`. */
  externalRef?: string | null;
  /** Where the sale HAPPENED, only when somebody honestly named it. */
  saleSource: string | null;
  /**
   * What the invoice cites as its source id. Null means the placed order's
   * own id (the storefront's shape); chat cites the confirmed draft.
   */
  invoiceSourceId?: string | null;
  actor: string;
}

export interface PlacedOrderResult {
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  totalK: number;
}

export async function placeOrderWork(
  tx: TenantDb,
  input: PlaceOrderCmdInput,
): Promise<PlacedOrderResult> {
  const placed = await ordersRepo.placeOrder(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    lines: [...input.lines],
    totalK: input.totalK,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    ...(input.externalRef ? { externalRef: input.externalRef } : {}),
  });

  const items = input.lines.map((line) => ({
    name: line.name,
    quantity: line.quantity,
    unitPriceK: line.unitPriceK,
  }));

  /* Nothing is paid: a customer asked and the merchant agreed to supply.
   * The money is the next event, not this one. */
  const issued = await issueRepo.issueSale(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    customerToken: input.customerToken ?? null,
    items,
    subtotalK: input.totalK,
    discountK: 0,
    deliveryFeeK: 0,
    vatK: 0,
    totalK: input.totalK,
    paidK: 0,
    balanceDueK: input.totalK,
    method: 'transfer',
    sourceType: input.sourceType,
    sourceId: input.invoiceSourceId ?? placed.id,
    saleSource: input.saleSource,
    /* No agreed payment date rides an order; what a customer said about
     * timing is about DELIVERY. */
    dueDate: null,
    actor: input.actor,
  });

  /* The same statement that confirms attaches the invoice, or the register
   * is back to matching orders and invoices by eye. */
  await ordersRepo.markOrder(
    tx,
    input.businessId,
    placed.id,
    'placed',
    'confirmed',
    issued.invoiceId,
  );

  await jobsRepo.enqueue(tx, {
    businessId: input.businessId,
    kind: 'document.render',
    payload: { invoiceId: issued.invoiceId },
    singletonKey: issued.invoiceId,
  });
  /* And a payable link, if this shop can take one — the job decides and
   * stays silent when there is nothing to offer. */
  await jobsRepo.enqueue(tx, {
    businessId: input.businessId,
    kind: 'payment.link',
    payload: { invoiceId: issued.invoiceId },
    singletonKey: `link:${issued.invoiceId}`,
  });

  const moved = await stockRepo.recordSaleMovements(
    tx,
    input.businessId,
    items,
    issued.invoiceNumber,
  );
  if (moved.costK > 0) {
    await issueRepo.writePosting(
      tx,
      input.businessId,
      postCostOfSale({ memo: `Cost of goods on ${issued.invoiceNumber}`, costK: moved.costK }),
      'invoice',
      issued.invoiceNumber,
    );
  }

  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'order.placed',
    payload: {
      orderNumber: placed.orderNumber,
      invoiceId: issued.invoiceId,
      invoiceNumber: issued.invoiceNumber,
      totalK: input.totalK,
      sourceType: input.sourceType,
    },
  });

  return {
    orderId: placed.id,
    orderNumber: placed.orderNumber,
    invoiceId: issued.invoiceId,
    invoiceNumber: issued.invoiceNumber,
    totalK: input.totalK,
  };
}
