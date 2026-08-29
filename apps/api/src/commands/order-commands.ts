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
import {
  catalogueRepo,
  chargesRepo,
  customersRepo,
  issueRepo,
  jobsRepo,
  ordersRepo,
  outboxRepo,
  paymentsHub,
  stockRepo,
  type TenantDb,
} from '@rekoda/db';
import { estimateProviderFeeMinor, lagosDay, postCostOfSale } from '@rekoda/core';

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

export interface CatalogueOrderCmdInput {
  businessId: string;
  customerId: string | null;
  lines: readonly {
    productId: string | null;
    name: string;
    quantity: number;
    unitPriceK: number;
    lineTotalK: number;
  }[];
  totalK: number;
  /** Meta's message id, prefixed — `orders_external_ux` makes a redelivered
   * webhook a no-op rather than a second order. */
  externalRef: string;
  sourceId: string;
}

export interface CatalogueOrderResult {
  orderId: string;
  orderNumber: string;
  totalK: number;
}

/**
 * The WABA catalogue door of `PlaceOrder` (spec §3.2; W3, PR-087): the
 * ORDER, and only the order.
 *
 * The storefront door above is a one-step shape — order, invoice, stock
 * and COGS together — because the storefront validated the cart in the
 * same request. A cart from WhatsApp lands at Appendix E.4's PLACED and
 * STOPS: server-side validation against real stock (PR-088) is what
 * turns it into a VALIDATED order with an invoice and a charge breakdown,
 * and issuing the invoice here would put a figure ahead of the validation
 * §3.2 orders before it. Nothing financial posts; the announcement says
 * what arrived.
 */
export async function placeCatalogueOrderWork(
  tx: TenantDb,
  input: CatalogueOrderCmdInput,
): Promise<CatalogueOrderResult> {
  const placed = await ordersRepo.placeOrder(tx, {
    businessId: input.businessId,
    customerId: input.customerId,
    lines: [...input.lines],
    totalK: input.totalK,
    sourceType: 'waba_catalogue',
    sourceId: input.sourceId,
    externalRef: input.externalRef,
  });

  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'order.placed',
    payload: {
      orderNumber: placed.orderNumber,
      totalK: input.totalK,
      sourceType: 'waba_catalogue',
    },
  });

  return { orderId: placed.id, orderNumber: placed.orderNumber, totalK: input.totalK };
}

export interface ValidateCatalogueOrderInput {
  businessId: string;
  orderId: string;
  actor: string;
}

export type ValidateCatalogueOrderResult =
  | { outcome: 'validated'; invoiceId: string; invoiceNumber: string; totalK: number }
  | {
      outcome: 'rejected';
      reason: 'not_found' | 'not_pending' | 'unsellable' | 'price_changed' | 'insufficient_stock';
    };

/**
 * Server-side validation and the charge breakdown (spec §5.2; W3,
 * PR-088): what turns a PLACED request into a VALIDATED order — "it is
 * not a sale and not a receivable until validated", and this is the
 * validation.
 *
 * Checked against the REAL catalogue and the REAL shelf, now: every line
 * still sellable at the price the order was taken at (a price the
 * merchant moved since is a refusal, never a silent re-quote), and the
 * counted shelf able to serve every quantity (an uncounted product — a
 * service — invents no empty shelf). A refusal CANCELS the order: the
 * record of the request stands, visibly refused, and nothing financial
 * exists for it.
 *
 * Validation is also where the figures become records: the provider's
 * expected fee lands as an ESTIMATED PaymentCharge (§19.1 — every line a
 * record, never arithmetic in a controller; merchant-borne, so the
 * customer's total is untouched, resolved to ACTUAL by settlement), and
 * the invoice is issued exactly as the storefront's validated cart is —
 * revenue and receivable now, goods committed and costed now, paper and
 * payable link enqueued. VAT on the checkout stays at zero pending the
 * OPEN COMPLIANCE tax decision: whether this merchant charges VAT on a
 * WhatsApp order is configuration W0-era compliance review supplies,
 * not a branch guessed here.
 */
export async function validateCatalogueOrderWork(
  tx: TenantDb,
  input: ValidateCatalogueOrderInput,
): Promise<ValidateCatalogueOrderResult> {
  const order = await ordersRepo.orderWithItems(tx, input.businessId, input.orderId);
  if (!order) return { outcome: 'rejected', reason: 'not_found' };
  if (order.status !== 'placed') return { outcome: 'rejected', reason: 'not_pending' };

  const reject = async (
    reason: 'unsellable' | 'price_changed' | 'insufficient_stock',
  ): Promise<ValidateCatalogueOrderResult> => {
    await ordersRepo.markOrder(tx, input.businessId, order.id, 'placed', 'cancelled');
    await outboxRepo.append(tx, {
      businessId: input.businessId,
      type: 'order.rejected',
      payload: { orderId: order.id, reason, totalK: order.totalK },
    });
    return { outcome: 'rejected', reason };
  };

  const ids = order.lines.map((line) => line.productId).filter((id): id is string => id !== null);
  const sellable = await catalogueRepo.sellableByIds(tx, input.businessId, ids);
  const priced = new Map(sellable.map((p) => [p.id, p]));
  for (const line of order.lines) {
    if (!line.productId) return reject('unsellable');
    const product = priced.get(line.productId);
    if (!product) return reject('unsellable');
    if (product.unitPriceK !== line.unitPriceK) return reject('price_changed');
  }

  const shelf = await stockRepo.onHandByIds(tx, input.businessId, ids);
  for (const line of order.lines) {
    const held = shelf.get(line.productId!);
    if (held && held.counted && held.onHand < line.quantity) {
      return reject('insufficient_stock');
    }
  }

  /* §19.1: the provider's expected fee, as an ESTIMATED record the moment
   * a figure exists to estimate from. Merchant-borne — the customer's
   * total is untouched — and resolved to ACTUAL when the settlement says
   * what was really taken. No connection, no invented figure. */
  const connection = await paymentsHub.connectionFor(tx, input.businessId, 'paystack');
  if (connection) {
    const card = await paymentsHub.costScheduleInForce(
      tx,
      'paystack',
      'collection_transfer_dva',
      lagosDay(new Date()),
    );
    if (card && card.basis === 'PERCENT_PLUS_FLAT') {
      const feeMinor = estimateProviderFeeMinor(
        {
          percentPpm: card.percentPpm ?? 0,
          flatMinor: card.flatMinor ?? 0,
          capMinor: card.capMinor,
          waiveFlatUnderMinor: card.waiveFlatUnderMinor,
        },
        order.totalK,
      );
      await chargesRepo.recordCharge(tx, {
        businessId: input.businessId,
        orderId: order.id,
        type: 'PAYMENT_PROCESSING',
        label: 'Payment charge',
        amountMinor: feeMinor,
        beneficiary: 'PROVIDER',
        economicBearer: 'MERCHANT',
        providerCostScheduleId: card.id,
      });
    }
  }

  const customerToken = order.customerId
    ? await customersRepo.tokenForCustomer(tx, input.businessId, order.customerId)
    : null;
  const items = order.lines.map((line) => ({
    name: line.name,
    quantity: line.quantity,
    unitPriceK: line.unitPriceK,
  }));
  const issued = await issueRepo.issueSale(tx, {
    businessId: input.businessId,
    customerId: order.customerId,
    customerToken,
    items,
    subtotalK: order.totalK,
    discountK: 0,
    deliveryFeeK: 0,
    vatK: 0,
    totalK: order.totalK,
    paidK: 0,
    balanceDueK: order.totalK,
    method: 'transfer',
    sourceType: 'waba_catalogue',
    sourceId: order.id,
    saleSource: 'whatsapp_catalogue',
    dueDate: null,
    actor: input.actor,
  });
  await ordersRepo.markOrder(
    tx,
    input.businessId,
    order.id,
    'placed',
    'validated',
    issued.invoiceId,
  );

  await jobsRepo.enqueue(tx, {
    businessId: input.businessId,
    kind: 'document.render',
    payload: { invoiceId: issued.invoiceId },
    singletonKey: issued.invoiceId,
  });
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
    type: 'order.validated',
    payload: {
      orderId: order.id,
      invoiceNumber: issued.invoiceNumber,
      totalK: order.totalK,
    },
  });

  return {
    outcome: 'validated',
    invoiceId: issued.invoiceId,
    invoiceNumber: issued.invoiceNumber,
    totalK: order.totalK,
  };
}
